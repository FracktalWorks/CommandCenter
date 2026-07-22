"""Learned patterns must be confirmed before the cleaner projects them.

A learned pattern short-circuits the classifier entirely and is the FIRST and
strongest evidence the Email Cleaner projects across the mailbox — with archive,
unsubscribe and delete offered on top of the result. One wrong FROM pattern
therefore mislabels every message from that sender, for free, forever.

Measured on the live account before this landed: 45 patterns, every single one
``source='AI'``. None from Fix, none from a label changed in the mail client,
none typed by hand. Every pattern in the system was the machine generalising
from its own output — ``_sender_consistent_for_rule`` requires three matches to
one rule, which measures consistency, not correctness — and the review screen
showed a sender, a rule and a delete button, so "is this right?" could not be
answered from what was on the page.

    "The learning patterns should drive cleanup, but first they must be
     populated by categorizing most emails and obtaining user approval to
     confirm their accuracy before proceeding with inbox cleaning." — 2026-07-20
"""
from __future__ import annotations

import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes.email.automation import cleanup as c
from gateway.routes.email.automation import engine as e
from gateway.routes.email.automation import rules as r

_ACC = "acc-approve"
_USER = SimpleNamespace(email="u@example.com")


def _db_rows(rows: list) -> AsyncMock:
    db = AsyncMock()
    db.execute.return_value = MagicMock(fetchall=MagicMock(return_value=rows))
    return db


async def _loaded_sql(**kw) -> str:
    db = _db_rows([])
    await e._load_rule_patterns(db, _ACC, **kw)
    return str(db.execute.call_args[0][0])


# ── what each caller is allowed to see ──────────────────────────────────────


async def test_a_rejected_pattern_is_dead_to_everyone() -> None:
    """Rejection is the one verdict with no exceptions: the user has said the
    pattern is wrong, so neither the classifier nor the cleaner may use it."""
    assert "rejected_at IS NULL" in await _loaded_sql()
    assert "rejected_at IS NULL" in await _loaded_sql(approved_includes_only=True)


async def test_the_classifier_still_uses_unreviewed_patterns() -> None:
    """Its alternative is an LLM call, so an unreviewed pattern there SAVES
    money and any mistake is one message the user can Fix. Gating it would raise
    the AI bill to buy safety the cleaner needs and the classifier doesn't."""
    assert "approved_at" not in await _loaded_sql()


async def test_the_cleaner_only_projects_approved_includes() -> None:
    """The cleaner's alternative is leaving mail uncategorized, and it applies
    one pattern to every matching message in the mailbox."""
    sql = await _loaded_sql(approved_includes_only=True)
    assert "approved_at IS NOT NULL" in sql


async def test_excludes_are_never_gated() -> None:
    """An include ASSERTS a category; an exclude only PREVENTS one. There is
    nothing to approve about "this sender is not Marketing" — withholding it
    until reviewed would make the cleaner label mail the user explicitly said
    it should not."""
    sql = await _loaded_sql(approved_includes_only=True)
    assert "exclude OR approved_at IS NOT NULL" in sql, (
        "gating excludes would suppress a correction, not a guess"
    )


def test_the_cleaner_asks_for_the_gated_set() -> None:
    """The other half — the flag exists only if the sweep passes it."""
    src = inspect.getsource(c.sweep_uncategorized)
    assert "approved_includes_only=True" in src


async def test_a_missing_migration_is_not_silent() -> None:
    """Returning {} on error disables EVERY learned pattern at once, which reads
    as "the user never taught us anything" rather than as a broken deploy."""
    db = AsyncMock()
    db.execute.side_effect = RuntimeError("column does not exist")
    with patch.object(e, "_log") as log:
        assert await e._load_rule_patterns(db, _ACC) == {}
    assert log.warning.called


# ── review state on write ───────────────────────────────────────────────────


def test_user_authored_sources_are_exactly_the_deliberate_ones() -> None:
    assert r._USER_AUTHORED_SOURCES == {
        "FIX", "USER", "LABEL_ADDED", "LABEL_REMOVED"}
    assert "AI" not in r._USER_AUTHORED_SOURCES, (
        "auto-learned patterns are the entire reason the review queue exists"
    )


def test_a_pattern_the_user_authored_needs_no_review() -> None:
    """Fix, a label changed in their own mail client, or a rule they typed IS
    the confirmation the queue collects. Asking again would be asking twice."""
    src = inspect.getsource(r._upsert_rule_pattern)
    assert "CASE WHEN :authored THEN now() ELSE NULL END" in src


