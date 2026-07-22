"""A backfill doesn't redo work it has already done.

The date picker is a RANGE, not a cursor. Re-running "last 7 days", or nudging
it out to 30, re-covers everything the previous run already processed — at one
classification call per message, to rewrite labels those messages already carry.

``rules_processed_at`` is the watermark that makes the run idempotent. It is
stamped only by runs that actually applied (live, with a working provider), so a
dry run or an auth failure leaves mail eligible instead of silently consuming it.
"""
from __future__ import annotations

import inspect

from gateway.routes.email.automation import runner as r
from gateway.routes.email.core import _date_range_clause

_ACC = "acc-1"


# ── the clause ──────────────────────────────────────────────────────────────


def test_unprocessed_only_filters_on_the_watermark() -> None:
    clause, _ = _date_range_clause(_ACC, None, None, unprocessed_only=True)
    assert "em.rules_processed_at IS NULL" in clause


def test_it_is_off_unless_asked_for() -> None:
    """Other callers of this helper must keep their existing behaviour."""
    clause, _ = _date_range_clause(_ACC, None, None)
    assert "rules_processed_at" not in clause


def test_the_filter_composes_with_the_other_conditions() -> None:
    """The skip narrows the range; it must not replace it. A backfill that
    dropped its date bounds would walk the entire mailbox."""
    clause, params = _date_range_clause(
        _ACC, "2026-01-01", "2026-02-01", only_unread=True, unprocessed_only=True)
    for fragment in ("em.received_at >= :start", "em.received_at <= :end",
                     "em.is_read = false", "em.rules_processed_at IS NULL",
                     "LOWER(em.folder) = 'inbox'"):
        assert fragment in clause, fragment
    assert params["start"] == "2026-01-01"
    assert params["end"] == "2026-02-01"


# ── the default ─────────────────────────────────────────────────────────────


def test_skipping_is_the_default_on_the_request() -> None:
    assert r.RuleProcessPastRequest(account_id=_ACC).skip_processed is True


def test_the_job_signature_defaults_to_skipping() -> None:
    """The endpoint passes it positionally; a default of False here would make a
    direct call (or a future caller that omits it) reprocess everything."""
    sig = inspect.signature(r._process_past_emails_job)
    assert sig.parameters["skip_processed"].default is True


def test_reprocessing_is_still_reachable() -> None:
    """Turning the skip off is a real need — it's how you re-apply after editing
    a rule. The fix is a default, not a removal."""
    assert r.RuleProcessPastRequest(
        account_id=_ACC, skip_processed=False).skip_processed is False


# ── the watermark is only earned by a real apply ────────────────────────────


def test_the_watermark_is_not_stamped_on_a_dry_run() -> None:
    """Otherwise a preview would silently consume the mail it previewed, and the
    real run that followed would find nothing to do."""
    src = inspect.getsource(r._process_past_emails_job)
    stamp = src.index("SET rules_processed_at = now()")
    guard = src.rindex("if not dry_run and provider is not None:", 0, stamp)
    # The guard is the statement immediately governing the stamp.
    assert stamp - guard < 400, (
        "the rules_processed_at stamp is no longer guarded by "
        "'not dry_run and provider is not None' — a preview or a run with no "
        "provider would burn the watermark"
    )


# ── the run explains itself ─────────────────────────────────────────────────


def test_the_skipped_count_is_reported_separately() -> None:
    """"Processed 0 emails" is the CORRECT outcome of a repeat run, and it reads
    exactly like the feature failing to find anything. The count of what was
    excluded is what tells them apart, so it must reach the tracker."""
    token = r._past_job_start(_ACC, "u@x", 0, False, already_processed=42)
    try:
        assert r._PAST_JOBS.get(_ACC)["already_processed"] == 42
        # And it must survive the transition out of the downloading phase.
        r._past_job_begin_processing(_ACC, token=token, total=3,
                                     already_processed=40)
        assert r._PAST_JOBS.get(_ACC)["already_processed"] == 40
        assert r._PAST_JOBS.get(_ACC)["total"] == 3
    finally:
        r._PAST_JOBS.pop(_ACC, None)


def test_already_processed_is_not_folded_into_skipped() -> None:
    """`skipped` means "processed this run, matched no rule". Merging the two
    would report thousands of skips on a run that did nothing at all."""
    token = r._past_job_start(_ACC, "u@x", 5, False, already_processed=100)
    try:
        r._past_job_tick(_ACC, token=token, skipped=1)
        assert r._PAST_JOBS.get(_ACC)["skipped"] == 1
        assert r._PAST_JOBS.get(_ACC)["already_processed"] == 100
    finally:
        r._PAST_JOBS.pop(_ACC, None)


def test_already_processed_defaults_to_zero() -> None:
    """Callers that don't pass it (other job paths) must not get None into a
    field the UI does arithmetic on."""
    r._past_job_start(_ACC, "u@x", 1, False)
    try:
        assert r._PAST_JOBS.get(_ACC)["already_processed"] == 0
    finally:
        r._PAST_JOBS.pop(_ACC, None)
