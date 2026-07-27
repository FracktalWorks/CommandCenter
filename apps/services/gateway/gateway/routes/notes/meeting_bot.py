"""Meeting bot — send a notetaker to join a live Meet/Teams/Zoom call.

Spec §3.13 / decision D10. A pluggable *provider* runs the actual headless
participant. Two are built:

- ``selfhosted`` (**default**, fully in-house): talks to our own worker service
  (``apps/services/meeting-bot`` — headless Chrome via Playwright) over a small
  vendor-neutral HTTP contract. No third-party cloud, no per-hour fee; the cost
  is the box the worker runs on (needs real RAM/CPU — one Chrome per meeting).
- ``recall`` (optional managed fallback): the Recall.ai API, for anyone who'd
  rather not run the worker.

The flow (identical for both):

    paste URL → create meeting + meeting_bot row → provider.join()
      → poll status (joining → waiting room → in call → done)
      → on done: download the bot's audio → ingest as a normal
        `meeting_recording` → run the EXISTING pipeline (transcribe →
        diarize → auto-name speakers → summary → actions).

So a bot recording is just another audio source; everything downstream is
unchanged. Because each bot is an independent server-side job, one user can fan
several notetakers out to concurrent meetings.

Config (all via env; the feature is inert but safe until configured):
- ``NOTES_BOT_PROVIDER`` — ``selfhosted`` (default) or ``recall``.
- ``NOTES_BOT_NAME``     — default display name for the bot ("AI Notetaker").
- self-hosted: ``MEETING_BOT_URL`` — the worker's base URL (required to enable);
                ``MEETING_BOT_TOKEN`` — optional bearer for the worker.
- recall:      ``RECALL_API_KEY`` (required); ``RECALL_REGION`` (default
                ``us-east-1``) or ``RECALL_BASE_URL``.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from urllib.parse import urlparse

import httpx
from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.notes.core import _get_db, _log, media_dir, router
from gateway.routes.notes.pipeline import run_transcription
from pydantic import BaseModel
from sqlalchemy import bindparam, text

# Keep strong refs to poller/pipeline tasks (a bare create_task() can be GC'd).
_TASKS: set[asyncio.Task] = set()

# Recall status codes we care about → our compact lifecycle. Anything unknown
# maps to None (leave status unchanged). See Recall bot `status_changes[].code`.
_RECALL_STATUS = {
    "ready": "joining",
    "joining_call": "joining",
    "in_waiting_room": "waiting_room",
    "in_call_not_recording": "in_call",
    "recording_permission_allowed": "in_call",
    "in_call_recording": "in_call",
    "call_ended": "processing",
    "recording_done": "processing",
    "done": "done",
    "analysis_done": "done",
    "fatal": "failed",
    "recording_permission_denied": "not_admitted",
    "call_join_failed": "failed",
}

# Bot statuses that are still running (drive polling + the "active" surface).
ACTIVE_STATUSES = ("requested", "joining", "waiting_room", "in_call", "processing")
# Every valid lifecycle status (a self-hosted worker reports these directly).
_ALL_STATUSES = (*ACTIVE_STATUSES, "done", "failed", "left", "not_admitted")
_AUDIO_EXT = {
    "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/mpeg": ".mp3",
    "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav",
    "video/mp4": ".mp4", "video/webm": ".webm",
}


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


# ── Pure helpers (unit-tested without network/DB) ────────────────────────────

def detect_platform(url: str) -> str:
    """Map a meeting URL to the platform tag used by `meeting.platform`."""
    host = (urlparse(url).hostname or "").lower()
    if "meet.google.com" in host:
        return "meet"
    if "zoom.us" in host or "zoom.com" in host:
        return "zoom"
    if "teams.microsoft.com" in host or "teams.live.com" in host:
        return "teams"
    return "other"


def is_supported_url(url: str) -> bool:
    """A plausible https meeting link (host present). Kept permissive — Recall
    supports more platforms than we tag; we just won't pretty-label those."""
    try:
        p = urlparse(url)
    except (ValueError, TypeError):
        return False
    return p.scheme in ("http", "https") and bool(p.hostname)


def normalize_status(recall_code: str | None) -> str | None:
    """Recall status code → our lifecycle status (None = unknown, leave as-is)."""
    if not recall_code:
        return None
    return _RECALL_STATUS.get(recall_code)


