"""Task-manager routes — shared kernel.

The shared ``router``, Pydantic models, DB infrastructure, row→model mappers
and ownership helpers used by the accounts/items/ai layers. Mirrors the email
package's ``core.py`` (the leaf module: it imports nothing from siblings).

Canonical store: the ``task_accounts`` / ``gtd_*`` tables from
``infra/postgres/48_task_manager_gtd.sql`` (spec: ai-company-brain/specs/
task_manager_app.md §4). Dual-source model (§5.1): LOCAL rows are ours;
SYNCED rows mirror a connected PM tool through the provider layer.
"""

from __future__ import annotations

import json
import os
from typing import Any

from acb_common import get_logger, get_settings
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

_log = get_logger("gateway.tasks")

router = APIRouter(prefix="/tasks", tags=["tasks"])


# ── Models (snake_case — the frontend maps to camelCase) ─────────────────────

class PersonModel(BaseModel):
    name: str
    email: str | None = None
    provider_user_id: str | None = None


class TaskAccountModel(BaseModel):
    id: str
    provider: str
    connector_kind: str = "api"
    workspace_id: str
    label: str = ""
    sync_enabled: bool = True
    sync_status: str = "idle"
    sync_error: str | None = None
    last_synced_at: str | None = None
    statuses: list[str] = []
    members: list[PersonModel] = []
    project_count: int = 0
    # ClickUp-shaped navigation tree for the project picker accordion:
    # [{id, name, folders: [{id, name, lists: [{id, name}]}], lists: [...]}]
    hierarchy: list[dict] = []


class GtdItemModel(BaseModel):
    id: str
    source: str = "LOCAL"
    provider: str | None = None          # account provider ('clickup' | …); None/'local' for LOCAL
    account_id: str | None = None
    provider_task_id: str | None = None
    provider_url: str | None = None
    title: str
    notes: str | None = None
    disposition: str = "INBOX"
    next_action: str | None = None
    context: str | None = None
    energy: str | None = None
    time_estimate_mins: int | None = None
    is_two_minute: bool = False
    project_id: str | None = None
    defer_until: str | None = None
    sync_state: str = "local"
    provider_status: str | None = None
    assignee: PersonModel | None = None
    is_mine: bool = True
    waiting_on: PersonModel | None = None
    delegated_at: str | None = None
    due_at: str | None = None
    is_hard_date: bool = False
    completed_at: str | None = None
    clarified_at: str | None = None
    origin: dict | None = None           # source linkage (e.g. captured from an email)
    attachments: list[dict] = []         # context refs: file/image/link descriptors
    created_at: str
    updated_at: str


class GtdProjectModel(BaseModel):
    id: str
    source: str = "LOCAL"
    provider: str | None = None
    account_id: str | None = None
    provider_ref: str | None = None
    outcome: str
    purpose: str | None = None
    status: str = "ACTIVE"
    has_next_action: bool = False
    created_at: str | None = None


# ── DB (shared pooled async engine, same recipe as email/core.py) ────────────

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
            pool_size=10, max_overflow=20, pool_recycle=1800,
        )
        _SESSION_FACTORY = async_sessionmaker(_ENGINE, expire_on_commit=False)
    return _SESSION_FACTORY


async def _get_db():
    """Return a new async session from the shared, pooled engine."""
    return _get_session_factory()()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _key_store():
    from acb_llm.key_store import get_key_store
    return get_key_store()


def _uid(user: Any) -> str:
    return getattr(user, "email", None) or "anonymous"


async def _assert_account_owner(db: Any, account_id: str, user_id: str) -> Any:
    """Return the account row or raise 404 if it isn't the user's."""
    row = (await db.execute(
        text("SELECT * FROM task_accounts WHERE id = :id AND user_id = :uid"),
        {"id": account_id, "uid": user_id},
    )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Account not found")
    return row


def _parse_jsonb(val: Any) -> Any:
    if val is None:
        return None
    if isinstance(val, str):
        try:
            return json.loads(val)
        except ValueError:
            return None
    return val


def _person(val: Any) -> PersonModel | None:
    data = _parse_jsonb(val)
    if isinstance(data, dict) and (data.get("name") or data.get("email")):
        return PersonModel(
            name=str(data.get("name") or data.get("email") or ""),
            email=data.get("email"),
            provider_user_id=(
                str(data["provider_user_id"])
                if data.get("provider_user_id") is not None else None
            ),
        )
    return None


def _iso(val: Any) -> str | None:
    return val.isoformat() if val is not None else None


def _row_to_item(row: Any) -> GtdItemModel:
    """DB row (gtd_items ⟕ gtd_waiting ⟕ task_accounts.provider) → model."""
    return GtdItemModel(
        id=str(row.id),
        source=row.source,
        provider=getattr(row, "account_provider", None)
        or ("local" if row.source == "LOCAL" else None),
        account_id=str(row.account_id) if row.account_id else None,
        provider_task_id=row.provider_task_id,
        provider_url=row.provider_url,
        title=row.title,
        notes=row.description,
        disposition=row.disposition,
        next_action=row.next_action,
        context=row.context,
        energy=row.energy,
        time_estimate_mins=row.time_estimate_mins,
        is_two_minute=bool(row.is_two_minute),
        project_id=str(row.project_id) if row.project_id else None,
        defer_until=_iso(row.defer_until),
        sync_state=row.sync_state or "local",
        provider_status=row.provider_status,
        assignee=_person(row.assignee),
        is_mine=bool(row.is_mine),
        waiting_on=_person(getattr(row, "waiting_on", None)),
        delegated_at=_iso(getattr(row, "delegated_at", None)),
        due_at=_iso(row.due_at),
        is_hard_date=bool(row.is_hard_date),
        completed_at=_iso(row.completed_at),
        clarified_at=_iso(row.clarified_at),
        origin=_parse_jsonb(getattr(row, "origin", None)),
        attachments=_parse_jsonb(getattr(row, "attachments", None)) or [],
        created_at=_iso(row.created_at) or "",
        updated_at=_iso(row.updated_at) or "",
    )


def _row_to_project(row: Any) -> GtdProjectModel:
    return GtdProjectModel(
        id=str(row.id),
        source=row.source,
        provider=getattr(row, "account_provider", None)
        or ("local" if row.source == "LOCAL" else None),
        account_id=str(row.account_id) if row.account_id else None,
        provider_ref=row.provider_ref,
        outcome=row.outcome,
        purpose=row.purpose,
        status=row.status,
        has_next_action=bool(row.has_next_action),
        created_at=_iso(row.created_at),
    )


# The SELECT used by every item read: joins the open waiting-for record (for
# waiting_on/delegated_at) and the account's provider name (for the badge).
ITEM_SELECT = """
    SELECT i.*, w.waiting_on, w.delegated_at, a.provider AS account_provider
      FROM gtd_items i
 LEFT JOIN gtd_waiting w ON w.item_id = i.id AND w.resolved = false
 LEFT JOIN task_accounts a ON a.id = i.account_id
"""

PROJECT_SELECT = """
    SELECT p.*, a.provider AS account_provider
      FROM gtd_projects p
 LEFT JOIN task_accounts a ON a.id = p.account_id
"""

# Default GTD context list, seeded lazily per user on first read.
DEFAULT_CONTEXTS: list[tuple[str, str]] = [
    ("@computer", "Monitor"),
    ("@calls", "Phone"),
    ("@errands", "Car"),
    ("@office", "Building2"),
    ("@home", "Home"),
    ("@agenda", "Users"),
]
