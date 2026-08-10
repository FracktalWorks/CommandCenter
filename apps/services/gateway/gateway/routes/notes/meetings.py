"""Meeting CRUD — library list, detail, create/patch/delete.

**A meeting is private to the member who owns it.** Notes is the surface that
holds verbatim transcripts of conversations people did not choose to publish —
a recorded 1:1, a salary discussion, a customer call — so `feature:notes` is
permission to keep your OWN meetings here, never permission to read the
company's. Until this change every endpoint in this module queried `meeting` by
id alone, so any member with the feature could open, edit and hard-delete any
colleague's transcript.

Scoping is `owner_email`, and the predicate itself lives ONCE in
`core.OWNED_MEETING_PREDICATE` (case-insensitive: the column is stamped
verbatim from `X-User-Email`, and an IdP that changes the casing of a UPN
between sessions would otherwise empty a member's own library). It is applied
in two places on purpose: the list SQL filters (so the library is a query, not
a filtered-in-Python view) and `_load_meeting` — a thin call to
`core.load_owned_meeting` — refuses a row it did not match. Sharing, when it comes, is the
`subject` vocabulary the rooms layer already speaks (`email | group:<slug> |
org` — `routes/rooms.py::_valid_subject`); it is deliberately NOT invented here.

One deliberate exception: rows with a NULL `owner_email` stay visible to
everyone with the feature. Those are pre-ownership legacy rows (the column
arrived in migration 95 as nullable); both insert paths have stamped an owner
ever since, so nothing new can enter that set, and excluding them would make a
member's own old meetings vanish from their library rather than protect
anybody.
"""

from __future__ import annotations

