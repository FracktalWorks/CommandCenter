"""What may become a learned pattern.

Auto-learning is the only path that writes a pattern with no human in the loop,
and a pattern short-circuits the classifier and drives the Email Cleaner. The
gate claimed "at least 3 consistent matches, and no other rule ever matched this
sender". Audited against the live account's 45 patterns, it enforced neither.

Everything below is a defect found in that audit, with the live evidence:

* **Dry runs taught.** The filter excluded SKIPPED/REJECTED but not PENDING —
  which is exactly what a *preview* writes. ``arvind@exinous.com`` → Calendar was
  learned from 7 log rows covering ONE message, five of them previews. A dry run
  is documented as changing nothing.

* **It counted log rows, not messages.** ``COUNT(*)`` over a table that gets a
  row per rule per run. ``donotreply@gst.gov.in``: 10 rows, 1 message.
  ``ar.zstoreind@zohocorp.com``: 9 rows, 1 message. Re-running a backfill over
  the same mail manufactured its own evidence.

* **The "no other rule" invariant was unenforceable.** ``multi_rule_execution``
  is ON, so one message legitimately matches several rules, and the apply loop
  calls this once per match — the first rule's check reads a log that does not
  yet contain its siblings. ``Info@yourstory.com`` was pinned to Marketing though
  every one of its messages matches Marketing + Newsletter or Marketing + Cold
  Email; the pattern then narrows the classifier to the single pinned rule.

* **People were pinned to cleanup categories.** ``midhun.vm@…`` → Calendar while
  carrying Awaiting Reply and Done; ``debesh@metafora.sg`` → Receipt while
  carrying Awaiting Reply. Both send documents *and* ask questions.
"""
from __future__ import annotations

import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes.email.automation import runner as m

_ACC = "acc-learn"
_RULE = "rule-newsletter"


def _db_counting(rows: list[tuple[str, int]]) -> AsyncMock:
    db = AsyncMock()
    db.execute.return_value = MagicMock(fetchall=MagicMock(return_value=[
        SimpleNamespace(rule_id=rid, n=n) for rid, n in rows]))
    return db


async def _gate_sql() -> str:
    db = _db_counting([])
    await m._sender_consistent_for_rule(db, _ACC, "a@b.com", _RULE)
    return str(db.execute.call_args[0][0])


# ── what counts as evidence ─────────────────────────────────────────────────


async def test_a_dry_run_never_teaches() -> None:
    """PENDING is what a preview logs. "Test this rule" must not durably change
    how the mailbox is classified — that is the entire contract of a dry run."""
    sql = await _gate_sql()
    assert "status = 'APPLIED'" in sql, (
        "the gate must require APPLIED specifically; 'NOT IN (SKIPPED, "
        "REJECTED)' let PENDING previews count as evidence"
    )


async def test_the_same_message_cannot_vote_twice() -> None:
    """One message produces a row per rule per run, so COUNT(*) let a single
    email clear a bar that reads "3 consistent matches"."""
    sql = await _gate_sql()
    assert "COUNT(DISTINCT message_id)" in sql


async def test_rows_with_no_message_are_not_evidence() -> None:
    """616 APPLIED rows on the live account carry a NULL message_id. Nothing
    can corroborate them, and NULL would collapse to one DISTINCT bucket."""
    sql = await _gate_sql()
    assert "message_id IS NOT NULL" in sql


async def test_five_distinct_messages_still_learn() -> None:
    """The tightening must not turn auto-learning off — it should keep firing
    on genuine repeat evidence (the current match is the +1).

    Raised from three to five. Three is a short enough streak that a
    classifier confidently wrong about one sender reaches it easily, and the
    count was the ONLY bar until the AI verdict was added beside it."""
    db = _db_counting([(_RULE, 4)])
    assert await m._sender_consistent_for_rule(db, _ACC, "a@b.com", _RULE)


async def test_four_distinct_messages_do_not() -> None:
    db = _db_counting([(_RULE, 3)])
    assert not await m._sender_consistent_for_rule(db, _ACC, "a@b.com", _RULE)


async def test_another_rule_in_the_history_still_blocks() -> None:
    db = _db_counting([(_RULE, 9), ("rule-marketing", 1)])
    assert not await m._sender_consistent_for_rule(db, _ACC, "a@b.com", _RULE)


# ── ambiguity ───────────────────────────────────────────────────────────────


def test_an_ambiguous_message_teaches_nothing() -> None:
    """The multi-rule fix. Pinning a sender to one rule only means something if
    the classification was unambiguous — and the apply loop cannot see its own
    siblings' log rows, so the "no other rule" check can't catch this itself."""
    src = inspect.getsource(m._apply_and_log_match)
    assert "sole_match and match.get(\"source\") == \"ai\"" in src


def test_every_caller_reports_whether_the_match_was_sole() -> None:
    """A default of True is right for a single-match caller but wrong for a
    multi-rule loop, so the loop must pass it explicitly. The three apply loops
    are now the ONE shared ``_apply_matches`` (2.2) — the single place that runs
    matches — so the guard is enforced there, once."""
    src = inspect.getsource(m._apply_matches)
    assert "sole_match=len(matches) == 1" in src, (
        "the shared apply loop stopped passing sole_match — that silently "
        "re-enables learning from ambiguous multi-rule classifications"
    )
    # And no OTHER function re-introduces a hand-rolled apply loop that could
    # forget the guard: _apply_and_log_match is called from exactly one place.
    assert inspect.getsource(m).count("await _apply_and_log_match(") == 1


# ── people are not senders of a category ────────────────────────────────────


