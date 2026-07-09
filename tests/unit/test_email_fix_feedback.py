"""Unit tests for the Fix-classification feedback routing.

Conversation-status rules (Reply / Awaiting / FYI / Done) are re-derived
from the full thread, so a learned sender/subject pattern is overridden — fixing
to one must SET THE THREAD STATUS directly, not pin the sender. Cleanup-category
rules (Newsletter/Receipt/…) are sender-stable → learn FROM/SUBJECT patterns.
DB + cross-module helpers mocked.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes import email as m

_rules = m.automation.rules
_rz = m.automation.replyzero


def _rule(rid, name):
    return {"id": rid, "name": name, "system_type": None, "enabled": True,
            "actions": []}


async def _run_feedback(req, *, rules, status_result=None):
    """Drive rule_feedback with mocked DB + helpers. Returns
    (response, upserts, status_calls)."""
    db = AsyncMock()
    # Every db.execute returns a row carrying a thread_id (for the message→thread
    # derivation); pattern upserts / status correction are mocked out separately.
    res = MagicMock()
    res.fetchone.return_value = SimpleNamespace(thread_id="t1")
    db.execute.return_value = res

    upserts: list[tuple] = []
    status_calls: list[tuple] = []

    async def fake_upsert(_db, aid, rid, val, exclude, *a, **k):
        upserts.append((rid, val, exclude))

    async def fake_status(aid, tid, key):
        status_calls.append((aid, tid, key))
        return status_result or {"ok": True, "status": "NEEDS_REPLY",
                                 "label": "Reply"}

    user = SimpleNamespace(email="u@example.com")
    with patch.object(_rules, "_get_db", AsyncMock(return_value=db)), \
            patch.object(_rules, "_assert_account_owner", AsyncMock()), \
            patch.object(_rules, "_load_rules", AsyncMock(return_value=rules)), \
            patch.object(_rules, "_upsert_rule_pattern",
                         AsyncMock(side_effect=fake_upsert)), \
            patch.object(_rz, "apply_thread_status_correction",
                         AsyncMock(side_effect=fake_status)):
        resp = await m.rule_feedback(req, user=user)
    return resp, upserts, status_calls


async def test_fix_to_conversation_rule_sets_status_not_pattern() -> None:
    rules = [_rule("r-toreply", "Reply"), _rule("r-news", "Newsletter")]
    req = m.RuleFeedbackRequest(
        account_id="acc-1", sender="jo@x.com", expected="r-toreply",
        matched_rule_ids=["r-news"], message_id="m1")
    resp, upserts, status_calls = await _run_feedback(req, rules=rules)

    # The conversation correction set the thread status directly…
    assert status_calls == [("acc-1", "t1", "REPLY")]
    # …and did NOT pin the sender to the conversation rule.
    assert not any(rid == "r-toreply" for rid, _v, _e in upserts)
    # The wrongly-matched CLEANUP rule (Newsletter) is excluded for the sender.
    assert ("r-news", "jo@x.com", True) in upserts
    assert resp["created"] is True
    assert resp["status_correction"]["ok"] is True


async def test_fix_to_cleanup_rule_learns_from_pattern() -> None:
    rules = [_rule("r-news", "Newsletter"), _rule("r-receipt", "Receipt")]
    req = m.RuleFeedbackRequest(
        account_id="acc-1", sender="news@brand.com", expected="r-news",
        matched_rule_ids=["r-receipt"], message_id="m1")
    resp, upserts, status_calls = await _run_feedback(req, rules=rules)

    # Cleanup rule → learn a FROM include pattern (no thread-status correction).
    assert status_calls == []
    assert ("r-news", "news@brand.com", False) in upserts
    assert ("r-receipt", "news@brand.com", True) in upserts
    assert resp["status_correction"] is None
    assert resp["created"] is True


async def test_apply_status_correction_rejects_unknown_key() -> None:
    res = await _rz.apply_thread_status_correction("acc-1", "t1", "BOGUS")
    assert res == {"ok": False}
