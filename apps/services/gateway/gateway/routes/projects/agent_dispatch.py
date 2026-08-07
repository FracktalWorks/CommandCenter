"""Projects · assignment IS dispatch — WS-27f / `workflows_app.md` §13 U7.

Spec: `ai-company-brain/specs/project_management_app.md` §6.4.

Assigning a task to `agent:<name>` starts an agent run. Not a separate
"delegate to AI" button, not a parallel feature with its own field — the same
gesture that hands work to a colleague, because D-PM-4 put both species in one
assignee vocabulary and this is where that stops being a schema note.

**Event-driven, never called from the handler.** `PUT /tasks/{id}/assignees`
emits `pm.task.assigned` and returns; this module is a *sink* on that event,
registered beside the workflows dispatcher at startup. That is Paca's shape
(research §5): the HTTP handler never calls the agent runtime, so a slow or
broken agent cannot make assigning somebody a task fail.

**The activity lands first.** Before the agent produces a single token, an
`agent_run` row is on the task's timeline — Paca's `agent.session.started`
move. A handoff that is invisible until the agent finishes looks, for its whole
duration, exactly like a handoff that never happened.

**Only NEW assignees dispatch.** `set_assignees` emits the *added* set, not the
whole set, so re-asserting an existing assignee cannot start a second run. That
property lives in the emitter and is relied on here; both sides say so.
"""

from __future__ import annotations

import asyncio
from typing import Any

from acb_common import get_logger
from gateway.routes.projects.core import _get_db, record_activity
from sqlalchemy import text

_log = get_logger("projects.agent_dispatch")

#: The prefix that makes an assignee an agent rather than a person (D-PM-4).
AGENT_PREFIX = "agent:"

#: How long a dispatched run may take before the activity is marked failed.
#: Matches the workflows engine's agent-node budget — the same runtime, so a
#: different number here would only mean one of the two is lying.
AGENT_RUN_TIMEOUT_SECONDS = 600.0


def agent_targets(assignees: Any) -> list[str]:
    """The agent names in an assignee list, in order, deduplicated.

    Case-insensitive on the prefix because the API lowercases on write but an
    event payload is not a database row and should not be trusted to have been
    through it.
    """
    out: list[str] = []
    seen: set[str] = set()
    for raw in assignees if isinstance(assignees, list) else []:
        value = str(raw or "").strip().lower()
        if not value.startswith(AGENT_PREFIX):
            continue
        name = value[len(AGENT_PREFIX):].strip()
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def build_message(task: Any) -> str:
    """What the agent is told. The task, not a prompt template.

    Deliberately plain: the agent gets the human-readable identifier it can
    quote back, the title, and the description if there is one. Anything richer
    belongs in the agent's own instructions, which are code-authored in Git —
    inventing a prompt here would put agent behaviour in a route package.
    """
    number = getattr(task, "task_number", None)
    label = f"#{number} " if number else ""
    parts = [f"You have been assigned task {label}{task.title}."]
    description = str(getattr(task, "description", "") or "").strip()
    if description:
        parts.append(description)
    parts.append(f"The task id is {task.id}.")
    return "\n\n".join(parts)


async def on_event(source: str, event_type: str, payload: dict[str, Any]) -> None:
    """Event sink: start a run for every agent newly assigned to a task.

    Registered alongside the workflows dispatcher, so `pm.task.assigned` fans
    out to both. Best-effort like every sink — `emit_event` swallows sink
    errors by default and that default is load-bearing (a webhook must never
    5xx because a sink failed), so this returns rather than raises.
    """
    if source != "projects" or event_type != "pm.task.assigned":
        return
    agents = agent_targets(payload.get("assignees"))
    if not agents:
        return

    task_id = str(payload.get("task_id") or "").strip()
    if not task_id:
        return

    db = await _get_db()
    try:
        task = (await db.execute(
            text("SELECT * FROM pm_tasks WHERE id = CAST(:tid AS uuid)"),
            {"tid": task_id},
        )).fetchone()
        if task is None:
            return
        message = build_message(task)
        for name in agents:
            # The timeline entry is written and COMMITTED before the run
            # starts, so the handoff is visible immediately rather than when
            # the agent finishes.
            await record_activity(
                db, activity_type="agent_run", created_by=f"{AGENT_PREFIX}{name}",
                task_id=task_id, body=f"Assigned to {name}; starting a run.",
                meta={"agent": name, "state": "started"},
            )
        await db.commit()
    finally:
        await db.close()

    for name in agents:
        await _run_and_record(name, message, task_id)


async def _run_and_record(agent: str, message: str, task_id: str) -> None:
    """Run one agent and close its timeline entry either way.

    A dispatch that fails silently is worse than one that never started: the
    task shows a session that appears to still be running and nobody knows to
    pick the work back up. So the failure path writes too.
    """
    try:
        from orchestrator.executor import run_agent
    except Exception as exc:  # pragma: no cover — orchestrator is a hard dep
        await _record_outcome(task_id, agent, ok=False, detail="orchestrator unavailable")
        _log.warning("projects.agent_dispatch_unavailable", error=str(exc))
        return

    try:
        result = await asyncio.wait_for(
            run_agent(agent, message), timeout=AGENT_RUN_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        await _record_outcome(task_id, agent, ok=False, detail="timed out")
        return
    except Exception as exc:
        await _record_outcome(task_id, agent, ok=False, detail=str(exc)[:300])
        return
    await _record_outcome(task_id, agent, ok=True, detail=str(result or "")[:2000])


async def _record_outcome(task_id: str, agent: str, *, ok: bool, detail: str) -> None:
    db = await _get_db()
    try:
        await record_activity(
            db, activity_type="agent_run", created_by=f"{AGENT_PREFIX}{agent}",
            task_id=task_id,
            body=detail if ok else f"Agent run failed: {detail}",
            meta={"agent": agent, "state": "finished" if ok else "failed"},
        )
        await db.commit()
    except Exception as exc:  # pragma: no cover — the outcome write is best-effort
        _log.warning("projects.agent_dispatch_record_failed", error=str(exc))
    finally:
        await db.close()