def extract_download_url(bot: dict) -> str | None:
    """Best-effort pull of a media download URL from a Recall bot object.

    Recall's shape has shifted across API versions, so we probe the known
    locations (prefer mixed audio, then mixed video, then legacy top-level
    fields). Isolated + pure so it's easy to adjust against the live API."""
    if not isinstance(bot, dict):
        return None
    recordings = bot.get("recordings")
    if isinstance(recordings, list):
        for rec in recordings:
            shortcuts = (rec or {}).get("media_shortcuts") or {}
            for key in ("audio_mixed", "video_mixed"):
                node = shortcuts.get(key) or {}
                data = node.get("data") or {}
                url = data.get("download_url") or node.get("download_url")
                if url:
                    return url
    # Legacy top-level fields.
    for key in ("audio_url", "video_url", "media_url"):
        if bot.get(key):
            return bot[key]
    return None


def latest_status_code(bot: dict) -> str | None:
    """The most recent status_changes[].code (or top-level status_code)."""
    changes = bot.get("status_changes") if isinstance(bot, dict) else None
    if isinstance(changes, list) and changes:
        last = changes[-1]
        if isinstance(last, dict):
            return last.get("code")
    status = bot.get("status") if isinstance(bot, dict) else None
    if isinstance(status, dict):
        return status.get("code")
    return status if isinstance(status, str) else None


# ── Provider config + Recall client ──────────────────────────────────────────

def _provider_name() -> str:
    # Default to the fully in-house worker; 'recall' remains an optional managed
    # fallback for anyone who'd rather not run the worker.
    return os.environ.get("NOTES_BOT_PROVIDER", "selfhosted").strip().lower()


def _recall_key() -> str:
    return os.environ.get("RECALL_API_KEY", "").strip()


def _recall_base() -> str:
    base = os.environ.get("RECALL_BASE_URL", "").strip().rstrip("/")
    if base:
        return base
    region = os.environ.get("RECALL_REGION", "us-east-1").strip() or "us-east-1"
    return f"https://{region}.recall.ai/api/v1"


def _selfhosted_url() -> str:
    """Base URL of the self-hosted meeting-bot worker (apps/services/meeting-bot)."""
    return os.environ.get("MEETING_BOT_URL", "").strip().rstrip("/")


def _selfhosted_token() -> str:
    return os.environ.get("MEETING_BOT_TOKEN", "").strip()


def default_bot_name() -> str:
    return os.environ.get("NOTES_BOT_NAME", "AI Notetaker").strip() or "AI Notetaker"


def bot_configured() -> bool:
    """True when a provider is actually usable.

    - ``selfhosted`` (default goal — fully in-house): needs the worker URL.
    - ``recall`` (optional managed fallback): needs the API key."""
    provider = _provider_name()
    if provider == "selfhosted":
        return bool(_selfhosted_url())
    return provider == "recall" and bool(_recall_key())


