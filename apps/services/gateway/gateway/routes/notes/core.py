"""Note Taker routes — shared kernel.

The shared ``router``, Pydantic models, DB session factory and row→model
mappers used by the meetings/recordings/pipeline modules. Mirrors
``routes/tasks/core.py`` (the leaf module: it imports nothing from siblings).

Canonical store: the ``meeting`` / ``meeting_recording`` / ``transcript_segment``
/ ``meeting_note`` / ``summary_run`` / ``action_item`` tables
(``infra/postgres/01_schema.sql`` + ``95_note_taker.sql``; spec:
ai-company-brain/specs/note_taker_app.md §3.6).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from acb_common import get_logger, get_settings
from fastapi import APIRouter
from pydantic import BaseModel

_log = get_logger("gateway.notes")

router = APIRouter(prefix="/notes", tags=["notes"])


# ── Models (snake_case — same convention as tasks) ───────────────────────────

class SegmentModel(BaseModel):
    id: str
    idx: int
    start_s: float
    end_s: float
    text: str
    speaker_label: str | None = None
    channel: str | None = None
    confidence: float | None = None


class RecordingModel(BaseModel):
    id: str
    channel: str
    mime: str
    duration_s: float | None = None
    byte_size: int = 0
    created_at: str | None = None


class SummaryRunModel(BaseModel):
    id: str
    kind: str
    status: str
    stage: str | None = None
    chunk_done: int = 0
    chunk_total: int = 0
    model: str | None = None
    error: str | None = None
    created_at: str | None = None
    finished_at: str | None = None


class MeetingListItem(BaseModel):
    id: str
    title: str | None = None
    platform: str
    status: str
    language: str | None = None
    duration_s: float | None = None
    segment_count: int = 0
    has_notes: bool = False
    owner_email: str | None = None
    start_at: str | None = None
    created_at: str | None = None


class Attendee(BaseModel):
    name: str = ""
    email: str = ""


class MeetingDetail(MeetingListItem):
    transcript_source: str | None = None
    summary_md: str | None = None
    scratch_notes: str | None = None
    attendees: list[Attendee] = []
    # Human names for diarized speaker labels, {"S1": "Alex Rivera", …}.
    speaker_names: dict[str, str] = {}
    recordings: list[RecordingModel] = []
    segments: list[SegmentModel] = []
    runs: list[SummaryRunModel] = []


class CreateMeetingRequest(BaseModel):
    title: str | None = None
    platform: str = "upload"        # 'in_person' once the recorder ships
    template_key: str | None = None


class PatchMeetingRequest(BaseModel):
    title: str | None = None
    template_key: str | None = None


# ── DB (shared pooled async engine, same recipe as tasks/core.py) ────────────

_ENGINE = None
_SESSION_FACTORY = None


def _get_session_factory():
    global _ENGINE, _SESSION_FACTORY
    if _SESSION_FACTORY is None:
        from sqlalchemy.ext.asyncio import (
            async_sessionmaker,
            create_async_engine,
        )
        settings = get_settings()
        db_url = os.environ.get("DATABASE_URL", settings.database_url)
        if "postgresql+psycopg" in db_url:
            db_url = db_url.replace("postgresql+psycopg", "postgresql+asyncpg")
        elif db_url.startswith("postgresql://"):
            db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")
        _ENGINE = create_async_engine(
            db_url, echo=False, pool_pre_ping=True,
            pool_size=5, max_overflow=10, pool_recycle=1800,
            connect_args={"timeout": settings.db_connect_timeout},
        )
        _SESSION_FACTORY = async_sessionmaker(_ENGINE, expire_on_commit=False)
    return _SESSION_FACTORY


async def _get_db():
    """Return a new async session from the shared, pooled engine."""
    return _get_session_factory()()


# ── Media storage (same recipe as tasks/attachments.py) ──────────────────────

def media_dir() -> Path:
    d = Path(os.environ.get("NOTES_MEDIA_DIR", "data/notes_media"))
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── Row → model mappers ──────────────────────────────────────────────────────

def _iso(v: Any) -> str | None:
    return v.isoformat() if v is not None else None


def row_to_segment(r: Any) -> SegmentModel:
    return SegmentModel(
        id=str(r.id), idx=r.idx, start_s=r.start_s or 0.0, end_s=r.end_s or 0.0,
        text=r.text or "", speaker_label=r.speaker_label, channel=r.channel,
        confidence=r.confidence,
    )


def row_to_recording(r: Any) -> RecordingModel:
    return RecordingModel(
        id=str(r.id), channel=r.channel, mime=r.mime, duration_s=r.duration_s,
        byte_size=r.byte_size or 0, created_at=_iso(r.created_at),
    )


def row_to_run(r: Any) -> SummaryRunModel:
    return SummaryRunModel(
        id=str(r.id), kind=r.kind, status=r.status, stage=r.stage,
        chunk_done=r.chunk_done or 0, chunk_total=r.chunk_total or 0,
        model=r.model, error=r.error, created_at=_iso(r.created_at),
        finished_at=_iso(r.finished_at),
    )


def row_to_list_item(r: Any) -> MeetingListItem:
    return MeetingListItem(
        id=str(r.id), title=r.title, platform=r.platform, status=r.status,
        language=r.language, duration_s=r.duration_s,
        segment_count=getattr(r, "segment_count", 0) or 0,
        has_notes=bool(getattr(r, "has_notes", False)),
        owner_email=r.owner_email, start_at=_iso(r.start_at),
        created_at=_iso(r.created_at),
    )
