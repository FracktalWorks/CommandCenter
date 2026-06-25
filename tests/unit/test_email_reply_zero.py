"""Unit tests for Reply Zero — now a PROJECTION of the rules pipeline.

Reply Zero no longer runs a parallel needs-reply classifier. Instead:
  * the deterministic pre-filter (``_is_reply_candidate`` / ``_gate_conversation_rules``)
    keeps no-reply / mass / broadcast mail out of the conversation-status rules;
  * the rule engine's match is projected to a stored status
    (``project_reply_status_from_matches``);
  * ``_maybe_classify_threads`` is a best-effort BACKFILL that reuses the engine.
DB + engine mocked.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes import email as m

_eng = m.automation.engine
_rz = m.automation.replyzero


def _result(*, fetchone=None, fetchall=None):
    res = MagicMock()
    res.fetchone.return_value = fetchone
    res.fetchall.return_value = fetchall if fetchall is not None else []
    return res


def test_settings_has_follow_up_days_default_off() -> None:
    s = m.AssistantSettingsModel(account_id="acc-1")
    assert s.follow_up_days == 0


# ── Deterministic reply-candidate gate ───────────────────────────────────────

async def test_gate_blocks_no_reply_sender_without_db() -> None:
    db = AsyncMock()
    allowed, why = await _eng._is_reply_candidate(
        db, "acc-1", {"from": "noreply@shop.com"})
    assert allowed is False
    assert why == "no_reply_sender"
    db.execute.assert_not_called()  # short-circuits before any DB hit


async def test_gate_blocks_broadcast_sender_never_replied() -> None:
    db = AsyncMock()
    db.execute.side_effect = [
        _result(fetchone=None),                  # no List-Unsubscribe
        _result(fetchone=SimpleNamespace(c=10)),  # 10 received
        _result(fetchone=None),                  # never replied
    ]
    allowed, why = await _eng._is_reply_candidate(
        db, "acc-1", {"from": "team@company.com"})
    assert allowed is False
    assert why == "reply_history_threshold"


async def test_gate_allows_sender_the_user_has_replied_to() -> None:
    db = AsyncMock()
    db.execute.side_effect = [
        _result(fetchone=None),                  # no List-Unsubscribe
        _result(fetchone=SimpleNamespace(c=10)),  # 10 received
        _result(fetchone=SimpleNamespace(x=1)),   # has replied before
    ]
    allowed, _why = await _eng._is_reply_candidate(
        db, "acc-1", {"from": "colleague@company.com"})
    assert allowed is True


async def test_gate_allows_low_volume_sender() -> None:
    db = AsyncMock()
    db.execute.side_effect = [
        _result(fetchone=None),                 # no List-Unsubscribe
        _result(fetchone=SimpleNamespace(c=2)),  # only 2 received → replied query skipped
    ]
    allowed, _why = await _eng._is_reply_candidate(
        db, "acc-1", {"from": "person@company.com"})
    assert allowed is True


def test_gate_drops_only_conversation_rules_when_blocked() -> None:
    rules = [
        {"id": "1", "name": "To Reply", "system_type": None},
        {"id": "2", "name": "Awaiting Reply", "system_type": None},
        {"id": "3", "name": "Newsletter", "system_type": None},
        {"id": "4", "name": "Custom rule", "system_type": None},
    ]
    kept = {r["name"] for r in _eng._gate_conversation_rules(rules, allowed=False)}
    assert "To Reply" not in kept and "Awaiting Reply" not in kept
    assert "Newsletter" in kept and "Custom rule" in kept
    # allowed → untouched
    assert _eng._gate_conversation_rules(rules, allowed=True) == rules


# ── Projecting a rule match to a stored Reply Zero status ─────────────────────

async def test_project_status_maps_rule_to_status_with_priority() -> None:
    recorded: list[tuple[str, str]] = []
    db = AsyncMock()
    row = SimpleNamespace(thread_id="t1", id="m1", received_at=None)

    def rec(_db, _aid, tid, status, *_a):
        recorded.append((tid, status))

    with patch.object(_rz, "_upsert_thread_status", AsyncMock(side_effect=rec)):
        # To Reply rule → NEEDS_REPLY
        await _rz.project_reply_status_from_matches(
            db, "acc-1", row, [{"rule": {"name": "To Reply"}, "reason": "asks"}])
        # No conversation rule (Newsletter) → FYI (kept out of To Reply)
        await _rz.project_reply_status_from_matches(
            db, "acc-1", row, [{"rule": {"name": "Newsletter"}}])
        # No match at all → FYI
        await _rz.project_reply_status_from_matches(db, "acc-1", row, [])
        # TO_REPLY beats AWAITING_REPLY/FYI when several match
        await _rz.project_reply_status_from_matches(
            db, "acc-1", row,
            [{"rule": {"name": "FYI"}}, {"rule": {"name": "To Reply"}}])

    assert recorded == [
        ("t1", "NEEDS_REPLY"), ("t1", "FYI"), ("t1", "FYI"), ("t1", "NEEDS_REPLY")]


async def test_project_status_respects_system_type_over_name() -> None:
    recorded: list[tuple[str, str]] = []
    db = AsyncMock()
    row = SimpleNamespace(thread_id="t9", id="m9", received_at=None)

    def rec(_d, _a, tid, st, *_rest):
        recorded.append((tid, st))

    with patch.object(_rz, "_upsert_thread_status", AsyncMock(side_effect=rec)):
        await _rz.project_reply_status_from_matches(
            db, "acc-1", row,
            [{"rule": {"name": "Renamed rule", "system_type": "AWAITING_REPLY"}}])
    assert recorded == [("t9", "AWAITING")]


# ── Backfill (reuses the engine, no parallel classifier) ─────────────────────

def _backfill_db(latest, existing):
    db = AsyncMock()
    db.execute.side_effect = [
        _result(fetchall=latest),
        _result(fetchall=existing),
        _result(fetchone=SimpleNamespace(email_address="me@x.com")),
    ]
    return db


def _row(thread_id, mid, frm, folder, body=""):
    return SimpleNamespace(
        thread_id=thread_id, id=mid, subject="Subject",
        from_address={"email": frm}, to_addresses=[], cc_addresses=[],
        body_text=body, snippet="", folder=folder, received_at=None)


async def test_backfill_awaiting_for_sent_and_engine_for_inbound() -> None:
    latest = [
        _row("t1", "m1", "me@x.com", "sent"),
        _row("t2", "m2", "a@b.com", "inbox", body="Can you help?"),
    ]
    db = _backfill_db(latest, [])
    recorded: list[tuple[str, str]] = []

    def rec(_db, _aid, tid, status, *_a):
        recorded.append((tid, status))

    to_reply_match = {"rule": {"name": "To Reply", "system_type": None},
                      "reason": "asks a question", "source": "ai"}
    with patch.object(_rz, "_get_db", AsyncMock(return_value=db)), \
            patch.object(_rz, "_load_assistant_about",
                         AsyncMock(return_value=("", ""))), \
            patch.object(_rz, "_upsert_thread_status",
                         AsyncMock(side_effect=rec)), \
            patch.object(_eng, "_match_email_to_rule",
                         AsyncMock(return_value=to_reply_match)):
        await m._maybe_classify_threads("acc-1")

    statuses = dict(recorded)
    assert statuses["t1"] == "AWAITING"      # sent-last → awaiting (no LLM)
    assert statuses["t2"] == "NEEDS_REPLY"   # inbound matched the To Reply rule


async def test_backfill_marks_fyi_when_no_conversation_rule_matches() -> None:
    latest = [_row("t3", "m3", "noreply@shop.com", "inbox", body="Thanks!")]
    db = _backfill_db(latest, [])
    recorded: list[tuple[str, str]] = []

    def rec(_db, _aid, tid, status, *_a):
        recorded.append((tid, status))

    with patch.object(_rz, "_get_db", AsyncMock(return_value=db)), \
            patch.object(_rz, "_load_assistant_about",
                         AsyncMock(return_value=("", ""))), \
            patch.object(_rz, "_upsert_thread_status",
                         AsyncMock(side_effect=rec)), \
            patch.object(_eng, "_match_email_to_rule",
                         AsyncMock(return_value=None)):  # nothing matched → FYI
        await m._maybe_classify_threads("acc-1")
    assert dict(recorded)["t3"] == "FYI"


async def test_backfill_skips_unchanged_threads() -> None:
    latest = [_row("t4", "m4", "a@b.com", "inbox")]
    existing = [SimpleNamespace(thread_id="t4", last_message_id="m4")]
    db = _backfill_db(latest, existing)
    match = AsyncMock()
    with patch.object(_rz, "_get_db", AsyncMock(return_value=db)), \
            patch.object(_rz, "_load_assistant_about",
                         AsyncMock(return_value=("", ""))), \
            patch.object(_rz, "_upsert_thread_status", AsyncMock()), \
            patch.object(_eng, "_match_email_to_rule", match):
        await m._maybe_classify_threads("acc-1")
    match.assert_not_awaited()  # latest message unchanged → no engine cost
