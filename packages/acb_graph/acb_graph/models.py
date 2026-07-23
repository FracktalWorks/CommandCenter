"""SQLAlchemy ORM models — 1:1 mirror of infra/postgres/01_schema.sql.

These are the runtime objects we hand to `Session` for upsert/query — the
storage surface. (There is no separate Pydantic wire/API layer; routes use the
ORM + ad-hoc dicts directly.)
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    ARRAY,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[UUID]:
    return mapped_column(PgUUID(as_uuid=True), primary_key=True, default=uuid4)


def _created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def _updated_at() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class Person(Base):
    __tablename__ = "person"

    id: Mapped[UUID] = _uuid_pk()
    canonical_name: Mapped[str] = mapped_column(Text, nullable=False)
    aliases: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}", nullable=False)
    clickup_id: Mapped[str | None] = mapped_column(Text, unique=True)
    zoho_id: Mapped[str | None] = mapped_column(Text, unique=True)
    odoo_id: Mapped[str | None] = mapped_column(Text, unique=True)
    email: Mapped[str | None] = mapped_column(Text, unique=True)
    whatsapp_e164: Mapped[str | None] = mapped_column(Text)
    role: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = _updated_at()


class Customer(Base):
    __tablename__ = "customer"

    id: Mapped[UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    zoho_id: Mapped[str | None] = mapped_column(Text, unique=True)
    odoo_id: Mapped[str | None] = mapped_column(Text, unique=True)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = _updated_at()


class Project(Base):
    __tablename__ = "project"

    id: Mapped[UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    clickup_id: Mapped[str | None] = mapped_column(Text, unique=True)
    customer_id: Mapped[UUID | None] = mapped_column(PgUUID(as_uuid=True), ForeignKey("customer.id"))
    status: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = _updated_at()

    customer: Mapped[Customer | None] = relationship(lazy="joined")


class Task(Base):
    __tablename__ = "task"
    __table_args__ = (
        Index("task_stage_idx", "stage"),
        Index("task_owner_idx", "owner_id"),
        Index("task_project_idx", "project_id"),
    )

    id: Mapped[UUID] = _uuid_pk()
    title: Mapped[str] = mapped_column(Text, nullable=False)
    clickup_id: Mapped[str | None] = mapped_column(Text, unique=True)
    owner_id: Mapped[UUID | None] = mapped_column(PgUUID(as_uuid=True), ForeignKey("person.id"))
    project_id: Mapped[UUID | None] = mapped_column(PgUUID(as_uuid=True), ForeignKey("project.id"))
    stage: Mapped[str | None] = mapped_column(Text)
    stage_entered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    days_in_stage: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = _updated_at()

    owner: Mapped[Person | None] = relationship(lazy="joined")
    project: Mapped[Project | None] = relationship(lazy="joined")


class Deal(Base):
    __tablename__ = "deal"
    __table_args__ = (
        CheckConstraint("deal_type IN ('product','service','software')", name="deal_type_check"),
    )

    id: Mapped[UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    zoho_id: Mapped[str | None] = mapped_column(Text, unique=True)
    customer_id: Mapped[UUID | None] = mapped_column(PgUUID(as_uuid=True), ForeignKey("customer.id"))
    owner_id: Mapped[UUID | None] = mapped_column(PgUUID(as_uuid=True), ForeignKey("person.id"))
    stage: Mapped[str | None] = mapped_column(Text)
    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    value_inr: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    deal_type: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = _updated_at()

    customer: Mapped[Customer | None] = relationship(lazy="joined")
    owner: Mapped[Person | None] = relationship(lazy="joined")


class Message(Base):
    __tablename__ = "message"
    __table_args__ = (
        CheckConstraint("channel IN ('email','whatsapp','meeting','other')", name="message_channel_check"),
        Index("message_thread_idx", "thread_id"),
    )

    id: Mapped[UUID] = _uuid_pk()
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    author_id: Mapped[UUID | None] = mapped_column(PgUUID(as_uuid=True), ForeignKey("person.id"))
    thread_id: Mapped[str | None] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024))
    created_at: Mapped[datetime] = _created_at()


class Meeting(Base):
    __tablename__ = "meeting"
    __table_args__ = (
        CheckConstraint(
            "platform IN ('meet','zoom','teams','other','in_person','upload')",
            name="meeting_platform_check",
        ),
        CheckConstraint(
            "status IN ('draft','recording','processing','ready','failed')",
            name="meeting_status_check",
        ),
    )

    id: Mapped[UUID] = _uuid_pk()
    platform: Mapped[str] = mapped_column(Text, nullable=False)
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attendee_ids: Mapped[list[UUID]] = mapped_column(
        ARRAY(PgUUID(as_uuid=True)), server_default="{}", nullable=False
    )
    transcript: Mapped[str | None] = mapped_column(Text)
    transcript_source: Mapped[str | None] = mapped_column(Text)
    # Note Taker app fields (infra/postgres/95_note_taker.sql)
    title: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default="draft", nullable=False)
    language: Mapped[str | None] = mapped_column(Text)
    duration_s: Mapped[float | None] = mapped_column()
    owner_email: Mapped[str | None] = mapped_column(Text)
    template_key: Mapped[str | None] = mapped_column(Text)
    summary_json: Mapped[dict | None] = mapped_column(JSONB)
    summary_md: Mapped[str | None] = mapped_column(Text)
    # External attendees as [{name, email}] (infra/postgres/96_note_taker_attendees.sql);
    # distinct from attendee_ids (org person refs).
    attendees: Mapped[list | None] = mapped_column(JSONB, server_default="[]")
    created_at: Mapped[datetime] = _created_at()


class MeetingRecording(Base):
    __tablename__ = "meeting_recording"
    __table_args__ = (
        CheckConstraint(
            "channel IN ('mic','system','mixed','upload')",
            name="meeting_recording_channel_check",
        ),
    )

    id: Mapped[UUID] = _uuid_pk()
    meeting_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("meeting.id", ondelete="CASCADE"), nullable=False
    )
    channel: Mapped[str] = mapped_column(Text, server_default="upload", nullable=False)
    artifact_path: Mapped[str] = mapped_column(Text, nullable=False)
    mime: Mapped[str] = mapped_column(
        Text, server_default="application/octet-stream", nullable=False
    )
    duration_s: Mapped[float | None] = mapped_column()
    byte_size: Mapped[int] = mapped_column(server_default="0", nullable=False)
    created_at: Mapped[datetime] = _created_at()


class TranscriptSegment(Base):
    __tablename__ = "transcript_segment"

    id: Mapped[UUID] = _uuid_pk()
    meeting_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("meeting.id", ondelete="CASCADE"), nullable=False
    )
    recording_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("meeting_recording.id", ondelete="SET NULL")
    )
    idx: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    start_s: Mapped[float] = mapped_column(server_default="0", nullable=False)
    end_s: Mapped[float] = mapped_column(server_default="0", nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    speaker_label: Mapped[str | None] = mapped_column(Text)
    speaker_person_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("person.id")
    )
    channel: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column()
    words: Mapped[list | None] = mapped_column(JSONB)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024))
    created_at: Mapped[datetime] = _created_at()


class MeetingNote(Base):
    __tablename__ = "meeting_note"

    meeting_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("meeting.id", ondelete="CASCADE"),
        primary_key=True,
    )
    notes_md: Mapped[str | None] = mapped_column(Text)
    notes_json: Mapped[dict | None] = mapped_column(JSONB)
    updated_by: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = _updated_at()


class SummaryRun(Base):
    __tablename__ = "summary_run"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('transcribe','summary','actions','translate','title')",
            name="summary_run_kind_check",
        ),
        CheckConstraint(
            "status IN ('queued','running','done','failed','cancelled')",
            name="summary_run_status_check",
        ),
    )

    id: Mapped[UUID] = _uuid_pk()
    meeting_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("meeting.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, server_default="summary", nullable=False)
    status: Mapped[str] = mapped_column(Text, server_default="queued", nullable=False)
    stage: Mapped[str | None] = mapped_column(Text)
    chunk_done: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    chunk_total: Mapped[int] = mapped_column(Integer, server_default="0", nullable=False)
    model: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict | None] = mapped_column(JSONB)
    result_backup: Mapped[dict | None] = mapped_column(JSONB)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created_at()


class ActionItem(Base):
    __tablename__ = "action_item"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft','approved','created','rejected')", name="action_item_status_check"
        ),
    )

    id: Mapped[UUID] = _uuid_pk()
    meeting_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("meeting.id", ondelete="CASCADE"), nullable=False
    )
    assignee_id: Mapped[UUID | None] = mapped_column(PgUUID(as_uuid=True), ForeignKey("person.id"))
    description: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float] = mapped_column(server_default="0.0", nullable=False)
    status: Mapped[str] = mapped_column(Text, server_default="draft", nullable=False)
    resulting_task_id: Mapped[UUID | None] = mapped_column(PgUUID(as_uuid=True), ForeignKey("task.id"))
    # Note Taker grounding (infra/postgres/95_note_taker.sql)
    segment_ids: Mapped[list[UUID]] = mapped_column(
        ARRAY(PgUUID(as_uuid=True)), server_default="{}", nullable=False
    )
    due_hint: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()


class AuditEvent(Base):
    __tablename__ = "audit_event"
    __table_args__ = (
        Index("audit_actor_idx", "actor"),
        Index("audit_at_idx", "at"),
    )

    id: Mapped[UUID] = _uuid_pk()
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    target: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, server_default="{}", nullable=False)


__all__ = [
    "ActionItem",
    "AuditEvent",
    "Base",
    "Customer",
    "Deal",
    "Meeting",
    "Message",
    "Person",
    "Project",
    "Task",
]