def test_re_learning_a_rejected_pattern_is_refused() -> None:
    """The auto-learner fires on any sender with three consistent AI matches —
    exactly the sender the user just rejected a pattern for. Without this the
    same wrong pattern is back within the hour and rejecting means nothing."""
    src = inspect.getsource(r._upsert_rule_pattern)
    assert "rejected_at IS NOT NULL" in src
    assert src.index("user_authored = source in _USER_AUTHORED_SOURCES") < \
        src.index("INSERT INTO email_rule_patterns")


def test_the_user_can_still_overturn_their_own_rejection() -> None:
    """A deliberate Fix on a rejected pattern must win — the guard is against
    the machine re-inferring it, not against the user changing their mind."""
    src = inspect.getsource(r._upsert_rule_pattern)
    assert "if not user_authored:" in src
    assert "rejected_at = CASE WHEN :authored THEN NULL" in src


def test_resetting_the_rules_preserves_review_state() -> None:
    """email_rule_patterns.rule_id is ON DELETE CASCADE, so a rules reset
    re-inserts every pattern. Dropping approved_at there would silently
    un-approve everything the user had confirmed."""
    src = inspect.getsource(r.reset_rules)
    assert "p.approved_at, p.rejected_at" in src
    assert '"approved": s.approved_at' in src


# ── the review endpoint ─────────────────────────────────────────────────────


async def _review(**kw) -> tuple[dict, str, dict]:
    db = AsyncMock()
    db.execute.return_value = MagicMock(rowcount=7)
    with patch.object(r, "_get_db", AsyncMock(return_value=db)), \
            patch.object(r, "_assert_account_owner", AsyncMock()):
        res = await r.review_rule_patterns(
            r.PatternReviewRequest(account_id=_ACC, **kw), user=_USER)
    call = db.execute.call_args
    return res, str(call[0][0]), call[0][1]


async def test_rejecting_keeps_the_row() -> None:
    """Deleting it would let the auto-learner re-infer the same pattern
    immediately, making rejection a gesture rather than a decision."""
    _, sql, _ = await _review(pattern_ids=["p1"], approve=False)
    assert sql.startswith("UPDATE")
    assert "DELETE" not in sql
    assert "rejected_at = now()" in sql


async def test_approving_clears_a_previous_rejection() -> None:
    _, sql, _ = await _review(pattern_ids=["p1"], approve=True)
    assert "approved_at = now(), rejected_at = NULL" in sql


async def test_reviewing_by_id_is_not_gated_to_pending() -> None:
    """The review UI now lets the user reject an IN-FORCE pattern and restore a
    REJECTED one — both act on an already-decided row by id. So a by-id review
    must target the row regardless of its current state (only "approve all",
    which passes no ids, is restricted to the pending set)."""
    _, sql_rej, params = await _review(pattern_ids=["p1"], approve=False)
    assert "id = ANY(:ids)" in sql_rej
    assert "approved_at IS NULL AND rejected_at IS NULL" not in sql_rej
    assert params["ids"] == ["p1"]
    _, sql_appr, _ = await _review(pattern_ids=["p1"], approve=True)
    assert "approved_at IS NULL AND rejected_at IS NULL" not in sql_appr


async def test_approve_all_only_touches_what_is_waiting() -> None:
    """"Approve everything waiting" must not silently un-reject what the user
    has already turned down."""
    res, sql, params = await _review(approve=True)
    assert "approved_at IS NULL AND rejected_at IS NULL" in sql
    assert "ids" not in params
    assert res["updated"] == 7


async def test_an_empty_selection_is_a_no_op_not_an_approve_all() -> None:
    """`pattern_ids=[]` means "nothing selected". Falling through to the
    unfiltered UPDATE would approve the entire backlog on an empty click."""
    db = AsyncMock()
    with patch.object(r, "_get_db", AsyncMock(return_value=db)), \
            patch.object(r, "_assert_account_owner", AsyncMock()):
        res = await r.review_rule_patterns(
            r.PatternReviewRequest(account_id=_ACC, pattern_ids=[]), user=_USER)
    assert res["updated"] == 0
    db.execute.assert_not_awaited()


# ── telling the user why the cleaner went quiet ─────────────────────────────


def test_the_cleaner_reports_what_is_waiting_for_review() -> None:
    """Gating the patterns makes the cleaner quietly worse until they are
    approved. Without a number and a prompt on screen, that reads as the
    cleaner breaking rather than as a decision waiting to be made."""
    src = inspect.getsource(c.uncategorized_overview)
    assert '"pending_patterns"' in src
    assert '"pending_pattern_reach"' in src
    assert "approved_at IS NULL AND rejected_at IS NULL" in src
