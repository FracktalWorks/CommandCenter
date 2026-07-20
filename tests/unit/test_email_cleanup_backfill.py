"""Clean older mail: fetch history, then categorize it without a model.

The Email Cleaner showed 564 outstanding messages on a mailbox holding ~43,000.
It was not failing to categorize them — it had never seen them. ``_sync_account``
fetches ``INITIAL_SYNC_DAYS = 365`` on an account's FIRST sync and every sync
after that is incremental, so mail older than a year is simply absent. Measured
on the live account: 6,803 messages held, every folder starting within days of
one year before the account was connected.

This is the deterministic counterpart of "Process past emails": same two-phase
shape, but it spends nothing on models.

The load-bearing detail is ``_mark_history_rules_processed``. The scheduled rule
run selects ``folder = 'inbox' AND rules_processed_at IS NULL``, 50 per cycle,
and classifies each with a model. Backfilled mail all arrives with that column
NULL, so downloading 36,000 messages would silently queue 36,000 model calls —
precisely the cost this feature exists to avoid.
"""
from __future__ import annotations

import inspect
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes.email.automation import cleanup as c

_ACC = "acc-backfill"


# ── the request ─────────────────────────────────────────────────────────────


def test_no_date_means_the_whole_mailbox() -> None:
    """"Everything" is the point — a floor that defaults to a year would
    reproduce the bug this feature exists to fix."""
    assert c.CleanupBackfillRequest(account_id=_ACC).since_date is None


def test_a_floor_can_be_given() -> None:
    req = c.CleanupBackfillRequest(account_id=_ACC, since_date="2023-01-01")
    assert req.since_date == "2023-01-01"


# ── holding history back from the model ─────────────────────────────────────


async def test_history_is_stamped_rules_processed() -> None:
    """Without this, a backfill is a bill."""
    db = AsyncMock()
    db.execute.return_value = MagicMock(rowcount=1234)
    n = await c._mark_history_rules_processed(
        db, _ACC, datetime(2025, 6, 30, tzinfo=timezone.utc))
    assert n == 1234
    sql = str(db.execute.call_args[0][0])
    assert "rules_processed_at = now()" in sql
    assert "rules_processed_at IS NULL" in sql


async def test_only_mail_older_than_what_we_already_had_is_stamped() -> None:
    """The floor is the oldest message held BEFORE the sync. Mail that arrives
    while the backfill runs is newer than that, so it stays eligible for the
    rules — stamping it would silently stop new mail being classified."""
    db = AsyncMock()
    db.execute.return_value = MagicMock(rowcount=0)
    floor = datetime(2025, 6, 30, tzinfo=timezone.utc)
    await c._mark_history_rules_processed(db, _ACC, floor)
    sql = str(db.execute.call_args[0][0])
    assert "received_at < :before" in sql
    assert db.execute.call_args[0][1]["before"] == floor


def test_the_job_stamps_before_it_sweeps() -> None:
    """Sweeping first would be harmless, but the RULE RUN fires on its own
    schedule — every cycle the stamp is late is a cycle it can bill for."""
    src = inspect.getsource(c._backfill_and_clean_job)
    assert src.index("_mark_history_rules_processed") < src.index(
        "sweep_uncategorized"), (
        "history must be held back from the model BEFORE the long sweep starts"
    )


def test_the_sweep_ignores_the_watermark() -> None:
    """Stamping mail rules-processed must not make it uncleanable — the whole
    plan is that the deterministic sweep still covers it."""
    assert "rules_processed_at" not in c._CLEANUP_SCOPE


# ── progress ────────────────────────────────────────────────────────────────


def test_both_phases_are_reported() -> None:
    """Downloading years of mail takes minutes. A job that reports nothing until
    it finishes reads as stuck, and the user presses the button again."""
    src = inspect.getsource(c._backfill_and_clean_job)
    assert '"phase": "downloading"' in src
    assert '"phase": "cleaning"' in src


def test_the_tracker_is_seeded_before_any_slow_work() -> None:
    """The UI polls immediately after the POST returns; an empty tracker would
    read as "idle" and the flow would look like it never started."""
    src = inspect.getsource(c._backfill_and_clean_job)
    assert src.index("_SWEEP_JOBS[account_id]") < src.index("_sync_account")


def test_a_failure_is_recorded_rather_than_lost() -> None:
    src = inspect.getsource(c._backfill_and_clean_job)
    assert '"status": "error"' in src


# ── the endpoint ────────────────────────────────────────────────────────────


async def test_a_second_run_is_refused_while_one_is_in_flight() -> None:
    """Two deep syncs on one mailbox race the provider and each other's progress
    row. Say so rather than silently start a second."""
    c._SWEEP_JOBS[_ACC] = {"owner": "u@x", "status": "running"}
    try:
        with patch.object(c, "_get_db", AsyncMock(return_value=AsyncMock())), \
                patch.object(c, "_assert_account_owner", AsyncMock()):
            from fastapi import BackgroundTasks
            res = await c.cleanup_backfill(
                c.CleanupBackfillRequest(account_id=_ACC),
                background=BackgroundTasks(),
                user=SimpleNamespace(email="u@x"))
        assert res["scheduled"] is False
        assert res["reason"] == "already_running"
    finally:
        c._SWEEP_JOBS.pop(_ACC, None)


async def test_a_finished_run_does_not_block_the_next_one() -> None:
    c._SWEEP_JOBS[_ACC] = {"owner": "u@x", "status": "done"}
    try:
        bg = None
        with patch.object(c, "_get_db", AsyncMock(return_value=AsyncMock())), \
                patch.object(c, "_assert_account_owner", AsyncMock()):
            from fastapi import BackgroundTasks
            bg = BackgroundTasks()
            res = await c.cleanup_backfill(
                c.CleanupBackfillRequest(account_id=_ACC),
                background=bg, user=SimpleNamespace(email="u@x"))
        assert res["scheduled"] is True
        assert len(bg.tasks) == 1
    finally:
        c._SWEEP_JOBS.pop(_ACC, None)
