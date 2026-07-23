"""Unit tests for the WhatsApp persist path — the single idempotent write.

No real database: a ``FakeDB`` captures the executed statements + params and
returns a canned RETURNING row, so the Python-side derivations (the 24h window,
direction→send_regime, the chat/message fan-out) are pinned without Postgres.
"""

from __future__ import annotations

from datetime import UTC, datetime

from whatsapp_ingestion import persist
from whatsapp_ingestion.providers.base import (
    SyncResult,
    WhatsAppContact,
    WhatsAppMedia,
    WhatsAppMessage,
)

_SENT = datetime(2026, 7, 23, 9, 0, tzinfo=UTC)


class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _Row:
    id = "chat-uuid-1"


class FakeDB:
    """Captures (sql_text, params) and returns a fixed chat id on RETURNING."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    async def execute(self, statement, params=None):
        self.calls.append((str(statement), params or {}))
        return _Result(_Row())

    def statements(self) -> str:
        return "\n".join(s for s, _ in self.calls)


def test_service_window_is_24h_after_inbound() -> None:
    assert persist.service_window_expiry(_SENT) == datetime(
        2026, 7, 24, 9, 0, tzinfo=UTC)
    assert persist.service_window_expiry(None) is None


def test_inbound_message_params_have_no_send_regime() -> None:
    msg = WhatsAppMessage(
        wa_message_id="wamid.1", wa_chat_id="91999", kind="text",
        sender_wa_id="91999", sender_name="Rajesh", body_text="hi", sent_at=_SENT)
    p = persist._message_params("acc", "chat-uuid-1", msg, "in")
    assert p["direction"] == "in"
    assert p["send_regime"] is None          # inbound has no regime
    assert p["kind"] == "text"
    assert '"name": "Rajesh"' in p["sender"]  # sender JSON carries the name


def test_outbound_message_params_default_to_session_regime() -> None:
    msg = WhatsAppMessage(
        wa_message_id="wamid.2", wa_chat_id="91999", body_text="ok", sent_at=_SENT)
    p = persist._message_params("acc", "chat-uuid-1", msg, "out")
    assert p["direction"] == "out"
    assert p["send_regime"] == "session"     # free-form reply inside the window


async def test_upsert_chat_sets_window_only_for_inbound() -> None:
    db = FakeDB()
    msg = WhatsAppMessage(
        wa_message_id="wamid.1", wa_chat_id="91999", chat_kind="dm",
        sender_name="Rajesh", sent_at=_SENT)

    await persist.upsert_chat(db, "acc", msg, direction="in")
    assert db.calls[-1][1]["window_expires"] == datetime(2026, 7, 24, 9, 0, tzinfo=UTC)

    db2 = FakeDB()
    await persist.upsert_chat(db2, "acc", msg, direction="out")
    assert db2.calls[-1][1]["window_expires"] is None  # our send never opens it


async def test_persist_sync_result_fans_out_contacts_chats_messages() -> None:
    db = FakeDB()
    result = SyncResult(
        contacts=[WhatsAppContact(wa_id="91999", phone_number="91999", name="Rajesh")],
        messages=[
            WhatsAppMessage(wa_message_id="wamid.1", wa_chat_id="91999",
                            sender_wa_id="91999", body_text="PO attached",
                            sent_at=_SENT),
            WhatsAppMessage(wa_message_id="wamid.2", wa_chat_id="91999",
                            sender_wa_id="91999", kind="document",
                            media=WhatsAppMedia(wa_media_id="M1",
                                                mime_type="application/pdf"),
                            sent_at=_SENT),
        ],
    )
    counts = await persist.persist_sync_result(db, "acc", result)
    assert counts == {"messages": 2, "chats": 1}   # both messages, one shared chat
    sql = db.statements()
    assert "INSERT INTO wa_contacts" in sql
    assert "INSERT INTO wa_chats" in sql
    assert "INSERT INTO wa_messages" in sql
    assert "INSERT INTO wa_media" in sql            # the document's media row


async def test_persist_skips_messages_without_an_id() -> None:
    db = FakeDB()
    result = SyncResult(messages=[
        WhatsAppMessage(wa_message_id="", wa_chat_id="91999"),  # dropped
        WhatsAppMessage(wa_message_id="wamid.ok", wa_chat_id="91999", sent_at=_SENT),
    ])
    counts = await persist.persist_sync_result(db, "acc", result)
    assert counts["messages"] == 1


def test_body_truncation_marks_oversized_text() -> None:
    big = "x" * (persist.MAX_BODY_TEXT_BYTES + 100)
    out = persist._truncate(big, persist.MAX_BODY_TEXT_BYTES)
    assert out.endswith("[truncated]")
    assert persist._truncate(None, 10) is None
