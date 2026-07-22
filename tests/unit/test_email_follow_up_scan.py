"""The follow-up reminder scan — dead in production for its entire life.

``_maybe_send_follow_up_reminders`` ran on every sync cycle and raised every
time:

    asyncpg.exceptions.AmbiguousParameterError:
    could not determine data type of parameter $2

A bare ``:param IS NOT NULL`` gives asyncpg no type to infer from. The exception
was swallowed by a best-effort handler that logged a warning nobody reads, so
the feature looked present in the UI and did nothing at all.

Behaviour was verified directly against the production database (PREPARE on the
old shape errors, PREPARE on the new shape succeeds; an unconfigured window
correctly returns no rows for its branch). These tests guard the shape so it
cannot regress.
"""
from __future__ import annotations

import inspect
import re

from gateway.routes.email.automation import followups as rz

_SRC_RAW = inspect.getsource(rz._maybe_send_follow_up_reminders)
# Comments are stripped before the SQL-shape checks below: the code carries a
# comment explaining the bug, and a guard that trips on its own explanation is
# worse than no guard — the next person deletes the comment to make CI pass.
_SRC = "\n".join(
    ln for ln in _SRC_RAW.splitlines() if not ln.lstrip().startswith("#")
)


def test_no_bare_parameter_null_test() -> None:
    """The exact construct that killed it. A bind parameter compared only to
    NULL has no type context, and asyncpg refuses to guess."""
    assert not re.search(r":\w+\s+IS\s+(NOT\s+)?NULL", _SRC), (
        "a bare ':param IS NULL' is back - this raises AmbiguousParameterError "
        "on asyncpg and the whole scan dies silently"
    )


def test_cutoffs_are_explicitly_cast() -> None:
    """Typed by construction rather than by inference, so the query cannot
    become ambiguous again if it is edited."""
    assert "CAST(:caw AS timestamptz)" in _SRC
    assert "CAST(:cnd AS timestamptz)" in _SRC


def test_an_unconfigured_window_disables_only_its_own_branch() -> None:
    """Dropping the NULL guards is safe because ``last_message_at < NULL`` is
    NULL — not TRUE — so the branch excludes itself.

    Confirmed on the live database: with the NEEDS_REPLY cutoff passed as NULL,
    the query returned AWAITING rows only.
    """
    # The AWAITING and NEEDS_REPLY branches each gate on their OWN cutoff, so a
    # NULL one cannot leak rows into the other branch.
    assert "ts.status = 'AWAITING'" in _SRC
    assert "ts.status = 'NEEDS_REPLY'" in _SRC
    aw = _SRC.index("ts.status = 'AWAITING'")
    nd = _SRC.index("ts.status = 'NEEDS_REPLY'")
    assert ":caw" in _SRC[aw:nd], "the AWAITING branch no longer uses its cutoff"
    assert ":cnd" in _SRC[nd:], "the NEEDS_REPLY branch no longer uses its cutoff"


# ── the staleness ceiling ───────────────────────────────────────────────────


def test_a_staleness_ceiling_exists() -> None:
    """Repairing a long-dead job releases everything it never processed.

    Without a ceiling the first working run would have chased threads back to
    October 2025 — and with follow_up_auto_draft on (it is, on the live
    account), written an AI nudge for each one. A reminder about last week is
    useful; one about last autumn is noise.
    """
    assert rz._FOLLOW_UP_MAX_AGE_DAYS > 0
    assert "CAST(:floor AS timestamptz)" in _SRC
    assert "_FOLLOW_UP_MAX_AGE_DAYS" in _SRC


def test_the_ceiling_is_a_floor_on_recency_not_a_second_cutoff() -> None:
    """It bounds how OLD a thread may be (``last_message_at > floor``), while
    the per-status cutoffs bound how RECENT it may be. Getting the direction
    wrong would silently invert the feature."""
    assert "ts.last_message_at > CAST(:floor AS timestamptz)" in _SRC


def test_newest_threads_are_chased_first() -> None:
    """The per-cycle LIMIT means order decides what gets attention when a
    backlog exists; the most recent waits are the ones still worth a nudge."""
    assert "ORDER BY ts.last_message_at DESC" in _SRC


def test_skipped_stale_threads_are_not_marked_reminded() -> None:
    """They are excluded by the query, not stamped. ``follow_up_reminded_at``
    means "we nudged this", and the column is re-armed by _upsert_thread_status
    when a thread changes hands — so a stale thread that comes back to life
    becomes eligible again on its own merits."""
    assert "follow_up_reminded_at = now()" in _SRC  # only on the act path
    # The exclusion is a WHERE clause, not an UPDATE of the stale rows.
    assert _SRC.count("follow_up_reminded_at = now()") == 1
