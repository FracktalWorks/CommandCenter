"""Action-item HITL — approve a draft item into a GTD task, or reject it.

The Meeting→Task counterpart of tasks/capture_email.py's Email→Task flow
(spec §3.9). A meeting's draft ``action_item`` rows only become real tasks when
a human approves them; on approval we insert a LOCAL ``gtd_items`` row (the same
store the task manager owns) with an ``origin`` provenance link back to the
meeting, and record ``action_item.resulting_task_id`` so the link is two-way.
Idempotent: approving an already-created item returns its existing task.
"""

from __future__ import annotations

import json
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.notes.core import _get_db, _log, router
from pydantic import BaseModel
from sqlalchemy import text


class ApproveResponse(BaseModel):
    action_id: str
    status: str
    resulting_task_id: str | None = None


async def _create_task_from_action(db, user_email: str, action) -> str:
    """Insert a LOCAL gtd_items task from an action_item row; return task id.

    Direct insert mirrors capture_email.py (there is no task service layer —
    the platform writes gtd_items via SQL). The free-text ``due_hint`` is kept
    in the notes body rather than force-parsed into a date.
    """
    task_id = str(uuid4())
    notes = f"From meeting notes. Confidence {action.confidence:.0%}."
    if action.due_hint:
        notes += f" Due (as stated): {action.due_hint}."
    origin = {
        "kind": "meeting",
        "meeting_id": str(action.meeting_id),
        "action_item_id": str(action.id),
        "segment_ids": [str(s) for s in (action.segment_ids or [])],
    }
    await db.execute(
        text(
            "INSERT INTO gtd_items (id, user_id, title, description, origin) "
            "VALUES (:id, :uid, :title, :notes, CAST(:origin AS JSONB))"
        ),
        {
            "id": task_id,
            "uid": user_email,
            "title": action.description[:500],
            "notes": notes,
            "origin": json.dumps(origin),
        },
    )
    return task_id


async def _load_action(db, action_id: str):
    row = (
        await db.execute(
            text(
                "SELECT id, meeting_id, description, confidence, status, "
                "due_hint, segment_ids, resulting_task_id "
                "FROM action_item WHERE id = :id"
            ),
            {"id": action_id},
        )
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="action item not found")
    return row


@router.post("/actions/{action_id}/approve")
async def approve_action(
    action_id: str,
    user: UserContext = Depends(get_current_user),
) -> ApproveResponse:
    async with await _get_db() as db:
        action = await _load_action(db, action_id)
        if action.resulting_task_id:  # idempotent
            return ApproveResponse(
                action_id=action_id, status=action.status,
                resulting_task_id=str(action.resulting_task_id),
            )
        task_id = await _create_task_from_action(db, user.email or "anonymous", action)
        await db.execute(
            text(
                "UPDATE action_item SET status='created', resulting_task_id=:tid "
                "WHERE id=:id"
            ),
            {"tid": task_id, "id": action_id},
        )
        await db.execute(
            text(
                "INSERT INTO audit_event (actor, action, target, payload) VALUES "
                "(:actor, 'notes.action_approved', :target, CAST(:p AS JSONB))"
            ),
            {
                "actor": user.email or "unknown",
                "target": f"action_item:{action_id}",
                "p": json.dumps({"task_id": task_id, "meeting_id": str(action.meeting_id)}),
            },
        )
        await db.commit()
    _log.info("notes.action_approved", action_id=action_id, task_id=task_id)
    return ApproveResponse(action_id=action_id, status="created", resulting_task_id=task_id)


@router.post("/actions/{action_id}/reject")
async def reject_action(
    action_id: str,
    _user: UserContext = Depends(get_current_user),
) -> ApproveResponse:
    async with await _get_db() as db:
        action = await _load_action(db, action_id)
        if action.resulting_task_id:
            raise HTTPException(
                status_code=409, detail="already created as a task; cannot reject"
            )
        await db.execute(
            text("UPDATE action_item SET status='rejected' WHERE id=:id"),
            {"id": action_id},
        )
        await db.commit()
    return ApproveResponse(action_id=action_id, status="rejected")


class BulkApproveRequest(BaseModel):
    min_confidence: float = 0.8


class BulkApproveResponse(BaseModel):
    created: list[str] = []  # action_ids approved this call


@router.post("/meetings/{meeting_id}/actions/approve-all")
async def approve_all(
    meeting_id: str,
    body: BulkApproveRequest,
    user: UserContext = Depends(get_current_user),
) -> BulkApproveResponse:
    """Approve every draft action item at or above a confidence threshold."""
    async with await _get_db() as db:
        rows = (
            await db.execute(
                text(
                    "SELECT id, meeting_id, description, confidence, status, "
                    "due_hint, segment_ids, resulting_task_id FROM action_item "
                    "WHERE meeting_id=:mid AND status='draft' "
                    "AND resulting_task_id IS NULL AND confidence >= :min"
                ),
                {"mid": meeting_id, "min": body.min_confidence},
            )
        ).fetchall()
        created: list[str] = []
        for action in rows:
            task_id = await _create_task_from_action(db, user.email or "anonymous", action)
            await db.execute(
                text(
                    "UPDATE action_item SET status='created', resulting_task_id=:tid "
                    "WHERE id=:id"
                ),
                {"tid": task_id, "id": str(action.id)},
            )
            created.append(str(action.id))
        if created:
            await db.execute(
                text(
                    "INSERT INTO audit_event (actor, action, target, payload) VALUES "
                    "(:actor, 'notes.actions_bulk_approved', :target, CAST(:p AS JSONB))"
                ),
                {
                    "actor": user.email or "unknown",
                    "target": f"meeting:{meeting_id}",
                    "p": json.dumps({"count": len(created), "min_confidence": body.min_confidence}),
                },
            )
        await db.commit()
    _log.info("notes.actions_bulk_approved", meeting_id=meeting_id, count=len(created))
    return BulkApproveResponse(created=created)