from acb_auth import UserContext, get_current_user
from fastapi import Depends
from gateway.routes.notes.core import (
    OWNED_MEETING_PREDICATE,
    Attendee,
    CreateMeetingRequest,
    MeetingDetail,
    MeetingListItem,
    PatchMeetingRequest,
    _log,
    _tenant_session,
    load_owned_meeting,
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
       m.owner_email, m.start_at, m.created_at, m.template_key,
       m.scheduled_at, m.copilot_enabled,
       (SELECT count(*) FROM transcript_segment ts WHERE ts.meeting_id = m.id)
           AS segment_count,
       EXISTS (SELECT 1 FROM meeting_note mn WHERE mn.meeting_id = m.id)
           AS has_notes,
       -- What the library bands on. Computed here rather than by fetching each
       -- meeting's detail, because the alternative is N+1 round-trips just to
       -- decide which heading a row belongs under.
       (SELECT count(*) FROM action_item ai
         WHERE ai.meeting_id = m.id AND ai.status = 'draft')
           AS pending_actions,
       (SELECT count(*) FROM action_item ai WHERE ai.meeting_id = m.id)
           AS action_count,
       jsonb_array_length(COALESCE(m.agenda, '[]'::JSONB)) AS agenda_count,
       (m.copilot_brief IS NOT NULL
        AND length(trim(m.copilot_brief)) > 0) AS has_brief,
       jsonb_array_length(COALESCE(m.attendees, '[]'::JSONB)) AS attendee_count,
       EXISTS (SELECT 1 FROM live_session ls
                WHERE ls.meeting_id = m.id AND ls.status = 'live')
           AS is_live
FROM meeting m
WHERE """ + OWNED_MEETING_PREDICATE + """
  AND (CAST(:q AS TEXT) IS NULL
       OR m.title ILIKE '%' || :q || '%'
       OR m.transcript ILIKE '%' || :q || '%')
ORDER BY m.created_at DESC
LIMIT :limit
"""


@router.get("/meetings")
async def list_meetings(
    query: str | None = None,
    limit: int = 100,
    user: UserContext = Depends(get_current_user),
) -> list[MeetingListItem]:
    """The caller's own meeting library. Never anybody else's — the search box
    searches transcript text, so an unscoped list was a full-text search over
    every recorded conversation in the company."""
    async with _tenant_session() as db:
        rows = (
            await db.execute(
                text(_LIST_SQL),
                {
                    "q": query or None,
                    "limit": min(max(limit, 1), 500),
                    "owner": user.email or "",
                },
            )
        ).fetchall()
    return [row_to_list_item(r) for r in rows]


@router.post("/meetings", status_code=201)
async def create_meeting(
    body: CreateMeetingRequest,
    user: UserContext = Depends(get_current_user),
) -> MeetingListItem:
    async with _tenant_session() as db:
        row = (
            await db.execute(
                text(
                    """
                    INSERT INTO meeting (platform, start_at, title, status,
                                         owner_email, template_key, scheduled_at)
                    VALUES (:platform, now(), :title, 'draft', :owner, :template,
                            CAST(:scheduled AS TIMESTAMPTZ))
                    RETURNING id, title, platform, status, language, duration_s,
                              owner_email, start_at, created_at, template_key,
                              scheduled_at, copilot_enabled
                    """
                ),
                {
                    "platform": body.platform,
                    "title": body.title,
                    "owner": user.email,
                    "template": body.template_key,
                    "scheduled": body.scheduled_at,
                },
            )
        ).fetchone()
    _log.info("notes.meeting_created", meeting_id=str(row.id), user=user.email)
    return row_to_list_item(row)


_DETAIL_COLS = """m.*,
                       (SELECT count(*) FROM transcript_segment ts
                        WHERE ts.meeting_id = m.id) AS segment_count,
                       EXISTS (SELECT 1 FROM meeting_note mn
                               WHERE mn.meeting_id = m.id) AS has_notes"""


async def _load_meeting(db, meeting_id: str, user: UserContext):
    """The meeting — if it belongs to ``user``. 404 otherwise.

    Every by-id endpoint in this module goes through here, and here goes
    through ``core.load_owned_meeting`` — the same door ``summaries.summarize``
    and ``recordings.retranscribe`` use, so the owner predicate is written
    once and cannot drift between the modules that enforce it.
    """
    return await load_owned_meeting(
        db, meeting_id, user.email, columns=_DETAIL_COLS
    )


@router.get("/meetings/{meeting_id}")
async def get_meeting(
    meeting_id: str,
    user: UserContext = Depends(get_current_user),
) -> MeetingDetail:
    async with _tenant_session() as db:
        m = await _load_meeting(db, meeting_id, user)
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
    speaker_names = (
        m.speaker_names if isinstance(getattr(m, "speaker_names", None), dict) else {}
    )
    return MeetingDetail(
        **base.model_dump(),
        transcript_source=m.transcript_source,
        summary_md=m.summary_md,
        summary_json=(
            m.summary_json if isinstance(getattr(m, "summary_json", None), dict) else None
        ),
        scratch_notes=m.scratch_notes,
        attendees=attendees,
        speaker_names=speaker_names,
        recordings=[row_to_recording(r) for r in recs],
        segments=[row_to_segment(s) for s in segs],
        runs=[row_to_run(r) for r in runs],
    )


class PutScratchRequest(BaseModel):
    scratch_notes: str = ""


@router.put("/meetings/{meeting_id}/scratch")
async def put_scratch(
    meeting_id: str,
    body: PutScratchRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Save the user's rough notes — merged into generation as emphasis signals."""
    async with _tenant_session() as db:
        await _load_meeting(db, meeting_id, user)
        await db.execute(
            text("UPDATE meeting SET scratch_notes = :s WHERE id = :id"),
            {"s": body.scratch_notes or None, "id": meeting_id},
        )
    return {"ok": True}


class PutAttendeesRequest(BaseModel):
    attendees: list[Attendee] = []


@router.put("/meetings/{meeting_id}/attendees")
async def put_attendees(
    meeting_id: str,
    body: PutAttendeesRequest,
    user: UserContext = Depends(get_current_user),
) -> list[Attendee]:
    """Replace the meeting's external attendee list (name + email)."""
    import json as _json

    clean = [
        a for a in body.attendees if (a.name.strip() or a.email.strip())
    ]
    async with _tenant_session() as db:
        await _load_meeting(db, meeting_id, user)
        await db.execute(
            text("UPDATE meeting SET attendees = CAST(:a AS JSONB) WHERE id = :id"),
            {"a": _json.dumps([a.model_dump() for a in clean]), "id": meeting_id},
        )
    return clean


class PutSpeakersRequest(BaseModel):
    # {"S1": "Alex Rivera", "S2": "Priya Menon"}. Empty/blank names clear a label.
    names: dict[str, str] = {}


@router.put("/meetings/{meeting_id}/speakers")
async def put_speakers(
    meeting_id: str,
    body: PutSpeakersRequest,
    user: UserContext = Depends(get_current_user),
) -> dict[str, str]:
    """Name the diarized speakers. Maps segment labels (S1/S2/…) → real people;
    resolved at display and prompt time so notes, action owners and the
    follow-up email all use the names. Raw segment labels are never rewritten."""
    import json as _json

    clean = {
        str(k).strip(): v.strip()
        for k, v in body.names.items()
        if str(k).strip() and isinstance(v, str) and v.strip()
    }
    async with _tenant_session() as db:
        await _load_meeting(db, meeting_id, user)
        await db.execute(
            text(
                "UPDATE meeting SET speaker_names = CAST(:n AS JSONB) WHERE id = :id"
            ),
            {"n": _json.dumps(clean), "id": meeting_id},
        )
    _log.info("notes.speakers_named", meeting_id=meeting_id, count=len(clean))
    return clean


@router.patch("/meetings/{meeting_id}")
async def patch_meeting(
    meeting_id: str,
    body: PatchMeetingRequest,
    user: UserContext = Depends(get_current_user),
) -> MeetingListItem:
    async with _tenant_session() as db:
        await _load_meeting(db, meeting_id, user)
        await db.execute(
            text(
                """
                UPDATE meeting SET
                    title = COALESCE(:title, title),
                    template_key = COALESCE(:template, template_key),
                    scheduled_at = COALESCE(CAST(:scheduled AS TIMESTAMPTZ),
                                            scheduled_at),
                    copilot_enabled = COALESCE(:copilot, copilot_enabled)
                WHERE id = :id
                """
            ),
            {
                "id": meeting_id,
                "title": body.title,
                "template": body.template_key,
                "scheduled": body.scheduled_at,
                "copilot": body.copilot_enabled,
            },
        )
        row = await _load_meeting(db, meeting_id, user)
    return row_to_list_item(row)


@router.delete("/meetings/{meeting_id}", status_code=204)
async def delete_meeting(
    meeting_id: str,
    user: UserContext = Depends(get_current_user),
) -> None:
    """Hard delete: rows cascade; media files are removed; audited.

    Irreversible and the reason the owner check above is not optional: a
    colleague's recording, transcript, notes and action items all go with it.
    """
    async with _tenant_session() as db:
        await _load_meeting(db, meeting_id, user)
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
