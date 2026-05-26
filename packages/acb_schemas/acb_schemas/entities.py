"""Canonical entity models. Keep aligned with infra/postgres/01_schema.sql."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class _Entity(BaseModel):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    id: UUID = Field(default_factory=uuid4)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class Person(_Entity):
    canonical_name: str
    aliases: list[str] = Field(default_factory=list)
    clickup_id: str | None = None
    zoho_id: str | None = None
    odoo_id: str | None = None
    email: EmailStr | None = None
    whatsapp_e164: str | None = None
    role: str | None = None


class Project(_Entity):
    name: str
    clickup_id: str | None = None
    customer_id: UUID | None = None
    status: str | None = None


class Task(_Entity):
    title: str
    clickup_id: str | None = None
    owner_id: UUID | None = None
    project_id: UUID | None = None
    stage: str | None = None
    stage_entered_at: datetime | None = None
    days_in_stage: int | None = None


class Customer(_Entity):
    name: str
    zoho_id: str | None = None
    odoo_id: str | None = None


class Deal(_Entity):
    name: str
    zoho_id: str | None = None
    customer_id: UUID | None = None
    owner_id: UUID | None = None
    stage: str | None = None
    last_activity_at: datetime | None = None
    value_inr: Decimal | None = None
    deal_type: Literal["product", "service", "software"] | None = None


class Message(_Entity):
    channel: Literal["email", "whatsapp", "meeting", "other"]
    author_id: UUID | None = None
    thread_id: str | None = None
    body: str
    sent_at: datetime | None = None


class Meeting(_Entity):
    platform: Literal["meet", "zoom", "teams", "other"]
    start: datetime
    end: datetime | None = None
    attendee_ids: list[UUID] = Field(default_factory=list)
    transcript: str | None = None
    transcript_source: str | None = None


class ActionItem(_Entity):
    meeting_id: UUID
    assignee_id: UUID | None = None
    description: str
    confidence: float = 0.0
    status: Literal["draft", "approved", "created", "rejected"] = "draft"
    resulting_task_id: UUID | None = None
