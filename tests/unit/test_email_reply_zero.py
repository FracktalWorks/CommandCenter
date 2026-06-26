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


async def test_reconcile_thread_labels_enforces_single_status() -> None:
    rows = [
        SimpleNamespace(id="m1", provider_message_id="p1", folder="inbox",
                        categories=["To Reply", "Follow-up"]),
        SimpleNamespace(id="m2", provider_message_id="p2", folder="inbox",
                        categories=["Awaiting Reply"]),
        SimpleNamespace(id="m3", provider_message_id="p3", folder="sent",
                        categories=[]),
    ]
    db = AsyncMock()
    db.execute.return_value = _result(fetchall=rows)
    calls: list[tuple[str, tuple, tuple]] = []

    async def set_labels(pmid, add=None, remove=None):
        calls.append((pmid, tuple(add or []), tuple(remove or [])))

    provider = AsyncMock()
    provider.set_labels.side_effect = set_labels

    await _rz._reconcile_thread_labels(db, provider, "acc", "t1", "Actioned")

    removed = {pmid: rem for pmid, _add, rem in calls if rem}
    added = {pmid: add for pmid, add, _rem in calls if add}
    # Every OTHER conversation label + Follow-up cleared (keep != Awaiting Reply).
    assert "To Reply" in removed["p1"] and "Follow-up" in removed["p1"]
    assert "Awaiting Reply" in removed["p2"]
    # The new status label lands on the latest inbound message (m2).
    assert added["p2"] == ("Actioned",)
    # Sent message untouched.
    assert "p3" not in removed and "p3" not in added


async def test_reconcile_thread_labels_keeps_follow_up_while_awaiting() -> None:
    rows = [
        SimpleNamespace(id="m1", provider_message_id="p1", folder="inbox",
                        categories=["To Reply", "Follow-up"]),
    ]
    db = AsyncMock()
    db.execute.return_value = _result(fetchall=rows)
    calls: list[tuple[str, tuple, tuple]] = []

    async def set_labels(pmid, add=None, remove=None):
        calls.append((pmid, tuple(add or []), tuple(remove or [])))

    provider = AsyncMock()
    provider.set_labels.side_effect = set_labels

    await _rz._reconcile_thread_labels(
        db, provider, "acc", "t1", "Awaiting Reply")

    removed = {pmid: rem for pmid, _add, rem in calls if rem}
    # "To Reply" cleared, but "Follow-up" KEPT because the thread is awaiting.
    assert "To Reply" in removed["p1"]
    assert "Follow-up" not in removed.get("p1", ())


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


# ── Full-thread conversation-status determination (inbox-zero parity) ────────

async def test_resolve_passthrough_for_non_conversation() -> None:
    db = AsyncMock()
    row = SimpleNamespace(thread_id="t1")
    matches = [{"rule": {"name": "Newsletter"}, "reason": "x"}]
    out = await _rz.resolve_conversation_status_matches(db, "acc", row, matches)
    assert out == matches
    db.execute.assert_not_called()  # no thread fetch / LLM for non-conversation


async def test_resolve_uses_full_thread_status_over_per_message_pick() -> None:
    db = AsyncMock()
    db.execute.side_effect = [
        _result(fetchall=[SimpleNamespace(
            from_address={"email": "a@b.com"}, subject="s", body_text="thanks",
            snippet="", folder="inbox")]),                 # thread messages
        _result(fetchone=SimpleNamespace(email_address="me@x.com")),  # acc email
    ]
    row = SimpleNamespace(thread_id="t1")
    actioned = {"id": "r1", "name": "Actioned", "system_type": None,
                "enabled": True}
    # Per-message pick said To Reply; full-thread says the thread is concluded.
    matches = [{"rule": {"name": "To Reply"}, "reason": "picked"}]
    with patch.object(_rz, "_load_assistant_about",
                      AsyncMock(return_value=("", ""))), \
            patch.object(_rz, "_llm_determine_thread_status",
                         AsyncMock(return_value="ACTIONED")), \
            patch.object(_rz, "_conversation_rule_for_status",
                         AsyncMock(return_value=actioned)):
        out = await _rz.resolve_conversation_status_matches(
            db, "acc", row, matches)
    assert len(out) == 1
    assert out[0]["rule"]["name"] == "Actioned"
    assert out[0]["source"] == "thread_status"


