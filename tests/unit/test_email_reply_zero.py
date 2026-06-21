"""Unit tests for Reply Zero — the thread reply-status classifier and the
follow-up setting. DB + LLM mocked.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes import email as m


def test_settings_has_follow_up_days_default_off() -> None:
    s = m.AssistantSettingsModel(account_id="acc-1")
    assert s.follow_up_days == 0


async def test_classify_threads_awaiting_for_sent_and_ai_for_inbound() -> None:
    latest = [
        SimpleNamespace(
            thread_id="t1", id="m1", subject="Re: Quote",
            from_address={"email": "me@x.com"}, body_text="", snippet="",
            folder="sent", received_at=None),
        SimpleNamespace(
            thread_id="t2", id="m2", subject="Quick question",
            from_address={"email": "a@b.com"}, body_text="Can you help?",
            snippet="", folder="inbox", received_at=None),
    ]
    latest_res = MagicMock()
    latest_res.fetchall.return_value = latest
    existing_res = MagicMock()
    existing_res.fetchall.return_value = []  # nothing classified yet

    db = AsyncMock()
    db.execute.side_effect = [latest_res, existing_res]

    recorded: list[tuple[str, str]] = []

    def rec(_db, _aid, tid, status, *_a):
        recorded.append((tid, status))

    with patch.object(m, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m, "_upsert_thread_status",
                         AsyncMock(side_effect=rec)), \
            patch.object(m, "_llm_needs_reply",
                         AsyncMock(return_value={0: {"needs": True,
                                                     "reason": "asks a question"}})):
        await m._maybe_classify_threads("acc-1")

    statuses = dict(recorded)
    assert statuses["t1"] == "AWAITING"      # sent-last → awaiting
    assert statuses["t2"] == "NEEDS_REPLY"   # inbound, AI says needs reply


async def test_classify_threads_marks_fyi_when_no_reply_needed() -> None:
    latest = [SimpleNamespace(
        thread_id="t3", id="m3", subject="Your receipt",
        from_address={"email": "noreply@shop.com"}, body_text="Thanks!",
        snippet="", folder="inbox", received_at=None)]
    latest_res = MagicMock()
    latest_res.fetchall.return_value = latest
    existing_res = MagicMock()
    existing_res.fetchall.return_value = []
    db = AsyncMock()
    db.execute.side_effect = [latest_res, existing_res]
    recorded: list[tuple[str, str]] = []

    with patch.object(m, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m, "_upsert_thread_status",
                         AsyncMock(side_effect=lambda *a: recorded.append(
                             (a[2], a[3])))), \
            patch.object(m, "_llm_needs_reply",
                         AsyncMock(return_value={0: {"needs": False,
                                                     "reason": "receipt"}})):
        await m._maybe_classify_threads("acc-1")

    assert dict(recorded)["t3"] == "FYI"


async def test_classify_skips_unchanged_threads() -> None:
    latest = [SimpleNamespace(
        thread_id="t4", id="m4", subject="x", from_address={"email": "a@b.com"},
        body_text="", snippet="", folder="inbox", received_at=None)]
    latest_res = MagicMock()
    latest_res.fetchall.return_value = latest
    existing_res = MagicMock()
    # already classified with the SAME last message id → skip
    existing_res.fetchall.return_value = [
        SimpleNamespace(thread_id="t4", last_message_id="m4")
    ]
    db = AsyncMock()
    db.execute.side_effect = [latest_res, existing_res]
    llm = AsyncMock()
    with patch.object(m, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m, "_upsert_thread_status", AsyncMock()), \
            patch.object(m, "_llm_needs_reply", llm):
        await m._maybe_classify_threads("acc-1")
    llm.assert_not_awaited()  # nothing changed → no LLM cost
