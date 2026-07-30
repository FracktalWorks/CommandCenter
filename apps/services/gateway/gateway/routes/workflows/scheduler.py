"""Schedule triggers — the platform's first real cron loop (spec F8, D6).

One supervised asyncio loop (the canonical gateway pattern — see
``routes/tasks/scheduler.py``) scans enabled ``schedule`` triggers of
published workflows every ``SCAN_INTERVAL_SECS``, computes due-ness with
APScheduler's ``CronTrigger`` (parser only — no scheduler process), and
CAS-claims ``last_fired_at`` so concurrent gateway workers can never
double-fire one tick. Missed ticks while the gateway was down fire once
(the most recent one), not as a catch-up storm.

Lifecycle: ``start_workflow_scheduler`` / ``stop_workflow_scheduler`` from
the gateway lifespan (main.py).
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime
from typing import Any

from gateway.routes.workflows.core import _get_db, _log, parse_jsonb
from gateway.routes.workflows.service import (
    RunRejected,
    load_version_serialized,
    start_run,
)
from sqlalchemy import text

SCAN_INTERVAL_SECS = 30.0

_scheduler_task: asyncio.Task | None = None


def compute_due_fire(
    cron: str,
    last_fired_at: datetime | None,
    now: datetime,
) -> datetime | None:
    """The most recent cron tick in (last_fired_at, now], or None.

    Anchoring on the PREVIOUS tick before *now* (rather than walking forward
    from ``last_fired_at``) is what collapses downtime into one catch-up fire.
    """
    from apscheduler.triggers.cron import CronTrigger

    trigger = CronTrigger.from_crontab(cron, timezone="UTC")
    # CronTrigger only walks forward; find the last tick <= now by stepping
    # from a probe point one interval-ish behind now.
    probe = last_fired_at
    if probe is None or (now - probe).total_seconds() > 366 * 24 * 3600:
        # Never fired (or absurdly stale): only fire ticks from now onward.
        nxt = trigger.get_next_fire_time(None, now)
        return None if nxt is None or nxt > now else nxt
    last_tick: datetime | None = None
    cursor: datetime | None = probe
    for _ in range(10000):  # hard bound: a minutely cron over a week of downtime
        nxt = trigger.get_next_fire_time(cursor, cursor or now)
        if nxt is None or nxt > now:
            break
        last_tick = nxt
        cursor = nxt
    return last_tick


async def _scan_once(now: datetime | None = None) -> int:
    """One scheduler pass. Returns the number of runs fired."""
    now = now or datetime.now(UTC)
    db = await _get_db()
    fired = 0
    try:
        rows = (
            await db.execute(
                text(
                    """SELECT t.id AS trigger_id, t.config, t.last_fired_at,
                      w.id AS workflow_id, w.name, w.latest_version, w.variables
                 FROM workflow_triggers t
                 JOIN workflows w ON w.id = t.workflow_id
                WHERE t.kind = 'schedule' AND t.enabled
                  AND w.status = 'published' AND w.latest_version IS NOT NULL"""
                )
            )
        ).fetchall()
        for row in rows:
            config = parse_jsonb(row.config, {}) or {}
            cron = str(config.get("cron") or "").strip()
            if not cron:
                continue
            try:
                due = compute_due_fire(cron, row.last_fired_at, now)
            except (ValueError, TypeError) as exc:
                _log.warning(
                    "workflows.schedule_bad_cron",
                    trigger_id=str(row.trigger_id),
                    error=str(exc)[:120],
                )
                continue
            if due is None:
                continue
            # CAS claim: only one worker wins this tick.
            claimed = await db.execute(
                text(
                    """UPDATE workflow_triggers SET last_fired_at = :due
                       WHERE id = :id
                         AND (last_fired_at IS NULL OR last_fired_at < :due)"""
                ),
                {"id": str(row.trigger_id), "due": due},
            )
            await db.commit()
            if claimed.rowcount != 1:
                continue
            serialized = await load_version_serialized(
                db,
                str(row.workflow_id),
                int(row.latest_version),
            )
            if serialized is None:
                continue
            try:
                await start_run(
                    workflow_id=str(row.workflow_id),
                    workflow_name=row.name,
                    version=int(row.latest_version),
                    serialized=serialized,
                    trigger_kind="schedule",
                    trigger_payload={"scheduled_at": due.isoformat()},
                    variables=parse_jsonb(row.variables, {}),
                    started_by="scheduler",
                )
                fired += 1
            except RunRejected as exc:
                _log.warning(
                    "workflows.schedule_run_rejected",
                    workflow_id=str(row.workflow_id),
                    error=str(exc),
                )
    finally:
        await db.close()
    return fired


async def _scheduler_loop() -> None:
    while True:
        try:
            await _scan_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # never let one bad cycle kill the loop
            _log.warning("workflows.scheduler_cycle_failed", error=str(exc)[:200])
        await asyncio.sleep(SCAN_INTERVAL_SECS)


async def start_workflow_scheduler() -> None:
    global _scheduler_task
    if _scheduler_task is not None and not _scheduler_task.done():
        return
    _scheduler_task = asyncio.get_running_loop().create_task(
        _scheduler_loop(),
        name="workflow-schedule-scanner",
    )
    _log.info("workflows.scheduler_started")


async def stop_workflow_scheduler() -> None:
    global _scheduler_task
    task, _scheduler_task = _scheduler_task, None
    if task is not None and not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


def scheduler_status() -> dict[str, Any]:
    return {
        "running": _scheduler_task is not None and not _scheduler_task.done(),
        "scan_interval_secs": SCAN_INTERVAL_SECS,
    }
