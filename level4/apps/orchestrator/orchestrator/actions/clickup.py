"""ClickUp write-back actions.

Each function: (1) calls the ClickUp REST client, (2) writes an
`AuditEvent` row (actor + action + target + payload), (3) best-effort
refreshes the local graph mirror so the very next pull-query sees the new
state without waiting for the ingestion cycle.

Failures from ClickUp surface as `ActionError`. The audit row is written
*after* a successful API call (so retries don't pollute the log with
phantom successes); on failure we still log a structured warning.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import select

from acb_audit import AuditEvent, record
from acb_common import get_logger
from acb_graph import get_session
from acb_graph.models import Task
from ingestion.sources.clickup import client as cu

_log = get_logger("orchestrator.actions.clickup")


class ActionError(RuntimeError):
    """Raised when a ClickUp write-back fails. Message is user-safe."""


@dataclass(slots=True, frozen=True)
class ActionResult:
    ok: bool
    summary: str           # one-line human readable result
    target: str            # e.g. "clickup:task:abc123"
    response: dict[str, Any]


def _audit(actor: str, action: str, target: str, payload: dict[str, Any]) -> None:
    record(AuditEvent(actor=actor, action=action, target=target, payload=payload))


def _refresh_task_stage(clickup_task_id: str, new_stage: str | None) -> None:
    """Update the local Task.stage column to match what we just pushed."""
    if not new_stage:
        return
    try:
        with get_session() as s:
            row = s.execute(
                select(Task).where(Task.clickup_id == str(clickup_task_id))
            ).scalar_one_or_none()
            if row is not None:
                row.stage = new_stage
    except Exception as exc:  # never fail the user action on a graph hiccup
        _log.warning("graph.refresh_failed", error=str(exc), task=clickup_task_id)


async def update_task_status(
    *,
    actor_email: str,
    clickup_task_id: str,
    status: str,
    note: str | None = None,
) -> ActionResult:
    """Set a ClickUp task's status (e.g. 'in progress', 'complete')."""
    payload = {"status": status, "note": note}
    target = f"clickup:task:{clickup_task_id}"
    try:
        resp = await cu.update_task(clickup_task_id, status=status)
    except httpx.HTTPStatusError as exc:
        _log.warning("clickup.update_task.failed", task=clickup_task_id,
                     status_code=exc.response.status_code, body=exc.response.text[:500])
        raise ActionError(
            f"ClickUp rejected status update ({exc.response.status_code}): "
            f"{exc.response.text[:200]}"
        ) from exc
    except (httpx.HTTPError, ValueError) as exc:
        _log.exception("clickup.update_task.error", task=clickup_task_id)
        raise ActionError(f"ClickUp call failed: {type(exc).__name__}: {exc}") from exc

    _audit(f"user:{actor_email}", "clickup.update_task_status", target, payload)
    _refresh_task_stage(clickup_task_id, status)
    title = resp.get("name") or clickup_task_id
    return ActionResult(
        ok=True,
        summary=f"Set status of '{title}' to '{status}'.",
        target=target,
        response=resp,
    )


async def add_task_comment(
    *,
    actor_email: str,
    clickup_task_id: str,
    comment_text: str,
    notify_all: bool = False,
) -> ActionResult:
    """Append a comment to a ClickUp task. Lowest-risk write."""
    payload = {"comment_text": comment_text, "notify_all": notify_all}
    target = f"clickup:task:{clickup_task_id}"
    try:
        resp = await cu.add_comment(
            clickup_task_id, comment_text=comment_text, notify_all=notify_all
        )
    except httpx.HTTPStatusError as exc:
        _log.warning("clickup.add_comment.failed", task=clickup_task_id,
                     status_code=exc.response.status_code, body=exc.response.text[:500])
        raise ActionError(
            f"ClickUp rejected the comment ({exc.response.status_code}): "
            f"{exc.response.text[:200]}"
        ) from exc
    except httpx.HTTPError as exc:
        _log.exception("clickup.add_comment.error", task=clickup_task_id)
        raise ActionError(f"ClickUp call failed: {type(exc).__name__}: {exc}") from exc

    _audit(f"user:{actor_email}", "clickup.add_comment", target, payload)
    return ActionResult(
        ok=True,
        summary=f"Posted comment on task {clickup_task_id}.",
        target=target,
        response=resp,
    )


# ------------- Helpers used by the gateway to resolve graph UUIDs ----------

def task_clickup_id_for(task_uuid: UUID) -> str | None:
    """Look up the ClickUp id for a local Task UUID (chat citations are UUIDs)."""
    with get_session() as s:
        row = s.get(Task, task_uuid)
        return row.clickup_id if row else None


__all__ = [
    "ActionError",
    "ActionResult",
    "update_task_status",
    "add_task_comment",
    "task_clickup_id_for",
]