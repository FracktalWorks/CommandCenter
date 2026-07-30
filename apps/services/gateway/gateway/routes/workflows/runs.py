"""Run endpoints: start, history, detail, live SSE (spec F5, F8, F9).

Test runs of the unpublished draft compile on the fly (``draft: true``) so the
editor's "Test ▸" loop needs no publish; real triggers always execute the
published version.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from fastapi.responses import StreamingResponse
from gateway.routes.workflows.core import (
    MAX_RUNS_PAGE,
    _get_db,
    _uid,
    iso,
    load_workflow_or_404,
    parse_jsonb,
    router,
)
from gateway.routes.workflows.engine.graph import (
    GraphValidationError,
    compile_graph,
)
from gateway.routes.workflows.service import (
    RunRejected,
    hub_for,
    load_version_serialized,
    start_run,
)
from pydantic import BaseModel, Field
from sqlalchemy import text


class RunRequest(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)
    draft: bool = False  # compile + run the current draft (Test ▸)


@router.post("/{workflow_id}/run", status_code=202)
async def run_workflow(
    workflow_id: str,
    body: RunRequest,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    db = await _get_db()
    try:
        row = await load_workflow_or_404(db, workflow_id)
        if body.draft:
            ready_modules = (
                await db.execute(
                    text("SELECT id FROM workflow_modules WHERE status = 'ready'"),
                )
            ).fetchall()
            from gateway.routes.workflows.catalog import known_agent_names

            try:
                serialized = compile_graph(
                    parse_jsonb(row.graph, {"nodes": [], "edges": []}),
                    known_modules={str(m.id) for m in ready_modules},
                    known_agents=known_agent_names(),
                )
            except GraphValidationError as exc:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "error": "graph_invalid",
                        "issues": [i.as_dict() for i in exc.issues],
                    },
                ) from exc
            version = int(row.latest_version or 0)
        else:
            if row.status != "published" or not row.latest_version:
                raise HTTPException(
                    status_code=409,
                    detail="Workflow is not published — run as draft or publish first",
                )
            version = int(row.latest_version)
            serialized = await load_version_serialized(db, workflow_id, version)
            if serialized is None:
                raise HTTPException(status_code=500, detail="Published version missing")
        variables = parse_jsonb(row.variables, {})
        name = row.name
    finally:
        await db.close()
    try:
        run_id = await start_run(
            workflow_id=workflow_id,
            workflow_name=name,
            version=version,
            serialized=serialized,
            trigger_kind="manual",
            trigger_payload=body.payload,
            variables=variables,
            started_by=_uid(user),
        )
    except RunRejected as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    return {"run_id": run_id, "status": "running", "version": version}


@router.get("/{workflow_id}/runs")
async def list_runs(
    workflow_id: str,
    limit: int = 25,
    user: UserContext = Depends(get_current_user),
) -> list[dict[str, Any]]:
    limit = max(1, min(limit, MAX_RUNS_PAGE))
    db = await _get_db()
    try:
        rows = (
            await db.execute(
                text(
                    """SELECT id, version, trigger_kind, status, error,
                          started_by, started_at, finished_at
                     FROM workflow_runs WHERE workflow_id = :wid
                    ORDER BY started_at DESC LIMIT :limit"""
                ),
                {"wid": workflow_id, "limit": limit},
            )
        ).fetchall()
    finally:
        await db.close()
    return [
        {
            "id": str(r.id),
            "version": r.version,
            "trigger_kind": r.trigger_kind,
            "status": r.status,
            "error": r.error,
            "started_by": r.started_by,
            "started_at": iso(r.started_at),
            "finished_at": iso(r.finished_at),
        }
        for r in rows
    ]


@router.get("/runs/{run_id}")
async def get_run(
    run_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    db = await _get_db()
    try:
        row = (
            await db.execute(
                text("SELECT * FROM workflow_runs WHERE id = :id"),
                {"id": run_id},
            )
        ).fetchone()
    finally:
        await db.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    status = row.status
    error = row.error
    # Honesty about restarts (spec §3.3): a "running" run with no live hub
    # entry died with the process — report it failed rather than forever-live.
    if status == "running" and hub_for(str(row.id)) is None:
        status = "failed"
        error = error or "interrupted by a platform restart"
    return {
        "id": str(row.id),
        "workflow_id": str(row.workflow_id),
        "workflow_name": row.workflow_name,
        "version": row.version,
        "trigger_kind": row.trigger_kind,
        "trigger_payload": parse_jsonb(row.trigger_payload, {}),
        "status": status,
        "error": error,
        "node_results": parse_jsonb(row.node_results, {}),
        "output": parse_jsonb(row.output, None),
        "started_by": row.started_by,
        "started_at": iso(row.started_at),
        "finished_at": iso(row.finished_at),
    }


@router.get("/runs/{run_id}/stream")
async def stream_run(
    run_id: str,
    user: UserContext = Depends(get_current_user),
) -> StreamingResponse:
    """SSE: replay this run's node events, then tail live until it finishes."""

    async def _generate():
        hub = hub_for(run_id)
        if hub is None:
            # Finished (or lost) run: serve the stored summary once and close.
            db = await _get_db()
            try:
                row = (
                    await db.execute(
                        text(
                            "SELECT status, error, node_results FROM workflow_runs WHERE id = :id"
                        ),
                        {"id": run_id},
                    )
                ).fetchone()
            finally:
                await db.close()
            if row is None:
                yield _sse({"event": "error", "error": "run not found"})
                return
            for node_id, result in (parse_jsonb(row.node_results, {}) or {}).items():
                yield _sse(
                    {
                        "event": "node",
                        "node_id": node_id,
                        "status": result.get("status", "ok"),
                        "output": result.get("output"),
                        "error": result.get("error"),
                    }
                )
            yield _sse({"event": "run", "status": row.status, "error": row.error})
            return

        queue: asyncio.Queue = asyncio.Queue()
        hub.queues.add(queue)
        try:
            for event in list(hub.events):
                yield _sse(event)
            if hub.done:
                return
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if event is None:
                    return
                yield _sse(event)
        finally:
            hub.queues.discard(queue)

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, default=str)}\n\n"
