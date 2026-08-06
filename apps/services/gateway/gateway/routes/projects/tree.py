"""Projects · tree — the project hierarchy and the grants that scope it.

Spec: ``ai-company-brain/specs/project_management_app.md`` §4 (``tree.py`` row).

    GET    /projects/tree                        → the granted forest, nested
    GET    /projects/nodes                       → the same, flat
    POST   /projects/nodes
    GET    /projects/nodes/{id}
    PATCH  /projects/nodes/{id}
    DELETE /projects/nodes/{id}                  → what cascaded
    POST   /projects/nodes/{id}/move
    GET    /projects/nodes/{id}/grants
    POST   /projects/nodes/{id}/grants
    DELETE /projects/nodes/{id}/grants/{grant_id}

Departments, projects and subprojects are all rows in ``pm_projects`` — a
department is simply a root project whose grant names a Center's group. The
paths say "nodes" rather than "projects" for the plain reason that
``/projects/projects/{id}`` reads like a typo; the resource is a node in one
tree.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.projects.core import (
    PROJECT_SOURCES,
    PROJECT_STATUSES,
    GrantModel,
    ProjectIn,
    ProjectModel,
    _get_db,
    actor,
    assert_no_project_cycle,
    clean_payload,
    count_where,
    diff_changes,
    emit,
    insert_row,
    load_visible_project,
    record_activity,
    resolve_visibility,
    root_project_id,
    router,
    row_to_dict,
    update_row,
    validate_choice,
    validate_grant_subject,
)
from pydantic import BaseModel
from sqlalchemy import text

#: Fields whose change is worth a timeline entry. Deliberately not every column:
#: `updated_at` moves on every write, and a diff that always has an entry is a
#: diff nobody reads.
_TRACKED_PROJECT_FIELDS: tuple[str, ...] = (
    "name", "description", "status", "lead", "parent_project_id",
)

#: Seeded on every ROOT project. The owner reshapes these in the app; they exist
#: so a new project has a working board on its first render rather than an empty
#: status picker.
_SEED_STATUSES: tuple[tuple[str, str, int, str, bool], ...] = (
    ("Backlog",     "gray",   10, "backlog",     True),
    ("To do",       "blue",   20, "todo",        False),
    ("In progress", "amber",  30, "in_progress", False),
    ("Done",        "green",  40, "done",        False),
)

#: 'Epic' is the one system type (§3.4) and carries the only structural rule in
#: the task hierarchy. There is deliberately no 'Subtask' type.
_SEED_TYPES: tuple[tuple[str, str | None, bool, bool], ...] = (
    ("Task", "circle-check", True, False),
    ("Bug",  "bug",          False, False),
    ("Epic", "layers",       False, True),
)


class MoveProject(BaseModel):
    parent_project_id: str | None = None
    position: float | None = None


class GrantIn(BaseModel):
    subject: str


class DeleteResponse(BaseModel):
    """R7/R8 — a destructive route says what it destroyed, per table."""

    deleted: str
    cascaded: dict[str, int]


# ── Reads ───────────────────────────────────────────────────────────────────

async def _visible_projects(db: Any, user: UserContext) -> list[Any]:
    vis = await resolve_visibility(db, user)
    return (await db.execute(
        text(
            f"SELECT * FROM pm_projects WHERE {vis.project_clause()} "
            f"ORDER BY position NULLS LAST, name"
        ),
        vis.params,
    )).fetchall()


@router.get("/tree")
async def get_tree(user: UserContext = Depends(get_current_user)) -> dict:
    """The caller's forest, nested.

    Built in Python from the flat visible set rather than by a recursive read:
    the visibility subquery already walks the grant closure once, and nesting
    what came back costs nothing. A node whose parent is *not* visible surfaces
    as a root here — that is not a bug to fix by hiding it, it is the shape of a
    subtree granted to a Center without its parent department.
    """
    db = await _get_db()
    try:
        rows = await _visible_projects(db, user)
    finally:
        await db.close()

    nodes = {str(r.id): {**row_to_dict(r, ProjectModel), "children": []} for r in rows}
    roots: list[dict] = []
    for node in nodes.values():
        parent = nodes.get(str(node.get("parent_project_id") or ""))
        (parent["children"] if parent else roots).append(node)
    return {"rows": roots, "total": len(nodes)}


@router.get("/nodes")
async def list_nodes(user: UserContext = Depends(get_current_user)) -> dict:
    db = await _get_db()
    try:
        rows = await _visible_projects(db, user)
    finally:
        await db.close()
    return {"rows": [row_to_dict(r, ProjectModel) for r in rows], "total": len(rows)}


@router.get("/nodes/{project_id}")
async def get_node(
    project_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        row = await load_visible_project(db, vis, project_id)
        return row_to_dict(row, ProjectModel)
    finally:
        await db.close()


# ── Writes ──────────────────────────────────────────────────────────────────

async def _seed_root(db: Any, project_id: str, created_by: str) -> None:
    """Give a new root project a working board.

    Statuses, types and one list view. The counter row is NOT seeded here — it
    is created by ``next_task_number``'s upsert on the first task, so there is
    one place that can allocate a number and no way to have a counter without
    having gone through it.
    """
    for name, color, position, category, is_default in _SEED_STATUSES:
        await insert_row(db, "pm_task_statuses", {
            "project_id": project_id, "name": name, "color": color,
            "position": position, "category": category, "is_default": is_default,
        })
    for name, icon, is_default, is_system in _SEED_TYPES:
        await insert_row(db, "pm_task_types", {
            "project_id": project_id, "name": name, "icon": icon,
            "is_default": is_default, "is_system": is_system,
        })
    await insert_row(db, "pm_views", {
        "project_id": project_id, "name": "All tasks", "view_type": "list",
        "config": {"sort_by": "created_at", "filters": {"include_subtree": True}},
        "position": 100.0, "created_by": created_by,
    })
    await insert_row(db, "pm_views", {
        "project_id": project_id, "name": "Board", "view_type": "board",
        "config": {
            "column_by": "status", "sort_by": "manual",
            "filters": {"include_subtree": True},
        },
        "position": 200.0, "created_by": created_by,
    })


@router.post("/nodes", status_code=201)
async def create_node(
    payload: ProjectIn, user: UserContext = Depends(get_current_user),
) -> dict:
    values = clean_payload(payload)
    name = str(values.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="A project needs a name.")
    validate_choice(values.get("status"), PROJECT_STATUSES, "project status")
    validate_choice(values.get("source"), PROJECT_SOURCES, "source")
    values["name"] = name
    values["created_by"] = actor(user)

    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        parent_id = values.get("parent_project_id")
        if parent_id:
            # Creating INSIDE a project requires seeing it — otherwise a caller
            # could graft a subtree onto another department by guessing an id,
            # and inherit that department's grants for it.
            await load_visible_project(db, vis, str(parent_id))

        row = await insert_row(db, "pm_projects", values)
        project_id = str(row.id)

        if parent_id is None:
            await _seed_root(db, project_id, actor(user))
            # A root project starts org-visible so a solo org is not immediately
            # locked out of the thing it just created. It is an ordinary grant
            # row: the importer writes `group:<slug>` instead (§7.1), and
            # removing this one is how scoping starts.
            await insert_row(db, "pm_project_grants", {
                "project_id": project_id, "subject": "org",
                "created_by": actor(user),
            })

        await record_activity(
            db, activity_type="system", created_by=actor(user),
            project_id=project_id, body=f"Project '{name}' created",
        )
        await db.commit()
        result = row_to_dict(row, ProjectModel)
    finally:
        await db.close()

    await emit("pm.project.created", {"project_id": project_id, "name": name})
    return result


@router.patch("/nodes/{project_id}")
async def patch_node(
    project_id: str, payload: ProjectIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    values = clean_payload(payload)
    validate_choice(values.get("status"), PROJECT_STATUSES, "project status")
    validate_choice(values.get("source"), PROJECT_SOURCES, "source")
    # Re-parenting is a MOVE, with its own cycle check and root re-stamping.
    # Accepting it here as an ordinary field would skip both.
    if "parent_project_id" in values:
        raise HTTPException(
            status_code=422,
            detail="Use POST /projects/nodes/{id}/move to re-parent a project.",
        )

    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        before = await load_visible_project(db, vis, project_id)
        if not values:
            return row_to_dict(before, ProjectModel)
        after = await update_row(db, "pm_projects", project_id, values)
        changes = diff_changes(before, after, _TRACKED_PROJECT_FIELDS)
        if changes:
            await record_activity(
                db, activity_type="field_change", created_by=actor(user),
                project_id=project_id, meta={"changes": changes},
            )
        await db.commit()
        result = row_to_dict(after, ProjectModel)
    finally:
        await db.close()

    await emit("pm.project.updated", {"project_id": project_id})
    return result


@router.post("/nodes/{project_id}/move")
async def move_node(
    project_id: str, payload: MoveProject,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Re-parent or reorder a project.

    Moving a subtree re-stamps ``root_project_id`` on **every task beneath it**,
    because that column is what scopes statuses, types and the task counter. A
    move that left it stale would leave tasks pointing at another project's
    status rows — visible immediately as lanes that do not exist on the board.
    """
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, project_id)
        new_parent = payload.parent_project_id
        if new_parent:
            await load_visible_project(db, vis, str(new_parent))
        await assert_no_project_cycle(db, project_id, new_parent)

        values: dict[str, Any] = {"parent_project_id": new_parent}
        if payload.position is not None:
            values["position"] = payload.position
        row = await update_row(db, "pm_projects", project_id, values)

        new_root = await root_project_id(db, project_id)
        await db.execute(
            text(
                "UPDATE pm_tasks SET root_project_id = CAST(:root AS uuid) "
                "WHERE project_id IN ("
                "  WITH RECURSIVE sub AS ("
                "    SELECT id FROM pm_projects WHERE id = CAST(:pid AS uuid)"
                "    UNION ALL"
                "    SELECT p.id FROM pm_projects p JOIN sub s"
                "      ON p.parent_project_id = s.id"
                "  ) SELECT id FROM sub)"
            ),
            {"root": new_root, "pid": project_id},
        )
        await record_activity(
            db, activity_type="system", created_by=actor(user),
            project_id=project_id, body="Project moved",
        )
        await db.commit()
        result = row_to_dict(row, ProjectModel)
    finally:
        await db.close()

    await emit("pm.project.moved", {"project_id": project_id})
    return result