async def test_a_sender_you_converse_with_is_never_pinned() -> None:
    """Reply / Awaiting Reply / Done / FYI are assigned per-THREAD from the whole
    conversation, so their presence proves a real exchange with this address.
    Pin such a person to Receipt and their next question is filed as a receipt."""
    db = AsyncMock()
    db.execute.return_value = MagicMock(
        fetchone=MagicMock(return_value=SimpleNamespace()))
    assert await m._sender_is_a_correspondent(db, _ACC, "a@b.com")
    sql = str(db.execute.call_args[0][0])
    assert "Awaiting Reply" in sql and "Done" in sql and "FYI" in sql


async def test_a_machine_sender_is_still_pinnable() -> None:
    """The guard must not block the case auto-learning exists for: a noreply
    address with no conversation history."""
    db = AsyncMock()
    db.execute.return_value = MagicMock(
        fetchone=MagicMock(return_value=None))
    assert not await m._sender_is_a_correspondent(db, _ACC, "noreply@x.com")


async def test_an_unreadable_history_refuses_to_pin() -> None:
    """Fail CLOSED. Not knowing whether someone is a correspondent is not the
    same as knowing they aren't, and the cost of the two mistakes differs."""
    db = AsyncMock()
    db.execute.side_effect = RuntimeError("boom")
    assert await m._sender_is_a_correspondent(db, _ACC, "a@b.com")


def test_the_correspondent_check_runs_before_the_pattern_is_written() -> None:
    src = inspect.getsource(m._apply_and_log_match)
    assert src.index("_sender_is_a_correspondent") < src.index(
        "_upsert_rule_pattern")


# ── what may be auto-learned at all ─────────────────────────────────────────


def test_only_bulk_categories_are_auto_learnable() -> None:
    """A FROM pattern asserts something about the SENDER'S IDENTITY — that this
    address only ever sends one kind of thing. True of a newsletter list, a
    marketing blast, a cold-outreach account: the mail is defined by who sent it.

    Not true of Receipt, Calendar or Notification, which describe what a message
    IS and routinely arrive from people you also converse with. A colleague
    sends an invite on Monday and a question on Tuesday; pinned to Calendar, the
    question is filed as a calendar item. Two of the patterns purged from the
    live account were exactly that.
    """
    for name in ("Newsletter", "Marketing", "Cold Email", "cold email"):
        assert m._is_auto_learnable_rule({"name": name}), name
    for name in ("Receipt", "Calendar", "Notification", "Reply", "FYI"):
        assert not m._is_auto_learnable_rule({"name": name}), name


def test_the_scope_check_runs_in_the_learn_gate() -> None:
    src = inspect.getsource(m._apply_and_log_match)
    assert "_is_auto_learnable_rule(rule)" in src


# ── the second opinion ──────────────────────────────────────────────────────


async def test_a_streak_alone_no_longer_creates_a_pattern() -> None:
    """Counting agreements measures CONSISTENCY, not correctness — a classifier
    confidently wrong about one sender is wrong the same way five times, and the
    streak was the entire bar. Upstream's threshold is only a floor before
    asking this; ours had no such step."""
    src = inspect.getsource(m._apply_and_log_match)
    assert "_ai_confirms_sender_pattern" in src
    assert src.index("_sender_consistent_for_rule") < src.index(
        "_ai_confirms_sender_pattern"), (
        "the cheap local checks must gate the one that costs a model call"
    )


async def test_the_verdict_needs_an_explicit_yes() -> None:
    db = AsyncMock()
    db.execute.return_value = MagicMock(fetchall=MagicMock(return_value=[
        SimpleNamespace(subject=f"s{i}", snippet="x") for i in range(6)]))
    rule = {"name": "Newsletter", "instructions": "newsletters"}
    with patch.object(m, "_llm_json",
                      AsyncMock(return_value=({"always": True}, "", ""))):
        assert await m._ai_confirms_sender_pattern(db, _ACC, "n@x.com", rule)
    with patch.object(m, "_llm_json",
                      AsyncMock(return_value=({"always": False}, "", ""))):
        assert not await m._ai_confirms_sender_pattern(db, _ACC, "n@x.com", rule)


async def test_an_unusable_verdict_teaches_nothing() -> None:
    """Fails CLOSED at every step. Not learning costs nothing; a wrong pin is
    silent, permanent and short-circuits the classifier that would have caught
    it."""
    db = AsyncMock()
    db.execute.return_value = MagicMock(fetchall=MagicMock(return_value=[
        SimpleNamespace(subject=f"s{i}", snippet="x") for i in range(6)]))
    rule = {"name": "Newsletter"}
    for bad in (({}, "", ""), ({"always": "yes"}, "", ""), (None, "", "")):
        with patch.object(m, "_llm_json", AsyncMock(return_value=bad)):
            assert not await m._ai_confirms_sender_pattern(
                db, _ACC, "n@x.com", rule)
    with patch.object(m, "_llm_json", AsyncMock(side_effect=RuntimeError("no"))):
        assert not await m._ai_confirms_sender_pattern(db, _ACC, "n@x.com", rule)


async def test_too_few_samples_is_not_asked_about() -> None:
    """Nothing to generalise from, and a model asked to judge two emails will
    happily say yes."""
    db = AsyncMock()
    db.execute.return_value = MagicMock(fetchall=MagicMock(return_value=[
        SimpleNamespace(subject="s", snippet="x")]))
    with patch.object(m, "_llm_json", AsyncMock()) as llm:
        assert not await m._ai_confirms_sender_pattern(
            db, _ACC, "n@x.com", {"name": "Newsletter"})
        llm.assert_not_called()
