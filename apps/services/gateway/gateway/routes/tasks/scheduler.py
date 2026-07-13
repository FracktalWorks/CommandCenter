"""Tasks · scheduler — server-side periodic provider refresh.

Until now the GTD mirror was refreshed only on demand: the Tasks UI calls
``POST /tasks/sync`` on app-open (when ``auto_sync_on_open`` is set) or from the
per-workspace Sync button. That means the agent's picture of ClickUp
(projects, members, stages, and other people's tasks) goes stale between
visits — and an agent run that happens while the app is closed reasons over
old data.

This module adds the missing piece: a background loop per sync-enabled
``task_accounts`` row, launched from the gateway lifespan, that

  1. pulls the workspace's tasks into the ``gtd_items`` mirror
     (``sync._sync_account`` — incremental via ``last_delta_token``, members
     cache refreshed every run), and
  2. periodically re-fetches the full provider schema
     (projects/statuses/hierarchy into ``task_accounts.schema_cache`` +
     mirrored ``gtd_projects``) so the clarify pickers and the agent's
     project/stage knowledge stay current, and
  3. sleeps ``sync_interval_secs`` (re-read each cycle so a settings change
     takes effect without a restart).

It is modelled 1:1 on ``email_ingestion/scheduler.py`` — the email app's
proven per-account asyncio-loop pattern — but reuses the tasks package's own
pooled engine (``core._get_db``) and the existing per-account pull/refresh
functions instead of standing up a second engine. Read-only toward the
provider (constraint C-04 untouched: the only upstream write is the explicit
``POST /items/{id}/push``).

"Update needed" is simply ``now() - last_synced_at > sync_interval_secs`` — the
loop enforces it by construction; ``get_scheduler_status()`` exposes the live
picture for health/debug.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from acb_common import get_logger
from gateway.routes.tasks.core import _get_db
from sqlalchemy import text

_log = get_logger("gateway.tasks.scheduler")

# Full provider-schema refresh cadence: every Nth sync cycle we re-fetch
# projects/statuses/hierarchy (heavier than the task pull, and the task pull
# already refreshes the member cache every run, so this can be less frequent).
_SCHEMA_REFRESH_EVERY_N_CYCLES = 12  # e.g. hourly at the 300s default interval
_DEFAULT_INTERVAL_SECS = 300
# Floor so a misconfigured tiny interval can't hammer the provider's rate limit.
_MIN_INTERVAL_SECS = 60

# ── Singleton state (mirrors the email scheduler) ────────────────────────────

_scheduler_tasks: dict[str, asyncio.Task] = {}   # account_id -> running loop
_scheduler_lock = asyncio.Lock()
_scheduler_running = False


# ── One sync cycle for one account ───────────────────────────────────────────

async def _run_one_cycle(account_id: str, *, refresh_schema: bool) -> None:
    """Pull tasks for one account (and, on schema cycles, re-fetch its full
    provider schema). Each step is isolated so one failing doesn't skip the
    other; the pull itself records ``sync_status``/``sync_error`` on the row."""
    from gateway.routes.tasks.accounts import _refresh_schema
    from gateway.routes.tasks.sync import _sync_account

    db = await _get_db()
    try:
        account = (await db.execute(
            text("SELECT * FROM task_accounts WHERE id = :id"),
            {"id": account_id},
        )).fetchone()
        if account is None:
            _log.info("tasks.scheduler.account_gone", account_id=account_id[:12])
            return
        if not account.sync_enabled:
            return

        # 1) Pull tasks into the mirror (commits internally; updates
        #    sync_status/last_synced_at/last_delta_token and refreshes the
        #    member cache). It CAN raise (bad creds / provider 401 surface
        #    before its own try), so we wrap it and roll back on failure so the
        #    schema-refresh step below runs on a clean session.
        try:
            result = await _sync_account(db, account, full=False)
            if result.error:
                _log.warning("tasks.scheduler.pull_error",
                             account_id=account_id[:12], error=result.error[:160])
            else:
                _log.info("tasks.scheduler.pulled",
                          account_id=account_id[:12], pulled=result.pulled,
                          created=result.created, updated=result.updated)
        except Exception as exc:  # defence in depth — _sync_account shouldn't raise
            await db.rollback()
            _log.warning("tasks.scheduler.pull_failed",
                         account_id=account_id[:12], error=str(exc)[:160])

        # 2) Periodically re-fetch the full schema so projects/stages the
        #    clarify pickers (and the agent) rely on stay current.
        if refresh_schema:
            try:
                await _refresh_schema(db, account_id, account.user_id)
                _log.info("tasks.scheduler.schema_refreshed",
                          account_id=account_id[:12])
            except Exception as exc:
                await db.rollback()
                _log.warning("tasks.scheduler.schema_refresh_failed",
                             account_id=account_id[:12], error=str(exc)[:160])
    finally:
        await db.close()


async def _account_sync_loop(account_id: str, interval_secs: int) -> None:
    """Sync one account forever: pull every cycle, full schema refresh every
    Nth cycle, then sleep the (re-read) interval."""
    interval_secs = max(interval_secs or _DEFAULT_INTERVAL_SECS, _MIN_INTERVAL_SECS)
    _log.info("tasks.scheduler.loop_started",
              account_id=account_id[:12], interval=interval_secs)
    cycle = 0
    while True:
        try:
            # Refresh the full schema on the first cycle and every Nth after,
            # so a freshly (re)started loop primes projects/stages immediately.
            refresh_schema = (cycle % _SCHEMA_REFRESH_EVERY_N_CYCLES) == 0
            await _run_one_cycle(account_id, refresh_schema=refresh_schema)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # never let one bad cycle kill the loop
            _log.warning("tasks.scheduler.cycle_failed",
                         account_id=account_id[:12], error=str(exc)[:160])
        cycle += 1

        # Re-read the interval so a settings change (or sync_enabled=false)
        # takes effect without a restart.
        interval_secs, still_enabled = await _read_interval(account_id)
        if not still_enabled:
            # Self-stop: just return. We deliberately do NOT pop
            # _scheduler_tasks here — mutating the registry outside
            # _scheduler_lock races refresh/remove/stop, and taking the lock
            # would deadlock against stop_background_sync (which holds it while
            # awaiting this task). The now-completed task entry is harmless and
            # is replaced/removed the next time refresh/remove runs for this
            # account.
            _log.info("tasks.scheduler.loop_self_stop",
                      account_id=account_id[:12])
            return
        await asyncio.sleep(interval_secs)


async def _read_interval(account_id: str) -> tuple[int, bool]:
    """(interval_secs, enabled) for an account, clamped to the floor. "enabled"
    is the account's sync_enabled AND the owner's background_sync toggle (a
    LEFT JOIN so a user with no settings row defaults to on). Missing account →
    (default, False) so the loop stops itself; a user turning background_sync
    off mid-run also self-stops the loop next cycle."""
    db = await _get_db()
    try:
        row = (await db.execute(
            text("""SELECT a.sync_interval_secs, a.sync_enabled,
                           coalesce(s.background_sync, true) AS background_sync
                    FROM task_accounts a
               LEFT JOIN gtd_settings s ON s.user_id = a.user_id
                   WHERE a.id = :id"""),
            {"id": account_id},
        )).fetchone()
    finally:
        await db.close()
    if row is None:
        return _DEFAULT_INTERVAL_SECS, False
    interval = max(row.sync_interval_secs or _DEFAULT_INTERVAL_SECS,
                   _MIN_INTERVAL_SECS)
    return interval, bool(row.sync_enabled and row.background_sync)


# ── Lifecycle (start/stop/refresh/remove + status) ───────────────────────────

async def start_background_sync() -> dict[str, int]:
    """Launch one sync loop per sync-enabled account. Called from the gateway
    lifespan on startup. Returns {account_id: interval_secs}."""
    global _scheduler_running
    async with _scheduler_lock:
        if _scheduler_running:
            _log.info("tasks.scheduler.already_running")
            return {}
        db = await _get_db()
        try:
            # Launch only for accounts whose owner hasn't turned background_sync
            # off (LEFT JOIN → users with no settings row default to on).
            rows = (await db.execute(
                text("""SELECT a.id, a.sync_interval_secs
                        FROM task_accounts a
                   LEFT JOIN gtd_settings s ON s.user_id = a.user_id
                       WHERE a.sync_enabled = true
                         AND coalesce(s.background_sync, true) = true"""),
            )).fetchall()
        finally:
            await db.close()

        launched: dict[str, int] = {}
        for row in rows:
            interval = max(row.sync_interval_secs or _DEFAULT_INTERVAL_SECS,
                           _MIN_INTERVAL_SECS)
            account_id = str(row.id)
            _scheduler_tasks[account_id] = asyncio.create_task(
                _account_sync_loop(account_id, interval))
            launched[account_id] = interval
        _scheduler_running = True
        _log.info("tasks.scheduler.started", accounts=len(launched))
        return launched


async def stop_background_sync() -> None:
    """Cancel every sync loop. Called from the gateway lifespan on shutdown."""
    global _scheduler_running
    async with _scheduler_lock:
        _scheduler_running = False
        tasks = list(_scheduler_tasks.values())
        _scheduler_tasks.clear()
        for task in tasks:
            task.cancel()
    # Await cancellation OUTSIDE the lock so a self-stopping loop (or any
    # lock-taking teardown) can't deadlock against shutdown.
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    _log.info("tasks.scheduler.stopped", cancelled=len(tasks))


async def refresh_account_sync(account_id: str) -> None:
    """Start or restart the loop for one account — call after connecting a
    workspace or toggling ``sync_enabled`` on. No-op if the scheduler hasn't
    started (startup will pick the account up)."""
    async with _scheduler_lock:
        if not _scheduler_running:
            return
        existing = _scheduler_tasks.pop(account_id, None)
        if existing:
            existing.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await existing
    interval, enabled = await _read_interval(account_id)
    if not enabled:
        return
    async with _scheduler_lock:
        _scheduler_tasks[account_id] = asyncio.create_task(
            _account_sync_loop(account_id, interval))
        _log.info("tasks.scheduler.loop_refreshed",
                  account_id=account_id[:12], interval=interval)


async def remove_account_sync(account_id: str) -> None:
    """Stop the loop for one account — call after disconnecting a workspace or
    toggling ``sync_enabled`` off."""
    async with _scheduler_lock:
        task = _scheduler_tasks.pop(account_id, None)
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        _log.info("tasks.scheduler.loop_removed", account_id=account_id[:12])


def get_scheduler_status() -> dict[str, Any]:
    """Live scheduler state for health checks / debug."""
    return {
        "running": _scheduler_running,
        "accounts": list(_scheduler_tasks.keys()),
        "count": len(_scheduler_tasks),
    }
