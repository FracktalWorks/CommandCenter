"""Append-only audit log.

Phase-0: writes to Postgres `audit_event` (schema in infra/postgres/01_schema.sql)
AND mirrors to structlog so traces show up locally even if the DB is down.
The Annealer (Phase 4) reads from this table to mine intervention patterns.

**The DB write is synchronous** — it goes through ``acb_graph.get_session()``,
which is a sync SQLAlchemy engine, and most callers here are sync code
(``orchestrator.executor``, the pull agents). But the gateway's route handlers
are ``async`` and call :func:`record` on the event loop, where a blocking
psycopg round-trip stalls *every* other request in the process for its duration
— and this write is best-effort, so it can stall them behind a DB that is
timing out. BO-10's remaining item. :func:`record` therefore keeps its sync
signature (25-odd call sites, most of them sync) and dispatches the write to a
worker thread **only when it is called from a running event loop**.
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from acb_common import get_logger

_log = get_logger("acb_audit")

#: Strong references to in-flight off-loop writes.
#:
#: ``asyncio`` holds only a weak reference to a task, so a fire-and-forget task
#: with no other referent can be garbage-collected mid-write. Discarded by the
#: done-callback, so this is bounded by concurrency, not by uptime.
_PENDING: set[asyncio.Task[None]] = set()


@dataclass(slots=True)
class AuditEvent:
    actor: str                                # e.g. "agent:sales", "user:vijay@..."
    action: str                               # e.g. "draft_email", "approve", "reject"
    target: str                               # e.g. "deal:<uuid>"
    payload: dict[str, Any] = field(default_factory=dict)
    id: UUID = field(default_factory=uuid4)
    at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def _persist(event: AuditEvent) -> None:
    """The blocking half: one row, its own session, never raises."""
    try:
        # Local import avoids a hard dep from acb_audit -> acb_graph at import time
        # (acb_audit is intentionally usable without the DB layer).
        from acb_graph import get_session
        from acb_graph.models import AuditEvent as AuditRow

        with get_session() as s:
            s.add(
                AuditRow(
                    id=event.id,
                    at=event.at,
                    actor=event.actor,
                    action=event.action,
                    target=event.target,
                    payload=event.payload,
                )
            )
    except Exception as exc:  # never block the caller on audit-DB failures
        _log.warning("audit.persist_failed", error=str(exc))


def record(event: AuditEvent) -> None:
    """Persist an audit event. Logs always; DB write is best-effort.

    Synchronous by signature, and synchronous in fact for sync callers. On an
    event loop the DB write is handed to a worker thread and this returns
    immediately, so an async handler is never blocked by it.

    ⚠️ What that costs, stated plainly: for an async caller the row is no longer
    written by the time this returns. Nothing depended on that ordering — the
    write has always been in its own session, outside the caller's transaction,
    and has always been allowed to fail silently (see
    ``routes/admin/members.py::purge_member``, which reasons explicitly about
    both) — but a caller that wants the row *now* must ``await drain()``.
    """
    _log.info("audit", **asdict(event))
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No event loop: we are sync code (or already on a worker thread).
        # Blocking here blocks only this caller, which is what it asked for.
        _persist(event)
        return

    task = loop.create_task(asyncio.to_thread(_persist, event))
    _PENDING.add(task)
    task.add_done_callback(_PENDING.discard)


async def drain(timeout: float = 5.0) -> None:
    """Wait for off-loop audit writes to finish. Call on shutdown.

    Without this, a process that exits right after a write cancels the task and
    loses the row — which would be a regression against the old blocking
    behaviour, where the write was complete before the handler returned. The
    timeout is a bound, not a promise: a wedged audit DB must not hold the
    shutdown open, and a lost audit row is by contract survivable.
    """
    pending = [t for t in _PENDING if not t.done()]
    if not pending:
        return
    _done, still_running = await asyncio.wait(pending, timeout=timeout)
    if still_running:
        _log.warning("audit.drain_timeout", pending=len(still_running))
