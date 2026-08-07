"""Projects · tasks — task CRUD, the list contract, assignees and links.

Spec: ``ai-company-brain/specs/project_management_app.md`` §4 (``tasks.py`` row).

    GET    /projects/tasks                       → {rows, total}
    POST   /projects/tasks
    GET    /projects/tasks/{id}
    PATCH  /projects/tasks/{id}
    DELETE /projects/tasks/{id}                  → what cascaded
    POST   /projects/tasks/{id}/move
    PUT    /projects/tasks/{id}/assignees        → replaces the set
    POST   /projects/tasks/{id}/links
    DELETE /projects/tasks/{id}/links/{link_id}

Subtasks are tasks with a ``parent_task_id`` — there is no second endpoint and
no second table (§3.5). ``?parent_task_id=`` lists one task's children;
``?include_subtree=`` widens a project filter to its descendants.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.projects.core import (
    DIRECTIONS,
    TASK_SORTS,
    TASK_SOURCES,
    ListResponse,
    Page,
    TaskIn,
    TaskModel,
    _get_db,
    actor,
    apply_status_transition,
    assert_epic_has_no_parent,
    assert_no_task_cycle,
    clean_payload,
    count_where,
    diff_changes,
    emit,
    insert_row,
    load_default_status,
    load_visible_project,
    load_visible_task,
    next_task_number,
    record_activity,
    require_status_in_project,
    resolve_visibility,
    root_project_id,
    router,
    row_to_dict,
    task_visibility_clause,
    update_row,
    validate_choice,
)
from gateway.routes.projects.notifications import notify
from pydantic import BaseModel
from sqlalchemy import text

#: Fields whose change earns a timeline entry. `status_id` is absent on purpose:
#: a status move is a TRANSITION and gets its own richer activity, so listing it
#: here too would write the same fact twice under two types.
_TRACKED_TASK_FIELDS: tuple[str, ...] = (
    "title", "description", "importance", "due_at", "start_date",
    "estimate_mins", "type_id", "parent_task_id", "project_id",
)

_LINK_TYPES: tuple[str, ...] = ("blocks", "relates_to", "duplicates")


class MoveTask(BaseModel):
    project_id: str | None = None
    parent_task_id: str | None = None


class AssigneesIn(BaseModel):
    assignees: list[str]


class LinkIn(BaseModel):
    target_task_id: str
    link_type: str = "relates_to"


class DeleteResponse(BaseModel):
    deleted: str
    cascaded: dict[str, int]


# ── List ────────────────────────────────────────────────────────────────────

@router.get("/tasks")
async def list_tasks(
    user: UserContext = Depends(get_current_user),
    project_id: str | None = None,
    include_subtree: bool = False,
    parent_task_id: str | None = None,
    status_id: str | None = None,
    assignee: str | None = None,
    q: str | None = None,
    sort: str | None = None,
    direction: str = "desc",
    page: Page = Depends(),
    include_archived: bool = False,
) -> ListResponse:
    """The one task-list endpoint every surface reads through.

    Paca's lesson: list, board and any saved view are the same query with
    different filters, so growing a second endpoint per surface is how the
    filters start disagreeing about what a member may see.

    An unknown sort key is a **422**, deliberately not a silent fall back to the
    default — a client sorting by a column it believes exists and quietly
    getting ``created_at`` is a bug that survives review.
    """
    column = TASK_SORTS.get(sort or "created_at")
    if column is None:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown sort key '{sort}'. One of: {sorted(TASK_SORTS)}.",
        )
    order = DIRECTIONS.get((direction or "").lower())
    if order is None:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown sort direction '{direction}'. One of: asc, desc.",
        )

    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        clauses: list[str] = [task_visibility_clause(vis)]
        params: dict[str, Any] = dict(vis.params)

        if project_id:
            # Seeing the project is required to filter by it, so an unreadable
            # id answers 404 rather than an empty list — an empty list would
            # tell the caller the project exists and is simply empty.
            await load_visible_project(db, vis, project_id)
            if include_subtree:
                clauses.append(
                    "t.project_id IN ("
                    "  WITH RECURSIVE sub AS ("
                    "    SELECT id FROM pm_projects WHERE id = CAST(:pid AS uuid)"
                    "    UNION ALL"
                    "    SELECT p.id FROM pm_projects p JOIN sub s"
                    "      ON p.parent_project_id = s.id"
                    "  ) SELECT id FROM sub)"
                )
            else:
                clauses.append("t.project_id = CAST(:pid AS uuid)")
            params["pid"] = project_id
        if parent_task_id:
            clauses.append("t.parent_task_id = CAST(:parent AS uuid)")
            params["parent"] = parent_task_id
        if status_id:
            clauses.append("t.status_id = CAST(:status_id AS uuid)")
            params["status_id"] = status_id
        if assignee:
            clauses.append(
                "EXISTS (SELECT 1 FROM pm_task_assignees a "
                "        WHERE a.task_id = t.id AND lower(a.assignee) = :assignee)"
            )
            params["assignee"] = assignee.strip().lower()
        if q:
            clauses.append("(t.title ILIKE :q OR t.description ILIKE :q)")
            params["q"] = f"%{q.strip()}%"
        if not include_archived:
            clauses.append("t.archived_at IS NULL")

        where = " WHERE " + " AND ".join(clauses)
        total = (await db.execute(
            text(f"SELECT count(*) FROM pm_tasks t{where}"), params,
        )).scalar() or 0
        rows = (await db.execute(
            text(
                f"SELECT t.* FROM pm_tasks t{where} "
                f"ORDER BY {column} {order} NULLS LAST, t.id {order} "
                f"LIMIT :limit OFFSET :offset"
            ),
            {**params, "limit": page.limit, "offset": page.offset},
        )).fetchall()
        return ListResponse(
            rows=[row_to_dict(r, TaskModel) for r in rows], total=int(total),
        )
    finally:
        await db.close()


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        row = await load_visible_task(db, vis, task_id)
        result = row_to_dict(row, TaskModel)
        assignees = (await db.execute(
            text(
                "SELECT assignee FROM pm_task_assignees "
                "WHERE task_id = CAST(:tid AS uuid) ORDER BY assignee"
            ),
            {"tid": task_id},
        )).fetchall()
        result["assignees"] = [r.assignee for r in assignees]
        return result
    finally:
        await db.close()


# ── Writes ──────────────────────────────────────────────────────────────────

@router.post("/tasks", status_code=201)
async def create_task(
    payload: TaskIn, user: UserContext = Depends(get_current_user),
) -> dict:
    values = clean_payload(payload)
    title = str(values.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=422, detail="A task needs a title.")
    project_id = values.get("project_id")
    if not project_id:
        raise HTTPException(status_code=422, detail="A task needs a project_id.")
    validate_choice(values.get("source"), TASK_SOURCES, "source")
    values["title"] = title
    values["created_by"] = actor(user)

    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_project(db, vis, str(project_id))
        root = await root_project_id(db, str(project_id))
        values["root_project_id"] = root

        parent_id = values.get("parent_task_id")
        if parent_id:
            await load_visible_task(db, vis, str(parent_id))
        await assert_epic_has_no_parent(db, values.get("type_id"), parent_id)

        status = (
            await require_status_in_project(db, root, str(values["status_id"]))
            if values.get("status_id")
            else await load_default_status(db, root)
        )
        values["status_id"] = str(status.id)
        values["task_number"] = await next_task_number(db, root)

        row = await insert_row(db, "pm_tasks", values)
        task_id = str(row.id)
        await record_activity(
            db, activity_type="system", created_by=actor(user),
            task_id=task_id, body="Task created",
        )
        await db.commit()
        result = row_to_dict(row, TaskModel)
    finally:
        await db.close()

    await emit("pm.task.created", {
        "task_id": task_id, "project_id": str(project_id), "title": title,
    })
    return result


@router.patch("/tasks/{task_id}")
async def patch_task(
    task_id: str, payload: TaskIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Update a task. A body that moves ``status_id`` is a status TRANSITION.

    Which is why the status is split out and delegated to
    ``core.apply_status_transition`` rather than written with the other columns:
    the transition owes ``completed_at`` and a timeline entry, and a PATCH that
    writes only the column would look correct in the UI while emptying the
    timeline (the CRM's finding, restated here because the shape is identical).
    """
    values = clean_payload(payload)
    validate_choice(values.get("source"), TASK_SOURCES, "source")
    for guarded, endpoint in (
        ("project_id", "move"), ("parent_task_id", "move"),
    ):
        if guarded in values:
            raise HTTPException(
                status_code=422,
                detail=f"Use POST /projects/tasks/{{id}}/{endpoint} to change "
                       f"'{guarded}'.",
            )
    new_status = values.pop("status_id", None)

    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        before = await load_visible_task(db, vis, task_id)

        after = before
        if values:
            await assert_epic_has_no_parent(
                db, values.get("type_id"), getattr(before, "parent_task_id", None),
            )
            after = await update_row(db, "pm_tasks", task_id, values)
            changes = diff_changes(before, after, _TRACKED_TASK_FIELDS)
            if changes:
                await record_activity(
                    db, activity_type="field_change", created_by=actor(user),
                    task_id=task_id, meta={"changes": changes},
                )
        moved = None
        if new_status is not None and str(new_status) != str(before.status_id):
            moved = await apply_status_transition(
                db, after, str(new_status), created_by=actor(user),
            )
            after = moved["row"]

        await db.commit()
        result = row_to_dict(after, TaskModel)
    finally:
        await db.close()

    await emit("pm.task.updated", {"task_id": task_id})
    if moved is not None:
        await emit("pm.task.status_changed", {
            "task_id": task_id,
            "from": moved["from"].name, "to": moved["to"].name,
            "to_category": moved["to"].category,
        })
    return result