async def test_resolve_keeps_original_when_no_rule_for_status() -> None:
    db = AsyncMock()
    db.execute.side_effect = [
        _result(fetchall=[SimpleNamespace(
            from_address={"email": "a@b.com"}, subject="s", body_text="b",
            snippet="", folder="inbox")]),
        _result(fetchone=SimpleNamespace(email_address="me@x.com")),
    ]
    row = SimpleNamespace(thread_id="t1")
    matches = [{"rule": {"name": "To Reply"}, "reason": "picked"}]
    with patch.object(_rz, "_load_assistant_about",
                      AsyncMock(return_value=("", ""))), \
            patch.object(_rz, "_llm_determine_thread_status",
                         AsyncMock(return_value="ACTIONED")), \
            patch.object(_rz, "_conversation_rule_for_status",
                         AsyncMock(return_value=None)):  # no enabled Actioned rule
        out = await _rz.resolve_conversation_status_matches(
            db, "acc", row, matches)
    assert out == matches  # degrade to the per-message pick


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


async def test_backfill_handles_outbound_reply_and_engine_for_inbound() -> None:
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
    mark = AsyncMock()
    with patch.object(_rz, "_get_db", AsyncMock(return_value=db)), \
            patch.object(_rz, "_load_assistant_about",
                         AsyncMock(return_value=("", ""))), \
            patch.object(_rz, "_mark_thread_replied", mark), \
            patch.object(_rz, "resolve_conversation_status_matches",
                         AsyncMock(side_effect=lambda _d, _a, _r, ms: ms)), \
            patch.object(_rz, "_upsert_thread_status",
                         AsyncMock(side_effect=rec)), \
            patch.object(_eng, "_match_email_to_rule",
                         AsyncMock(return_value=to_reply_match)):
        await m._maybe_classify_threads("acc-1")

    # Sent-last thread → outbound-reply handling (AI status + label swap), the
    # SAME path as a CC reply — this is what gives native-client replies parity.
    mark.assert_awaited_once_with("acc-1", "t1")
    # Inbound thread → engine match → NEEDS_REPLY.
    assert dict(recorded)["t2"] == "NEEDS_REPLY"


async def test_backfill_caps_outbound_reply_determination() -> None:
    n = _rz._REPLY_DETERMINE_CAP + 2
    latest = [_row(f"t{i}", f"m{i}", "me@x.com", "sent") for i in range(n)]
    db = _backfill_db(latest, [])
    overflow: list[tuple[str, str]] = []
    mark = AsyncMock()
    with patch.object(_rz, "_get_db", AsyncMock(return_value=db)), \
            patch.object(_rz, "_load_assistant_about",
                         AsyncMock(return_value=("", ""))), \
            patch.object(_rz, "_mark_thread_replied", mark), \
            patch.object(_rz, "_upsert_thread_status",
                         AsyncMock(side_effect=lambda _d, _a, tid, st, *x:
                                   overflow.append((tid, st)))), \
            patch.object(_eng, "_match_email_to_rule", AsyncMock(return_value=None)):
        await m._maybe_classify_threads("acc-1")

    # Newest _REPLY_DETERMINE_CAP sent threads get full AI handling; the rest
    # fall back to a cheap AWAITING so they're still classified.
    assert mark.await_count == _rz._REPLY_DETERMINE_CAP
    assert len(overflow) == 2
    assert all(st == "AWAITING" for _tid, st in overflow)


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
