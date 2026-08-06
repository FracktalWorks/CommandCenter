"""CRM · admin — managing the pipeline itself: statuses and lost reasons.

Spec: ``ai-company-brain/specs/crm_app.md`` §3.6, §3.10, §4 (``admin.py`` row).

    GET/POST          /crm/statuses/{lead|deal}
    PATCH/DELETE      /crm/statuses/{lead|deal}/{status_id}
    GET/POST          /crm/lost-reasons
    PATCH/DELETE      /crm/lost-reasons/{reason_id}

**Gated on ``feature:crm`` only** — the router's gate, no extra capability.
That is decision D-CRM-3: the sales team manages its own pipeline, and a
separate admin permission would mean the owner is the only person who can
rename a stage. Revisit when WS-24 admits colleague #1.

``DELETE`` on a status still holding records is a **409**. The FK is
``ON DELETE RESTRICT``, so Postgres would refuse it anyway — but it would
surface as a driver IntegrityError and a 500. Counting first turns "the
database said no" into "Proposal still has 4 deals in it".
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.crm.core import (
    STATUS_TYPES,
    LostReasonModel,
    StatusModel,
    _get_db,
    insert_row,
    require_row,
    router,
    update_row,
)
from pydantic import BaseModel
from sqlalchemy import text

#: URL segment → (statuses table, the table whose rows reference it). Two
#: entries, written out: the segment is matched against this dict and never
#: interpolated, so ``/crm/statuses/{kind}`` cannot name a table we did not
#: choose.
STATUS_KINDS: dict[str, tuple[str, str]] = {
    "lead": ("crm_lead_statuses", "crm_leads"),
    "deal": ("crm_deal_statuses", "crm_deals"),
}


class StatusIn(BaseModel):
    name: str | None = None
    color: str | None = None
    position: int | None = None
    type: str | None = None
    is_default: bool | None = None
    #: Deal statuses only; ignored (and rejected) for lead statuses.
    probability: int | None = None


class LostReasonIn(BaseModel):
    label: str | None = None
    position: int | None = None


def _kind(kind: str) -> tuple[str, str]:
    try:
        return STATUS_KINDS[kind]
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown status kind '{kind}'. One of: {sorted(STATUS_KINDS)}.",
        ) from None


def _status_wire(row: Any) -> StatusModel:
    return StatusModel(
        id=str(row.id),
        name=row.name,
        color=getattr(row, "color", "gray") or "gray",
        position=int(getattr(row, "position", 0) or 0),
        type=getattr(row, "type", "open"),
        is_default=bool(getattr(row, "is_default", False)),
        probability=getattr(row, "probability", None),
    )


def _validate_status(kind: str, values: dict[str, Any]) -> None:
    declared = values.get("type")
    if declared is not None and declared not in STATUS_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown status type '{declared}'. One of: {list(STATUS_TYPES)}.",
        )
    # Keyed on the field being PRESENT, not on it being non-null:
    # `{"probability": null}` would otherwise reach an INSERT naming a column
    # `crm_lead_statuses` has not got, and surface as a driver error rather
    # than as the 422 this rule already knows how to say (WS-26c dw 3).
    if kind == "lead" and "probability" in values:
        raise HTTPException(
            status_code=422,
            detail="Lead statuses have no probability — that column is deal-only.",
        )


# ── Statuses ────────────────────────────────────────────────────────────────

@router.get("/statuses/{kind}", response_model=list[StatusModel])
async def list_statuses(
    kind: str, user: UserContext = Depends(get_current_user),
) -> list[StatusModel]:
    """The kanban lanes, in lane order."""
    table, _ = _kind(kind)
    db = await _get_db()
    try:
        rows = (await db.execute(
            text(f"SELECT * FROM {table} ORDER BY position, name"), {},
        )).fetchall()
        return [_status_wire(r) for r in rows]
    finally:
        await db.close()


@router.post("/statuses/{kind}", response_model=StatusModel, status_code=201)
async def create_status(
    kind: str, payload: StatusIn,
    user: UserContext = Depends(get_current_user),
) -> StatusModel:
    table, _ = _kind(kind)
    values = payload.model_dump(exclude_unset=True)
    _validate_status(kind, values)
    if not (values.get("name") or "").strip():
        raise HTTPException(status_code=422, detail="A status needs a name.")
    values.setdefault("type", "open")
    db = await _get_db()
    try:
        if values.get("position") is None:
            values["position"] = await _next_position(db, table)
        row = await insert_row(db, table, values)
        await db.commit()
        return _status_wire(row)
    finally:
        await db.close()


@router.patch("/statuses/{kind}/{status_id}", response_model=StatusModel)
async def patch_status(
    kind: str, status_id: str, payload: StatusIn,
    user: UserContext = Depends(get_current_user),
) -> StatusModel:
    """Rename, recolour, retype, or reorder a lane (reorder = PATCH position)."""
    table, _ = _kind(kind)
    values = payload.model_dump(exclude_unset=True)
    _validate_status(kind, values)
    db = await _get_db()
    try:
        row = await require_row(db, table, status_id, "Status")
        if not values:
            return _status_wire(row)
        row = await update_row(db, table, status_id, values, touch=False)
        await db.commit()
        return _status_wire(row)
    finally:
        await db.close()


@router.delete("/statuses/{kind}/{status_id}")
async def delete_status(
    kind: str, status_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    table, referencing = _kind(kind)
    db = await _get_db()
    try:
        await require_row(db, table, status_id, "Status")
        in_use = (await db.execute(
            text(
                f"SELECT count(*) FROM {referencing} "
                "WHERE status_id = CAST(:status_id AS uuid)"
            ),
            {"status_id": status_id},
        )).scalar() or 0
        if int(in_use):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"This status still holds {int(in_use)} record(s). Move them "
                    "to another status first — deleting it would orphan them."
                ),
            )
        await db.execute(
            text(f"DELETE FROM {table} WHERE id = CAST(:id AS uuid)"),
            {"id": status_id},
        )
        await db.commit()
        return {"deleted": status_id, "kind": kind}
    finally:
        await db.close()


async def _next_position(db: Any, table: str) -> int:
    """Append a new lane at the end rather than at 0, which would silently
    reorder every existing lane."""
    highest = (await db.execute(
        text(f"SELECT max(position) FROM {table}"), {},
    )).scalar()
    return int(highest or 0) + 10


# ── Lost reasons ────────────────────────────────────────────────────────────

@router.get("/lost-reasons", response_model=list[LostReasonModel])
async def list_lost_reasons(
    user: UserContext = Depends(get_current_user),
) -> list[LostReasonModel]:
    db = await _get_db()
    try:
        rows = (await db.execute(
            text("SELECT * FROM crm_lost_reasons ORDER BY position, label"), {},
        )).fetchall()
        return [
            LostReasonModel(
                id=str(r.id), label=r.label,
                position=int(getattr(r, "position", 0) or 0),
            )
            for r in rows
        ]
    finally:
        await db.close()


@router.post("/lost-reasons", response_model=LostReasonModel, status_code=201)
async def create_lost_reason(
    payload: LostReasonIn, user: UserContext = Depends(get_current_user),
) -> LostReasonModel:
    values = payload.model_dump(exclude_unset=True)
    if not (values.get("label") or "").strip():
        raise HTTPException(status_code=422, detail="A lost reason needs a label.")
    db = await _get_db()
    try:
        if values.get("position") is None:
            values["position"] = await _next_position(db, "crm_lost_reasons")
        row = await insert_row(db, "crm_lost_reasons", values)
        await db.commit()
        return LostReasonModel(
            id=str(row.id), label=row.label,
            position=int(getattr(row, "position", 0) or 0),
        )
    finally:
        await db.close()


@router.patch("/lost-reasons/{reason_id}", response_model=LostReasonModel)
async def patch_lost_reason(
    reason_id: str, payload: LostReasonIn,
    user: UserContext = Depends(get_current_user),
) -> LostReasonModel:
    values = payload.model_dump(exclude_unset=True)
    db = await _get_db()
    try:
        row = await require_row(db, "crm_lost_reasons", reason_id, "Lost reason")
        if values:
            row = await update_row(
                db, "crm_lost_reasons", reason_id, values, touch=False,
            )
            await db.commit()
        return LostReasonModel(
            id=str(row.id), label=row.label,
            position=int(getattr(row, "position", 0) or 0),
        )
    finally:
        await db.close()


@router.delete("/lost-reasons/{reason_id}")
async def delete_lost_reason(
    reason_id: str, user: UserContext = Depends(get_current_user),
) -> dict:
    """Deleting a lost reason is safe: both FKs are ``ON DELETE SET NULL``, so
    the records that cited it keep their ``lost_note`` and lose the label."""
    db = await _get_db()
    try:
        await require_row(db, "crm_lost_reasons", reason_id, "Lost reason")
        await db.execute(
            text("DELETE FROM crm_lost_reasons WHERE id = CAST(:id AS uuid)"),
            {"id": reason_id},
        )
        await db.commit()
        return {"deleted": reason_id}
    finally:
        await db.close()
