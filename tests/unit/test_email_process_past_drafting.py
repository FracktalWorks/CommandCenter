"""Backfills file old mail; they don't answer it.

"Process past emails" walks a date range and runs every matched rule's actions.
Those include REPLY / DRAFT_EMAIL / FORWARD, each of which spends a call on the
drafting model — on conversations that, being months old, have usually ended.
Pointing the date picker at 90 days therefore used to generate (and bill for) a
pile of drafts the user then deleted by hand.

Drafting is now OPT-IN per run. These tests pin that default, and pin that
turning it off does not quietly disable the rest of the rule.
"""
from __future__ import annotations

from gateway.routes.email.automation import runner as r


def _match(*types):
    return {"rule": {"name": "Reply", "actions": [{"type": t} for t in types]},
            "reason": "matched"}


# ── the default ─────────────────────────────────────────────────────────────


def test_drafting_is_off_by_default_on_the_request() -> None:
    """The API default is what protects a user who never opens the toggle."""
    req = r.RuleProcessPastRequest(account_id="acc-1")
    assert req.draft_replies is False


def test_a_live_run_is_unaffected() -> None:
    """Only the BACKFILL defaults drafting off. New mail still drafts — that's
    the feature working as intended on a conversation that is actually live."""
    import inspect
    src = inspect.getsource(r._run_rules_job)
    assert "_without_drafting" not in src, (
        "the live rule run must not suppress drafting"
    )


# ── what gets stripped ──────────────────────────────────────────────────────


def test_every_drafting_action_is_stripped() -> None:
    for t in ("REPLY", "DRAFT_EMAIL", "FORWARD"):
        out, stripped = r._without_drafting(_match(t))
        assert stripped is True, t
        assert out["rule"]["actions"] == [], t


def test_filing_actions_survive() -> None:
    """The point of a backfill is to file old mail. Suppressing drafting must
    not quietly suppress the labelling that the user actually ran this for."""
    out, stripped = r._without_drafting(
        _match("LABEL", "REPLY", "ARCHIVE", "MARK_READ"))
    assert stripped is True
    assert [a["type"] for a in out["rule"]["actions"]] == [
        "LABEL", "ARCHIVE", "MARK_READ"]


def test_a_rule_with_no_drafting_is_returned_untouched() -> None:
    m = _match("LABEL", "ARCHIVE")
    out, stripped = r._without_drafting(m)
    assert stripped is False
    assert out is m          # same object — no needless copy
    assert [a["type"] for a in out["rule"]["actions"]] == ["LABEL", "ARCHIVE"]


def test_stripping_does_not_mutate_the_caller_s_rule() -> None:
    """The rule dict comes from the shared rule cache. Mutating it in place
    would disable drafting for every later message in the run — and for the
    live runner too, since both read the same loaded rules."""
    m = _match("LABEL", "REPLY")
    out, _ = r._without_drafting(m)
    assert [a["type"] for a in m["rule"]["actions"]] == ["LABEL", "REPLY"]
    assert [a["type"] for a in out["rule"]["actions"]] == ["LABEL"]


def test_match_metadata_is_preserved() -> None:
    """History shows the match reason; losing it would make a filed email look
    like it was categorized for no stated cause."""
    out, _ = r._without_drafting(_match("REPLY"))
    assert out["reason"] == "matched"
    assert out["rule"]["name"] == "Reply"


# ── it is reported, not silent ──────────────────────────────────────────────


def test_suppressed_drafting_is_reported_on_the_job() -> None:
    """A run that skipped drafting must not read as one where the rules simply
    ran in full."""
    r._PAST_JOBS["acc-x"] = {"token": 1, "status": "running"}
    try:
        r._past_job_finish("acc-x", token=1, drafts_skipped=17)
        assert r._PAST_JOBS["acc-x"]["drafts_skipped"] == 17
        assert r._PAST_JOBS["acc-x"]["status"] == "done"
    finally:
        r._PAST_JOBS.pop("acc-x", None)
