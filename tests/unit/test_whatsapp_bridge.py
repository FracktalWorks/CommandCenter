"""Unit tests for the whatsmeow bridge seam (W15.1).

The bridge is the personal-number (QR) counterpart to the Cloud API webhook. The
gateway holds no WhatsApp session — it parses the bridge's normalized JSON into a
``SyncResult`` and runs it through the SAME persist + post-sync path as the
webhook. These pin:

* ``parse_bridge_payload`` — the pure mapper (messages/contacts/media/timestamps,
  and that a row missing an id is dropped rather than half-written).
* ``bridge_secret_ok`` — the constant-time shared-secret check.
* ``bridge_ingest`` — verify → parse → persist → hooks, with a fake db + mocked
  persist/hooks so the whole flow is exercised without a database.
* ``bridge_paired`` — the pairing-complete account update.
* route registration.
"""

from __future__ import annotations

from datetime import UTC

import gateway.routes.whatsapp.transport.bridge as bridge
from gateway.routes.whatsapp.transport.bridge import (
    bridge_secret_ok,
    parse_bridge_payload,
)

# ── pure parser ────────────────────────────────────────────────────────────────

def test_parses_message_contact_and_media() -> None:
    result = parse_bridge_payload({
        "contacts": [{"wa_id": "919990388", "phone_number": "+919990388",
                      "name": "Rajesh Mehta"}],
        "messages": [{
            "wa_message_id": "3EB0.1", "chat_id": "919990388@s.whatsapp.net",
            "direction": "in", "kind": "document",
            "sender_wa_id": "919990388", "sender_name": "Rajesh Mehta",
            "body_text": "PO attached",
            "media": {"wa_media_id": "M1", "mime_type": "application/pdf",
                      "filename": "PO.pdf", "size_bytes": 4417, "sha256": "abc"},
            "sent_at": "2026-07-24T10:00:00+00:00",
        }],
    })
    assert len(result.contacts) == 1
    assert result.contacts[0].wa_id == "919990388"
    assert result.contacts[0].name == "Rajesh Mehta"
    assert len(result.messages) == 1
    m = result.messages[0]
    assert m.wa_message_id == "3EB0.1"
    assert m.wa_chat_id == "919990388@s.whatsapp.net"
    assert m.kind == "document"
    assert m.body_text == "PO attached"
    assert m.direction == "in"
    assert m.media is not None
    assert m.media.wa_media_id == "M1"
    assert m.media.mime_type == "application/pdf"
    assert m.media.filename == "PO.pdf"
    assert m.media.size_bytes == 4417
    assert m.sent_at is not None
    assert m.sent_at.tzinfo == UTC
    assert m.raw["wa_message_id"] == "3EB0.1"    # original preserved


def test_group_and_outbound_directions_normalized() -> None:
    result = parse_bridge_payload({"messages": [
        {"wa_message_id": "g1", "chat_id": "GROUP@g.us", "chat_kind": "group",
         "group_subject": "Dealers South", "direction": "in"},
        {"wa_message_id": "o1", "chat_id": "919@s.whatsapp.net",
         "direction": "out"},
        {"wa_message_id": "x1", "chat_id": "919@s.whatsapp.net",
         "direction": "weird"},        # anything not 'out' is 'in'
    ]})
    by_id = {m.wa_message_id: m for m in result.messages}
    assert by_id["g1"].chat_kind == "group"
    assert by_id["g1"].group_subject == "Dealers South"
    assert by_id["o1"].direction == "out"
    assert by_id["x1"].direction == "in"


def test_message_missing_ids_is_skipped_not_partial() -> None:
    result = parse_bridge_payload({"messages": [
        {"wa_message_id": "", "chat_id": "c1"},        # no message id → skip
        {"wa_message_id": "m2"},                        # no chat id → skip
        {"chat_id": "c3"},                              # no message id → skip
        {"wa_message_id": "ok", "chat_id": "c4"},       # the only good one
    ]})
    assert [m.wa_message_id for m in result.messages] == ["ok"]


def test_media_without_id_is_ignored() -> None:
    result = parse_bridge_payload({"messages": [
        {"wa_message_id": "m", "chat_id": "c", "kind": "image",
         "media": {"mime_type": "image/jpeg"}},         # no wa_media_id
    ]})
    assert result.messages[0].media is None


def test_bad_timestamp_becomes_none_not_raise() -> None:
    result = parse_bridge_payload({"messages": [
        {"wa_message_id": "m", "chat_id": "c", "sent_at": "not-a-date"},
    ]})
    assert result.messages[0].sent_at is None


def test_empty_and_nonlist_fields_are_total() -> None:
    assert parse_bridge_payload({}).messages == []
    assert parse_bridge_payload({"messages": None, "contacts": None}).messages == []
    # A non-dict entry in either list is skipped, not fatal.
    result = parse_bridge_payload({
        "contacts": ["nope"], "messages": ["nope", {"wa_message_id": "m",
                                                     "chat_id": "c"}]})
    assert result.contacts == []
    assert [m.wa_message_id for m in result.messages] == ["m"]


# ── shared-secret auth ─────────────────────────────────────────────────────────

def test_secret_ok_matches_constant_time(monkeypatch) -> None:
    monkeypatch.setenv("WHATSAPP_BRIDGE_SECRET", "s3cr3t")
    assert bridge_secret_ok("s3cr3t") is True
    assert bridge_secret_ok("wrong") is False
    assert bridge_secret_ok(None) is False
    assert bridge_secret_ok("") is False


