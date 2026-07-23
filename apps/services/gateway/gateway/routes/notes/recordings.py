"""Recording upload + audio playback.

Slice 0 ships the retro-import path (single-file upload → transcription
pipeline). The live browser recorder (chunked MediaRecorder appends) lands in
slice 1 on the same tables (spec: note_taker_app.md §6).
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from acb_auth import UserContext, get_current_user
from fastapi import Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from gateway.routes.notes.core import (
    _get_db,
    _log,
    media_dir,
    router,
)
from gateway.routes.notes.pipeline import run_transcription
from sqlalchemy import text

_ALLOWED_EXT = {".webm", ".mp3", ".wav", ".m4a", ".mp4", ".ogg", ".oga", ".flac", ".aac"}
_MAX_UPLOAD_BYTES = 300 * 1024 * 1024  # server cap; provider caps surface as run errors

_EXT_MIME = {
    ".webm": "audio/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".ogg": "audio/ogg",
    ".oga": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac",
}

# Keep strong refs to in-flight pipeline tasks — a bare create_task() result
# can be garbage-collected mid-run.
_PIPELINE_TASKS: set[asyncio.Task] = set()


def _spawn_pipeline(coro) -> None:
    task = asyncio.create_task(coro)
    _PIPELINE_TASKS.add(task)
    task.add_done_callback(_PIPELINE_TASKS.discard)


@router.post("/meetings/{meeting_id}/upload", status_code=202)
async def upload_recording(
    meeting_id: str,
    file: UploadFile = File(...),
    channel: str = Form("upload"),
    _user: UserContext = Depends(get_current_user),
) -> dict:
    """Attach an audio file to a meeting and start transcription.

    Returns ``{recording_id, run_id}``; progress is visible on the meeting's
    ``runs`` (poll ``GET /notes/meetings/{id}`` — SSE arrives with slice 1).
    """
    if channel not in ("mic", "system", "mixed", "upload"):
        raise HTTPException(status_code=400, detail="invalid channel")
    safe_name = Path(file.filename or "audio").name
    ext = Path(safe_name).suffix.lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported audio type: {ext or '(none)'}. "
                   f"Allowed: {', '.join(sorted(_ALLOWED_EXT))}",
        )
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="empty file")
    if len(content) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file exceeds 300 MB limit")

    mime = file.content_type or _EXT_MIME.get(ext, "application/octet-stream")
    recording_id = str(uuid.uuid4())
    rel_path = f"{meeting_id}/{recording_id}{ext}"
    dest = media_dir() / rel_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(content)

    async with await _get_db() as db:
        meeting = (
            await db.execute(text("SELECT id FROM meeting WHERE id = :id"), {"id": meeting_id})
        ).fetchone()
        if meeting is None:
            dest.unlink(missing_ok=True)
            raise HTTPException(status_code=404, detail="meeting not found")
        await db.execute(
            text(
                """
                INSERT INTO meeting_recording (id, meeting_id, channel, artifact_path,
                                               mime, byte_size)
                VALUES (:id, :meeting_id, :channel, :path, :mime, :size)
                """
            ),
            {
                "id": recording_id, "meeting_id": meeting_id, "channel": channel,
                "path": rel_path, "mime": mime, "size": len(content),
            },
        )
        run_row = (
            await db.execute(
                text(
                    """
                    INSERT INTO summary_run (meeting_id, kind, status, stage)
                    VALUES (:meeting_id, 'transcribe', 'queued', 'queued')
                    RETURNING id
                    """
                ),
                {"meeting_id": meeting_id},
            )
        ).fetchone()
        await db.execute(
            text("UPDATE meeting SET status = 'processing' WHERE id = :id"),
            {"id": meeting_id},
        )
        await db.commit()

    run_id = str(run_row.id)
    _log.info(
        "notes.recording_uploaded",
        meeting_id=meeting_id, recording_id=recording_id, bytes=len(content), mime=mime,
    )
    _spawn_pipeline(run_transcription(meeting_id, recording_id, run_id))
    return {"recording_id": recording_id, "run_id": run_id, "status": "processing"}


@router.get("/meetings/{meeting_id}/audio")
async def get_audio(
    meeting_id: str,
    _user: UserContext = Depends(get_current_user),
) -> FileResponse:
    """Serve the meeting's audio for the seek-player (mixed > upload > mic)."""
    async with await _get_db() as db:
        rows = (
            await db.execute(
                text("SELECT * FROM meeting_recording WHERE meeting_id = :id"),
                {"id": meeting_id},
            )
        ).fetchall()
    if not rows:
        raise HTTPException(status_code=404, detail="no recording for this meeting")
    order = {"mixed": 0, "upload": 1, "mic": 2, "system": 3}
    best = sorted(rows, key=lambda r: order.get(r.channel, 9))[0]
    path = media_dir() / best.artifact_path
    if not path.is_file():
        raise HTTPException(status_code=410, detail="audio file no longer on disk")
    return FileResponse(path, media_type=best.mime, filename=path.name)
