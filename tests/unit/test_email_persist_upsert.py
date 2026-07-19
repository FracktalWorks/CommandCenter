"""Unit tests for the shared message-upsert helper (C1 consolidation).

These are DB-free: a fake session records the ``execute(text, params)`` calls so
we can assert the emitted SQL + binds without a live Postgres (the DB-touching
suites are slow/flaky on Windows). They pin the behaviour every ingest path now
shares — conflict mode, unsubscribe-link preservation, body truncation, and
attachment persistence.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from email_ingestion.persist import (
    MAX_BODY_TEXT_BYTES,
    truncate_body,
    upsert_message,
)


@dataclass
class _Addr:
    name: str = "Jane"
    email: str = "jane@example.com"


@dataclass
class _Att:
    filename: str = "f.pdf"
    mime_type: str = "application/pdf"
    size_bytes: int = 10
    provider_attachment_id: str = "att-1"


@dataclass
class _Msg:
    provider_message_id: str = "pm-1"
    thread_id: str | None = "t-1"
    folder: str = "INBOX"
    labels: list = field(default_factory=list)
    from_address: Any = field(default_factory=_Addr)
    to_addresses: list = field(default_factory=list)
    cc_addresses: list = field(default_factory=list)
    bcc_addresses: list = field(default_factory=list)
    subject: str = "hi"
    body_text: str = "body"
    body_html: str | None = None
    snippet: str = "snip"
    has_attachments: bool = False
    attachments: list = field(default_factory=list)
    is_read: bool = False
    is_starred: bool = False
    is_flagged: bool = False
    importance: str = "normal"
    categories: list = field(default_factory=list)
    categories_authoritative: bool = False
    unsubscribe_link: str | None = "https://unsub.example/x"
    received_at: Any = None


class _FakeDB:
    """Records every execute() as (rendered_sql, params) — no real DB."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def execute(self, sql: Any, params: dict | None = None):
        self.calls.append((str(sql), params or {}))
        return None


async def test_update_mode_emits_do_update_and_preserves_unsubscribe():
    db = _FakeDB()
    await upsert_message(db, "acct-1", _Msg())
    sql, params = db.calls[0]
    assert "INSERT INTO email_messages" in sql
    assert "DO UPDATE SET" in sql
    # The link is bound AND preserved (COALESCE) rather than clobbered on re-sync.
    assert "unsubscribe_link = COALESCE(EXCLUDED.unsubscribe_link" in sql
    assert params["unsubscribe_link"] == "https://unsub.example/x"
    assert params["account_id"] == "acct-1"
    assert params["provider_id"] == "pm-1"


async def test_resync_never_clobbers_labels_a_provider_cannot_report():
    """The regression that made the Inbox Cleaner look empty.

    ``email_messages.categories`` is where the RULE ENGINE writes its labels
    (Newsletter / Marketing / Notification / …) and what every category chip,
    quick filter and the cleaner read. A provider that simply doesn't report
    categories — generic IMAP, and Gmail before it resolved user-label IDs to
    names — sends ``{}`` on every tick. The old unconditional
    ``categories = EXCLUDED.categories`` therefore erased the lot on the next
    re-sync, permanently: ``rules_processed_at`` is already stamped, so the
    rules never re-applied them. The replace is now opt-in per provider.
    """
    db = _FakeDB()
    await upsert_message(db, "acct-1", _Msg())
    sql, params = db.calls[0]
    assert "categories = CASE WHEN :categories_authoritative" in sql
    assert "ELSE email_messages.categories END" in sql
    assert params["categories_authoritative"] is False


async def test_a_round_tripping_provider_stays_authoritative():
    """Gmail (with its label map loaded) and Outlook do report the full label
    set, so an empty list genuinely means "the user cleared them" and must
    propagate — otherwise a label removed upstream could never be removed."""
    db = _FakeDB()
    await upsert_message(
        db, "acct-1", _Msg(categories=["Newsletter"], categories_authoritative=True)
    )
    _, params = db.calls[0]
    assert params["categories_authoritative"] is True
    assert params["categories"] == ["Newsletter"]


async def test_nothing_mode_emits_do_nothing_only():
    db = _FakeDB()
    await upsert_message(db, "acct-1", _Msg(), on_conflict="nothing")
    sql, _ = db.calls[0]
    assert "DO NOTHING" in sql
    assert "DO UPDATE" not in sql


async def test_attachments_are_persisted_after_the_message():
    db = _FakeDB()
    await upsert_message(
        db, "acct-1", _Msg(has_attachments=True, attachments=[_Att()])
    )
    assert len(db.calls) == 2  # message, then attachment
    att_sql, att_params = db.calls[1]
    assert "INSERT INTO email_attachments" in att_sql
    assert att_params["provider_attachment_id"] == "att-1"
    assert att_params["provider_id"] == "pm-1"


async def test_body_is_truncated_for_every_ingest_path():
    big = "x" * (MAX_BODY_TEXT_BYTES + 5000)
    db = _FakeDB()
    await upsert_message(db, "acct-1", _Msg(body_text=big))
    _, params = db.calls[0]
    assert params["body_text"].endswith(" ... [truncated]")
    assert len(params["body_text"].encode("utf-8")) <= MAX_BODY_TEXT_BYTES


def test_truncate_body_passthrough_and_cap():
    assert truncate_body(None, 100) is None
    assert truncate_body("", 100) == ""
    assert truncate_body("short", 100) == "short"
    out = truncate_body("y" * 500, 100)
    assert out.endswith(" ... [truncated]")
    assert len(out.encode("utf-8")) <= 100
