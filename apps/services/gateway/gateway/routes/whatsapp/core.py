"""WhatsApp routes — shared kernel.

The shared ``router``, Pydantic models, DB session helper and the provider
adapter used by the transport layer. Depends on nothing inside the package (the
leaf), so importing it never pulls in a route module. Structurally identical to
``gateway.routes.email.core`` — a WhatsApp channel is the same shape as email.
"""

from __future__ import annotations

import json
import os
from typing import Any

from acb_common import get_logger, get_settings
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

_log = get_logger("gateway.whatsapp")

router = APIRouter(prefix="/whatsapp", tags=["whatsapp"])


# ── Pydantic models (the wire shape the Next.js app consumes) ─────────────────

class WhatsAppAccountModel(BaseModel):
    id: str
    phone_number: str
    phone_number_id: str
    waba_id: str | None = None
    display_name: str = ""
    avatar_color: str = "#25D366"
    sync_status: str = "idle"
    sync_error: str | None = None
    history_import_phase: int = 0
    quality_rating: str | None = None
    last_synced_at: str | None = None
    is_default: bool = False


class WhatsAppChatModel(BaseModel):
    id: str
    account_id: str
    wa_chat_id: str
    kind: str = "dm"
    name: str = ""
    category: str | None = None
    status: str | None = None          # NEEDS_REPLY | AWAITING | FYI | DONE
    last_message_at: str | None = None
    last_snippet: str = ""
    # Whether the 24h free-form window is currently open, and when it closes.
    window_open: bool = False
    window_expires_at: str | None = None
    snoozed_until: str | None = None    # set while the chat is snoozed (W6)


class WhatsAppMessageModel(BaseModel):
    id: str
    chat_id: str
    wa_message_id: str
    direction: str = "in"
    kind: str = "text"
    sender_name: str = ""
    body_text: str = ""
    transcript_text: str | None = None    # voice-note transcription (W4.3)
    quoted_wa_message_id: str | None = None
    categories: list[str] = []
    intent: str | None = None
    send_regime: str | None = None
    sent_at: str | None = None


# ── DB session (own pooled engine, same pattern as email.core) ────────────────

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


# ── provider adapter ──────────────────────────────────────────────────────────

def _instantiate_provider(name: str, creds: dict[str, Any]):
    """Construct a WhatsApp provider from its name + decrypted creds."""
    from whatsapp_ingestion.providers.factory import build_provider
    try:
        return build_provider(name, creds)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _provider_for_account(db: Any, account_id: str):
    """Load + decrypt creds and build the Cloud API provider for an account.

    Returns ``(provider, store, row)`` or raises 404. Unscoped (no user filter) —
    the callers are the send path (already user-scoped upstream) and background
    webhook tasks (no request user).
    """
    from sqlalchemy import text
    row = (await db.execute(
        text("""SELECT credentials_encrypted, phone_number_id
                FROM wa_accounts WHERE id = :id"""),
        {"id": account_id},
    )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="WhatsApp account not found")
    from acb_llm.key_store import get_key_store
    store = get_key_store()
    creds = json.loads(store.decrypt(row.credentials_encrypted))
    provider = _instantiate_provider("cloud_api", creds)
    return provider, store, row
