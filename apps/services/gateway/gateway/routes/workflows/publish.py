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


@router.post("/{workflow_id}/versions/{version}/rollback")
async def rollback_workflow(
    workflow_id: str,
    version: int,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Rollback = republish an old version (spec F6): copy version N's
    immutable snapshot into a NEW version and make it live.

    Deliberately does NOT re-validate against the current catalog as a gate —
    a rollback is usually an incident response, and version N already passed
    publish validation when it shipped. Catalog drift since then (an agent
    renamed, a module retired) is surfaced as non-blocking ``warnings``
    instead. The draft edit-model (``workflows.graph``) is untouched: runs
    execute versions, never the draft, and unpublished edits must survive.
    """
    db = await _get_db()
    try:
        row = await load_workflow_or_404(db, workflow_id)
        vrow = (
            await db.execute(
                text(
                    "SELECT serialized, graph FROM workflow_versions "
                    "WHERE workflow_id = :wid AND version = :v"
                ),
                {"wid": workflow_id, "v": version},
            )
        ).fetchone()
        if vrow is None:
            raise HTTPException(status_code=404, detail=f"No version {version}")
        latest = int(row.latest_version or 0)
        if version == latest and row.status == "published":
            raise HTTPException(
                status_code=409, detail=f"v{version} is already the live version"
            )
        new_version = latest + 1
        await db.execute(
            text(
                """INSERT INTO workflow_versions
                   (workflow_id, version, serialized, graph, published_by)
                   VALUES (:wid, :v, :serialized ::jsonb, :graph ::jsonb, :by)"""
            ),
            {
                "wid": workflow_id,
                "v": new_version,
                "serialized": json.dumps(parse_jsonb(vrow.serialized, {}), default=str),
                "graph": json.dumps(parse_jsonb(vrow.graph, {}), default=str),
                "by": _uid(user),
            },
        )
        await db.execute(
            text(
                """UPDATE workflows SET status = 'published',
                       latest_version = :v, updated_at = now()
                   WHERE id = :id"""
            ),
            {"id": workflow_id, "v": new_version},
        )
        ready_modules = (
            await db.execute(
                text("SELECT id FROM workflow_modules WHERE status = 'ready'"),
            )
        ).fetchall()
        await db.commit()
    finally:
        await db.close()

    warnings: list[dict[str, Any]] = []
    try:
        from gateway.routes.workflows.catalog import known_agent_names
        from gateway.routes.workflows.engine.graph import validate_graph
        from gateway.routes.workflows.tools import destructive_action_names

        warnings = [
            i.as_dict()
            for i in validate_graph(
                parse_jsonb(vrow.graph, {"nodes": [], "edges": []}),
                known_modules={str(m.id) for m in ready_modules},
                known_agents=known_agent_names(),
                destructive_actions=destructive_action_names(),
            )
        ]
    except Exception:  # warnings are advisory — never fail a rollback over them
        warnings = []
    return {
        "workflow_id": workflow_id,
        "version": new_version,
        "rolled_back_to": version,
        "status": "published",
        "warnings": warnings,
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
