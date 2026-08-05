"""CRM · activities — the timeline: notes, calls, meetings, follow-up tasks.

Spec: ``ai-company-brain/specs/crm_app.md`` §3.8, §4 (``activities.py`` row).

    GET    /crm/<entity>/{id}/timeline     activities + status changes, merged
    POST   /crm/<entity>/{id}/activities   log a note / call / meeting / task
    PATCH  /crm/activities/{aid}           edit a note, complete a task
    DELETE /crm/activities/{aid}

A deal's timeline **unions its originating lead's history**, labelled with the
source, because everything said before conversion was said about this deal —
losing it at the conversion boundary is the failure the ``lead_id`` provenance
column exists to prevent (§5.3).

Email threads join in at Phase D (WS-26d) by address, with no link table
(D-CRM-5). The merge below is already shaped for a third source.

Paths are written out per entity for the same reason as ``records.py``: a
generic ``/crm/{entity}/{id}/…`` template would make route registration order
load-bearing, and ``PATCH /crm/activities/{aid}`` sits at the depth it would
compete with.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, Query
from gateway.routes.crm.core import (
    ACTIVITY_TYPES,
    CONTACTS,
    DEALS,
    LEADS,
    ORGANIZATIONS,
    ActivityModel,
    Entity,
    _get_db,
    actor,
    bump_last_activity,
    insert_row,
    require_row,
    router,
    row_to_dict,
    update_row,
    wire,
)
from pydantic import BaseModel
from sqlalchemy import text

#: Types a human may log through this API. ``status_change`` is deliberately
#: NOT here: the pipeline writes those and a hand-written one would be a
#: funnel event with no transition behind it.
LOGGABLE_TYPES: tuple[str, ...] = ("note", "call", "meeting", "task")


class ActivityIn(BaseModel):
    type: str = "note"
    subject: str | None = None
    body: str | None = None
    occurred_at: str | None = None
    due_at: str | None = None
    meta: dict | None = None


class ActivityPatch(BaseModel):
    subject: str | None = None
    body: str | None = None
    occurred_at: str | None = None
    due_at: str | None = None
    #: Sent as an ISO instant to complete a task, or ``null`` to reopen it.
    completed_at: str | None = None


class TimelineEntry(BaseModel):
    """One merged timeline row. ``kind`` says which source it came from."""

    kind: str
    at: str | None = None
    #: 'own' for the record's own history, 'lead' for a deal inheriting its
    #: lead's. The UI labels inherited entries rather than pretending they
    #: happened to the deal.
    origin: str = "own"
    activity: dict | None = None
    status_change: dict | None = None


class TimelineResponse(BaseModel):
    entries: list[TimelineEntry]


# ── Shared behaviour ────────────────────────────────────────────────────────

async def _timeline(entity: Entity, record_id: str, limit: int) -> TimelineResponse:
    db = await _get_db()
    try:
        record = await require_row(db, entity.table, record_id, entity.label)
        sources: list[tuple[Entity, str, str]] = [(entity, record_id, "own")]
        inherited = getattr(record, "lead_id", None)
        if inherited:
            # §5.3 — the deal inherits the lead it was converted from.
            sources.append((LEADS, str(inherited), "lead"))

        entries: list[TimelineEntry] = []
        for source_entity, source_id, origin in sources:
            entries.extend(
                await _activity_entries(db, source_entity, source_id, origin, limit)
            )
            entries.extend(
                await _status_entries(db, source_entity, source_id, origin, limit)
            )
        # Newest first. `at` is None only for a row with no timestamp at all,
        # which sorts last rather than crashing the comparison.
        entries.sort(key=lambda e: (e.at or ""), reverse=True)
        return TimelineResponse(entries=entries[:limit])
    finally:
        await db.close()


async def _activity_entries(
    db: Any, entity: Entity, record_id: str, origin: str, limit: int,
) -> list[TimelineEntry]:
    rows = (await db.execute(
        text(
            "SELECT * FROM crm_activities "
            f"WHERE {entity.activity_column} = CAST(:record_id AS uuid) "
            "ORDER BY created_at DESC LIMIT :limit"
        ),
        {"record_id": record_id, "limit": limit},
    )).fetchall()
    return [
        TimelineEntry(
            kind="activity",
            at=wire(getattr(row, "occurred_at", None) or row.created_at),
            origin=origin,
            activity=row_to_dict(row, ActivityModel),
        )
        for row in rows
    ]


async def _status_entries(
    db: Any, entity: Entity, record_id: str, origin: str, limit: int,
) -> list[TimelineEntry]:
    """Status changes are merged in from their own log, not re-read from the
    activity that mirrors them: the log carries ``dwell_seconds``, which is the
    part a human actually reads off a timeline ("sat in Proposal for 11 days")."""
    from gateway.routes.crm.pipeline import ENTITY_TYPES

    entity_type = ENTITY_TYPES.get(entity.slug)
    if entity_type is None:
        return []
    rows = (await db.execute(
        text(
            "SELECT * FROM crm_status_changes "
            "WHERE entity_type = :entity_type "
            "AND entity_id = CAST(:record_id AS uuid) "
            "ORDER BY changed_at DESC LIMIT :limit"
        ),
        {"entity_type": entity_type, "record_id": record_id, "limit": limit},
    )).fetchall()
    return [
        TimelineEntry(
            kind="status_change",
            at=wire(row.changed_at),
            origin=origin,
            status_change={
                "id": str(row.id),
                "from_status": row.from_status,
                "to_status": row.to_status,
                "changed_by": row.changed_by,
                "changed_at": wire(row.changed_at),
                "dwell_seconds": (
                    int(row.dwell_seconds)
                    if getattr(row, "dwell_seconds", None) is not None else None
                ),
            },
        )
        for row in rows
    ]


async def _log_activity(
    entity: Entity, record_id: str, payload: ActivityIn, user: UserContext,
) -> dict:
    if payload.type not in LOGGABLE_TYPES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Cannot log an activity of type '{payload.type}'. "
                f"One of: {list(LOGGABLE_TYPES)}. "
                "('status_change' and 'system' are written by the platform.)"
            ),
        )
    db = await _get_db()
    try:
        await require_row(db, entity.table, record_id, entity.label)
        # `entity.activity_column` is one of four registry literals, so the
        # CHECK requiring at least one target cannot be reached with all four
        # NULL through this path — the target is structural, not optional.
        row = await insert_row(db, "crm_activities", {
            "type": payload.type,
            "subject": payload.subject,
            "body": payload.body,
            "occurred_at": payload.occurred_at,
            "due_at": payload.due_at,
            "meta": payload.meta,
            "created_by": actor(user),
            entity.activity_column: record_id,
        })
        await bump_last_activity(db, entity.table, record_id)
        await db.commit()
        return row_to_dict(row, ActivityModel)
    finally:
        await db.close()


# ── Timelines ───────────────────────────────────────────────────────────────

@router.get("/leads/{record_id}/timeline", response_model=TimelineResponse)
async def lead_timeline(
    record_id: str,
    limit: int = Query(100, ge=1, le=500),
    user: UserContext = Depends(get_current_user),
) -> TimelineResponse:
    return await _timeline(LEADS, record_id, limit)


@router.get("/deals/{record_id}/timeline", response_model=TimelineResponse)
async def deal_timeline(
    record_id: str,
    limit: int = Query(100, ge=1, le=500),
    user: UserContext = Depends(get_current_user),
) -> TimelineResponse:
    """A deal's own history, unioned with its originating lead's (§5.3)."""
    return await _timeline(DEALS, record_id, limit)


@router.get("/contacts/{record_id}/timeline", response_model=TimelineResponse)
async def contact_timeline(
    record_id: str,
    limit: int = Query(100, ge=1, le=500),
    user: UserContext = Depends(get_current_user),
) -> TimelineResponse:
    return await _timeline(CONTACTS, record_id, limit)


@router.get("/organizations/{record_id}/timeline", response_model=TimelineResponse)
async def organization_timeline(
    record_id: str,
    limit: int = Query(100, ge=1, le=500),
    user: UserContext = Depends(get_current_user),
) -> TimelineResponse:
    return await _timeline(ORGANIZATIONS, record_id, limit)


# ── Logging ─────────────────────────────────────────────────────────────────

@router.post("/leads/{record_id}/activities", status_code=201)
async def log_lead_activity(
    record_id: str, payload: ActivityIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    return await _log_activity(LEADS, record_id, payload, user)


@router.post("/deals/{record_id}/activities", status_code=201)
async def log_deal_activity(
    record_id: str, payload: ActivityIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    return await _log_activity(DEALS, record_id, payload, user)


@router.post("/contacts/{record_id}/activities", status_code=201)
async def log_contact_activity(
    record_id: str, payload: ActivityIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    return await _log_activity(CONTACTS, record_id, payload, user)


@router.post("/organizations/{record_id}/activities", status_code=201)
async def log_organization_activity(
    record_id: str, payload: ActivityIn,
    user: UserContext = Depends(get_current_user),
) -> dict:
    return await _log_activity(ORGANIZATIONS, record_id, payload, user)


# ── Editing one activity ────────────────────────────────────────────────────

@router.patch("/activities/{activity_id}")
async def patch_activity(
    activity_id: str, payload: ActivityPatch,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Edit a note or complete a follow-up task.

    ``type`` is deliberately not editable: a call that becomes a note rewrites
    history, and re-logging is one request.
    """
    values = payload.model_dump(exclude_unset=True)
    db = await _get_db()
    try:
        row = await require_row(db, "crm_activities", activity_id, "Activity")
        if not values:
            return row_to_dict(row, ActivityModel)
        # `crm_activities` has no `updated_at` — an activity is a log entry.
        row = await update_row(
            db, "crm_activities", activity_id, values, touch=False,
        )
        await db.commit()
        return row_to_dict(row, ActivityModel)
    finally:
        await db.close()


@router.delete("/activities/{activity_id}")
async def delete_activity(
    activity_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    db = await _get_db()
    try:
        row = await require_row(db, "crm_activities", activity_id, "Activity")
        if row.type in ("status_change", "system"):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Platform-written activities cannot be deleted — a funnel "
                    "with editable history is not a record of anything."
                ),
            )
        await db.execute(
            text("DELETE FROM crm_activities WHERE id = CAST(:id AS uuid)"),
            {"id": activity_id},
        )
        await db.commit()
        return {"deleted": activity_id}
    finally:
        await db.close()


__all__ = [
    "ACTIVITY_TYPES",
    "LOGGABLE_TYPES",
    "ActivityIn",
    "ActivityPatch",
    "TimelineEntry",
    "TimelineResponse",
]