class RecallProvider:
    """Thin async client over the Recall.ai bot API. All calls raise on HTTP
    error; callers wrap them so a provider hiccup never crashes the poller."""

    def __init__(self) -> None:
        self._base = _recall_base()
        self._headers = {
            "Authorization": f"Token {_recall_key()}",
            "Content-Type": "application/json",
        }

    async def join(
        self, meeting_url: str, bot_name: str, live_callback: str | None = None
    ) -> str:
        """Create a bot in the call; returns the provider bot id. (Recall doesn't
        do our live-callback streaming, so ``live_callback`` is ignored.)"""
        body: dict = {"meeting_url": meeting_url, "bot_name": bot_name}
        raw = os.environ.get("RECALL_RECORDING_CONFIG", "").strip()
        if raw:
            import contextlib
            import json as _json

            with contextlib.suppress(ValueError):
                body["recording_config"] = _json.loads(raw)
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self._base}/bot/", headers=self._headers, json=body
            )
            resp.raise_for_status()
            data = resp.json()
        bot_id = data.get("id") or data.get("bot_id")
        if not bot_id:
            raise RuntimeError("Recall did not return a bot id")
        return str(bot_id)

    async def fetch(self, bot_id: str) -> dict:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{self._base}/bot/{bot_id}/", headers=self._headers
            )
            resp.raise_for_status()
            return resp.json()

    async def status(self, bot_id: str) -> tuple[str | None, str | None]:
        """Provider-agnostic (lifecycle_status, download_url|None) for the poller."""
        bot = await self.fetch(bot_id)
        return normalize_status(latest_status_code(bot)), extract_download_url(bot)

    async def leave(self, bot_id: str) -> None:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self._base}/bot/{bot_id}/leave_call/", headers=self._headers
            )
            # 200/202 expected; a already-gone bot may 404 — tolerate.
            if resp.status_code not in (200, 202, 204, 404):
                resp.raise_for_status()

    async def download(self, url: str) -> tuple[bytes, str]:
        """Fetch the recording bytes + content-type from a (signed) media URL."""
        async with httpx.AsyncClient(timeout=600, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            ctype = (resp.headers.get("content-type") or "").split(";")[0].strip()
            return resp.content, ctype


class SelfHostedProvider:
    """Client for a *self-hosted* meeting-bot worker — a headless Chrome that
    joins the call, running on our own box (apps/services/meeting-bot). Fully
    in-house: no third-party cloud, no per-hour fee. Speaks a small
    vendor-neutral HTTP contract, and the worker already reports our lifecycle
    vocabulary so no per-provider status translation is needed.

    Contract:
      POST   {base}/bots                {meeting_url, bot_name} -> {id, status}
      GET    {base}/bots/{id}           -> {id, status, download_url|null}
      POST   {base}/bots/{id}/leave     -> 202
      GET    {base}/bots/{id}/recording -> audio bytes (when status == done)
    """

    def __init__(self) -> None:
        self._base = _selfhosted_url()
        self._headers = {"Content-Type": "application/json"}
        tok = _selfhosted_token()
        if tok:
            self._headers["Authorization"] = f"Bearer {tok}"

    async def join(
        self, meeting_url: str, bot_name: str, live_callback: str | None = None
    ) -> str:
        body: dict = {"meeting_url": meeting_url, "bot_name": bot_name}
        # Tell the worker where to POST live transcript segments (per meeting) so
        # the UI + agents get a live feed. Omitted → the worker just records.
        if live_callback:
            body["live_callback"] = live_callback
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self._base}/bots", headers=self._headers, json=body
            )
            resp.raise_for_status()
            data = resp.json()
        bot_id = data.get("id")
        if not bot_id:
            raise RuntimeError("meeting-bot worker did not return a bot id")
        return str(bot_id)

    async def status(self, bot_id: str) -> tuple[str | None, str | None]:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{self._base}/bots/{bot_id}", headers=self._headers
            )
            resp.raise_for_status()
            data = resp.json()
        status = data.get("status")
        status = status if status in _ALL_STATUSES else None
        download = data.get("download_url") or None
        # Worker may serve the file at a stable path instead of returning a URL.
        if status == "done" and not download:
            download = f"{self._base}/bots/{bot_id}/recording"
        return status, download

    async def leave(self, bot_id: str) -> None:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self._base}/bots/{bot_id}/leave", headers=self._headers
            )
            if resp.status_code not in (200, 202, 204, 404):
                resp.raise_for_status()

    async def say(self, bot_id: str, text: str) -> None:
        """Have the worker speak a line into the live call (TTS → virtual mic).
        The seam for agent-driven interjections; only the self-hosted worker
        can do this."""
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{self._base}/bots/{bot_id}/say",
                headers=self._headers,
                json={"text": text},
            )
            resp.raise_for_status()

    async def download(self, url: str) -> tuple[bytes, str]:
        async with httpx.AsyncClient(timeout=600, follow_redirects=True) as client:
            resp = await client.get(url, headers=self._headers)
            resp.raise_for_status()
            ctype = (resp.headers.get("content-type") or "").split(";")[0].strip()
            return resp.content, ctype


def resolve_bot_provider() -> RecallProvider | SelfHostedProvider | None:
    if not bot_configured():
        return None
    if _provider_name() == "selfhosted":
        return SelfHostedProvider()
    return RecallProvider()


# ── DB helpers + ingest ──────────────────────────────────────────────────────

async def _set_bot(db, bot_id: str, **fields) -> None:
    assigns = ", ".join(f"{k} = :{k}" for k in fields)
    assigns = f"{assigns}, updated_at = now()" if assigns else "updated_at = now()"
    await db.execute(
        text(f"UPDATE meeting_bot SET {assigns} WHERE id = :id"),
        {**fields, "id": bot_id},
    )