@router.delete("/nodes/{project_id}")
async def delete_node(
    project_id: str, user: UserContext = Depends(get_current_user),
) -> DeleteResponse:
    """Delete a project and everything under it, and say what that was.

    R7/R8. The counts are read BEFORE the delete: afterwards the rows are gone
    and the honest number is unobtainable, which is how a destructive route ends
    up reporting zero.
    """
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, project_id)

        subtree = (await db.execute(
            text(
                "WITH RECURSIVE sub AS ("
                "  SELECT id FROM pm_projects WHERE id = CAST(:pid AS uuid)"
                "  UNION ALL"
                "  SELECT p.id FROM pm_projects p JOIN sub s"
                "    ON p.parent_project_id = s.id"
                ") SELECT count(*) FROM sub"
            ),
            {"pid": project_id},
        )).scalar() or 0
        tasks = (await db.execute(
            text(
                "SELECT count(*) FROM pm_tasks WHERE project_id IN ("
                "  WITH RECURSIVE sub AS ("
                "    SELECT id FROM pm_projects WHERE id = CAST(:pid AS uuid)"
                "    UNION ALL"
                "    SELECT p.id FROM pm_projects p JOIN sub s"
                "      ON p.parent_project_id = s.id"
                "  ) SELECT id FROM sub)"
            ),
            {"pid": project_id},
        )).scalar() or 0
        grants = await count_where(db, "pm_project_grants", "project_id", project_id)

        await db.execute(
            text("DELETE FROM pm_projects WHERE id = CAST(:pid AS uuid)"),
            {"pid": project_id},
        )
        await db.commit()
    finally:
        await db.close()

    await emit("pm.project.deleted", {"project_id": project_id})
    return DeleteResponse(
        deleted=project_id,
        cascaded={
            # Subprojects include this project itself, so the caller sees the
            # true number of rows that disappeared rather than a count that
            # excludes the one they named.
            "projects": int(subtree),
            "tasks": int(tasks),
            "grants": int(grants),
        },
    )


