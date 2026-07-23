"""Meeting CRUD — library list, detail, create/patch/delete."""

from __future__ import annotations

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.notes.core import (
    Attendee,
    CreateMeetingRequest,
    MeetingDetail,
    MeetingListItem,
    PatchMeetingRequest,
    _get_db,
    _log,
    media_dir,
    router,
    row_to_list_item,
    row_to_recording,
    row_to_run,
    row_to_segment,
)
from pydantic import BaseModel
from sqlalchemy import text

_LIST_SQL = """
SELECT m.id, m.title, m.platform, m.status, m.language, m.duration_s,
       m.owner_email, m.start_at, m.created_at,
       (SELECT count(*) FROM transcript_segment ts WHERE ts.meeting_id = m.id)
           AS segment_count,
       EXISTS (SELECT 1 FROM meeting_note mn WHERE mn.meeting_id = m.id)
           AS has_notes
FROM meeting m
WHERE (CAST(:q AS TEXT) IS NULL
       OR m.title ILIKE '%' || :q || '%'
       OR m.transcript ILIKE '%' || :q || '%')
ORDER BY m.created_at DESC
LIMIT :limit
"""


@router.get("/meetings")
async def list_meetings(
    query: str | None = None,
    limit: int = 100,
    _user: UserContext = Depends(get_current_user),
) -> list[MeetingListItem]:
    async with await _get_db() as db:
        rows = (
            await db.execute(
                text(_LIST_SQL), {"q": query or None, "limit": min(max(limit, 1), 500)}
            )
        ).fetchall()
    return [row_to_list_item(r) for r in rows]


@router.post("/meetings", status_code=201)
async def create_meeting(
    body: CreateMeetingRequest,
    user: UserContext = Depends(get_current_user),
) -> MeetingListItem:
    async with await _get_db() as db:
        row = (
            await db.execute(
                text(
                    """
                    INSERT INTO meeting (platform, start_at, title, status,
                                         owner_email, template_key)
                    VALUES (:platform, now(), :title, 'draft', :owner, :template)
                    RETURNING id, title, platform, status, language, duration_s,
                              owner_email, start_at, created_at
                    """
                ),
                {
                    "platform": body.platform,
                    "title": body.title,
                    "owner": user.email,
                    "template": body.template_key,
                },
            )
        ).fetchone()
        await db.commit()
    _log.info("notes.meeting_created", meeting_id=str(row.id), user=user.email)
    return row_to_list_item(row)


async def _load_meeting(db, meeting_id: str):
    row = (
        await db.execute(
            text(
                """
                SELECT m.*,
                       (SELECT count(*) FROM transcript_segment ts
                        WHERE ts.meeting_id = m.id) AS segment_count,
                       EXISTS (SELECT 1 FROM meeting_note mn
                               WHERE mn.meeting_id = m.id) AS has_notes
                FROM meeting m WHERE m.id = :id
                """
            ),
            {"id": meeting_id},
        )
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="meeting not found")
    return row


@router.get("/meetings/{meeting_id}")
async def get_meeting(
    meeting_id: str,
    _user: UserContext = Depends(get_current_user),
) -> MeetingDetail:
    async with await _get_db() as db:
        m = await _load_meeting(db, meeting_id)
        recs = (
            await db.execute(
                text(
                    "SELECT * FROM meeting_recording WHERE meeting_id = :id "
                    "ORDER BY created_at"
                ),
                {"id": meeting_id},
            )
        ).fetchall()
        segs = (
            await db.execute(
                text(
                    "SELECT * FROM transcript_segment WHERE meeting_id = :id "
                    "ORDER BY idx"
                ),
                {"id": meeting_id},
            )
        ).fetchall()
        runs = (
            await db.execute(
                text(
                    "SELECT * FROM summary_run WHERE meeting_id = :id "
                    "ORDER BY created_at DESC LIMIT 20"
                ),
                {"id": meeting_id},
            )
        ).fetchall()
    base = row_to_list_item(m)
    attendees = m.attendees if isinstance(m.attendees, list) else []
    return MeetingDetail(
        **base.model_dump(),
        transcript_source=m.transcript_source,
        summary_md=m.summary_md,
        attendees=attendees,
        recordings=[row_to_recording(r) for r in recs],
        segments=[row_to_segment(s) for s in segs],
        runs=[row_to_run(r) for r in runs],
    )


class PutAttendeesRequest(BaseModel):
    attendees: list[Attendee] = []


@router.put("/meetings/{meeting_id}/attendees")
async def put_attendees(
    meeting_id: str,
    body: PutAttendeesRequest,
    _user: UserContext = Depends(get_current_user),
) -> list[Attendee]:
    """Replace the meeting's external attendee list (name + email)."""
    import json as _json

    clean = [
        a for a in body.attendees if (a.name.strip() or a.email.strip())
    ]
    async with await _get_db() as db:
        await _load_meeting(db, meeting_id)
        await db.execute(
            text("UPDATE meeting SET attendees = CAST(:a AS JSONB) WHERE id = :id"),
            {"a": _json.dumps([a.model_dump() for a in clean]), "id": meeting_id},
        )
        await db.commit()
    return clean


@router.patch("/meetings/{meeting_id}")
async def patch_meeting(
    meeting_id: str,
    body: PatchMeetingRequest,
    _user: UserContext = Depends(get_current_user),
) -> MeetingListItem:
    async with await _get_db() as db:
        await _load_meeting(db, meeting_id)
        await db.execute(
            text(
                """
                UPDATE meeting SET
                    title = COALESCE(:title, title),
                    template_key = COALESCE(:template, template_key)
                WHERE id = :id
                """
            ),
            {"id": meeting_id, "title": body.title, "template": body.template_key},
        )
        await db.commit()
        row = await _load_meeting(db, meeting_id)
    return row_to_list_item(row)


@router.delete("/meetings/{meeting_id}", status_code=204)
async def delete_meeting(
    meeting_id: str,
    user: UserContext = Depends(get_current_user),
) -> None:
    """Hard delete: rows cascade; media files are removed; audited."""
    async with await _get_db() as db:
        await _load_meeting(db, meeting_id)
        paths = (
            await db.execute(
                text("SELECT artifact_path FROM meeting_recording WHERE meeting_id = :id"),
                {"id": meeting_id},
            )
        ).fetchall()
        await db.execute(text("DELETE FROM meeting WHERE id = :id"), {"id": meeting_id})
        await db.execute(
            text(
                "INSERT INTO audit_event (actor, action, target, payload) "
                "VALUES (:actor, 'notes.meeting_deleted', :target, '{}'::jsonb)"
            ),
            {"actor": user.email or "unknown", "target": f"meeting:{meeting_id}"},
        )
        await db.commit()
    root = media_dir().resolve()
    for p in paths:
        try:
            f = (root / p.artifact_path).resolve() if not p.artifact_path.startswith("/") \
                else None
            # Only unlink files that live inside the media dir (path hygiene).
            if f is not None and f.is_relative_to(root) and f.is_file():
                f.unlink()
        except OSError as exc:
            _log.warning("notes.media_delete_failed", path=p.artifact_path, error=str(exc))