async def _ingest_recording(meeting_id: str, audio: bytes, ctype: str) -> None:
    """Save the bot's audio as a `meeting_recording` and run the pipeline —
    identical to an upload, so diarization/speaker-naming/summary all apply."""
    ext = _AUDIO_EXT.get(ctype, ".mp4")
    mime = ctype or "audio/mp4"
    recording_id = str(uuid.uuid4())
    rel_path = f"{meeting_id}/{recording_id}{ext}"
    dest = media_dir() / rel_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(audio)

    async with await _get_db() as db:
        await db.execute(
            text(
                "INSERT INTO meeting_recording (id, meeting_id, channel, "
                "artifact_path, mime, byte_size) VALUES "
                "(:id, :mid, 'mixed', :path, :mime, :size)"
            ),
            {"id": recording_id, "mid": meeting_id, "path": rel_path,
             "mime": mime, "size": len(audio)},
        )
        run_row = (
            await db.execute(
                text(
                    "INSERT INTO summary_run (meeting_id, kind, status, stage) "
                    "VALUES (:mid, 'transcribe', 'queued', 'queued') RETURNING id"
                ),
                {"mid": meeting_id},
            )
        ).fetchone()
        await db.execute(
            text("UPDATE meeting SET status='processing', end_at=COALESCE(end_at, now()) "
                 "WHERE id=:id"),
            {"id": meeting_id},
        )
        await db.commit()
    _spawn(run_transcription(meeting_id, recording_id, str(run_row.id)))
    _log.info("notes.bot_ingested", meeting_id=meeting_id, bytes=len(audio), mime=mime)


async def _refresh_bot(bot_row_id: str) -> None:
    """Poll the provider once and advance the bot's state; ingest on completion.
    Idempotent + safe to call from both the background poller and poll-on-read;
    ingestion is claimed atomically so it happens exactly once. Never raises."""
    provider = resolve_bot_provider()
    if provider is None:
        return
    try:
        async with await _get_db() as db:
            row = (
                await db.execute(
                    text("SELECT id, meeting_id, provider_bot_id, status "
                         "FROM meeting_bot WHERE id = :id"),
                    {"id": bot_row_id},
                )
            ).fetchone()
        if row is None or row.status not in ACTIVE_STATUSES or not row.provider_bot_id:
            return

        new_status, download_url = await provider.status(row.provider_bot_id)

        # Terminal success: call finished AND media is downloadable → claim the
        # ingest atomically (only one caller flips out of an active status).
        if new_status == "done" and download_url:
            async with await _get_db() as db:
                claim = (
                    await db.execute(
                        text(
                            "UPDATE meeting_bot SET status='done', updated_at=now() "
                            "WHERE id=:id AND status IN :active RETURNING id"
                        ).bindparams(bindparam("active", expanding=True)),
                        {"id": bot_row_id, "active": list(ACTIVE_STATUSES)},
                    )
                ).fetchone()
                await db.commit()
            if claim is None:
                return  # another caller is ingesting
            try:
                audio, ctype = await provider.download(download_url)
                await _ingest_recording(str(row.meeting_id), audio, ctype)
            except Exception as exc:  # ingest failed after claiming
                async with await _get_db() as db:
                    await _set_bot(db, bot_row_id, status="failed",
                                   error=f"ingest failed: {str(exc)[:400]}")
                    await db.execute(
                        text("UPDATE meeting SET status='failed' WHERE id=:id"),
                        {"id": str(row.meeting_id)},
                    )
                    await db.commit()
            return

        # Non-terminal (or terminal-without-media-yet): record status changes.
        if new_status and new_status != row.status and new_status != "done":
            async with await _get_db() as db:
                await _set_bot(db, bot_row_id, status=new_status)
                if new_status in ("failed", "not_admitted"):
                    await db.execute(
                        text("UPDATE meeting SET status='failed' WHERE id=:id"),
                        {"id": str(row.meeting_id)},
                    )
                    # Never left the ground — clear presence (the pipeline that
                    # normally ends a session won't run without a recording).
                    from gateway.routes.notes import live_session

                    await live_session.end(str(row.meeting_id))
                elif new_status == "in_call":
                    await db.execute(
                        text("UPDATE meeting SET status='recording' "
                             "WHERE id=:id AND status='draft'"),
                        {"id": str(row.meeting_id)},
                    )
                await db.commit()
    except Exception as exc:
        _log.warning("notes.bot_refresh_failed", bot=bot_row_id, error=str(exc)[:200])


