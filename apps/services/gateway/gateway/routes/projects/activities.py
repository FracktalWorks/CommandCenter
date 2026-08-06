"""Projects · activities — the task timeline, comments, and revert.

Spec: ``ai-company-brain/specs/project_management_app.md`` §4 (``activities.py``).

    GET    /projects/tasks/{id}/timeline
    POST   /projects/tasks/{id}/comments
    PATCH  /projects/comments/{activity_id}
    DELETE /projects/comments/{activity_id}
    POST   /projects/activities/{activity_id}/revert

Comments and system events share one table, discriminated by ``type`` (§3.8) —
the shape Paca, trycompai and our own ``crm_activities`` all converged on. The
comment routes are spelled ``/comments`` rather than ``/activities`` because a
caller may only ever create, edit or delete that one type: a route that accepted
any type would let a client forge a ``status_change`` nobody performed.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.projects.core import (
    ActivityModel,
    Page,
    _get_db,
    actor,
    emit,
    from_jsonb,
    load_visible_task,
    now,
    record_activity,
    resolve_visibility,
    router,
    row_to_dict,
    update_row,
)
from pydantic import BaseModel
from sqlalchemy import text

#: Columns ``revert`` is willing to restore. Everything a ``field_change``
#: activity can record is here EXCEPT the structural ones (`project_id`,
#: `parent_task_id`, `type_id`): those move a task between hierarchies and
#: scopes, and undoing one by writing a bare column would skip the root
#: re-stamping and the status re-point that ``/move`` owes. Reverting a move is
#: a move.
_REVERTIBLE: frozenset[str] = frozenset({
    "title", "description", "importance", "due_at", "start_date", "estimate_mins",
})


class CommentIn(BaseModel):
    body: str


@router.get("/tasks/{task_id}/timeline")
async def get_timeline(
    task_id: str,
    user: UserContext = Depends(get_current_user),
    page: Page = Depends(),
) -> dict:
    """One task's timeline, newest first.

    Deleted comments are withheld; system events have no ``deleted_at`` and are
    never withheld — the history of what happened to a task is not editable by
    the people it happened to.
    """
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_task(db, vis, task_id)
        params = {
            "tid": task_id, "limit": page.limit, "offset": page.offset,
        }
        total = (await db.execute(
            text(
                "SELECT count(*) FROM pm_activities "
                "WHERE task_id = CAST(:tid AS uuid) AND deleted_at IS NULL"
            ),
            {"tid": task_id},
        )).scalar() or 0
        rows = (await db.execute(
            text(
                "SELECT * FROM pm_activities "
                "WHERE task_id = CAST(:tid AS uuid) AND deleted_at IS NULL "
                "ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset"
            ),
            params,
        )).fetchall()
        return {
            "rows": [row_to_dict(r, ActivityModel) for r in rows],
            "total": int(total),
        }
    finally:
        await db.close()


@router.post("/tasks/{task_id}/comments", status_code=201)
async def add_comment(
    task_id: str, payload: CommentIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(status_code=422, detail="A comment needs a body.")
    db = await _get_db()
    try:
        vis = await resolve_visibility(db, user)
        await load_visible_task(db, vis, task_id)
        row = await record_activity(
            db, activity_type="comment", created_by=actor(user),
            task_id=task_id, body=body,
        )
        await db.commit()
        result = row_to_dict(row, ActivityModel)
    finally:
        await db.close()

    await emit("pm.task.comment_added", {"task_id": task_id})
    return result


async def _load_own_comment(db: Any, activity_id: str, user: UserContext) -> Any:
    """A comment the caller wrote, or 404.

    Authorship is the boundary, and it is checked in the same query that finds
    the row so "someone else's comment" and "no such comment" are one answer
    (R5). Editing another member's words is not an admin action either — there
    is deliberately no override.
    """
    row = (await db.execute(
        text(
            "SELECT * FROM pm_activities WHERE id = CAST(:aid AS uuid) "
            "AND type = 'comment' AND deleted_at IS NULL "
            "AND lower(created_by) = :who"
        ),
        {"aid": activity_id, "who": actor(user).lower()},
    )).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Comment not found")
    return row


@router.patch("/comments/{activity_id}")
async def edit_comment(
    activity_id: str, payload: CommentIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    body = (payload.body or "").strip()
    if not body:
        raise HTTPException(status_code=422, detail="A comment needs a body.")
    db = await _get_db()
    try:
        comment = await _load_own_comment(db, activity_id, user)
        # The task must still be visible: a member removed from a Center keeps
        # authorship of what they wrote but not access to it.
        vis = await resolve_visibility(db, user)
        await load_visible_task(db, vis, str(comment.task_id))
        row = await update_row(db, "pm_activities", activity_id, {"body": body})
        await db.commit()
        return row_to_dict(row, ActivityModel)
    finally:
        await db.close()


@router.delete("/comments/{activity_id}")
async def delete_comment(
    activity_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    """Soft-delete a comment.

    Soft because the timeline is a record: a hard delete would leave replies
    referring to something that never existed. The body is cleared as well as
    the row hidden, so "deleted" means the words are gone rather than merely
    filtered out of one read path.
    """
    db = await _get_db()
    try:
        await _load_own_comment(db, activity_id, user)
        await update_row(
            db, "pm_activities", activity_id,
            {"deleted_at": now(), "body": None},
        )
        await db.commit()
        return {"deleted": activity_id}
    finally:
        await db.close()


@router.post("/activities/{activity_id}/revert")
async def revert_change(
    activity_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    """Restore the values a ``field_change`` activity recorded as ``old``.

    Paca's diff-and-revert, and the reason §3.8 stores both ends of every change
    rather than only the new one. The revert is itself a normal edit: it writes
    a fresh ``field_change`` activity rather than erasing the one it undoes, so
    the timeline shows that a revert happened instead of history appearing never
    to have contained the change.
    """
    db = await _get_db()
    try:
        row = (await db.execute(
            text(
                "SELECT * FROM pm_activities WHERE id = CAST(:aid AS uuid) "
                "AND type = 'field_change'"
            ),
            {"aid": activity_id},
        )).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Change not found")
        vis = await resolve_visibility(db, user)
        task = await load_visible_task(db, vis, str(row.task_id))

        meta = from_jsonb(getattr(row, "meta", None)) or {}
        changes = [c for c in (meta.get("changes") or []) if isinstance(c, dict)]
        restore = {
            c["field"]: c.get("old") for c in changes
            if c.get("field") in _REVERTIBLE
        }
        skipped = sorted(
            {
                str(c.get("field")) for c in changes
                if c.get("field") not in _REVERTIBLE
            }
        )
        if not restore:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Nothing on this change can be reverted here"
                    + (f"; {skipped} must be undone by moving the task." if skipped
                       else ".")
                ),
            )

        await update_row(db, "pm_tasks", str(task.id), restore)
        await record_activity(
            db, activity_type="field_change", created_by=actor(user),
            task_id=str(task.id),
            meta={
                "changes": [
                    {"field": f, "old": c.get("new"), "new": c.get("old")}
                    for c in changes for f in [c.get("field")] if f in restore
                ],
                "reverted_activity_id": activity_id,
            },
        )
        await db.commit()
        task_id = str(task.id)
        reverted = sorted(restore)
    finally:
        await db.close()

    await emit("pm.task.updated", {"task_id": task_id})
    return {"task_id": task_id, "reverted": reverted, "skipped": skipped}
