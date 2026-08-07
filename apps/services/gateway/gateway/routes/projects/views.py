"""Projects · views — saved views and per-view manual order.

Spec: ``ai-company-brain/specs/project_management_app.md`` §4 (``views.py`` row).

    GET    /projects/nodes/{project_id}/views
    POST   /projects/nodes/{project_id}/views
    PATCH  /projects/views/{view_id}
    DELETE /projects/views/{view_id}
    GET    /projects/views/{view_id}/positions
    PUT    /projects/views/{view_id}/positions      → bulk upsert

**Ordering is per view** (D-PM-5). There is no rank column on ``pm_tasks``,
because the People Center's master board and a Center slice must be able to
order the same task differently — one column cannot serve two views without
them fighting over it. Positions are floats and a drag writes exactly one row:
between two neighbours is ``(prev + next) / 2``.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.projects.core import (
    ViewModel,
    _get_db,
    actor,
    clean_payload,
    insert_row,
    load_visible_project,
    require_row,
    resolve_visibility,
    router,
    row_to_dict,
    update_row,
)
from pydantic import BaseModel
from sqlalchemy import text

VIEW_TYPES: tuple[str, ...] = ("list", "board")

#: The ceiling on one bulk position write. Generous — a board column
#: materialising its order sends every task in the group — but not unbounded: a
#: single request that can write the whole table is a denial-of-service surface
#: rather than a feature.
MAX_POSITIONS = 1000


class ViewIn(BaseModel):
    name: str | None = None
    view_type: str | None = None
    config: dict | None = None
    position: float | None = None


class PositionIn(BaseModel):
    task_id: str
    position: float
    group_key: str | None = None


class PositionsIn(BaseModel):
    positions: list[PositionIn]


@router.get("/nodes/{project_id}/views")
async def list_views(
    project_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, project_id)
        rows = (await db.execute(
            text(
                "SELECT * FROM pm_views WHERE project_id = CAST(:pid AS uuid) "
                "ORDER BY position NULLS LAST, name"
            ),
            {"pid": project_id},
        )).fetchall()
        return {
            "rows": [row_to_dict(r, ViewModel) for r in rows], "total": len(rows),
        }
    finally:
        await db.close()


@router.post("/nodes/{project_id}/views", status_code=201)
async def create_view(
    project_id: str, payload: ViewIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    values = clean_payload(payload)
    name = str(values.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="A view needs a name.")
    view_type = values.get("view_type") or "list"
    if view_type not in VIEW_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown view type '{view_type}'. One of: {list(VIEW_TYPES)}.",
        )
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, project_id)
        row = await insert_row(db, "pm_views", {
            "project_id": project_id, "name": name, "view_type": view_type,
            "config": values.get("config") or {},
            "position": values.get("position"),
            "created_by": actor(user),
        })
        await db.commit()
        return row_to_dict(row, ViewModel)
    finally:
        await db.close()


@router.patch("/views/{view_id}")
async def patch_view(
    view_id: str, payload: ViewIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    values = clean_payload(payload)
    if values.get("view_type") and values["view_type"] not in VIEW_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown view type '{values['view_type']}'. "
                   f"One of: {list(VIEW_TYPES)}.",
        )
    db = await _get_db()
    try:
        existing = await require_row(db, "pm_views", view_id, "View")
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, str(existing.project_id))
        if not values:
            return row_to_dict(existing, ViewModel)
        row = await update_row(db, "pm_views", view_id, values)
        await db.commit()
        return row_to_dict(row, ViewModel)
    finally:
        await db.close()


@router.delete("/views/{view_id}")
async def delete_view(
    view_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    """Delete a view and the manual order that belonged to it.

    ``pm_view_task_positions`` CASCADEs, which is correct — the order was the
    view's, not the tasks' — but the count is reported anyway (R7/R8), because
    losing a hand-arranged board silently is exactly the surprise that makes
    people distrust a delete button.
    """
    db = await _get_db()
    try:
        existing = await require_row(db, "pm_views", view_id, "View")
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, str(existing.project_id))
        positions = (await db.execute(
            text(
                "SELECT count(*) FROM pm_view_task_positions "
                "WHERE view_id = CAST(:vid AS uuid)"
            ),
            {"vid": view_id},
        )).scalar() or 0
        await db.execute(
            text("DELETE FROM pm_views WHERE id = CAST(:vid AS uuid)"),
            {"vid": view_id},
        )
        await db.commit()
        return {"deleted": view_id, "cascaded": {"positions": int(positions)}}
    finally:
        await db.close()


# ── Manual order ────────────────────────────────────────────────────────────

async def _load_visible_view(db: Any, user: UserContext, view_id: str) -> Any:
    view = await require_row(db, "pm_views", view_id, "View")
    vis = await resolve_visibility(db, user)
    await load_visible_project(db, vis, str(view.project_id))
    return view


@router.get("/views/{view_id}/positions")
async def get_positions(
    view_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    db = await _get_db()
    try:
        await _load_visible_view(db, user, view_id)
        rows = (await db.execute(
            text(
                "SELECT task_id, position, group_key FROM pm_view_task_positions "
                "WHERE view_id = CAST(:vid AS uuid) ORDER BY group_key, position"
            ),
            {"vid": view_id},
        )).fetchall()
        return {
            "rows": [
                {
                    "task_id": str(r.task_id),
                    "position": float(r.position),
                    "group_key": r.group_key,
                }
                for r in rows
            ],
            "total": len(rows),
        }
    finally:
        await db.close()


@router.put("/views/{view_id}/positions")
async def set_positions(
    view_id: str, payload: PositionsIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Upsert manual positions for this view.

    Bulk by design, and it is the *preferred* shape rather than a convenience:
    a single drag writes one entry, but the first drag into an unordered group
    has to materialise positions for every task in it at once, and doing that as
    N requests would leave the order half-applied if one failed.
    """
    if len(payload.positions) > MAX_POSITIONS:
        raise HTTPException(
            status_code=422,
            detail=f"At most {MAX_POSITIONS} positions per request; "
                   f"got {len(payload.positions)}.",
        )
    db = await _get_db()
    try:
        await _load_visible_view(db, user, view_id)
        for entry in payload.positions:
            await db.execute(
                text(
                    "INSERT INTO pm_view_task_positions "
                    "(view_id, task_id, position, group_key) "
                    "VALUES (CAST(:vid AS uuid), CAST(:tid AS uuid), :pos, :grp) "
                    "ON CONFLICT (view_id, task_id) DO UPDATE "
                    "SET position = EXCLUDED.position, "
                    "    group_key = EXCLUDED.group_key, "
                    "    updated_at = now()"
                ),
                {
                    "vid": view_id, "tid": entry.task_id,
                    "pos": entry.position, "grp": entry.group_key,
                },
            )
        await db.commit()
        return {"view_id": view_id, "written": len(payload.positions)}
    finally:
        await db.close()
