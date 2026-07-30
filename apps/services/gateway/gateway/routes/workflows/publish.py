"""Publish — compile the draft to an immutable version (spec F6, D3).

Publish is the platform-contract choke point (§3.2 rung 3): the graph must
validate against the live capability catalog (agents, ready modules), carry
no credential-shaped strings, and compile cleanly — or nothing is published.
Runs execute versions, never the draft, so editing never breaks in-flight
automations.
"""

from __future__ import annotations

import json
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.workflows.core import (
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
from sqlalchemy import text


@router.post("/{workflow_id}/publish")
async def publish_workflow(
    workflow_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    db = await _get_db()
    try:
        row = await load_workflow_or_404(db, workflow_id)
        graph = parse_jsonb(row.graph, {"nodes": [], "edges": []})
        ready_modules = (
            await db.execute(
                text("SELECT id FROM workflow_modules WHERE status = 'ready'"),
            )
        ).fetchall()
        from gateway.routes.workflows.catalog import known_agent_names

        try:
            from gateway.routes.workflows.tools import destructive_action_names

            serialized = compile_graph(
                graph,
                known_modules={str(m.id) for m in ready_modules},
                known_agents=known_agent_names(),
                destructive_actions=destructive_action_names(),
            )
        except GraphValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={
                    "error": "graph_invalid",
                    "issues": [i.as_dict() for i in exc.issues],
                },
            ) from exc

        version = int(row.latest_version or 0) + 1
        vrow = (
            await db.execute(
                text(
                    """INSERT INTO workflow_versions
                   (workflow_id, version, serialized, graph, published_by)
                   VALUES (:wid, :v, :serialized ::jsonb, :graph ::jsonb, :by)
                   RETURNING published_at"""
                ),
                {
                    "wid": workflow_id,
                    "v": version,
                    "serialized": json.dumps(serialized, default=str),
                    "graph": json.dumps(graph, default=str),
                    "by": _uid(user),
                },
            )
        ).fetchone()
        await db.execute(
            text(
                """UPDATE workflows SET status = 'published',
                       latest_version = :v, updated_at = now()
                   WHERE id = :id"""
            ),
            {"id": workflow_id, "v": version},
        )
        await db.commit()
    finally:
        await db.close()
    return {
        "workflow_id": workflow_id,
        "version": version,
        "published_at": iso(vrow.published_at),
        "status": "published",
    }


@router.post("/{workflow_id}/disable")
async def disable_workflow(
    workflow_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Stop all triggers firing without deleting anything (spec R2)."""
    db = await _get_db()
    try:
        await load_workflow_or_404(db, workflow_id)
        await db.execute(
            text("UPDATE workflows SET status = 'disabled', updated_at = now() WHERE id = :id"),
            {"id": workflow_id},
        )
        await db.commit()
    finally:
        await db.close()
    return {"workflow_id": workflow_id, "status": "disabled"}
