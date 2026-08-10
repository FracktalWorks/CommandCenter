"""Projects · admin — task statuses and task types, per root project.

Spec: ``project-docs/specs/project_management_app.md`` §4 (``admin.py`` row).

    GET    /projects/nodes/{project_id}/statuses
    POST   /projects/nodes/{project_id}/statuses
    PATCH  /projects/statuses/{status_id}
    DELETE /projects/statuses/{status_id}          → 409 while in use
    GET    /projects/nodes/{project_id}/types
    POST   /projects/nodes/{project_id}/types
    PATCH  /projects/types/{type_id}
    DELETE /projects/types/{type_id}

Statuses are DATA, not an enum (§3.3): the importer has to represent ClickUp's
real per-list status names and the owner has to reshape a workflow without a
deploy. ``category`` is the machine-readable half and is the only part other
code may key off.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.projects.core import (
    EPIC_TYPE_NAME,
    STATUS_CATEGORIES,
    StatusModel,
    TypeModel,
    _tenant_session,
    clean_payload,
    count_where,
    load_visible_project,
    require_row,
    resolve_visibility,
    root_project_id,
    router,
    row_to_dict,
    update_row,
    validate_choice,
)
from pydantic import BaseModel
from sqlalchemy import text


class StatusIn(BaseModel):
    name: str | None = None
    color: str | None = None
    position: int | None = None
    category: str | None = None
    is_default: bool | None = None


class TypeIn(BaseModel):
    name: str | None = None
    icon: str | None = None
    color: str | None = None
    is_default: bool | None = None
    #: WS-27ae / P-28. Unlike `is_system`, this IS the caller's to set: it says
    #: "this type is a top level", which is a workflow decision a project makes
    #: about its own vocabulary. `is_system` stays a hard-coded literal below,
    #: because that one grants an exemption rather than accepting a rule.
    is_epic: bool | None = None


async def _root_for(db: Any, vis: Any, project_id: str) -> str:
    """The root whose statuses and types a project inherits.

    Configuration is root-scoped and the subtree inherits, so a caller may pass
    any node in the tree and reach the same set — otherwise every subproject
    would need its own duplicated workflow.
    """
    await load_visible_project(db, vis, project_id)
    return await root_project_id(db, project_id)


async def _clear_other_defaults(db: Any, table: str, root: str, keep: str) -> None:
    """Exactly one default per project.

    The migration cannot express this — a partial unique index would need the
    project in its predicate — so it is enforced here, by demoting the others
    rather than refusing the write. Refusing would make "make this the default"
    a two-step operation that is broken in between.
    """
    await db.execute(
        text(
            f"UPDATE {table} SET is_default = false "
            f"WHERE project_id = CAST(:root AS uuid) AND id <> CAST(:keep AS uuid)"
        ),
        {"root": root, "keep": keep},
    )


# ── Statuses ────────────────────────────────────────────────────────────────

@router.get("/nodes/{project_id}/statuses")
async def list_statuses(
    project_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        root = await _root_for(db, vis, project_id)
        rows = (await db.execute(
            text(
                "SELECT * FROM pm_task_statuses WHERE project_id = CAST(:root AS uuid) "
                "ORDER BY position, name"
            ),
            {"root": root},
        )).fetchall()
        return {
            "rows": [row_to_dict(r, StatusModel) for r in rows], "total": len(rows),
        }


@router.post("/nodes/{project_id}/statuses", status_code=201)
async def create_status(
    project_id: str, payload: StatusIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    values = clean_payload(payload)
    name = str(values.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="A status needs a name.")
    category = values.get("category") or "todo"
    validate_choice(category, STATUS_CATEGORIES, "status category")

    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        root = await _root_for(db, vis, project_id)
        row = (await db.execute(
            text(
                "INSERT INTO pm_task_statuses "
                "(project_id, name, color, position, category, is_default) "
                "VALUES (CAST(:root AS uuid), :name, :color, :position, "
                "        :category, :is_default) RETURNING *"
            ),
            {
                "root": root, "name": name,
                "color": values.get("color") or "gray",
                "position": values.get("position") or 0,
                "category": category,
                "is_default": bool(values.get("is_default")),
            },
        )).fetchone()
        if row.is_default:
            await _clear_other_defaults(db, "pm_task_statuses", root, str(row.id))
        return row_to_dict(row, StatusModel)


@router.patch("/statuses/{status_id}")
async def patch_status(
    status_id: str, payload: StatusIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    values = clean_payload(payload)
    validate_choice(values.get("category"), STATUS_CATEGORIES, "status category")
    async with _tenant_session() as db:
        existing = await require_row(db, "pm_task_statuses", status_id, "Status")
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, str(existing.project_id))
        if not values:
            return row_to_dict(existing, StatusModel)
        row = await update_row(db, "pm_task_statuses", status_id, values)
        if values.get("is_default"):
            await _clear_other_defaults(
                db, "pm_task_statuses", str(row.project_id), status_id,
            )
        return row_to_dict(row, StatusModel)


@router.delete("/statuses/{status_id}")
async def delete_status(
    status_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    """Delete a status, unless tasks are still in it.

    ``pm_tasks.status_id`` is ``ON DELETE RESTRICT``, so the database would
    refuse this anyway — as an opaque IntegrityError 500. Counting first turns
    that into a 409 naming how many tasks are in the way, which is the number
    the caller needs to decide what to do next.
    """
    async with _tenant_session() as db:
        existing = await require_row(db, "pm_task_statuses", status_id, "Status")
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, str(existing.project_id))
        in_use = await count_where(db, "pm_tasks", "status_id", status_id)
        if in_use:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"'{existing.name}' still holds {in_use} task(s). "
                    "Move them to another status first."
                ),
            )
        await db.execute(
            text("DELETE FROM pm_task_statuses WHERE id = CAST(:sid AS uuid)"),
            {"sid": status_id},
        )
        return {"deleted": status_id, "tasks_affected": 0}


# ── Types ───────────────────────────────────────────────────────────────────

@router.get("/nodes/{project_id}/types")
async def list_types(
    project_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        root = await _root_for(db, vis, project_id)
        rows = (await db.execute(
            text(
                "SELECT * FROM pm_task_types WHERE project_id = CAST(:root AS uuid) "
                "ORDER BY name"
            ),
            {"root": root},
        )).fetchall()
        return {
            "rows": [row_to_dict(r, TypeModel) for r in rows], "total": len(rows),
        }


@router.post("/nodes/{project_id}/types", status_code=201)
async def create_type(
    project_id: str, payload: TypeIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    values = clean_payload(payload)
    name = str(values.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="A task type needs a name.")

    async with _tenant_session() as db:
        vis = await resolve_visibility(db, user)
        root = await _root_for(db, vis, project_id)
        row = (await db.execute(
            text(
                "INSERT INTO pm_task_types "
                "(project_id, name, icon, color, is_default, is_epic, "
                " is_system) "
                "VALUES (CAST(:root AS uuid), :name, :icon, :color, "
                "        :is_default, :is_epic, false) RETURNING *"
            ),
            {
                "root": root, "name": name,
                "icon": values.get("icon"), "color": values.get("color"),
                "is_default": bool(values.get("is_default")),
                "is_epic": bool(values.get("is_epic")),
            },
        )).fetchone()
        # is_system is written as a literal false, never from the payload: the
        # Epic rule keys off it (§3.4), so a caller able to set it could mint a
        # second root-only type — or, worse, a type that claims Epic's exemption.
        if row.is_default:
            await _clear_other_defaults(db, "pm_task_types", root, str(row.id))
        return row_to_dict(row, TypeModel)


@router.patch("/types/{type_id}")
async def patch_type(
    type_id: str, payload: TypeIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    values = clean_payload(payload)
    async with _tenant_session() as db:
        existing = await require_row(db, "pm_task_types", type_id, "Task type")
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, str(existing.project_id))
        if getattr(existing, "is_system", False) and "name" in values:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"'{EPIC_TYPE_NAME}' is a system type and cannot be renamed; "
                    "the hierarchy rule keys off it."
                ),
            )
        # WS-27ae — and it cannot be un-flagged either, for exactly the same
        # reason the rename is refused. `core.is_epic_type` still recognises the
        # seeded system type by name, so clearing the flag would answer 200 and
        # change nothing: a write that reports success while the rule stays on
        # is worse than one that says no.
        if getattr(existing, "is_system", False) and values.get("is_epic") is False:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"'{EPIC_TYPE_NAME}' is a system type and stays the top "
                    "level; the hierarchy rule keys off it."
                ),
            )
        if not values:
            return row_to_dict(existing, TypeModel)
        row = await update_row(db, "pm_task_types", type_id, values)
        if values.get("is_default"):
            await _clear_other_defaults(
                db, "pm_task_types", str(row.project_id), type_id,
            )
        return row_to_dict(row, TypeModel)


@router.delete("/types/{type_id}")
async def delete_type(
    type_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    """Delete a task type. Tasks carrying it keep existing, untyped.

    ``pm_tasks.type_id`` is ``ON DELETE SET NULL`` — unlike a status, a type
    carries no workflow semantics, so losing it costs a label rather than a
    lane. The count is reported (R7/R8) because "12 tasks became untyped" is
    not something to discover from a board.
    """
    async with _tenant_session() as db:
        existing = await require_row(db, "pm_task_types", type_id, "Task type")
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, str(existing.project_id))
        if getattr(existing, "is_system", False):
            raise HTTPException(
                status_code=409,
                detail=f"'{EPIC_TYPE_NAME}' is a system type and cannot be deleted.",
            )
        affected = await count_where(db, "pm_tasks", "type_id", type_id)
        await db.execute(
            text("DELETE FROM pm_task_types WHERE id = CAST(:tid AS uuid)"),
            {"tid": type_id},
        )
        return {"deleted": type_id, "tasks_untyped": affected}