async def _poll_bot(bot_row_id: str) -> None:
    """Background loop: refresh a bot until it leaves the active set. Best-effort
    — a gateway restart drops it, but poll-on-read (`GET /notes/bots/active`)
    keeps the DB state advancing and still triggers ingest."""
    # ~4h ceiling at 15s cadence — long enough for any real meeting.
    for _ in range(960):
        await _refresh_bot(bot_row_id)
        async with await _get_db() as db:
            row = (
                await db.execute(
                    text("SELECT status FROM meeting_bot WHERE id=:id"),
                    {"id": bot_row_id},
                )
            ).fetchone()
        if row is None or row.status not in ACTIVE_STATUSES:
            return
        await asyncio.sleep(15)


# ── API models ───────────────────────────────────────────────────────────────

class BotJoinRequest(BaseModel):
    meeting_url: str
    title: str | None = None
    bot_name: str | None = None


class MeetingBotModel(BaseModel):
    id: str
    meeting_id: str
    status: str
    provider: str
    meeting_url: str
    bot_name: str | None = None
    error: str | None = None
    meeting_title: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


def _row_to_bot(r) -> MeetingBotModel:
    return MeetingBotModel(
        id=str(r.id), meeting_id=str(r.meeting_id), status=r.status,
        provider=r.provider, meeting_url=r.meeting_url, bot_name=r.bot_name,
        error=r.error,
        meeting_title=getattr(r, "meeting_title", None),
        created_at=r.created_at.isoformat() if r.created_at else None,
        updated_at=r.updated_at.isoformat() if getattr(r, "updated_at", None) else None,
    )


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/bots/status")
async def bot_status(_user: UserContext = Depends(get_current_user)) -> dict:
    """Whether the meeting-bot feature is usable (a provider key is set)."""
    return {"configured": bot_configured(), "provider": _provider_name()}


@router.post("/meetings/bot-join", status_code=201)
async def bot_join(
    body: BotJoinRequest,
    user: UserContext = Depends(get_current_user),
) -> MeetingBotModel:
    """Send a notetaker bot to join a meeting URL. Creates the meeting + bot,
    dispatches the provider, and starts tracking. Call once per URL to fan out
    to multiple meetings concurrently."""
    url = (body.meeting_url or "").strip()
    if not is_supported_url(url):
        raise HTTPException(status_code=400, detail="Enter a valid meeting link (https://…).")
    provider = resolve_bot_provider()
    if provider is None:
        raise HTTPException(
            status_code=503,
            detail="The meeting notetaker isn't set up yet — an admin needs to "
                   "point it at a self-hosted meeting-bot worker (MEETING_BOT_URL) "
                   "or configure a provider key.",
        )
    platform = detect_platform(url)
    bot_name = (body.bot_name or "").strip() or default_bot_name()
    title = (body.title or "").strip() or None

    async with await _get_db() as db:
        m = (
            await db.execute(
                text(
                    "INSERT INTO meeting (platform, start_at, title, status, owner_email) "
                    "VALUES (:p, now(), :t, 'recording', :o) RETURNING id"
                ),
                {"p": platform, "t": title, "o": user.email},
            )
        ).fetchone()
        meeting_id = str(m.id)
        bot_row = (
            await db.execute(
                text(
                    "INSERT INTO meeting_bot (meeting_id, provider, meeting_url, "
                    "bot_name, status, requested_by) VALUES "
                    "(:mid, :prov, :url, :name, 'requested', :by) RETURNING id"
                ),
                {"mid": meeting_id, "prov": _provider_name(), "url": url,
                 "name": bot_name, "by": user.email},
            )
        ).fetchone()
        await db.commit()
    bot_row_id = str(bot_row.id)

    # Where the worker posts live transcript segments for this meeting (enables
    # live captions + agent hooks). Only when a reachable gateway base is set.
    live_callback = None
    base = os.environ.get("NOTES_LIVE_CALLBACK_BASE", "").strip().rstrip("/")
    if base:
        live_callback = f"{base}/notes/meetings/{meeting_id}/live/segment"

    try:
        provider_bot_id = await provider.join(url, bot_name, live_callback=live_callback)
    except Exception as exc:
        async with await _get_db() as db:
            await _set_bot(db, bot_row_id, status="failed",
                           error=f"join failed: {str(exc)[:400]}")
            await db.execute(text("UPDATE meeting SET status='failed' WHERE id=:id"),
                             {"id": meeting_id})
            await db.commit()
        _log.warning("notes.bot_join_failed", meeting_id=meeting_id, error=str(exc)[:200])
        raise HTTPException(
            status_code=502,
            detail="Couldn't dispatch the notetaker to that meeting. Check the link.",
        ) from None

    async with await _get_db() as db:
        await _set_bot(db, bot_row_id, provider_bot_id=provider_bot_id, status="joining")
        await db.commit()
    # Register presence — a bot meeting shows as "live now" in Command Center
    # from the moment it's dispatched, not just once audio starts flowing.
    from gateway.routes.notes import live_session

    await live_session.begin(meeting_id, "bot", user.email)
    _log.info("notes.bot_joined", meeting_id=meeting_id, platform=platform)
    _spawn(_poll_bot(bot_row_id))

    return MeetingBotModel(
        id=bot_row_id, meeting_id=meeting_id, status="joining",
        provider=_provider_name(), meeting_url=url, bot_name=bot_name,
        meeting_title=title,
    )