def test_secret_absent_allows_for_dev(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_BRIDGE_SECRET", raising=False)
    assert bridge_secret_ok(None) is True
    assert bridge_secret_ok("anything") is True


# ── fakes for the route handlers ───────────────────────────────────────────────

class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _FakeDB:
    def __init__(self, row=object()):
        self._row = row
        self.executed: list[tuple] = []
        self.committed = False
        self.closed = False

    async def execute(self, sql, params=None):
        self.executed.append((str(sql), params))
        return _Result(self._row)

    async def commit(self):
        self.committed = True

    async def close(self):
        self.closed = True


class _FakeRequest:
    def __init__(self, body, headers=None):
        self._body = body
        self.headers = headers or {}

    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def _patch_db(monkeypatch, db):
    async def _get_db():
        return db
    monkeypatch.setattr(bridge, "_get_db", _get_db)


def _patch_persist_and_hooks(monkeypatch, messages=1):
    """Fake persist + register identifiable hooks so we can assert which fired.

    ``run_hook`` is replaced with a recorder that logs the hook it was handed;
    the two hook slots are set to named sentinels so the recorded names are
    meaningful (they default to ``None`` outside a running app)."""
    calls: list[str] = []

    async def _persist(db, account_id, result):
        return {"messages": messages, "chats": 0, "contacts": 0}

    async def on_new_messages(_aid):  # named sentinel
        ...

    async def classify_chats(_aid):   # named sentinel
        ...

    async def _run_hook(hook, account_id):
        calls.append(getattr(hook, "__name__", str(hook)))

    from whatsapp_ingestion.post_sync import hooks
    monkeypatch.setattr(hooks, "on_new_messages", on_new_messages)
    monkeypatch.setattr(hooks, "classify_chats", classify_chats)
    monkeypatch.setattr(
        "whatsapp_ingestion.persist.persist_sync_result", _persist)
    monkeypatch.setattr("whatsapp_ingestion.post_sync.run_hook", _run_hook)
    return calls


# ── ingest route ───────────────────────────────────────────────────────────────

async def test_ingest_rejects_bad_secret(monkeypatch) -> None:
    monkeypatch.setenv("WHATSAPP_BRIDGE_SECRET", "s3cr3t")
    resp = await bridge.bridge_ingest(
        _FakeRequest({"account_id": "a"}, headers={"X-Bridge-Secret": "no"}))
    assert resp.status_code == 403


async def test_ingest_bad_json_is_400(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_BRIDGE_SECRET", raising=False)
    resp = await bridge.bridge_ingest(_FakeRequest(ValueError("boom")))
    assert resp.status_code == 400


async def test_ingest_missing_account_acks(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_BRIDGE_SECRET", raising=False)
    resp = await bridge.bridge_ingest(_FakeRequest({"messages": []}))
    assert resp.status_code == 200


async def test_ingest_unknown_account_acks(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_BRIDGE_SECRET", raising=False)
    db = _FakeDB(row=None)          # not owned / not whatsmeow
    _patch_db(monkeypatch, db)
    resp = await bridge.bridge_ingest(_FakeRequest({"account_id": "ghost"}))
    assert resp.status_code == 200
    assert db.closed is True


async def test_ingest_persists_and_fires_both_hooks(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_BRIDGE_SECRET", raising=False)
    db = _FakeDB()                  # owned row present
    _patch_db(monkeypatch, db)
    calls = _patch_persist_and_hooks(monkeypatch, messages=2)
    out = await bridge.bridge_ingest(_FakeRequest({
        "account_id": "acc-1",
        "messages": [{"wa_message_id": "m", "chat_id": "c", "body_text": "hi"}],
    }))
    assert out == {"ok": True, "messages": 2}
    assert db.committed is True
    assert db.closed is True
    # Both the new-message pipeline and the chat-status classifier ran, in order.
    assert calls == ["on_new_messages", "classify_chats"]


async def test_ingest_skips_new_message_hook_when_no_messages(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_BRIDGE_SECRET", raising=False)
    db = _FakeDB()
    _patch_db(monkeypatch, db)
    calls = _patch_persist_and_hooks(monkeypatch, messages=0)
    out = await bridge.bridge_ingest(_FakeRequest({"account_id": "acc-1"}))
    assert out == {"ok": True, "messages": 0}
    # Only classify_chats runs on an empty batch (mirrors the webhook).
    assert calls == ["classify_chats"]


# ── paired route ───────────────────────────────────────────────────────────────

async def test_paired_updates_account(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_BRIDGE_SECRET", raising=False)
    db = _FakeDB()
    _patch_db(monkeypatch, db)
    out = await bridge.bridge_paired(_FakeRequest({
        "session": "acc-1", "phone_number": "+919990388",
        "display_name": "Vijay", "jid": "919990388@s.whatsapp.net"}))
    assert out == {"ok": True}
    assert db.committed is True
    sql, params = db.executed[0]
    assert "UPDATE wa_accounts" in sql
    assert params["aid"] == "acc-1"
    assert params["phone"] == "+919990388"
    assert params["jid"] == "919990388@s.whatsapp.net"


async def test_paired_requires_session(monkeypatch) -> None:
    monkeypatch.delenv("WHATSAPP_BRIDGE_SECRET", raising=False)
    resp = await bridge.bridge_paired(_FakeRequest({"phone_number": "+91"}))
    assert resp.status_code == 400


async def test_paired_rejects_bad_secret(monkeypatch) -> None:
    monkeypatch.setenv("WHATSAPP_BRIDGE_SECRET", "s3cr3t")
    resp = await bridge.bridge_paired(
        _FakeRequest({"session": "a"}, headers={"X-Bridge-Secret": "no"}))
    assert resp.status_code == 403


# ── route registration ─────────────────────────────────────────────────────────

def test_bridge_routes_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/bridge/ingest" in paths
    assert "/whatsapp/bridge/paired" in paths
    assert "/whatsapp/bridge/connect" in paths
    assert "/whatsapp/bridge/status" in paths