@router.post("/tasks/{task_id}/move")
async def move_task(
    task_id: str, payload: MoveTask,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Re-parent a task, move it to another project, or both.

    Crossing into another project re-stamps ``root_project_id`` and re-points
    the status, because statuses are per-root: carrying the old status across
    would leave the task in a lane the destination board does not render.
    """
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        task = await load_visible_task(db, vis, task_id)
        values: dict[str, Any] = {}

        if payload.parent_task_id is not None or "parent_task_id" in payload.model_fields_set:
            new_parent = payload.parent_task_id
            if new_parent:
                await load_visible_task(db, vis, str(new_parent))
            await assert_no_task_cycle(db, task_id, new_parent)
            await assert_epic_has_no_parent(
                db, getattr(task, "type_id", None), new_parent,
            )
            values["parent_task_id"] = new_parent

        if payload.project_id and str(payload.project_id) != str(task.project_id):
            await load_visible_project(db, vis, str(payload.project_id))
            new_root = await root_project_id(db, str(payload.project_id))
            values["project_id"] = str(payload.project_id)
            if new_root != str(task.root_project_id):
                values["root_project_id"] = new_root
                values["status_id"] = str((await load_default_status(db, new_root)).id)
                # The number belongs to the old root's sequence and would
                # collide in the new one, so it is reallocated rather than
                # carried. The old number is recorded on the timeline below —
                # a task's human id changing without a trace is how a reference
                # in a comment stops resolving.
                values["task_number"] = await next_task_number(db, new_root)

        if not values:
            return row_to_dict(task, TaskModel)

        row = await update_row(db, "pm_tasks", task_id, values)
        await record_activity(
            db, activity_type="system", created_by=actor(user), task_id=task_id,
            body="Task moved",
            meta={"from_project": str(task.project_id),
                  "from_number": getattr(task, "task_number", None)},
        )
        await db.commit()
        result = row_to_dict(row, TaskModel)
    finally:
        await db.close()

    await emit("pm.task.moved", {"task_id": task_id})
    return result


@router.delete("/tasks/{task_id}")
async def delete_task(
    task_id: str, user: UserContext = Depends(get_current_user),
) -> DeleteResponse:
    """Delete a task, and say what went with it.

    Subtasks are **promoted, not destroyed** — ``parent_task_id`` SET NULLs
    (§3.5) — so the reported ``subtasks_promoted`` count is not a cascade but
    its opposite, and is named accordingly. Reporting it as "deleted" would be
    the exact class of lie the N8 purge shipped: a count that reassures in the
    wrong direction.
    """
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_task(db, vis, task_id)
        promoted = await count_where(db, "pm_tasks", "parent_task_id", task_id)
        activities = await count_where(db, "pm_activities", "task_id", task_id)
        assignees = (await db.execute(
            text(
                "SELECT count(*) FROM pm_task_assignees "
                "WHERE task_id = CAST(:tid AS uuid)"
            ),
            {"tid": task_id},
        )).scalar() or 0
        links = (await db.execute(
            text(
                "SELECT count(*) FROM pm_task_links "
                "WHERE source_task_id = CAST(:tid AS uuid) "
                "   OR target_task_id = CAST(:tid AS uuid)"
            ),
            {"tid": task_id},
        )).scalar() or 0

        await db.execute(
            text("DELETE FROM pm_tasks WHERE id = CAST(:tid AS uuid)"),
            {"tid": task_id},
        )
        await db.commit()
    finally:
        await db.close()

    await emit("pm.task.deleted", {"task_id": task_id})
    return DeleteResponse(
        deleted=task_id,
        cascaded={
            "activities": int(activities),
            "assignees": int(assignees),
            "links": int(links),
            "subtasks_promoted": int(promoted),
        },
    )


# ── Assignees ───────────────────────────────────────────────────────────────

@router.put("/tasks/{task_id}/assignees")
async def set_assignees(
    task_id: str, payload: AssigneesIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Replace a task's assignee set.

    An assignee is an email or ``agent:<name>`` — one vocabulary for both
    species (D-PM-4), which is what makes handing work to an agent the *same*
    action as handing it to a colleague rather than a parallel feature.

    The emitted ``pm.task.assigned`` event is what WS-27f keys agent dispatch
    off, so it carries the added assignees rather than the whole set: a
    re-assert of an existing assignee must not re-dispatch a run.
    """
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_task(db, vis, task_id)

        wanted = {
            a.strip().lower() for a in payload.assignees if (a or "").strip()
        }
        current = {
            r.assignee for r in (await db.execute(
                text(
                    "SELECT assignee FROM pm_task_assignees "
                    "WHERE task_id = CAST(:tid AS uuid)"
                ),
                {"tid": task_id},
            )).fetchall()
        }
        added, removed = wanted - current, current - wanted

        for who in sorted(removed):
            await db.execute(
                text(
                    "DELETE FROM pm_task_assignees "
                    "WHERE task_id = CAST(:tid AS uuid) AND assignee = :who"
                ),
                {"tid": task_id, "who": who},
            )
        for who in sorted(added):
            await db.execute(
                text(
                    "INSERT INTO pm_task_assignees "
                    "(task_id, assignee, assigned_by) "
                    "VALUES (CAST(:tid AS uuid), :who, :by) "
                    "ON CONFLICT (task_id, assignee) DO NOTHING"
                ),
                {"tid": task_id, "who": who, "by": actor(user)},
            )
        if added or removed:
            await record_activity(
                db, activity_type="assignment", created_by=actor(user),
                task_id=task_id,
                meta={"added": sorted(added), "removed": sorted(removed)},
            )
        # WS-27j — the notification is written INSIDE this transaction, not
        # emitted on the bus afterwards. `emit` is best-effort by construction
        # so a broken workflow can never fail a task edit; that is right for
        # agent dispatch, where a missed run is recoverable, and wrong here.
        # An assignment that committed while its notification did not is
        # exactly the silent assignment §11.2 filed.
        #
        # Only `added`: a re-assert of somebody already on the task must not
        # ping them again, the same reason the event carries added rather than
        # the whole set.
        notified = await notify(
            db, recipients=sorted(added), kind="assigned",
            task_id=task_id, actor_id=actor(user),
        )
        await db.commit()
    finally:
        await db.close()

    if added:
        await emit("pm.task.assigned", {
            "task_id": task_id, "assignees": sorted(added),
        })
    return {
        "task_id": task_id,
        "assignees": sorted(wanted),
        # Named rather than swallowed: assigning somebody outside the project's
        # grant closure is a real thing to do by accident, and it leaves them
        # holding work they cannot open. Saying so is what lets the assigner
        # fix it.
        "not_notified": notified["skipped"],
    }


# ── Links ───────────────────────────────────────────────────────────────────

@router.post("/tasks/{task_id}/links", status_code=201)
async def create_link(
    task_id: str, payload: LinkIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    if payload.link_type not in _LINK_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown link type '{payload.link_type}'. "
                   f"One of: {list(_LINK_TYPES)}.",
        )
    if str(payload.target_task_id) == str(task_id):
        raise HTTPException(
            status_code=422, detail="A task cannot be linked to itself.",
        )
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_task(db, vis, task_id)
        # Both ends must be visible: a link is readable from either side, so
        # accepting an unreadable target would disclose that it exists.
        await load_visible_task(db, vis, str(payload.target_task_id))
        row = (await db.execute(
            text(
                "INSERT INTO pm_task_links "
                "(source_task_id, target_task_id, link_type, created_by) "
                "VALUES (CAST(:src AS uuid), CAST(:tgt AS uuid), :kind, :who) "
                "ON CONFLICT (source_task_id, target_task_id, link_type) "
                "DO UPDATE SET link_type = EXCLUDED.link_type RETURNING id"
            ),
            {
                "src": task_id, "tgt": str(payload.target_task_id),
                "kind": payload.link_type, "who": actor(user),
            },
        )).fetchone()
        await record_activity(
            db, activity_type="link", created_by=actor(user), task_id=task_id,
            meta={"target": str(payload.target_task_id), "type": payload.link_type},
        )
        await db.commit()
        return {
            "id": str(row.id), "source_task_id": task_id,
            "target_task_id": str(payload.target_task_id),
            "link_type": payload.link_type,
        }
    finally:
        await db.close()


@router.delete("/tasks/{task_id}/links/{link_id}")
async def delete_link(
    task_id: str, link_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_task(db, vis, task_id)
        row = (await db.execute(
            text(
                "DELETE FROM pm_task_links WHERE id = CAST(:lid AS uuid) "
                "AND (source_task_id = CAST(:tid AS uuid) "
                "     OR target_task_id = CAST(:tid AS uuid)) RETURNING id"
            ),
            {"lid": link_id, "tid": task_id},
        )).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Link not found")
        await db.commit()
        return {"deleted": link_id}
    finally:
        await db.close()
