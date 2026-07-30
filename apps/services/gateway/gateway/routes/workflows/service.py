"""Run lifecycle: create → execute (supervised asyncio task) → persist.

Bridges the transport-free engine to the gateway's real seams:

- agent nodes    → ``orchestrator.executor.run_agent`` (MAF batch path,
                   ``source="workflow"`` — constraint #9: event-driven
                   execution goes through MAF, never the Copilot runtime)
- tool nodes     → the workflow tool registry (broker-gated writes)
- module nodes   → ``workflow_modules`` rows (status ``ready``)

Live run events fan out through an in-process hub (per-run replay + tail) that
``runs.py`` serves over SSE. v1 honesty note (spec §3.3): runs execute as
supervised asyncio tasks inside the gateway process — durable queueing across
restarts is BO-20's scope; a run interrupted by a restart is marked failed on
the next status read rather than silently lost.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from gateway.routes.workflows.core import (
    _get_db,
    _log,
    parse_jsonb,
    publish_workflow_activity,
)
from gateway.routes.workflows.engine.handlers import (
    NodeExecutionError,
    NodeServices,
)
from gateway.routes.workflows.engine.runner import execute_workflow
from gateway.routes.workflows.tools import execute_tool
from sqlalchemy import text

#: Global + per-workflow concurrency caps (spec R2 mitigation).
MAX_CONCURRENT_RUNS = 8
MAX_CONCURRENT_RUNS_PER_WORKFLOW = 2
#: Hub entries are dropped this long after a run finishes.
HUB_TTL_SECS = 600.0


# ── The in-process run event hub ─────────────────────────────────────────────


@dataclass(slots=True)
class RunHub:
    events: list[dict[str, Any]] = field(default_factory=list)
    queues: set[asyncio.Queue] = field(default_factory=set)
    done: bool = False


_HUBS: dict[str, RunHub] = {}
_ACTIVE_BY_WORKFLOW: dict[str, int] = {}
_ACTIVE_TOTAL = 0


def hub_for(run_id: str) -> RunHub | None:
    return _HUBS.get(run_id)


def _hub_emit(run_id: str, event: dict[str, Any]) -> None:
    hub = _HUBS.get(run_id)
    if hub is None:
        return
    event = {**event, "ts": time.time()}
    hub.events.append(event)
    for queue in list(hub.queues):
        with contextlib.suppress(asyncio.QueueFull):  # unbounded queues
            queue.put_nowait(event)


def _hub_close(run_id: str) -> None:
    hub = _HUBS.get(run_id)
    if hub is None:
        return
    hub.done = True
    for queue in list(hub.queues):
        with contextlib.suppress(asyncio.QueueFull):
            queue.put_nowait(None)  # sentinel: stream over

    def _expire() -> None:
        # Identity-guarded: a resumed run replaces the hub before the TTL
        # fires, and the new hub must not be popped by the old timer.
        if _HUBS.get(run_id) is hub:
            _HUBS.pop(run_id, None)

    asyncio.get_running_loop().call_later(HUB_TTL_SECS, _expire)


# ── Real NodeServices ────────────────────────────────────────────────────────


async def _run_agent_node(agent: str, message: str, model: str | None) -> str:
    try:
        from orchestrator.executor import AgentRunError, run_agent
    except Exception as exc:  # pragma: no cover - orchestrator is a dep
        raise NodeExecutionError("orchestrator unavailable") from exc
    payload: dict[str, Any] = {
        "message": message,
        "mode": "sub_task",
        "source": "workflow",
    }
    try:
        result = await run_agent(agent, payload, model=model)
    except AgentRunError as exc:
        raise NodeExecutionError(f"agent '{agent}' failed: {exc}") from exc
    text_out = str(result.get("result") or result.get("answer") or "")
    if not text_out:
        raise NodeExecutionError(f"agent '{agent}' returned no output")
    return text_out


async def _get_module_code(module_id: str) -> str | None:
    db = await _get_db()
    try:
        row = (
            await db.execute(
                text("SELECT code FROM workflow_modules WHERE id = :id AND status = 'ready'"),
                {"id": module_id},
            )
        ).fetchone()
    finally:
        await db.close()
    return row.code if row is not None else None


def build_node_services(actor: str) -> NodeServices:
    return NodeServices(
        run_agent=_run_agent_node,
        run_tool=execute_tool,
        get_module_code=_get_module_code,
        actor=actor,
    )


# ── Run lifecycle ────────────────────────────────────────────────────────────


async def load_version_serialized(
    db: Any,
    workflow_id: str,
    version: int,
) -> dict[str, Any] | None:
    row = (
        await db.execute(
            text(
                "SELECT serialized FROM workflow_versions WHERE workflow_id = :wid AND version = :v"
            ),
            {"wid": workflow_id, "v": version},
        )
    ).fetchone()
    return parse_jsonb(row.serialized, None) if row is not None else None


async def start_run(
    *,
    workflow_id: str,
    workflow_name: str,
    version: int,
    serialized: dict[str, Any],
    trigger_kind: str,
    trigger_payload: dict[str, Any],
    variables: dict[str, Any] | None = None,
    started_by: str = "",
) -> str:
    """Create the run row + hub entry and launch the supervised task."""
    global _ACTIVE_TOTAL
    if _ACTIVE_TOTAL >= MAX_CONCURRENT_RUNS:
        raise RunRejected("the platform run concurrency limit is reached — retry shortly")
    if _ACTIVE_BY_WORKFLOW.get(workflow_id, 0) >= MAX_CONCURRENT_RUNS_PER_WORKFLOW:
        raise RunRejected("this workflow already has the maximum concurrent runs")

    run_id = str(uuid.uuid4())
    db = await _get_db()
    try:
        await db.execute(
            text(
                """INSERT INTO workflow_runs
                   (id, workflow_id, workflow_name, version, trigger_kind,
                    trigger_payload, status, started_by)
                   VALUES (:id, :wid, :name, :v, :tk,
                           :tp ::jsonb, 'running', :by)"""
            ),
            {
                "id": run_id,
                "wid": workflow_id,
                "name": workflow_name,
                "v": version,
                "tk": trigger_kind,
                "tp": json.dumps(trigger_payload, default=str),
                "by": started_by,
            },
        )
        await db.commit()
    finally:
        await db.close()

    _HUBS[run_id] = RunHub()
    _ACTIVE_TOTAL += 1
    _ACTIVE_BY_WORKFLOW[workflow_id] = _ACTIVE_BY_WORKFLOW.get(workflow_id, 0) + 1
    asyncio.get_running_loop().create_task(
        _execute_run(
            run_id=run_id,
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            serialized=serialized,
            trigger_payload=trigger_payload,
            variables=variables or {},
            started_by=started_by,
        ),
        name=f"workflow-run:{run_id}",
    )
    return run_id


class RunRejected(Exception):
    """The run was refused before starting (concurrency limits)."""


async def _execute_run(
    *,
    run_id: str,
    workflow_id: str,
    workflow_name: str,
    serialized: dict[str, Any],
    trigger_payload: dict[str, Any],
    variables: dict[str, Any],
    started_by: str,
    precomputed: dict[str, Any] | None = None,
    resolved_approvals: set[str] | None = None,
) -> None:
    global _ACTIVE_TOTAL
    actor = f"workflow:{workflow_name or workflow_id}"
    publish_workflow_activity(
        workflow_id,
        workflow_name,
        user=started_by or None,
        phase="start",
        run_id=run_id,
    )
    _hub_emit(run_id, {"event": "run", "status": "running"})

    def emit(node_id: str, status: str, detail: dict[str, Any]) -> None:
        _hub_emit(
            run_id,
            {
                "event": "node",
                "node_id": node_id,
                "status": status,
                **_safe_detail(detail),
            },
        )

    status = "failed"
    error: str | None = None
    try:
        outcome = await execute_workflow(
            serialized,
            trigger_payload,
            build_node_services(actor),
            variables=variables,
            emit=emit,
            precomputed=precomputed,
            resolved_approvals=resolved_approvals,
        )
        status, error = outcome.status, outcome.error
        await _finish_run(
            run_id,
            status=status,
            error=error,
            variables=outcome.state,
            node_results=outcome.node_results,
            outputs=outcome.outputs,
        )
        if status == "paused" and outcome.paused_nodes:
            await _hold_for_approval(
                run_id=run_id,
                workflow_id=workflow_id,
                workflow_name=workflow_name,
                node_id=outcome.paused_nodes[0],
                serialized=serialized,
                trigger_payload=trigger_payload,
                variables=variables,
                started_by=started_by,
            )
    except Exception as exc:  # engine bugs must still close the run out
        error = f"{type(exc).__name__}: {exc}"[:500]
        _log.warning("workflows.run_crashed", run_id=run_id, error=error)
        await _finish_run(
            run_id,
            status="failed",
            error=error,
            variables={},
            node_results={},
            outputs=[],
        )
    finally:
        _ACTIVE_TOTAL = max(0, _ACTIVE_TOTAL - 1)
        remaining = _ACTIVE_BY_WORKFLOW.get(workflow_id, 1) - 1
        if remaining <= 0:
            _ACTIVE_BY_WORKFLOW.pop(workflow_id, None)
        else:
            _ACTIVE_BY_WORKFLOW[workflow_id] = remaining
        _hub_emit(run_id, {"event": "run", "status": status, "error": error})
        _hub_close(run_id)
        publish_workflow_activity(
            workflow_id,
            workflow_name,
            user=started_by or None,
            phase="end",
            run_id=run_id,
            status=status,
        )


def _safe_detail(detail: dict[str, Any]) -> dict[str, Any]:
    """Keep hub/SSE events small: clamp big node outputs to a preview."""
    out = dict(detail)
    output = out.get("output")
    if output is not None:
        try:
            encoded = json.dumps(output, default=str)
        except (TypeError, ValueError):
            encoded = str(output)
        if len(encoded) > 8000:
            out["output"] = {"_truncated": True, "preview": encoded[:8000]}
    return out


async def _finish_run(
    run_id: str,
    *,
    status: str,
    error: str | None,
    variables: dict[str, Any],
    node_results: dict[str, Any],
    outputs: list[Any],
) -> None:
    try:
        db = await _get_db()
        try:
            # A paused run has not finished — finished_at stays NULL until
            # the resumed execution reaches a terminal status.
            finished = "now()" if status != "paused" else "NULL"
            await db.execute(
                text(
                    f"""UPDATE workflow_runs SET
                         status = :status, error = :error,
                         variables = :variables ::jsonb,
                         node_results = :node_results ::jsonb,
                         output = :output ::jsonb,
                         finished_at = {finished}
                       WHERE id = :id"""
                ),
                {
                    "id": run_id,
                    "status": status,
                    "error": error,
                    "variables": json.dumps(variables, default=str),
                    "node_results": json.dumps(node_results, default=str),
                    "output": json.dumps(outputs, default=str),
                },
            )
            await db.commit()
        finally:
            await db.close()
    except Exception as exc:  # pragma: no cover - best effort persistence
        _log.warning("workflows.finish_persist_failed", run_id=run_id, error=str(exc)[:160])


# ── Approval pause / resume (spec F11 — rides the Action Broker inbox) ───────


async def _hold_for_approval(
    *,
    run_id: str,
    workflow_id: str,
    workflow_name: str,
    node_id: str,
    serialized: dict[str, Any],
    trigger_payload: dict[str, Any],
    variables: dict[str, Any],
    started_by: str,
) -> None:
    """Persist the pause and put the decision in the existing approvals inbox.

    The proposal (action ``workflow.resume_run``) lands in ``pending_actions``
    exactly like any outward write — the operator sees it at /approvals and
    approving it fires this package's registered broker handler, which resumes
    the run. Everything a resume needs travels in the pause snapshot, so even
    a draft test run (no published version to reload) resumes cleanly.
    """
    node_label = next(
        (
            str(b.get("label") or node_id)
            for b in serialized.get("blocks", [])
            if str(b.get("id")) == node_id
        ),
        node_id,
    )
    action_id: str | None = None
    try:
        from action_broker.broker import AuthorityTier, propose, submit

        proposal = propose(
            actor=f"workflow:{workflow_name or workflow_id}",
            action="workflow.resume_run",
            target=f"workflow_run:{run_id}",
            payload={
                "run_id": run_id,
                "workflow_id": workflow_id,
                "workflow_name": workflow_name,
                "node_id": node_id,
                "node_label": node_label,
                "requested_by": started_by,
            },
            authority=AuthorityTier.SUGGEST,  # always NEEDS_APPROVAL
            destructive=False,
        )
        result = await submit(proposal)
        action_id = str(result.get("action_id") or "") or None
    except Exception as exc:
        _log.warning("workflows.approval_propose_failed", run_id=run_id, error=str(exc)[:160])
    try:
        db = await _get_db()
        try:
            await db.execute(
                text(
                    """INSERT INTO workflow_run_pauses
                       (run_id, node_id, snapshot, reason, status)
                       VALUES (:run_id, :node_id, :snapshot ::jsonb,
                               'approval', 'pending')"""
                ),
                {
                    "run_id": run_id,
                    "node_id": node_id,
                    "snapshot": json.dumps(
                        {
                            "serialized": serialized,
                            "trigger_payload": trigger_payload,
                            "variables": variables,
                            "workflow_id": workflow_id,
                            "workflow_name": workflow_name,
                            "started_by": started_by,
                            "action_id": action_id,
                        },
                        default=str,
                    ),
                },
            )
            await db.commit()
        finally:
            await db.close()
    except Exception as exc:  # pragma: no cover - best effort persistence
        _log.warning("workflows.pause_persist_failed", run_id=run_id, error=str(exc)[:160])


async def resume_run(run_id: str, *, resumed_by: str = "approver") -> dict[str, Any]:
    """Resume a paused run: replay completed nodes from stored outputs and
    pass the approved node. Called by the broker handler on approve."""
    global _ACTIVE_TOTAL
    db = await _get_db()
    try:
        run = (
            await db.execute(
                text("SELECT * FROM workflow_runs WHERE id = :id"),
                {"id": run_id},
            )
        ).fetchone()
        if run is None or run.status != "paused":
            return {
                "ok": False,
                "error": f"run {run_id} is not paused" if run is not None else f"no run {run_id}",
            }
        pause = (
            await db.execute(
                text(
                    "SELECT * FROM workflow_run_pauses "
                    "WHERE run_id = :id AND status = 'pending' "
                    "ORDER BY created_at DESC LIMIT 1"
                ),
                {"id": run_id},
            )
        ).fetchone()
        if pause is None:
            return {"ok": False, "error": f"run {run_id} has no pending pause"}
        snapshot = parse_jsonb(pause.snapshot, {}) or {}
        await db.execute(
            text(
                "UPDATE workflow_run_pauses SET status = 'resolved', "
                "resolved_at = now() WHERE id = :id"
            ),
            {"id": str(pause.id)},
        )
        await db.execute(
            text("UPDATE workflow_runs SET status = 'running' WHERE id = :id"),
            {"id": run_id},
        )
        await db.commit()
        node_results = parse_jsonb(run.node_results, {}) or {}
    finally:
        await db.close()

    serialized = snapshot.get("serialized") or {}
    precomputed = {
        nid: res.get("output")
        for nid, res in node_results.items()
        if isinstance(res, dict) and res.get("status") == "ok"
    }
    workflow_id = str(snapshot.get("workflow_id") or run.workflow_id)
    _HUBS[run_id] = RunHub()
    _ACTIVE_TOTAL += 1
    _ACTIVE_BY_WORKFLOW[workflow_id] = _ACTIVE_BY_WORKFLOW.get(workflow_id, 0) + 1
    asyncio.get_running_loop().create_task(
        _execute_run(
            run_id=run_id,
            workflow_id=workflow_id,
            workflow_name=str(snapshot.get("workflow_name") or run.workflow_name),
            serialized=serialized,
            trigger_payload=snapshot.get("trigger_payload") or {},
            variables=snapshot.get("variables") or {},
            started_by=resumed_by,
            precomputed=precomputed,
            resolved_approvals={str(pause.node_id)},
        ),
        name=f"workflow-resume:{run_id}",
    )
    return {"ok": True, "resumed": True, "run_id": run_id, "node_id": str(pause.node_id)}