_ACTIVE_SQL = (
    "SELECT b.*, m.title AS meeting_title FROM meeting_bot b "
    "JOIN meeting m ON m.id = b.meeting_id "
    "WHERE b.status IN :active ORDER BY b.created_at DESC"
)


@router.get("/bots/active")
async def list_active_bots(
    _user: UserContext = Depends(get_current_user),
) -> list[MeetingBotModel]:
    """Active notetaker bots (for the live surface). Poll-on-read: refresh each
    from the provider so status advances (and completed calls ingest) even
    without the in-process poller."""
    async with await _get_db() as db:
        rows = (
            await db.execute(
                text(_ACTIVE_SQL).bindparams(bindparam("active", expanding=True)),
                {"active": list(ACTIVE_STATUSES)},
            )
        ).fetchall()
    ids = [str(r.id) for r in rows]
    if ids:
        await asyncio.gather(*(_refresh_bot(i) for i in ids), return_exceptions=True)
        async with await _get_db() as db:
            rows = (
                await db.execute(
                    text(_ACTIVE_SQL).bindparams(bindparam("active", expanding=True)),
                    {"active": list(ACTIVE_STATUSES)},
                )
            ).fetchall()
    return [_row_to_bot(r) for r in rows]


@router.get("/meetings/{meeting_id}/bot")
async def get_meeting_bot(
    meeting_id: str,
    _user: UserContext = Depends(get_current_user),
) -> MeetingBotModel | None:
    async with await _get_db() as db:
        r = (
            await db.execute(
                text("SELECT b.*, m.title AS meeting_title FROM meeting_bot b "
                     "JOIN meeting m ON m.id=b.meeting_id WHERE b.meeting_id=:id "
                     "ORDER BY b.created_at DESC LIMIT 1"),
                {"id": meeting_id},
            )
        ).fetchone()
    if r is None:
        return None
    if r.status in ACTIVE_STATUSES:
        await _refresh_bot(str(r.id))
        async with await _get_db() as db:
            r = (
                await db.execute(
                    text("SELECT b.*, m.title AS meeting_title FROM meeting_bot b "
                         "JOIN meeting m ON m.id=b.meeting_id WHERE b.id=:id"),
                    {"id": str(r.id)},
                )
            ).fetchone()
    return _row_to_bot(r)


@router.post("/meetings/{meeting_id}/bot/stop", status_code=202)
async def stop_meeting_bot(
    meeting_id: str,
    _user: UserContext = Depends(get_current_user),
) -> dict:
    """Remove the notetaker from the call. Any audio captured so far is still
    processed by the provider and ingested when ready."""
    async with await _get_db() as db:
        r = (
            await db.execute(
                text("SELECT id, provider_bot_id, status FROM meeting_bot "
                     "WHERE meeting_id=:id ORDER BY created_at DESC LIMIT 1"),
                {"id": meeting_id},
            )
        ).fetchone()
    if r is None:
        raise HTTPException(status_code=404, detail="no bot for this meeting")
    provider = resolve_bot_provider()
    if provider is not None and r.provider_bot_id and r.status in ACTIVE_STATUSES:
        try:
            await provider.leave(r.provider_bot_id)
        except Exception as exc:
            _log.warning("notes.bot_stop_failed", meeting_id=meeting_id, error=str(exc)[:200])
    async with await _get_db() as db:
        await _set_bot(db, str(r.id), status="processing")
        await db.commit()
    # Kick one refresh so ingest happens promptly once the recording finalizes.
    _spawn(_poll_bot(str(r.id)))
    return {"ok": True, "status": "processing"}