# ── Grants ──────────────────────────────────────────────────────────────────

@router.get("/nodes/{project_id}/grants")
async def list_grants(
    project_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, project_id)
        rows = (await db.execute(
            text(
                "SELECT * FROM pm_project_grants "
                "WHERE project_id = CAST(:pid AS uuid) ORDER BY subject"
            ),
            {"pid": project_id},
        )).fetchall()
        return {
            "rows": [row_to_dict(r, GrantModel) for r in rows], "total": len(rows),
        }
    finally:
        await db.close()


@router.post("/nodes/{project_id}/grants", status_code=201)
async def create_grant(
    project_id: str, payload: GrantIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Grant a subject access to this project's subtree.

    A caller-reachable creation path is deliberate, not implied: WS-14 C1's
    review found an acceptance that could go green with no way to create a
    grant at all, and the same hole here would make every scoping test a
    fixture INSERT proving nothing about the API.
    """
    subject = validate_grant_subject(payload.subject)
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, project_id)
        row = (await db.execute(
            text(
                "INSERT INTO pm_project_grants (project_id, subject, created_by) "
                "VALUES (CAST(:pid AS uuid), :subject, :who) "
                "ON CONFLICT (project_id, subject) DO UPDATE SET subject = "
                "EXCLUDED.subject RETURNING *"
            ),
            {"pid": project_id, "subject": subject, "who": actor(user)},
        )).fetchone()
        await record_activity(
            db, activity_type="system", created_by=actor(user),
            project_id=project_id, body=f"Granted to {subject}",
        )
        await db.commit()
        return row_to_dict(row, GrantModel)
    finally:
        await db.close()


@router.delete("/nodes/{project_id}/grants/{grant_id}")
async def delete_grant(
    project_id: str, grant_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, project_id)
        row = (await db.execute(
            text(
                "DELETE FROM pm_project_grants "
                "WHERE id = CAST(:gid AS uuid) AND project_id = CAST(:pid AS uuid) "
                "RETURNING subject"
            ),
            {"gid": grant_id, "pid": project_id},
        )).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Grant not found")
        await record_activity(
            db, activity_type="system", created_by=actor(user),
            project_id=project_id, body=f"Revoked {row.subject}",
        )
        await db.commit()
        return {"deleted": grant_id, "subject": row.subject}
    finally:
        await db.close()
