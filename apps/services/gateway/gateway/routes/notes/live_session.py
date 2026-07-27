"""Live-session registry — presence for meetings that are happening *now*.

The live-transcript bus (``live_transcript.py``) knows *what is being said*; this
module knows *what is running*: which meetings are currently being captured, by
which source (meeting bot or in-browser recorder), since when, who owns them, and
whether the copilot is opted in for that session.

That split is deliberate. The bus is in-memory and per-process (a restart drops
it, harmlessly — the recording and the batch pass are unaffected), but presence
and the opt-in toggle must survive a page refresh, a navigation, or a gateway
restart, so they live in Postgres (``live_session``).

Powers:
1. the global **"live now"** dock across Command Center,
2. **reattaching** the copilot console to a running session by id,
3. the per-session **copilot opt-in** (default OFF; Phase A stores the state,
   the Phase B orchestrator acts on it).

Fail-safe: ``begin``/``end`` never raise — presence is a nice-to-have, and must
never be able to break a recording or a bot join.

Spec: live_meeting_copilot.md §7 (presence + console), §8 (opt-in), §10 (model).
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.notes.core import _get_db, _iso, _log, router
from pydantic import BaseModel
from sqlalchemy import text

_MODES = ("listening", "interactive", "speaking")


class LiveSessionModel(BaseModel):
    id: str
    meeting_id: str
    source: str                      # 'bot' | 'browser'
    owner_email: str | None = None
    status: str                      # 'live' | 'ended'
    copilot_enabled: bool = False
    mode: str = "listening"
    started_at: str | None = None
    ended_at: str | None = None
    # Denormalised for the presence dock, so it can label a session without a
    # second round-trip per row.
    title: str | None = None


def _row_to_session(r: Any) -> LiveSessionModel:
    return LiveSessionModel(
        id=str(r.id),
        meeting_id=str(r.meeting_id),
        source=r.source,
        owner_email=r.owner_email,
        status=r.status,
        copilot_enabled=bool(r.copilot_enabled),
        mode=r.mode,
        started_at=_iso(r.started_at),
        ended_at=_iso(r.ended_at),
        title=getattr(r, "title", None),
    )


# ── Lifecycle (called by the capture sources, not by the UI) ────────────────

async def begin(meeting_id: str, source: str, owner_email: str | None) -> None:
    """Mark a meeting live. Idempotent — a duplicate start or a reconnect
    refreshes the existing row rather than forking presence (enforced by the
    partial unique index). Never raises."""
    try:
        async with await _get_db() as db:
            await db.execute(
                text(
                    """
                    INSERT INTO live_session (meeting_id, source, owner_email)
                    VALUES (CAST(:m AS UUID), :s, :o)
                    ON CONFLICT (meeting_id) WHERE status = 'live'
                    DO UPDATE SET source = EXCLUDED.source,
                                  owner_email = COALESCE(EXCLUDED.owner_email,
                                                         live_session.owner_email),
                                  updated_at = now()
                    """
                ),
                {"m": meeting_id, "s": source, "o": owner_email},
            )
            await db.commit()
        _log.info("notes.live_session_begin", meeting_id=meeting_id, source=source)
    except Exception as exc:
        # Presence is additive — never let it break a recording or a bot join.
        _log.warning(
            "notes.live_session_begin_failed",
            meeting_id=meeting_id, error=str(exc)[:200],
        )


async def end(meeting_id: str) -> None:
    """Mark a meeting no longer live (no-op if it wasn't). Never raises."""
    try:
        async with await _get_db() as db:
            await db.execute(
                text(
                    "UPDATE live_session SET status = 'ended', ended_at = now(), "
                    "updated_at = now() "
                    "WHERE meeting_id = CAST(:m AS UUID) AND status = 'live'"
                ),
                {"m": meeting_id},
            )
            await db.commit()
    except Exception as exc:
        _log.warning(
            "notes.live_session_end_failed",
            meeting_id=meeting_id, error=str(exc)[:200],
        )


# ── Read (presence + console reattach) ──────────────────────────────────────

@router.get("/live/sessions")
async def list_live_sessions(
    _user: UserContext = Depends(get_current_user),
) -> list[LiveSessionModel]:
    """Meetings being captured right now — drives the global "live now" dock."""
    async with await _get_db() as db:
        rows = (
            await db.execute(
                text(
                    "SELECT ls.*, m.title FROM live_session ls "
                    "JOIN meeting m ON m.id = ls.meeting_id "
                    "WHERE ls.status = 'live' ORDER BY ls.started_at DESC"
                )
            )
        ).fetchall()
    return [_row_to_session(r) for r in rows]


@router.get("/meetings/{meeting_id}/live/session")
async def get_live_session(
    meeting_id: str,
    _user: UserContext = Depends(get_current_user),
) -> LiveSessionModel | None:
    """This meeting's live session, if any — how the console reattaches after a
    refresh. Returns null (200) rather than 404 when nothing is live, so the UI
    can poll it without treating "not live" as an error."""
    async with await _get_db() as db:
        row = (
            await db.execute(
                text(
                    "SELECT ls.*, m.title FROM live_session ls "
                    "JOIN meeting m ON m.id = ls.meeting_id "
                    "WHERE ls.meeting_id = CAST(:m AS UUID) "
                    "ORDER BY ls.started_at DESC LIMIT 1"
                ),
                {"m": meeting_id},
            )
        ).fetchone()
    return _row_to_session(row) if row is not None else None


# ── Copilot opt-in (Phase A stores; Phase B acts) ───────────────────────────

class CopilotToggleRequest(BaseModel):
    enabled: bool
    # Escalating stakes: private suggestions → asks questions → speaks in-call.
    mode: str | None = None


@router.post("/meetings/{meeting_id}/live/copilot")
async def set_copilot(
    meeting_id: str,
    body: CopilotToggleRequest,
    _user: UserContext = Depends(get_current_user),
) -> LiveSessionModel:
    """Turn the copilot on/off for a live session, mid-session either way.

    Default is OFF and it stays off until this is called. Turning it off is the
    instant cost-stop (Phase B unsubscribes the orchestrator on this flag)."""
    mode = (body.mode or "").strip() or None
    if mode is not None and mode not in _MODES:
        raise HTTPException(status_code=400, detail=f"mode must be one of {_MODES}")
    async with await _get_db() as db:
        row = (
            await db.execute(
                text(
                    "UPDATE live_session SET copilot_enabled = :e, "
                    "mode = COALESCE(:mo, mode), updated_at = now() "
                    "WHERE meeting_id = CAST(:m AS UUID) AND status = 'live' "
                    "RETURNING *"
                ),
                {"e": body.enabled, "mo": mode, "m": meeting_id},
            )
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="no live session for this meeting")
        await db.commit()
    _log.info(
        "notes.copilot_toggled",
        meeting_id=meeting_id, enabled=body.enabled, mode=row.mode,
    )
    return _row_to_session(row)
