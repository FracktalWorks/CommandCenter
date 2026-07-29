"""CommandCenter Meeting Bot — a fully self-hosted meeting-joining worker.

A headless-Chrome (Playwright) participant that joins a meeting link, records
the call's audio, and serves it back over a small vendor-neutral HTTP contract.
CommandCenter's ``selfhosted`` bot provider (gateway
``routes/notes/meeting_bot.py``) drives this — so there is **no third-party
cloud** in the loop; the only cost is the box this runs on.

Contract (what the gateway provider speaks):
    POST   /bots                {meeting_url, bot_name} -> {id, status}
    GET    /bots/{id}           -> {id, status, download_url|null, error|null}
    POST   /bots/{id}/leave     -> 202  (leave the call now)
    GET    /bots/{id}/recording -> audio bytes (when status == "done")
    GET    /health              -> {ok: true}

Status vocabulary matches the gateway's lifecycle directly:
    joining -> waiting_room -> in_call -> processing -> done
    (or failed / not_admitted)

Scope: this MVP targets **Google Meet** (the most automatable via a browser).
Zoom/Teams are future work (they usually need their SDKs). One meeting per
worker instance — scale by running more instances (each is ~1 headless Chrome).
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .meet import MeetingBotError, join_and_record

DATA_DIR = os.environ.get("MEETING_BOT_DATA", "/data")
TOKEN = os.environ.get("MEETING_BOT_TOKEN", "").strip()

logging.basicConfig(
    level=os.environ.get("MEETING_BOT_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
_log = logging.getLogger("meeting_bot")

app = FastAPI(title="CommandCenter Meeting Bot", version="0.1.0")


class _Job:
    def __init__(
        self, job_id: str, meeting_url: str, bot_name: str, live_callback: str | None
    ) -> None:
        self.id = job_id
        self.meeting_url = meeting_url
        self.bot_name = bot_name
        self.live_callback = live_callback  # gateway URL for live segments (or None)
        self.status = "requested"
        self.error: str | None = None
        #: What the page looked like when a join failed (see meet._snapshot).
        self.diagnostics: dict = {}
        self.recording: str | None = None
        self.leave = asyncio.Event()
        self.say_queue: asyncio.Queue[str] = asyncio.Queue()
        self.task: asyncio.Task | None = None


_JOBS: dict[str, _Job] = {}


def _auth(authorization: str | None) -> None:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


class JoinRequest(BaseModel):
    meeting_url: str
    bot_name: str = "AI Notetaker"
    # Optional gateway URL to POST live transcript segments to (per meeting).
    live_callback: str | None = None


class SayRequest(BaseModel):
    text: str


async def _run(job: _Job) -> None:
    """Background driver: join + record, then mark the job terminal."""
    os.makedirs(DATA_DIR, exist_ok=True)
    out_path = os.path.join(DATA_DIR, f"{job.id}.ogg")

    def on_status(s: str) -> None:
        job.status = s

    try:
        await join_and_record(
            job.meeting_url, job.bot_name, out_path, job.leave, on_status,
            live_callback=job.live_callback, say_queue=job.say_queue,
            job_id=job.id,
        )
        ok = os.path.isfile(out_path) and os.path.getsize(out_path) > 0
        job.recording = out_path if ok else None
        job.status = "done" if ok else "failed"
        if not ok and not job.error:
            job.error = (
                "Joined the call but captured no audio — check that PulseAudio "
                "and ffmpeg are running inside the container."
            )
    except MeetingBotError as exc:
        job.status = exc.status
        job.error = str(exc)
        job.diagnostics = exc.diagnostics
        _log.warning("bot.failed id=%s status=%s error=%s", job.id, exc.status, exc)
    except Exception as exc:  # never let a runner crash take down the worker
        job.status = "failed"
        job.error = f"{type(exc).__name__}: {str(exc)[:400]}"
        _log.exception("bot.crashed id=%s", job.id)


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "active": sum(1 for j in _JOBS.values() if j.status in
            ("joining", "waiting_room", "in_call", "processing"))}


@app.post("/bots", status_code=201)
async def create_bot(
    req: JoinRequest, authorization: str | None = Header(default=None)
) -> dict:
    _auth(authorization)
    url = (req.meeting_url or "").strip()
    if not url.startswith("http"):
        raise HTTPException(status_code=400, detail="invalid meeting_url")
    job_id = uuid.uuid4().hex
    job = _Job(
        job_id, url,
        (req.bot_name or "AI Notetaker").strip() or "AI Notetaker",
        (req.live_callback or None),
    )
    job.status = "joining"
    _JOBS[job_id] = job
    job.task = asyncio.create_task(_run(job))
    return {"id": job_id, "status": job.status}


@app.post("/bots/{bot_id}/say", status_code=202)
async def say(
    bot_id: str, req: SayRequest, authorization: str | None = Header(default=None)
) -> dict:
    """Queue a line for the bot to speak into the call (TTS → virtual mic).
    The actuator for agent interjections; the runner drains this queue while
    in-call."""
    _auth(authorization)
    job = _JOBS.get(bot_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown bot")
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    job.say_queue.put_nowait(text)
    return {"ok": True}


@app.get("/bots/{bot_id}")
async def get_bot(
    bot_id: str, authorization: str | None = Header(default=None)
) -> dict:
    _auth(authorization)
    job = _JOBS.get(bot_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown bot")
    # download_url null → the gateway falls back to GET /bots/{id}/recording.
    return {"id": bot_id, "status": job.status, "download_url": None, "error": job.error}


@app.get("/bots/{bot_id}/diagnostics")
async def get_diagnostics(
    bot_id: str, authorization: str | None = Header(default=None)
) -> dict:
    """What the page looked like when a join failed.

    Exists because Meet's DOM is not a public API: when a selector misses, the
    only way to write the next one is to see which controls the page actually
    rendered. ``controls`` is that list; ``screenshot`` is served by
    ``/bots/{id}/screenshot``.
    """
    _auth(authorization)
    job = _JOBS.get(bot_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown bot")
    diag = dict(job.diagnostics)
    diag.pop("screenshot", None)  # a path inside the container is not useful
    return {
        "id": bot_id,
        "status": job.status,
        "error": job.error,
        "has_screenshot": bool(job.diagnostics.get("screenshot")),
        "diagnostics": diag,
    }


@app.get("/bots/{bot_id}/screenshot")
async def get_screenshot(
    bot_id: str, authorization: str | None = Header(default=None)
) -> FileResponse:
    """The green room as the bot saw it — the fastest way to tell a waiting
    room from a sign-in wall from a device dialog."""
    _auth(authorization)
    job = _JOBS.get(bot_id)
    shot = (job.diagnostics or {}).get("screenshot") if job else None
    if not shot or not os.path.isfile(shot):
        raise HTTPException(status_code=404, detail="no screenshot")
    return FileResponse(shot, media_type="image/png")


@app.post("/bots/{bot_id}/leave", status_code=202)
async def leave_bot(
    bot_id: str, authorization: str | None = Header(default=None)
) -> dict:
    _auth(authorization)
    job = _JOBS.get(bot_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown bot")
    job.leave.set()  # the runner finalises the recording and leaves
    return {"ok": True}


@app.get("/bots/{bot_id}/recording")
async def get_recording(
    bot_id: str, authorization: str | None = Header(default=None)
) -> FileResponse:
    _auth(authorization)
    job = _JOBS.get(bot_id)
    if job is None or not job.recording or not os.path.isfile(job.recording):
        raise HTTPException(status_code=404, detail="no recording")
    return FileResponse(job.recording, media_type="audio/ogg")
