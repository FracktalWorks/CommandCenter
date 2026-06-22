"""Email management gateway routes.

Endpoints for email account CRUD, message listing/search, send, sync,
and AI assistant chat.

Routes
------
GET    /email/accounts                — List connected email accounts
POST   /email/accounts                — Add a new email account (OAuth callback)
DELETE /email/accounts/{id}           — Remove an email account
PATCH  /email/accounts/{id}           — Update account (label, sync toggle)
GET    /email/accounts/{id}/folders   — List folders/labels
GET    /email/messages                — List/search emails (paginated)
GET    /email/messages/{id}           — Get full email detail
PATCH  /email/messages/{id}           — Update email (read, starred, labels)
DELETE /email/messages/{id}           — Delete/trash email
POST   /email/send                    — Send a new email
POST   /email/sync                    — Trigger manual sync
POST   /email/ai/chat                 — AI assistant chat (SSE stream)
POST   /email/ai/quick-action         — Trigger quick action
GET    /email/oauth/{provider}/authorize — Start OAuth flow
GET    /email/oauth/{provider}/callback  — OAuth callback
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import io
import os
import secrets
import socket
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import httpx
from acb_auth import UserContext, get_current_user
from acb_common import get_logger, get_settings
from urllib.parse import urlencode, urlparse

from fastapi import (
    APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status,
)
from fastapi.responses import (
    PlainTextResponse, RedirectResponse, StreamingResponse,
)
from pydantic import BaseModel, Field
from sqlalchemy import text

_log = get_logger("gateway.email")

router = APIRouter(prefix="/email", tags=["email"])

# ── Pydantic models ──────────────────────────────────────────────────────

class EmailAddressModel(BaseModel):
    name: str = ""
    email: str


class AttachmentModel(BaseModel):
    id: str
    filename: str
    mime_type: str = "application/octet-stream"
    size_bytes: int | None = None
    download_url: str | None = None


# Storage limits (hybrid approach — store bodies with caps, fetch full on demand)
MAX_BODY_TEXT_BYTES = 500 * 1024      # 500 KB
MAX_BODY_HTML_BYTES = 2 * 1024 * 1024  # 2 MB
ATTACHMENT_CACHE_TTL_SECS = 3600       # 1 hour


class EmailMessageModel(BaseModel):
    id: str
    provider_message_id: str
    thread_id: str | None = None
    account_id: str
    from_address: EmailAddressModel | None = None
    to_addresses: list[EmailAddressModel] = []
    cc_addresses: list[EmailAddressModel] = []
    bcc_addresses: list[EmailAddressModel] = []
    subject: str = ""
    body_text: str = ""
    body_html: str | None = None
    body_truncated: bool = False
    snippet: str = ""
    has_attachments: bool = False
    attachments: list[AttachmentModel] = []
    is_read: bool = False
    is_starred: bool = False
    is_flagged: bool = False
    importance: str = "normal"
    labels: list[str] = []
    categories: list[str] = []
    folder: str = "INBOX"
    received_at: str | None = None
    synced_at: str | None = None

class EmailAccountModel(BaseModel):
    id: str
    provider: str  # 'gmail' | 'microsoft' | 'imap'
    email_address: str
    label: str = ""
    avatar_color: str = "#6366f1"
    sync_enabled: bool = True
    sync_status: str = "idle"
    sync_error: str | None = None
    last_synced_at: str | None = None
    unread_count: int = 0

class AccountUpdateModel(BaseModel):
    label: str | None = None
    sync_enabled: bool | None = None

class SendEmailRequest(BaseModel):
    account_id: str
    to: list[str]
    subject: str
    body_text: str
    body_html: str | None = None
    cc: list[str] | None = None
    bcc: list[str] | None = None
    reply_to_message_id: str | None = None

class MessageUpdateModel(BaseModel):
    is_read: bool | None = None
    is_starred: bool | None = None
    is_flagged: bool | None = None
    folder: str | None = None
    add_labels: list[str] | None = None
    remove_labels: list[str] | None = None

class SyncRequest(BaseModel):
    account_id: str

class BackfillRequest(BaseModel):
    folder: str = "inbox"
    page_token: str | None = None
    max_pages: int = Field(default=3, ge=1, le=10)

class ListMessagesParams(BaseModel):
    account_id: str | None = None
    folder: str = "INBOX"
    query: str | None = None
    page: int = 1
    page_size: int = Field(default=50, ge=1, le=200)

class AIChatRequest(BaseModel):
    messages: list[dict[str, str]]
    account_id: str | None = None
    email_context_id: str | None = None
    session_id: str | None = None  # stable per conversation (thread continuity)

class QuickActionRequest(BaseModel):
    action: str  # 'summarize' | 'find_urgent' | 'draft_reply' | 'unsubscribe'
    account_id: str | None = None
    email_id: str | None = None

class OAuthCallbackRequest(BaseModel):
    code: str
    state: str

class CreateAccountRequest(BaseModel):
    """Manual account creation (IMAP/SMTP or other manual config)."""
    provider: str  # 'imap' | 'gmail' | 'microsoft'
    email_address: str
    label: str = ""
    credentials: dict[str, Any]  # Provider-specific credential dict


# ── Helpers ──────────────────────────────────────────────────────────────

def _truncate_body(text: str, max_bytes: int) -> str:
    """Truncate text to fit within max_bytes when UTF-8 encoded.

    Appends a truncation marker \"… [truncated]\" so the UI can offer a
    \"Load full message\" button.
    """
    if not text:
        return text
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return text
    marker = b" ... [truncated]"
    # Find a safe cut point that doesn't split a multi-byte character
    cut = max_bytes - len(marker)
    while cut > 0 and (encoded[cut] & 0xC0) == 0x80:
        cut -= 1
    return encoded[:cut].decode("utf-8", errors="replace") + marker.decode()


async def _get_redis():
    """Get a Redis client for caching (skips if unavailable)."""
    try:
        import redis.asyncio as aioredis  # noqa: PLC0415
        settings = get_settings()
        return aioredis.from_url(settings.redis_url, decode_responses=False)
    except Exception:
        return None


def _instantiate_provider(provider_name: str, creds: dict[str, Any]):
    """Construct an email provider instance from its name + decrypted creds.

    Raises HTTPException(400) for unknown providers so callers get a clean error.
    """
    if provider_name == "gmail":
        from email_ingestion.providers.gmail import GmailProvider
        return GmailProvider(creds)
    if provider_name == "microsoft":
        from email_ingestion.providers.outlook import OutlookProvider
        return OutlookProvider(creds)
    if provider_name == "imap":
        from email_ingestion.providers.imap import IMAPProvider
        return IMAPProvider(creds)
    raise HTTPException(status_code=400, detail=f"Unknown provider: {provider_name}")


async def _provider_for_message(db: Any, message_id: str, user_email: str):
    """Load the provider + provider_message_id for a stored message.

    Returns (provider, provider_message_id, account_id, store) or raises 404.
    Persisting rotated OAuth tokens is the caller's responsibility via
    ``_persist_rotated_creds``.
    """
    result = await db.execute(
        text(
            """SELECT em.provider_message_id, em.account_id,
                      ea.provider, ea.credentials_encrypted
               FROM email_messages em
               JOIN email_accounts ea ON em.account_id = ea.id
               WHERE em.id = :mid AND ea.user_id = :user_id"""
        ),
        {"mid": message_id, "user_id": user_email},
    )
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    from acb_llm.key_store import get_key_store
    store = get_key_store()
    creds = json.loads(store.decrypt(row.credentials_encrypted))
    provider = _instantiate_provider(row.provider, creds)
    return provider, row.provider_message_id, str(row.account_id), store


async def _persist_rotated_creds(db: Any, store: Any, account_id: str, provider) -> None:
    """Persist refreshed OAuth tokens if the provider rotated them mid-request."""
    if provider.credentials_dirty():
        await db.execute(
            text(
                """UPDATE email_accounts
                   SET credentials_encrypted = :creds, updated_at = now()
                   WHERE id = :id"""
            ),
            {"id": account_id, "creds": store.encrypt(json.dumps(provider.export_credentials()))},
        )


# A single shared async engine + session factory for the whole module. Creating
# an engine per request (as this used to) spins up a fresh connection pool each
# call and never disposes it → connection-pool exhaustion. The engine owns the
# pool and is created exactly once.
_ENGINE = None
_SESSION_FACTORY = None


def _get_session_factory():
    global _ENGINE, _SESSION_FACTORY
    if _SESSION_FACTORY is None:
        from sqlalchemy.ext.asyncio import (
            async_sessionmaker, create_async_engine,
        )
        settings = get_settings()
        db_url = os.environ.get("DATABASE_URL", settings.database_url)
        if "postgresql+psycopg" in db_url:
            db_url = db_url.replace("postgresql+psycopg", "postgresql+asyncpg")
        elif db_url.startswith("postgresql://"):
            db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")
        elif "+asyncpg" not in db_url and "postgresql" in db_url:
            db_url = db_url.replace("postgresql://", "postgresql+asyncpg://")
        _ENGINE = create_async_engine(
            db_url, echo=False, pool_pre_ping=True,
            pool_size=10, max_overflow=20, pool_recycle=1800,
        )
        _SESSION_FACTORY = async_sessionmaker(_ENGINE, expire_on_commit=False)
    return _SESSION_FACTORY


async def _get_db(request_id: str | None = None):
    """Return a new async session from the shared, pooled engine."""
    return _get_session_factory()()


# ── Account CRUD ─────────────────────────────────────────────────────────

@router.get("/accounts", response_model=list[EmailAccountModel])
async def list_accounts(
    user: UserContext = Depends(get_current_user),
):
    """List all connected email accounts for the current user."""
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT id, provider, email_address, label, avatar_color,
                          sync_enabled, sync_status, sync_error, last_synced_at
                   FROM email_accounts
                   WHERE user_id = :user_id
                   ORDER BY created_at"""
            ),
            {"user_id": user.email or "anonymous"},
        )
        rows = result.fetchall()
        accounts: list[EmailAccountModel] = []
        for row in rows:
            # Count unread messages for this account
            unread_result = await db.execute(
                text(
                    """SELECT COUNT(*) FROM email_messages
                       WHERE account_id = :account_id AND is_read = false"""
                ),
                {"account_id": row.id},
            )
            unread = unread_result.scalar() or 0

            accounts.append(EmailAccountModel(
                id=str(row.id),
                provider=row.provider,
                email_address=row.email_address,
                label=row.label or "",
                avatar_color=row.avatar_color or "#6366f1",
                sync_enabled=row.sync_enabled,
                sync_status=row.sync_status or "idle",
                sync_error=row.sync_error,
                last_synced_at=row.last_synced_at.isoformat()
                if row.last_synced_at else None,
                unread_count=unread,
            ))
        return accounts
    finally:
        await db.close()


@router.post("/accounts", response_model=EmailAccountModel, status_code=201)
async def create_account(
    req: CreateAccountRequest,
    user: UserContext = Depends(get_current_user),
):
    """Add a new email account manually (IMAP/SMTP or pre-configured OAuth creds).

    For OAuth-based providers (gmail, microsoft), use the /oauth/{provider}/authorize
    flow instead — it handles token exchange automatically.
    """
    # Validate provider
    if req.provider not in ("gmail", "microsoft", "imap"):
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider: {req.provider}. Supported: gmail, microsoft, imap",
        )

    # For IMAP, validate required credential fields
    if req.provider == "imap":
        required = ["imap_host", "imap_port", "imap_username", "imap_password",
                     "smtp_host", "smtp_port"]
        missing = [k for k in required if k not in req.credentials]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Missing IMAP credential fields: {', '.join(missing)}",
            )

    # Encrypt credentials
    from acb_llm.key_store import get_key_store
    store = get_key_store()
    encrypted_creds = store.encrypt(json.dumps(req.credentials))

    db = await _get_db()
    try:
        # Check for duplicate account
        existing = await db.execute(
            text(
                """SELECT id FROM email_accounts
                   WHERE user_id = :user_id
                     AND provider = :provider
                     AND email_address = :email"""
            ),
            {
                "user_id": user.email or "anonymous",
                "provider": req.provider,
                "email": req.email_address,
            },
        )
        if existing.fetchone():
            raise HTTPException(
                status_code=409,
                detail=f"Account {req.email_address} already exists",
            )

        account_id = str(uuid4())
        await db.execute(
            text(
                """INSERT INTO email_accounts
                   (id, user_id, provider, email_address, label,
                    avatar_color, credentials_encrypted)
                   VALUES (:id, :user_id, :provider, :email, :label,
                           :color, :creds)"""
            ),
            {
                "id": account_id,
                "user_id": user.email or "anonymous",
                "provider": req.provider,
                "email": req.email_address,
                "label": req.label or _default_label(req.provider),
                "color": "#6366f1",
                "creds": encrypted_creds,
            },
        )
        await db.commit()

        # Start background sync for this account
        try:
            from email_ingestion.scheduler import refresh_account_sync
            await refresh_account_sync(account_id)
        except Exception:
            pass

        return EmailAccountModel(
            id=account_id,
            provider=req.provider,
            email_address=req.email_address,
            label=req.label or _default_label(req.provider),
            avatar_color="#6366f1",
            sync_enabled=True,
            sync_status="idle",
            last_synced_at=None,
            unread_count=0,
        )
    finally:
        await db.close()


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    account_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Remove an email account and all its synced messages."""
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """DELETE FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": account_id, "user_id": user.email or "anonymous"},
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Account not found")
        await db.commit()

        # Stop background sync for this account
        try:
            from email_ingestion.scheduler import remove_account_sync
            await remove_account_sync(account_id)
        except Exception:
            pass
    finally:
        await db.close()


@router.patch("/accounts/{account_id}", response_model=EmailAccountModel)
async def update_account(
    account_id: str,
    updates: AccountUpdateModel,
    user: UserContext = Depends(get_current_user),
):
    """Update account settings (label, sync toggle)."""
    db = await _get_db()
    try:
        set_clauses = []
        params: dict[str, Any] = {"id": account_id, "user_id": user.email or "anonymous"}

        if updates.label is not None:
            set_clauses.append("label = :label")
            params["label"] = updates.label
        if updates.sync_enabled is not None:
            set_clauses.append("sync_enabled = :sync_enabled")
            params["sync_enabled"] = updates.sync_enabled

        if not set_clauses:
            raise HTTPException(status_code=400, detail="No fields to update")

        set_clauses.append("updated_at = now()")

        result = await db.execute(
            text(
                f"""UPDATE email_accounts
                    SET {', '.join(set_clauses)}
                    WHERE id = :id AND user_id = :user_id
                    RETURNING id, provider, email_address, label, avatar_color,
                              sync_enabled, sync_status, last_synced_at"""
            ),
            params,
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")
        await db.commit()

        # Refresh background sync: start/stop loop for this account
        try:
            from email_ingestion.scheduler import refresh_account_sync, remove_account_sync
            if row.sync_enabled:
                await refresh_account_sync(account_id)
            else:
                await remove_account_sync(account_id)
        except Exception:
            pass

        return EmailAccountModel(
            id=str(row.id),
            provider=row.provider,
            email_address=row.email_address,
            label=row.label or "",
            avatar_color=row.avatar_color or "#6366f1",
            sync_enabled=row.sync_enabled,
            sync_status=row.sync_status or "idle",
            last_synced_at=row.last_synced_at.isoformat()
            if row.last_synced_at else None,
        )
    finally:
        await db.close()


class EmailFolderModel(BaseModel):
    provider_folder_id: str
    name: str
    type: str = "system"  # 'system' | 'user'
    message_count: int = 0
    unread_count: int = 0


@router.get("/accounts/{account_id}/folders", response_model=list[EmailFolderModel])
async def list_folders(
    account_id: str,
    user: UserContext = Depends(get_current_user),
):
    """List folders/labels for a connected email account.

    Fetches live from the provider (Gmail labels, Outlook folders, IMAP mailboxes)
    so the UI always shows the current folder structure.
    """
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT provider, credentials_encrypted
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": account_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        # Decrypt credentials
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        # Instantiate provider
        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown provider: {row.provider}",
            )

        # Authenticate and fetch folders
        if not await provider.authenticate():
            raise HTTPException(
                status_code=401,
                detail="Email account authentication failed — token may have expired",
            )

        folders = await provider.list_folders()

        # Persist rotated OAuth tokens so a later sync doesn't reuse a stale one.
        if provider.credentials_dirty():
            await db.execute(
                text(
                    """UPDATE email_accounts
                       SET credentials_encrypted = :creds, updated_at = now()
                       WHERE id = :id"""
                ),
                {
                    "id": account_id,
                    "creds": store.encrypt(
                        json.dumps(provider.export_credentials())
                    ),
                },
            )
            await db.commit()

        return [
            EmailFolderModel(
                provider_folder_id=f.provider_folder_id,
                name=f.name,
                type=f.type,
                message_count=f.message_count,
                unread_count=f.unread_count,
            )
            for f in folders
        ]
    except HTTPException:
        raise
    except Exception as exc:
        _log.error("list_folders.failed", account_id=account_id, error=str(exc)[:200])
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list folders: {str(exc)}",
        )
    finally:
        await db.close()


# ── Labels ───────────────────────────────────────────────────────────────

@router.get("/accounts/{account_id}/labels", response_model=list[str])
async def list_labels(
    account_id: str,
    user: UserContext = Depends(get_current_user),
):
    """List user-applicable label/category names for an account.

    Gmail = user labels, Outlook = master categories, IMAP = none.
    """
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT provider, credentials_encrypted
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": account_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            return []

        if not await provider.authenticate():
            raise HTTPException(
                status_code=401,
                detail="Email account authentication failed — reconnect.",
            )
        labels = await provider.list_labels()

        if provider.credentials_dirty():
            await db.execute(
                text(
                    """UPDATE email_accounts
                       SET credentials_encrypted = :creds, updated_at = now()
                       WHERE id = :id"""
                ),
                {
                    "id": account_id,
                    "creds": store.encrypt(
                        json.dumps(provider.export_credentials())
                    ),
                },
            )
            await db.commit()
        return labels
    except HTTPException:
        raise
    except Exception as exc:
        _log.error("list_labels.failed", account_id=account_id, error=str(exc)[:200])
        raise HTTPException(status_code=500, detail=f"Failed to list labels: {exc}")
    finally:
        await db.close()


# ── History backfill ─────────────────────────────────────────────────────

@router.post("/accounts/{account_id}/backfill")
async def backfill_folder(
    account_id: str,
    req: BackfillRequest,
    user: UserContext = Depends(get_current_user),
):
    """Fetch OLDER messages for a folder from the provider and persist them.

    The list view is DB-backed and the initial sync only grabs the newest
    ~100 per folder, so this pages further back through the provider's history
    on demand.  Returns the next page token so the client can keep loading
    older mail until ``exhausted`` is true.
    """
    from email_ingestion.providers.base import canonical_folder

    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT provider, credentials_encrypted
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": account_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            raise HTTPException(
                status_code=400, detail=f"Unknown provider: {row.provider}"
            )

        if not await provider.authenticate():
            raise HTTPException(
                status_code=401,
                detail="Email account authentication failed — reconnect.",
            )

        canon_req = canonical_folder(req.folder)

        # Resolve the provider-native folder id/label for the canonical key so
        # both system and user folders page correctly (Gmail label id, Graph
        # folder id, IMAP mailbox name).
        provider_folder = req.folder
        try:
            for f in await provider.list_folders():
                if canonical_folder(f.name) == canon_req:
                    provider_folder = f.provider_folder_id
                    break
        except Exception:
            pass

        token = req.page_token
        synced = 0
        for _ in range(req.max_pages):
            msgs, token = await provider.list_messages(
                folder=provider_folder,
                max_results=100,
                page_token=token,
                canonical_override=canon_req,
            )
            for msg in msgs:
                await _upsert_message(db, account_id, msg)
                synced += 1
            if not token:
                break
        await db.commit()

        if provider.credentials_dirty():
            await db.execute(
                text(
                    """UPDATE email_accounts
                       SET credentials_encrypted = :creds, updated_at = now()
                       WHERE id = :id"""
                ),
                {
                    "id": account_id,
                    "creds": store.encrypt(
                        json.dumps(provider.export_credentials())
                    ),
                },
            )
            await db.commit()

        return {
            "synced": synced,
            "next_page_token": token,
            "exhausted": token is None,
        }
    except HTTPException:
        raise
    except Exception as exc:
        _log.error("backfill.failed", account_id=account_id, error=str(exc)[:200])
        raise HTTPException(status_code=500, detail=f"Backfill failed: {str(exc)}")
    finally:
        await db.close()


# ── Messages ─────────────────────────────────────────────────────────────

@router.get("/messages")
async def list_messages(
    account_id: str | None = Query(None),
    folder: str = Query("INBOX"),
    label: str | None = Query(None),
    query: str | None = Query(None),
    thread_id: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: UserContext = Depends(get_current_user),
):
    """List/search emails across accounts.

    When ``thread_id`` is given the result is the whole conversation (across
    folders), oldest-first — used by the reading pane's conversation view.
    """
    db = await _get_db()
    try:
        where_clauses = [
            "ea.user_id = :user_id"
        ]
        params: dict[str, Any] = {
            "user_id": user.email or "anonymous",
            "limit": page_size,
            "offset": (page - 1) * page_size,
        }

        if account_id:
            where_clauses.append("em.account_id = :account_id")
            params["account_id"] = account_id
        if thread_id:
            # Conversation view: every message in the thread, ignore the folder
            # filter (a thread spans inbox/sent/etc.).
            where_clauses.append("em.thread_id = :thread_id")
            params["thread_id"] = thread_id
        elif folder:
            # "starred" is a flag, not a stored folder; everything else is matched
            # case-insensitively against the canonical folder key persisted by the
            # providers (inbox/sent/drafts/trash/archive/junk + user folders).
            if folder.lower() == "starred":
                where_clauses.append("em.is_starred = true")
            else:
                where_clauses.append("LOWER(em.folder) = LOWER(:folder)")
                params["folder"] = folder
        if label:
            # Match either a user label or an assigned category (both TEXT[]).
            where_clauses.append(
                "(:label = ANY(COALESCE(em.labels, '{}'))"
                " OR :label = ANY(em.categories))"
            )
            params["label"] = label
        if query:
            where_clauses.append(
                """to_tsvector('english',
                   coalesce(em.subject,'') || ' ' ||
                   coalesce(em.body_text,'') || ' ' ||
                   coalesce(em.from_address->>'name','') || ' ' ||
                   coalesce(em.from_address->>'email',''))
                   @@ plainto_tsquery('english', :query)"""
            )
            params["query"] = query

        where_sql = " AND ".join(where_clauses)

        # Count total
        count_result = await db.execute(
            text(
                f"""SELECT COUNT(*)
                    FROM email_messages em
                    JOIN email_accounts ea ON em.account_id = ea.id
                    WHERE {where_sql}"""
            ),
            params,
        )
        total = count_result.scalar() or 0

        # Fetch page
        result = await db.execute(
            text(
                f"""SELECT em.id, em.provider_message_id, em.thread_id,
                          em.account_id, em.folder, em.labels,
                          em.from_address, em.to_addresses,
                          em.cc_addresses, em.bcc_addresses,
                          em.subject, em.body_text, em.body_html,
                          em.snippet, em.has_attachments,
                          em.is_read, em.is_starred, em.is_flagged,
                          em.importance, em.categories,
                          em.received_at, em.synced_at
                   FROM email_messages em
                   JOIN email_accounts ea ON em.account_id = ea.id
                   WHERE {where_sql}
                   ORDER BY em.received_at {"ASC" if thread_id else "DESC"}
                   LIMIT :limit OFFSET :offset"""
            ),
            params,
        )
        rows = result.fetchall()

        messages = [_row_to_message(row) for row in rows]

        # Thread sizes — one extra grouped query so the list can flag which rows
        # are conversations (badge with the message count).
        thread_ids = list({m.thread_id for m in messages if m.thread_id})
        thread_counts: dict[str, int] = {}
        if thread_ids:
            cnt_params: dict[str, Any] = {"tids": thread_ids}
            cnt_sql = (
                "SELECT thread_id, COUNT(*) AS c FROM email_messages "
                "WHERE thread_id = ANY(:tids)"
            )
            if account_id:
                cnt_sql += " AND account_id = :account_id"
                cnt_params["account_id"] = account_id
            cnt_sql += " GROUP BY thread_id"
            cnt_res = await db.execute(text(cnt_sql), cnt_params)
            thread_counts = {r.thread_id: r.c for r in cnt_res.fetchall()}

        emails_out = []
        for m in messages:
            d = m.model_dump()
            d["thread_count"] = thread_counts.get(m.thread_id, 1)
            emails_out.append(d)

        return {
            "emails": emails_out,
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    finally:
        await db.close()


@router.get("/messages/{message_id}", response_model=EmailMessageModel)
async def get_message(
    message_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Get full email detail."""
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT em.id, em.provider_message_id, em.thread_id,
                          em.account_id, em.folder, em.labels,
                          em.from_address, em.to_addresses,
                          em.cc_addresses, em.bcc_addresses,
                          em.subject, em.body_text, em.body_html,
                          em.snippet, em.has_attachments,
                          em.is_read, em.is_starred, em.is_flagged,
                          em.importance, em.categories,
                          em.received_at, em.synced_at
                   FROM email_messages em
                   JOIN email_accounts ea ON em.account_id = ea.id
                   WHERE em.id = :message_id AND ea.user_id = :user_id"""
            ),
            {"message_id": message_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")

        # Mark as read
        await db.execute(
            text(
                """UPDATE email_messages SET is_read = true, updated_at = now()
                   WHERE id = :id AND is_read = false"""
            ),
            {"id": message_id},
        )
        await db.commit()

        msg = _row_to_message(row)

        # ── Lazy body hydration ──
        # Some providers (notably Outlook/Graph) sync message *headers* only, so
        # the stored body is empty.  When the user opens such a message, fetch the
        # full body from the provider once and persist it so subsequent opens are
        # instant.  Mark as read on the provider too (two-way sync).
        if not msg.body_text and not msg.body_html:
            try:
                provider, provider_msg_id, account_id, store = await _provider_for_message(
                    db, message_id, user.email or "anonymous"
                )
                if await provider.authenticate():
                    full = await provider.get_message(provider_msg_id)
                    body_text = _truncate_body(full.body_text or "", MAX_BODY_TEXT_BYTES)
                    body_html = (
                        _truncate_body(full.body_html, MAX_BODY_HTML_BYTES)
                        if full.body_html else None
                    )
                    await db.execute(
                        text(
                            """UPDATE email_messages
                               SET body_text = :bt, body_html = :bh,
                                   has_attachments = :ha, updated_at = now()
                               WHERE id = :id"""
                        ),
                        {
                            "id": message_id,
                            "bt": body_text,
                            "bh": body_html,
                            "ha": full.has_attachments,
                        },
                    )
                    # Persist attachment metadata fetched with the full message.
                    for att in full.attachments:
                        await db.execute(
                            text(
                                """INSERT INTO email_attachments
                                   (message_id, filename, mime_type, size_bytes,
                                    provider_attachment_id)
                                   VALUES (:mid, :filename, :mime_type, :size_bytes,
                                           :provider_attachment_id)
                                   ON CONFLICT DO NOTHING"""
                            ),
                            {
                                "mid": message_id,
                                "filename": att.filename,
                                "mime_type": att.mime_type,
                                "size_bytes": att.size_bytes,
                                "provider_attachment_id": att.provider_attachment_id,
                            },
                        )
                    await _persist_rotated_creds(db, store, account_id, provider)
                    await db.commit()
                    msg.body_text = body_text
                    msg.body_html = body_html
                    msg.has_attachments = full.has_attachments
            except HTTPException:
                raise
            except Exception as exc:  # noqa: BLE001
                _log.warning("get_message.hydrate_failed", message_id=message_id, error=str(exc)[:200])

        if msg.has_attachments:
            msg.attachments = await _fetch_attachments(db, message_id)
        return msg
    finally:
        await db.close()


@router.patch("/messages/{message_id}", response_model=EmailMessageModel)
async def update_message(
    message_id: str,
    updates: MessageUpdateModel,
    user: UserContext = Depends(get_current_user),
):
    """Update email properties (read, starred, flagged, folder, labels)."""
    db = await _get_db()
    try:
        # Verify ownership
        result = await db.execute(
            text(
                """SELECT em.id FROM email_messages em
                   JOIN email_accounts ea ON em.account_id = ea.id
                   WHERE em.id = :id AND ea.user_id = :user_id"""
            ),
            {"id": message_id, "user_id": user.email or "anonymous"},
        )
        if not result.fetchone():
            raise HTTPException(status_code=404, detail="Message not found")

        set_clauses = ["updated_at = now()"]
        params: dict[str, Any] = {"id": message_id}

        if updates.is_read is not None:
            set_clauses.append("is_read = :is_read")
            params["is_read"] = updates.is_read
        if updates.is_starred is not None:
            set_clauses.append("is_starred = :is_starred")
            params["is_starred"] = updates.is_starred
        if updates.is_flagged is not None:
            set_clauses.append("is_flagged = :is_flagged")
            params["is_flagged"] = updates.is_flagged
        if updates.folder is not None:
            set_clauses.append("folder = :folder")
            params["folder"] = updates.folder

        await db.execute(
            text(
                f"""UPDATE email_messages
                    SET {', '.join(set_clauses)}
                    WHERE id = :id"""
            ),
            params,
        )
        await db.commit()

        # Apply label add/remove locally — the categories column drives the
        # label chips shown in the UI.
        if updates.add_labels or updates.remove_labels:
            cat_res = await db.execute(
                text("SELECT categories FROM email_messages WHERE id = :id"),
                {"id": message_id},
            )
            crow = cat_res.fetchone()
            cats = list(crow.categories or []) if crow else []
            for name in updates.add_labels or []:
                if name not in cats:
                    cats.append(name)
            for name in updates.remove_labels or []:
                if name in cats:
                    cats.remove(name)
            await db.execute(
                text(
                    """UPDATE email_messages SET categories = :cats,
                       updated_at = now() WHERE id = :id"""
                ),
                {"id": message_id, "cats": cats},
            )
            await db.commit()

        # ── Two-way sync: push the change to the provider (best-effort) ──
        # The local DB is already updated; if the provider write fails we keep the
        # local state and log, rather than failing the user's action.
        try:
            provider, provider_msg_id, account_id, store = await _provider_for_message(
                db, message_id, user.email or "anonymous"
            )
            if await provider.authenticate():
                if (
                    updates.is_read is not None
                    or updates.is_starred is not None
                    or updates.is_flagged is not None
                ):
                    await provider.apply_flags(
                        provider_msg_id,
                        is_read=updates.is_read,
                        is_starred=updates.is_starred,
                        is_flagged=updates.is_flagged,
                    )
                if updates.folder is not None:
                    await provider.move_to_folder(provider_msg_id, updates.folder.lower())
                if updates.add_labels or updates.remove_labels:
                    await provider.set_labels(
                        provider_msg_id,
                        add=updates.add_labels or [],
                        remove=updates.remove_labels or [],
                    )
                await _persist_rotated_creds(db, store, account_id, provider)
                await db.commit()
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warning(
                "update_message.provider_sync_failed",
                message_id=message_id, error=str(exc)[:200],
            )

        # Return updated message
        return await get_message(message_id, user)
    finally:
        await db.close()


@router.delete("/messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_message(
    message_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Move email to trash (locally and on the provider)."""
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """UPDATE email_messages SET folder = 'trash', updated_at = now()
                   WHERE id = :id
                   AND account_id IN (
                       SELECT id FROM email_accounts WHERE user_id = :user_id
                   )"""
            ),
            {"id": message_id, "user_id": user.email or "anonymous"},
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Message not found")
        await db.commit()

        # ── Two-way sync: trash on the provider too (best-effort) ──
        try:
            provider, provider_msg_id, account_id, store = await _provider_for_message(
                db, message_id, user.email or "anonymous"
            )
            if await provider.authenticate():
                await provider.trash_message(provider_msg_id)
                await _persist_rotated_creds(db, store, account_id, provider)
                await db.commit()
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warning(
                "delete_message.provider_sync_failed",
                message_id=message_id, error=str(exc)[:200],
            )
    finally:
        await db.close()


# ── Remote image proxy ─────────────────────────────────────────────────────

MAX_PROXY_IMAGE_BYTES = 15 * 1024 * 1024  # 15 MB


def _resolve_is_public(host: str) -> bool:
    """True only if every A/AAAA record for host is a public, routable IP.

    Blocks SSRF to loopback/private/link-local/metadata endpoints.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    if not infos:
        return False
    for info in infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return False
        if (
            ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_multicast or ip.is_unspecified
        ):
            return False
    return True


@router.get("/image-proxy")
async def image_proxy(
    url: str = Query(..., max_length=4096),
    user: UserContext = Depends(get_current_user),
):
    """Fetch a remote email image server-side and stream it back.

    Lets the reading pane show images without the sender's tracking pixel
    seeing the *user's* IP — only the gateway's IP is exposed.  Guarded
    against SSRF (scheme + private-IP checks) and size-capped.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid image URL")
    if not await asyncio.to_thread(_resolve_is_public, parsed.hostname):
        raise HTTPException(status_code=400, detail="Blocked image host")

    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=15.0, max_redirects=3
        ) as client:
            resp = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (CommandCenter image proxy)",
                    "Accept": "image/*",
                },
            )
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "")
            if not content_type.startswith("image/"):
                raise HTTPException(status_code=415, detail="Not an image")
            content = resp.content
            if len(content) > MAX_PROXY_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="Image too large")
            return StreamingResponse(
                io.BytesIO(content),
                media_type=content_type,
                headers={
                    "Content-Length": str(len(content)),
                    "Cache-Control": "private, max-age=3600",
                },
            )
    except HTTPException:
        raise
    except Exception as exc:
        _log.warning("image_proxy.failed", error=str(exc)[:200])
        raise HTTPException(status_code=502, detail="Failed to fetch image")


# ── Attachments ───────────────────────────────────────────────────────────

@router.get("/attachments/{attachment_id}/download")
async def download_attachment(
    attachment_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Proxy download an email attachment, streaming from the provider.

    Checks Redis cache first (TTL 1 hour) to avoid redundant provider API
    calls for attachments downloaded multiple times.
    """
    # ── Check Redis cache first ──
    redis = await _get_redis()
    if redis:
        try:
            cache_key = f"email:att:cache:{attachment_id}"
            cached = await redis.get(cache_key)
            if cached:
                return StreamingResponse(
                    io.BytesIO(cached),
                    media_type="application/octet-stream",
                    headers={
                        "Content-Disposition": (
                            f'attachment; filename="cached"'
                        ),
                        "Content-Length": str(len(cached)),
                        "X-Cache": "HIT",
                    },
                )
        except Exception:
            redis = None  # fall through to provider fetch

    db = await _get_db()
    try:
        # Look up attachment and verify user owns the parent message
        result = await db.execute(
            text(
                """SELECT ea.id, ea.filename, ea.mime_type, ea.size_bytes,
                          ea.provider_attachment_id, ea.storage_path,
                          em.provider_message_id, p.provider, p.credentials_encrypted
                   FROM email_attachments ea
                   JOIN email_messages em ON ea.message_id = em.id
                   JOIN email_accounts p ON em.account_id = p.id
                   WHERE ea.id = :aid AND p.user_id = :user_id"""
            ),
            {"aid": attachment_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Attachment not found")

        # Decrypt credentials
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        # Instantiate provider
        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown provider: {row.provider}",
            )

        content = await provider.get_attachment(
            row.provider_message_id, row.provider_attachment_id
        )

        # ── Store in Redis cache ──
        if redis and content:
            try:
                cache_key = f"email:att:cache:{attachment_id}"
                await redis.setex(
                    cache_key, ATTACHMENT_CACHE_TTL_SECS, content
                )
            except Exception:
                pass

        return StreamingResponse(
            io.BytesIO(content),
            media_type=row.mime_type,
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{row.filename}"'
                ),
                "Content-Length": str(len(content)),
                "X-Cache": "MISS",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        _log.error("download_attachment.failed", aid=attachment_id, error=str(exc)[:200])
        raise HTTPException(status_code=500, detail="Failed to download attachment")
    finally:
        await db.close()


# ── Full-body fetch ─────────────────────────────────────────────────────


@router.get("/messages/{message_id}/full-body")
async def get_full_body(
    message_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Fetch the full, untruncated email body from the provider.

    Use this when body_truncated is true on a message — the stored body
    was capped to stay within storage limits.  This endpoint reaches out
    to Gmail/Microsoft/IMAP live to retrieve the complete message body.
    """
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT em.provider_message_id, p.provider,
                          p.credentials_encrypted
                   FROM email_messages em
                   JOIN email_accounts p ON em.account_id = p.id
                   WHERE em.id = :mid AND p.user_id = :user_id"""
            ),
            {"mid": message_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")

        # Decrypt credentials
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        # Instantiate provider
        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown provider: {row.provider}",
            )

        if not await provider.authenticate():
            raise HTTPException(
                status_code=401,
                detail="Email account authentication failed",
            )

        msg = await provider.get_message(row.provider_message_id)
        return {
            "message_id": message_id,
            "body_text": msg.body_text,
            "body_html": msg.body_html,
            "subject": msg.subject,
            "from": (
                f"{msg.from_address.name} <{msg.from_address.email}>"
                if msg.from_address else ""
            ),
        }
    except HTTPException:
        raise
    except Exception as exc:
        _log.error(
            "full_body.failed", message_id=message_id, error=str(exc)[:200]
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch full body: {str(exc)}",
        )
    finally:
        await db.close()


# ── Send ─────────────────────────────────────────────────────────────────

@router.post("/send")
async def send_email(
    req: SendEmailRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Send a new email from a connected account."""
    db = await _get_db()
    try:
        # Verify account ownership
        result = await db.execute(
            text(
                """SELECT id, provider, credentials_encrypted
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": req.account_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        # Decrypt credentials and instantiate provider
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Send not supported for provider: {row.provider}"
            )

        # Authenticate and send
        if not await provider.authenticate():
            raise HTTPException(status_code=401, detail="Email account auth failed")

        msg_id = await provider.send_message(
            to=req.to,
            subject=req.subject,
            body_text=req.body_text,
            body_html=req.body_html,
            cc=req.cc,
            bcc=req.bcc,
            reply_to_message_id=req.reply_to_message_id,
        )

        # Persist any refreshed/rotated OAuth token from authenticate().
        if provider.credentials_dirty():
            await _persist_rotated_creds(db, store, str(row.id), provider)
            await db.commit()

        # If this was a reply, learn from how the user edited the AI's draft.
        if req.reply_to_message_id and req.body_text:
            try:
                trow = (await db.execute(text(
                    "SELECT thread_id FROM email_messages "
                    "WHERE account_id = :aid AND provider_message_id = :pmid"
                ), {"aid": req.account_id,
                    "pmid": req.reply_to_message_id})).fetchone()
                if trow and trow.thread_id:
                    background.add_task(
                        _learn_from_sent, req.account_id, trow.thread_id,
                        req.body_text)
            except Exception:  # noqa: BLE001
                pass

        return {"id": msg_id, "ok": True}
    finally:
        await db.close()


# ── Sync ─────────────────────────────────────────────────────────────────

@router.post("/sync")
async def trigger_sync(
    req: SyncRequest,
    user: UserContext = Depends(get_current_user),
):
    """Trigger a manual email sync for an account.

    Calls the email provider's incremental sync and persists new/updated
    messages to the email_messages table.  Deleted messages are moved to
    TRASH folder locally.
    """
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """SELECT id, provider, credentials_encrypted, last_history_id
                   FROM email_accounts
                   WHERE id = :id AND user_id = :user_id"""
            ),
            {"id": req.account_id, "user_id": user.email or "anonymous"},
        )
        row = result.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Account not found")

        # Update sync status to 'syncing'
        await db.execute(
            text(
                """UPDATE email_accounts
                   SET sync_status = 'syncing', updated_at = now()
                   WHERE id = :id"""
            ),
            {"id": req.account_id},
        )
        await db.commit()

        # Create sync log entry
        sync_log_result = await db.execute(
            text(
                """INSERT INTO email_sync_log (account_id, started_at, status)
                   VALUES (:id, now(), 'running')
                   RETURNING id"""
            ),
            {"id": req.account_id},
        )
        sync_log_id = sync_log_result.fetchone().id
        await db.commit()

        # Decrypt credentials
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))

        # Instantiate provider
        if row.provider == "gmail":
            from email_ingestion.providers.gmail import GmailProvider
            provider = GmailProvider(creds)
        elif row.provider == "microsoft":
            from email_ingestion.providers.outlook import OutlookProvider
            provider = OutlookProvider(creds)
        elif row.provider == "imap":
            from email_ingestion.providers.imap import IMAPProvider
            provider = IMAPProvider(creds)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Sync not supported for provider: {row.provider}"
            )

        try:
            if not await provider.authenticate():
                raise HTTPException(status_code=401, detail="Auth failed")

            sync_result = await provider.sync_messages(
                history_id=row.last_history_id,
                max_results=100,
            )

            # Persist fetched messages to email_messages
            persisted_count = 0
            skipped_count = 0
            for msg in sync_result.messages:
                if msg.subject == "[DELETED]":
                    # Message was deleted on provider — move to TRASH locally
                    await db.execute(
                        text(
                            """UPDATE email_messages
                               SET folder = 'TRASH', updated_at = now()
                               WHERE account_id = :account_id
                                 AND provider_message_id = :provider_id"""
                        ),
                        {
                            "account_id": req.account_id,
                            "provider_id": msg.provider_message_id,
                        },
                    )
                    persisted_count += 1
                else:
                    # Upsert message
                    await db.execute(
                        text(
                            """INSERT INTO email_messages
                               (id, account_id, provider_message_id, thread_id,
                                folder, labels, categories, importance,
                                from_address, to_addresses,
                                cc_addresses, bcc_addresses, subject,
                                body_text, body_html, snippet,
                                has_attachments, is_read, is_starred, is_flagged,
                                unsubscribe_link, received_at, synced_at)
                               VALUES
                               (:id, :account_id, :provider_id, :thread_id,
                                :folder, :labels, :categories, :importance,
                                :from_addr, :to_addrs,
                                :cc_addrs, :bcc_addrs, :subject,
                                :body_text, :body_html, :snippet,
                                :has_attachments, :is_read, :is_starred, :is_flagged,
                                :unsubscribe_link, :received_at, now())
                               ON CONFLICT (account_id, provider_message_id)
                               DO UPDATE SET
                                thread_id = EXCLUDED.thread_id,
                                folder = EXCLUDED.folder,
                                labels = EXCLUDED.labels,
                                categories = EXCLUDED.categories,
                                importance = EXCLUDED.importance,
                                from_address = EXCLUDED.from_address,
                                to_addresses = EXCLUDED.to_addresses,
                                cc_addresses = EXCLUDED.cc_addresses,
                                bcc_addresses = EXCLUDED.bcc_addresses,
                                subject = EXCLUDED.subject,
                                body_text = EXCLUDED.body_text,
                                body_html = EXCLUDED.body_html,
                                snippet = EXCLUDED.snippet,
                                has_attachments = EXCLUDED.has_attachments,
                                is_read = EXCLUDED.is_read,
                                is_starred = EXCLUDED.is_starred,
                                is_flagged = EXCLUDED.is_flagged,
                                unsubscribe_link = COALESCE(
                                    EXCLUDED.unsubscribe_link,
                                    email_messages.unsubscribe_link),
                                received_at = EXCLUDED.received_at,
                                updated_at = now()"""
                        ),
                        {
                            "id": str(uuid4()),
                            "account_id": req.account_id,
                            "provider_id": msg.provider_message_id,
                            "thread_id": msg.thread_id,
                            "folder": msg.folder or "INBOX",
                            "labels": msg.labels,
                            "categories": getattr(msg, "categories", []) or [],
                            "importance": getattr(msg, "importance", "normal") or "normal",
                            "from_addr": json.dumps({
                                "name": msg.from_address.name if msg.from_address else "",
                                "email": msg.from_address.email if msg.from_address else "",
                            }),
                            "to_addrs": json.dumps([
                                {"name": a.name, "email": a.email}
                                for a in msg.to_addresses
                            ]),
                            "cc_addrs": json.dumps([
                                {"name": a.name, "email": a.email}
                                for a in msg.cc_addresses
                            ]),
                            "bcc_addrs": json.dumps([
                                {"name": a.name, "email": a.email}
                                for a in msg.bcc_addresses
                            ]),
                            "subject": msg.subject,
                            "body_text": _truncate_body(msg.body_text, MAX_BODY_TEXT_BYTES),
                            "body_html": _truncate_body(
                                msg.body_html, MAX_BODY_HTML_BYTES
                            ) if msg.body_html else None,
                                            "snippet": msg.snippet[:200] if msg.snippet else "",
                            "has_attachments": msg.has_attachments,
                            "is_read": msg.is_read,
                            "is_starred": msg.is_starred,
                            "is_flagged": msg.is_flagged,
                            "unsubscribe_link": getattr(
                                msg, "unsubscribe_link", None),
                            "body_truncated": (
                                len(msg.body_text.encode("utf-8", errors="replace"))
                                > MAX_BODY_TEXT_BYTES
                                or (
                                    bool(msg.body_html)
                                    and len(
                                        (msg.body_html or "").encode(
                                            "utf-8", errors="replace"
                                        )
                                    )
                                    > MAX_BODY_HTML_BYTES
                                )
                            ),
                            "received_at": msg.received_at,
                        },
                    )
                    persisted_count += 1

                    # Persist attachment metadata
                    for att in msg.attachments:
                        await db.execute(
                            text(
                                """INSERT INTO email_attachments
                                   (message_id, filename, mime_type, size_bytes,
                                    provider_attachment_id)
                                   VALUES (
                                    (SELECT id FROM email_messages
                                     WHERE account_id = :account_id
                                       AND provider_message_id = :provider_id),
                                    :filename, :mime_type, :size_bytes,
                                    :provider_attachment_id
                                   )
                                   ON CONFLICT DO NOTHING"""
                            ),
                            {
                                "account_id": req.account_id,
                                "provider_id": msg.provider_message_id,
                                "filename": att.filename,
                                "mime_type": att.mime_type,
                                "size_bytes": att.size_bytes,
                                "provider_attachment_id": att.provider_attachment_id,
                            },
                        )

            await db.commit()

            # Persist refreshed OAuth tokens (access/refresh) if the provider
            # rotated them during this sync, so the next sync doesn't reuse a
            # stale token.
            if provider.credentials_dirty():
                await db.execute(
                    text(
                        """UPDATE email_accounts
                           SET credentials_encrypted = :creds, updated_at = now()
                           WHERE id = :id"""
                    ),
                    {
                        "id": req.account_id,
                        "creds": store.encrypt(
                            json.dumps(provider.export_credentials())
                        ),
                    },
                )

            # Update account sync state
            await db.execute(
                text(
                    """UPDATE email_accounts
                       SET sync_status = 'idle',
                           last_synced_at = now(),
                           last_history_id = :history_id,
                           sync_error = NULL,
                           updated_at = now()
                       WHERE id = :id"""
                ),
                {
                    "id": req.account_id,
                    "history_id": sync_result.new_history_id,
                },
            )

            # Mark sync log as success
            await db.execute(
                text(
                    """UPDATE email_sync_log
                       SET status = 'success',
                           completed_at = now(),
                           messages_synced = :synced,
                           messages_skipped = :skipped,
                           provider_history_id = :history_id
                       WHERE id = :log_id"""
                ),
                {
                    "log_id": sync_log_id,
                    "synced": persisted_count,
                    "skipped": skipped_count,
                    "history_id": sync_result.new_history_id,
                },
            )
            await db.commit()

            return {
                "ok": True,
                "messages_synced": persisted_count,
                "messages_skipped": skipped_count,
            }
        except Exception as e:
            # Update account to error state
            await db.execute(
                text(
                    """UPDATE email_accounts
                       SET sync_status = 'error',
                           sync_error = :error,
                           updated_at = now()
                       WHERE id = :id"""
                ),
                {"id": req.account_id, "error": str(e)},
            )
            # Mark sync log as error
            await db.execute(
                text(
                    """UPDATE email_sync_log
                       SET status = 'error',
                           completed_at = now(),
                           error_message = :error
                       WHERE id = :log_id"""
                ),
                {"log_id": sync_log_id, "error": str(e)},
            )
            await db.commit()
            raise HTTPException(
                status_code=500,
                detail=f"Sync failed: {e}"
            )
    finally:
        await db.close()


# ── AI Chat ──────────────────────────────────────────────────────────────

@router.post("/ai/chat")
async def ai_chat(
    req: AIChatRequest,
    user: UserContext = Depends(get_current_user),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """AI assistant chat — streams SSE events from the email assistant agent.

    Routes through the orchestrator's run_agent_stream with the email-assistant
    agent, translating AG-UI protocol events into the frontend SSE format
    (type: 'start' / 'content' / 'done').
    """
    import uuid

    user_id: str = getattr(user, "email", "") or "anonymous"
    run_id = str(uuid.uuid4())

    # ── Set user context for memory tools ──
    try:
        from acb_skills.memory_tools import _set_memory_user_id  # noqa: PLC0415
        _set_memory_user_id(user_id)
    except ImportError:
        pass

    # Build the agent payload — the last user message + optional email context
    last_user_msg = ""
    if req.messages:
        for m in reversed(req.messages):
            if m.get("role") == "user":
                last_user_msg = m.get("content", "")
                break

    # Build conversation history for the agent
    history = req.messages[:-1] if req.messages else []
    conversation_context = ""
    if history:
        history_lines = []
        for m in history[-10:]:  # keep last 10 for context
            role = m.get("role", "unknown")
            content = m.get("content", "")[:500]
            history_lines.append(f"[{role}]: {content}")
        conversation_context = "## Conversation history\n" + "\n".join(history_lines)

    # Build enriched payload
    payload: dict[str, Any] = {
        "message": last_user_msg or "Help me with my email",
        "user_query": last_user_msg,
        "conversation_history": conversation_context,
        "account_id": req.account_id,
        "email_context_id": req.email_context_id,
        "user_email": user_id,
    }

    # If an email is in context, fetch its full content for the agent
    if req.email_context_id:
        try:
            db = await _get_db()
            result = await db.execute(
                text(
                    """SELECT em.subject, em.body_text, em.from_address,
                              em.received_at
                       FROM email_messages em
                       JOIN email_accounts ea ON em.account_id = ea.id
                       WHERE em.id = :id AND ea.user_id = :uid"""
                ),
                {"id": req.email_context_id, "uid": user.email or "anonymous"},
            )
            email_row = result.fetchone()
            if email_row:
                from_data = email_row.from_address
                if isinstance(from_data, str):
                    from_data = json.loads(from_data)
                from_name = from_data.get("name", "") if isinstance(from_data, dict) else ""
                from_email = from_data.get("email", "") if isinstance(from_data, dict) else ""
                payload["current_email"] = {
                    "id": req.email_context_id,
                    "subject": email_row.subject,
                    "body": (email_row.body_text or "")[:5000],
                    "from": f"{from_name} <{from_email}>",
                    "date": str(email_row.received_at),
                }
            await db.close()
        except Exception:  # noqa: BLE001
            pass

    # ── Resolve which LiteLLM tier the agent should use (per-account) ──
    agent_model = "tier-balanced"
    if req.account_id:
        try:
            _mdb = await _get_db()
            try:
                _mrow = (await _mdb.execute(text(
                    "SELECT agent_model FROM email_assistant_settings "
                    "WHERE account_id = :aid"
                ), {"aid": req.account_id})).fetchone()
                if _mrow and _mrow.agent_model:
                    agent_model = _mrow.agent_model
            finally:
                await _mdb.close()
        except Exception:  # noqa: BLE001
            pass

    # ── Run the agent through the orchestrator ──
    from orchestrator.executor import run_agent_stream  # noqa: PLC0415

    # A stable session id keeps the agent's thread (memory) continuous across the
    # turns of one conversation; fall back to the per-request run id.
    thread_key = req.session_id or run_id
    agent_gen = run_agent_stream(
        "email-assistant",
        payload,
        run_id=run_id,
        thread_id=f"email-chat:{user_id}:{thread_key}",
        model=agent_model,
    )

    async def event_stream():
        """Translate AG-UI protocol events to frontend SSE format."""
        # Set the memory/user ContextVar HERE — this generator runs in Starlette's
        # streaming context (not the handler body), so the agent's tools and
        # memory see the right user only if it's set inside the stream.
        try:
            from acb_skills.memory_tools import _set_memory_user_id  # noqa: PLC0415
            _set_memory_user_id(user_id)
        except Exception:  # noqa: BLE001
            pass

        yield f"data: {json.dumps({'type': 'start'})}\n\n"

        content_buffer: list[str] = []
        try:
            async for sse_line in agent_gen:
                if not sse_line.startswith("data: "):
                    continue
                try:
                    evt = json.loads(sse_line[len("data: "):])
                except json.JSONDecodeError:
                    continue

                evt_type = evt.get("type", "")
                if evt_type in (
                    "TEXT_MESSAGE_CONTENT",
                    "REASONING_MESSAGE_CONTENT",
                    "THINKING_TEXT_MESSAGE_CONTENT",
                ):
                    delta = str(evt.get("delta", "") or evt.get("content", ""))
                    if delta:
                        content_buffer.append(delta)
                        yield f"data: {json.dumps({'type': 'content', 'text': delta})}\n\n"

                elif evt_type in ("RUN_FINISHED", "done"):
                    # Capture any TOOL_CALL_RESULT that might be the final answer
                    # when the agent returns a tool result as its last message
                    result_text = evt.get("result") or ""
                    if result_text:
                        content_buffer.append(result_text)
                        yield f"data: {json.dumps({'type': 'content', 'text': result_text})}\n\n"

                elif evt_type == "RUN_ERROR":
                    error_msg = evt.get("error", "Agent encountered an error")
                    yield f"data: {json.dumps({'type': 'error', 'error': error_msg})}\n\n"
                    yield f"data: {json.dumps({'type': 'done'})}\n\n"
                    return

        except Exception as exc:  # noqa: BLE001
            _log.error("email.ai_chat_stream_error", error=str(exc))
            yield f"data: {json.dumps({'type': 'error', 'error': str(exc)})}\n\n"

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

        # ── Save episode to knowledge graph ──
        full_response = "".join(content_buffer)
        if full_response and last_user_msg:
            try:
                from acb_memory import add_episode  # noqa: PLC0415
                background_tasks.add_task(
                    add_episode,
                    name=f"email-assistant:{user_id[:20]}",
                    content=f"Q: {last_user_msg[:300]}\nA: {full_response[:500]}",
                    source_description="email-assistant",
                    group_id=user_id,
                )
            except ImportError:
                pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/ai/quick-action")
async def quick_action(
    req: QuickActionRequest,
    user: UserContext = Depends(get_current_user),
):
    """Trigger a quick AI action (summarize, find urgent, draft reply).

    Calls the email-assistant agent's tool functions directly for fast,
    non-streaming responses to common email workflows.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "email_agent",
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "agent-email-assistant", "agents.py"),
    )
    agent_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(agent_mod)

    # Scope the agent's gateway tool calls to the current user.
    try:
        from acb_skills.memory_tools import _set_memory_user_id  # noqa: PLC0415
        _set_memory_user_id(user.email or "")
    except ImportError:
        pass

    try:
        if req.action == "summarize":
            result = await agent_mod.search_emails(
                query="unread",
                folder="inbox",
                account_id=req.account_id,
            )
        elif req.action == "find_urgent":
            result = await agent_mod.find_urgent(account_id=req.account_id)
        elif req.action == "draft_reply":
            if not req.email_id or not req.account_id:
                raise HTTPException(
                    status_code=400,
                    detail="email_id and account_id are required for draft_reply",
                )
            result = await agent_mod.draft_reply(
                email_id=req.email_id, account_id=req.account_id,
            )
        elif req.action == "unsubscribe":
            result = await agent_mod.suggest_unsubscribes(account_id=req.account_id)
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown action: {req.action}. Supported: summarize, find_urgent, draft_reply, unsubscribe",
            )

        return {"action": req.action, "result": result, "ok": True}

    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        _log.error("email.quick_action_error", action=req.action, error=str(exc))
        raise HTTPException(
            status_code=500,
            detail=f"Quick action '{req.action}' failed: {str(exc)}",
        )


# ══════════════════════════════════════════════════════════════════════════
# EMAIL AUTOMATION — Analytics, Bulk actions, Newsletters, Assistant rules
# ══════════════════════════════════════════════════════════════════════════
#
# Backs the four "Email Automation" features in the email app sidebar:
#   • Analytics        — GET /email/analytics/overview
#   • Bulk Archive     — GET /email/senders, POST /email/messages/bulk
#   • Bulk Unsubscribe — GET /email/senders, GET/POST /email/newsletters
#   • Assistant        — /email/rules CRUD, /test, /run, /history
# ──────────────────────────────────────────────────────────────────────────


def _account_scope(account_id: str | None, params: dict[str, Any]) -> str:
    """Return a SQL fragment scoping email_messages `em` to the user's accounts.

    Adds :uid (and optionally :aid) to `params`. The caller must have already
    set params["uid"] to the user's email.
    """
    frag = "em.account_id IN (SELECT id FROM email_accounts WHERE user_id = :uid"
    if account_id:
        frag += " AND id = :aid"
        params["aid"] = account_id
    frag += ")"
    return frag


async def _assert_account_owner(db: Any, account_id: str, user_email: str) -> None:
    """Raise 404 if the account isn't owned by the user."""
    res = await db.execute(
        text("SELECT 1 FROM email_accounts WHERE id = :id AND user_id = :uid"),
        {"id": account_id, "uid": user_email},
    )
    if not res.fetchone():
        raise HTTPException(status_code=404, detail="Account not found")


# ── Analytics ───────────────────────────────────────────────────────────────

@router.get("/analytics/overview")
async def analytics_overview(
    account_id: str | None = Query(None),
    days: int = Query(30, ge=1, le=365),
    user: UserContext = Depends(get_current_user),
):
    """Inbox analytics: totals, read-rate, volume-over-time, top senders, folders."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous", "days": days}
        scope = _account_scope(account_id, params)

        totals = (await db.execute(text(
            f"""SELECT
                  COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE is_read = false) AS unread,
                  COUNT(*) FILTER (WHERE LOWER(folder) = 'sent') AS sent,
                  COUNT(*) FILTER (WHERE LOWER(folder) = 'archive') AS archived,
                  COUNT(*) FILTER (WHERE is_starred) AS starred,
                  COUNT(*) FILTER (WHERE has_attachments) AS with_attachments
                FROM email_messages em WHERE {scope}"""
        ), params)).fetchone()

        total = totals.total or 0
        read = total - (totals.unread or 0)
        read_rate = round(read / total, 4) if total else 0.0

        volume_rows = (await db.execute(text(
            f"""SELECT to_char(date_trunc('day', received_at), 'YYYY-MM-DD') AS day,
                       COUNT(*) FILTER (WHERE LOWER(folder) <> 'sent') AS received,
                       COUNT(*) FILTER (WHERE LOWER(folder) = 'sent') AS sent
                FROM email_messages em
                WHERE {scope} AND received_at >= now() - make_interval(days => :days)
                GROUP BY day ORDER BY day"""
        ), params)).fetchall()

        sender_rows = (await db.execute(text(
            f"""SELECT from_address->>'email' AS email,
                       MAX(from_address->>'name') AS name,
                       COUNT(*) AS count,
                       COUNT(*) FILTER (WHERE is_read = false) AS unread
                FROM email_messages em
                WHERE {scope} AND COALESCE(from_address->>'email','') <> ''
                GROUP BY email ORDER BY count DESC LIMIT 12"""
        ), params)).fetchall()

        folder_rows = (await db.execute(text(
            f"""SELECT LOWER(folder) AS folder, COUNT(*) AS count
                FROM email_messages em WHERE {scope}
                GROUP BY LOWER(folder) ORDER BY count DESC"""
        ), params)).fetchall()

        return {
            "totals": {
                "total": total,
                "unread": totals.unread or 0,
                "sent": totals.sent or 0,
                "archived": totals.archived or 0,
                "starred": totals.starred or 0,
                "with_attachments": totals.with_attachments or 0,
                "read_rate": read_rate,
            },
            "volume": [
                {"day": r.day, "received": r.received or 0, "sent": r.sent or 0}
                for r in volume_rows
            ],
            "top_senders": [
                {"email": r.email, "name": r.name or "", "count": r.count,
                 "unread": r.unread or 0}
                for r in sender_rows
            ],
            "by_folder": [
                {"folder": r.folder, "count": r.count} for r in folder_rows
            ],
        }
    finally:
        await db.close()


# ── Sender aggregation (bulk archive + unsubscribe) ─────────────────────────

@router.get("/senders")
async def list_senders(
    account_id: str | None = Query(None),
    folder: str | None = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    user: UserContext = Depends(get_current_user),
):
    """Aggregate messages by sender, merged with newsletter status.

    Powers Bulk Archive (volume per sender) and Bulk Unsubscribe (read-rate +
    unsubscribe link + approve/unsubscribe disposition).
    """
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous", "limit": limit}
        scope = _account_scope(account_id, params)
        folder_sql = ""
        if folder:
            folder_sql = " AND LOWER(em.folder) = LOWER(:folder)"
            params["folder"] = folder

        rows = (await db.execute(text(
            f"""SELECT LOWER(from_address->>'email') AS email,
                       MAX(from_address->>'name') AS name,
                       COUNT(*) AS count,
                       COUNT(*) FILTER (WHERE is_read = false) AS unread,
                       COUNT(*) FILTER (WHERE LOWER(folder) = 'archive') AS archived,
                       MAX(received_at) AS last_received,
                       MAX(unsubscribe_link) AS unsubscribe_link
                FROM email_messages em
                WHERE {scope}{folder_sql}
                  AND COALESCE(from_address->>'email','') <> ''
                GROUP BY LOWER(from_address->>'email')
                ORDER BY count DESC LIMIT :limit"""
        ), params)).fetchall()

        # Merge newsletter disposition (APPROVED/UNSUBSCRIBED/AUTO_ARCHIVED).
        nl_params: dict[str, Any] = {"uid": user.email or "anonymous"}
        nl_scope = (
            "account_id IN (SELECT id FROM email_accounts WHERE user_id = :uid"
        )
        if account_id:
            nl_scope += " AND id = :aid"
            nl_params["aid"] = account_id
        nl_scope += ")"
        nl_rows = (await db.execute(text(
            f"SELECT LOWER(email) AS email, status FROM email_newsletters WHERE {nl_scope}"
        ), nl_params)).fetchall()
        status_by_email = {r.email: r.status for r in nl_rows}

        # Merge assigned categories (same account scope as newsletters).
        cat_rows = (await db.execute(text(
            f"SELECT LOWER(email) AS email, category FROM email_senders "
            f"WHERE {nl_scope}"
        ), nl_params)).fetchall()
        category_by_email = {r.email: r.category for r in cat_rows if r.category}

        return {
            "senders": [
                {
                    "email": r.email,
                    "name": r.name or "",
                    "count": r.count,
                    "unread": r.unread or 0,
                    "archived": r.archived or 0,
                    "read_rate": round((r.count - (r.unread or 0)) / r.count, 4)
                    if r.count else 0.0,
                    "last_received": r.last_received.isoformat()
                    if r.last_received else None,
                    "unsubscribe_link": r.unsubscribe_link,
                    "status": status_by_email.get(r.email, "APPROVED"),
                    "category": category_by_email.get(r.email),
                }
                for r in rows
            ]
        }
    finally:
        await db.close()


# ── Bulk actions ────────────────────────────────────────────────────────────

class BulkActionRequest(BaseModel):
    action: str  # archive | trash | read | unread | star | unstar
    account_id: str | None = None
    message_ids: list[str] | None = None
    sender_email: str | None = None
    folder: str | None = None
    older_than_days: int | None = None
    only_read: bool | None = None


_BULK_DB_UPDATE = {
    "archive": "folder = 'archive'",
    "trash": "folder = 'trash'",
    "read": "is_read = true",
    "unread": "is_read = false",
    "star": "is_starred = true",
    "unstar": "is_starred = false",
}

_BULK_MAX = 1000


@router.post("/messages/bulk")
async def bulk_action(
    req: BulkActionRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Apply an action to many messages at once (archive/trash/read/star).

    The local DB is updated synchronously (authoritative for the UI); the
    provider is reconciled in the background so the request stays fast.
    """
    if req.action not in _BULK_DB_UPDATE:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown action '{req.action}'. "
            f"Supported: {', '.join(_BULK_DB_UPDATE)}",
        )

    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous"}
        scope = _account_scope(req.account_id, params)
        clauses = [scope]
        if req.message_ids:
            clauses.append("em.id::text = ANY(:ids)")
            params["ids"] = req.message_ids
        if req.sender_email:
            clauses.append("LOWER(em.from_address->>'email') = LOWER(:sender)")
            params["sender"] = req.sender_email
        if req.folder:
            clauses.append("LOWER(em.folder) = LOWER(:folder)")
            params["folder"] = req.folder
        if req.older_than_days:
            clauses.append("em.received_at < now() - make_interval(days => :odays)")
            params["odays"] = req.older_than_days
        if req.only_read:
            clauses.append("em.is_read = true")
        where_sql = " AND ".join(clauses)

        # Resolve target rows (capped) — keep provider ids for reconciliation.
        rows = (await db.execute(text(
            f"""SELECT em.id, em.provider_message_id, em.account_id, ea.provider
                FROM email_messages em
                JOIN email_accounts ea ON em.account_id = ea.id
                WHERE {where_sql}
                LIMIT {_BULK_MAX}"""
        ), params)).fetchall()
        if not rows:
            return {"affected": 0}

        ids = [str(r.id) for r in rows]
        await db.execute(text(
            f"UPDATE email_messages SET {_BULK_DB_UPDATE[req.action]}, "
            f"updated_at = now() WHERE id::text = ANY(:ids)"
        ), {"ids": ids})
        await db.commit()

        # Group provider message ids per account for background reconciliation.
        per_account: dict[str, list[str]] = {}
        for r in rows:
            per_account.setdefault(str(r.account_id), []).append(r.provider_message_id)
        for aid, pmids in per_account.items():
            background.add_task(_bulk_reconcile_provider, aid, pmids, req.action)

        return {"affected": len(ids)}
    finally:
        await db.close()


async def _bulk_reconcile_provider(
    account_id: str, provider_msg_ids: list[str], action: str
) -> None:
    """Best-effort: push a bulk action to the provider (runs in background)."""
    db = await _get_db()
    try:
        row = (await db.execute(text(
            "SELECT provider, credentials_encrypted FROM email_accounts WHERE id = :id"
        ), {"id": account_id})).fetchone()
        if not row:
            return
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))
        provider = _instantiate_provider(row.provider, creds)
        if not await provider.authenticate():
            return
        for pmid in provider_msg_ids:
            try:
                if action == "archive":
                    await provider.move_to_folder(pmid, "archive")
                elif action == "trash":
                    await provider.trash_message(pmid)
                elif action == "read":
                    await provider.apply_flags(pmid, is_read=True)
                elif action == "unread":
                    await provider.apply_flags(pmid, is_read=False)
                elif action == "star":
                    await provider.apply_flags(pmid, is_starred=True)
                elif action == "unstar":
                    await provider.apply_flags(pmid, is_starred=False)
            except Exception as exc:  # noqa: BLE001
                _log.warning("email.bulk_reconcile_item_failed",
                             pmid=pmid, action=action, error=str(exc)[:120])
        await _persist_rotated_creds(db, store, account_id, provider)
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.bulk_reconcile_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()


# ── Newsletters (bulk unsubscribe disposition) ──────────────────────────────

class NewsletterUpdate(BaseModel):
    account_id: str
    email: str
    name: str | None = None
    status: str  # APPROVED | UNSUBSCRIBED | AUTO_ARCHIVED
    unsubscribe_link: str | None = None


@router.get("/newsletters")
async def list_newsletters(
    account_id: str | None = Query(None),
    user: UserContext = Depends(get_current_user),
):
    """List newsletter dispositions for the user's accounts."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous"}
        scope = "account_id IN (SELECT id FROM email_accounts WHERE user_id = :uid"
        if account_id:
            scope += " AND id = :aid"
            params["aid"] = account_id
        scope += ")"
        rows = (await db.execute(text(
            f"""SELECT id, account_id, email, name, status, unsubscribe_link, updated_at
                FROM email_newsletters WHERE {scope} ORDER BY updated_at DESC"""
        ), params)).fetchall()
        return {
            "newsletters": [
                {"id": str(r.id), "account_id": str(r.account_id), "email": r.email,
                 "name": r.name or "", "status": r.status,
                 "unsubscribe_link": r.unsubscribe_link,
                 "updated_at": r.updated_at.isoformat() if r.updated_at else None}
                for r in rows
            ]
        }
    finally:
        await db.close()


@router.post("/newsletters")
async def upsert_newsletter(
    req: NewsletterUpdate,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Set a sender's disposition. UNSUBSCRIBED/AUTO_ARCHIVED also archives the
    sender's existing inbox mail (locally + provider in the background)."""
    if req.status not in ("APPROVED", "UNSUBSCRIBED", "AUTO_ARCHIVED"):
        raise HTTPException(status_code=400, detail=f"Bad status: {req.status}")
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        await db.execute(text(
            """INSERT INTO email_newsletters
                 (account_id, email, name, status, unsubscribe_link, updated_at)
               VALUES (:aid, LOWER(:email), :name, :status, :link, now())
               ON CONFLICT (account_id, email) DO UPDATE SET
                 name = COALESCE(EXCLUDED.name, email_newsletters.name),
                 status = EXCLUDED.status,
                 unsubscribe_link = COALESCE(EXCLUDED.unsubscribe_link,
                                             email_newsletters.unsubscribe_link),
                 updated_at = now()"""
        ), {"aid": req.account_id, "email": req.email, "name": req.name,
            "status": req.status, "link": req.unsubscribe_link})
        await db.commit()

        archived = 0
        if req.status in ("UNSUBSCRIBED", "AUTO_ARCHIVED"):
            rows = (await db.execute(text(
                """SELECT em.id, em.provider_message_id
                   FROM email_messages em
                   WHERE em.account_id = :aid
                     AND LOWER(em.from_address->>'email') = LOWER(:email)
                     AND LOWER(em.folder) = 'inbox'"""
            ), {"aid": req.account_id, "email": req.email})).fetchall()
            if rows:
                ids = [str(r.id) for r in rows]
                await db.execute(text(
                    "UPDATE email_messages SET folder = 'archive', updated_at = now() "
                    "WHERE id::text = ANY(:ids)"
                ), {"ids": ids})
                await db.commit()
                archived = len(ids)
                background.add_task(
                    _bulk_reconcile_provider, req.account_id,
                    [r.provider_message_id for r in rows], "archive",
                )

        return {"ok": True, "status": req.status, "archived": archived}
    finally:
        await db.close()


# ── Assistant: rules engine ─────────────────────────────────────────────────

class RuleActionModel(BaseModel):
    id: str | None = None
    type: str
    label: str | None = None
    subject: str | None = None
    content: str | None = None
    to_address: str | None = None
    cc_address: str | None = None
    bcc_address: str | None = None
    url: str | None = None


class RuleModel(BaseModel):
    id: str | None = None
    account_id: str
    name: str
    instructions: str | None = None
    enabled: bool = True
    automated: bool = True
    run_on_threads: bool = False
    conditional_operator: str = "AND"
    from_pattern: str | None = None
    to_pattern: str | None = None
    subject_pattern: str | None = None
    body_pattern: str | None = None
    category_filter_type: str | None = None
    category_filters: list[str] = []
    system_type: str | None = None
    sort_order: int = 0
    actions: list[RuleActionModel] = []


async def _load_rules(db: Any, account_id: str) -> list[dict[str, Any]]:
    """Load rules + their actions for an account, ordered by sort_order."""
    rule_rows = (await db.execute(text(
        """SELECT id, account_id, name, instructions, enabled, automated,
                  run_on_threads, conditional_operator, from_pattern, to_pattern,
                  subject_pattern, body_pattern, category_filter_type,
                  category_filters, system_type, sort_order
           FROM email_rules WHERE account_id = :aid
           ORDER BY sort_order, created_at"""
    ), {"aid": account_id})).fetchall()
    rules: list[dict[str, Any]] = []
    for r in rule_rows:
        act_rows = (await db.execute(text(
            """SELECT id, type, label, subject, content, to_address, cc_address,
                      bcc_address, url FROM email_actions WHERE rule_id = :rid
               ORDER BY created_at"""
        ), {"rid": r.id})).fetchall()
        rules.append({
            "id": str(r.id), "account_id": str(r.account_id), "name": r.name,
            "instructions": r.instructions, "enabled": r.enabled,
            "automated": r.automated,
            "run_on_threads": r.run_on_threads,
            "conditional_operator": r.conditional_operator,
            "from_pattern": r.from_pattern, "to_pattern": r.to_pattern,
            "subject_pattern": r.subject_pattern, "body_pattern": r.body_pattern,
            "category_filter_type": r.category_filter_type,
            "category_filters": list(r.category_filters) if r.category_filters else [],
            "system_type": r.system_type, "sort_order": r.sort_order,
            "actions": [
                {"id": str(a.id), "type": a.type, "label": a.label,
                 "subject": a.subject, "content": a.content,
                 "to_address": a.to_address, "cc_address": a.cc_address,
                 "bcc_address": a.bcc_address, "url": a.url}
                for a in act_rows
            ],
        })
    return rules


@router.get("/rules")
async def list_rules(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """List assistant rules (with actions) for an account."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        return {"rules": await _load_rules(db, account_id)}
    finally:
        await db.close()


# Default rule set, mirroring inbox-zero's system rules. Single source of truth
# so the agent's install tool and the UI's "Add defaults" button stay in sync.
_PRESET_RULES: list[dict[str, Any]] = [
    {"name": "To Reply", "instructions": "Emails I need to respond to.",
     "run_on_threads": True,
     "actions": [{"type": "LABEL", "label": "To Reply"}, {"type": "DRAFT_EMAIL"}]},
    {"name": "FYI", "run_on_threads": True,
     "instructions": "Important emails I should know about, but don't need to "
                     "reply to.",
     "actions": [{"type": "LABEL", "label": "FYI"}]},
    {"name": "Newsletter",
     "instructions": "Newsletters: regular content from publications, blogs, or "
                     "services I've subscribed to.",
     "actions": [{"type": "LABEL", "label": "Newsletter"}]},
    {"name": "Marketing",
     "instructions": "Marketing: promotional emails about products, services, "
                     "sales, or offers.",
     "actions": [{"type": "LABEL", "label": "Marketing"}, {"type": "ARCHIVE"}]},
    {"name": "Calendar",
     "instructions": "Calendar: any email related to scheduling, meeting "
                     "invites, or calendar notifications.",
     "actions": [{"type": "LABEL", "label": "Calendar"}]},
    {"name": "Receipt",
     "instructions": "Receipts: purchase confirmations, payment receipts, "
                     "transaction records or invoices.",
     "actions": [{"type": "LABEL", "label": "Receipt"}]},
    {"name": "Notification",
     "instructions": "Notifications: alerts, status updates, or system messages.",
     "actions": [{"type": "LABEL", "label": "Notification"}]},
    {"name": "Cold Email",
     "instructions": "Cold emails: unsolicited sales pitches and outreach from "
                     "people or companies I have no prior relationship with.",
     "actions": [{"type": "LABEL", "label": "Cold Email"}, {"type": "ARCHIVE"}]},
]


@router.post("/rules/install-presets")
async def install_preset_rules(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """Install the default inbox-zero-style rule set (skips ones already present
    by name). Used by the UI's 'Add defaults' and the assistant's setup flow."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        existing = {r["name"].lower() for r in await _load_rules(db, account_id)}
        installed: list[str] = []
        for i, p in enumerate(_PRESET_RULES):
            if p["name"].lower() in existing:
                continue
            rid = str(uuid4())
            await db.execute(text(
                """INSERT INTO email_rules
                     (id, account_id, name, instructions, run_on_threads,
                      sort_order)
                   VALUES (:id, :aid, :name, :instr, :rot, :so)"""
            ), {"id": rid, "aid": account_id, "name": p["name"],
                "instr": p["instructions"], "rot": p.get("run_on_threads", False),
                "so": i})
            await _replace_actions(
                db, rid, [RuleActionModel(**a) for a in p["actions"]]
            )
            installed.append(p["name"])
        await db.commit()
        return {"installed": installed,
                "total_presets": len(_PRESET_RULES)}
    finally:
        await db.close()


async def _replace_actions(db: Any, rule_id: str, actions: list[RuleActionModel]) -> None:
    await db.execute(text("DELETE FROM email_actions WHERE rule_id = :rid"),
                     {"rid": rule_id})
    for a in actions:
        await db.execute(text(
            """INSERT INTO email_actions
                 (rule_id, type, label, subject, content, to_address,
                  cc_address, bcc_address, url)
               VALUES (:rid, :type, :label, :subject, :content, :to_addr,
                       :cc, :bcc, :url)"""
        ), {"rid": rule_id, "type": a.type, "label": a.label, "subject": a.subject,
            "content": a.content, "to_addr": a.to_address, "cc": a.cc_address,
            "bcc": a.bcc_address, "url": a.url})


@router.post("/rules")
async def create_rule(
    req: RuleModel,
    user: UserContext = Depends(get_current_user),
):
    """Create an assistant rule with its actions."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        rule_id = str(uuid4())
        await db.execute(text(
            """INSERT INTO email_rules
                 (id, account_id, name, instructions, enabled, automated,
                  run_on_threads, conditional_operator, from_pattern, to_pattern,
                  subject_pattern, body_pattern, category_filter_type,
                  category_filters, system_type, sort_order)
               VALUES (:id, :aid, :name, :instr, :enabled, :auto, :rot, :op,
                       :fp, :tp, :sp, :bp, :cft, :cfs, :st, :so)"""
        ), {"id": rule_id, "aid": req.account_id, "name": req.name,
            "instr": req.instructions, "enabled": req.enabled,
            "auto": req.automated, "rot": req.run_on_threads,
            "op": req.conditional_operator,
            "fp": req.from_pattern, "tp": req.to_pattern, "sp": req.subject_pattern,
            "bp": req.body_pattern, "cft": req.category_filter_type,
            "cfs": req.category_filters, "st": req.system_type,
            "so": req.sort_order})
        await _replace_actions(db, rule_id, req.actions)
        await db.commit()
        rules = await _load_rules(db, req.account_id)
        return next((r for r in rules if r["id"] == rule_id), {"id": rule_id})
    finally:
        await db.close()


@router.patch("/rules/{rule_id}")
async def update_rule(
    rule_id: str,
    req: RuleModel,
    user: UserContext = Depends(get_current_user),
):
    """Update a rule and replace its actions."""
    db = await _get_db()
    try:
        owner = (await db.execute(text(
            """SELECT er.account_id FROM email_rules er
               JOIN email_accounts ea ON er.account_id = ea.id
               WHERE er.id = :rid AND ea.user_id = :uid"""
        ), {"rid": rule_id, "uid": user.email or "anonymous"})).fetchone()
        if not owner:
            raise HTTPException(status_code=404, detail="Rule not found")
        await db.execute(text(
            """UPDATE email_rules SET
                 name = :name, instructions = :instr, enabled = :enabled,
                 automated = :auto, run_on_threads = :rot,
                 conditional_operator = :op,
                 from_pattern = :fp, to_pattern = :tp, subject_pattern = :sp,
                 body_pattern = :bp, category_filter_type = :cft,
                 category_filters = :cfs,
                 system_type = :st, sort_order = :so, updated_at = now()
               WHERE id = :rid"""
        ), {"rid": rule_id, "name": req.name, "instr": req.instructions,
            "enabled": req.enabled, "auto": req.automated,
            "rot": req.run_on_threads,
            "op": req.conditional_operator, "fp": req.from_pattern,
            "tp": req.to_pattern, "sp": req.subject_pattern, "bp": req.body_pattern,
            "cft": req.category_filter_type, "cfs": req.category_filters,
            "st": req.system_type, "so": req.sort_order})
        await _replace_actions(db, rule_id, req.actions)
        await db.commit()
        rules = await _load_rules(db, str(owner.account_id))
        return next((r for r in rules if r["id"] == rule_id), {"id": rule_id})
    finally:
        await db.close()


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(
    rule_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Delete a rule (cascades to actions)."""
    db = await _get_db()
    try:
        res = await db.execute(text(
            """DELETE FROM email_rules er
               USING email_accounts ea
               WHERE er.id = :rid AND er.account_id = ea.id
                 AND ea.user_id = :uid"""
        ), {"rid": rule_id, "uid": user.email or "anonymous"})
        await db.commit()
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Rule not found")
    finally:
        await db.close()


def _safe_json(content: str) -> Any | None:
    """Extract a JSON object/array from an LLM response (tolerates ``` fences)."""
    if not content:
        return None
    s = content.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1] if "```" in s[3:] else s.strip("`")
        if s.startswith("json"):
            s = s[4:]
    start = min((i for i in (s.find("{"), s.find("[")) if i >= 0), default=-1)
    if start < 0:
        return None
    s = s[start:]
    end = max(s.rfind("}"), s.rfind("]"))
    if end >= 0:
        s = s[:end + 1]
    try:
        return json.loads(s)
    except Exception:
        return None


async def _llm_pick_rule(
    email: dict[str, str], rules: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Ask the LLM which instruction-based rule matches the email.

    Returns {"index": int, "reason": str} (index into `rules`) or None.
    Fails closed (returns None) when the LLM is unavailable.
    """
    if not rules:
        return None
    try:
        import litellm as _litellm  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        from acb_llm.client import ensure_model_registered, _TIER_MODEL  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)

        rule_lines = "\n".join(
            f"{i}. {r['name']}: {r.get('instructions') or '(no description)'}"
            for i, r in enumerate(rules)
        )
        sys_prompt = (
            "You are an email classifier. Given an email and a numbered list of "
            "rules, choose the single best-matching rule. Respond with ONLY a JSON "
            'object: {"index": <number or -1 if none match>, "reason": "<short why>"}.'
        )
        user_prompt = (
            f"EMAIL\nFrom: {email.get('from','')}\nSubject: {email.get('subject','')}\n"
            f"Body: {(email.get('body','') or '')[:1500]}\n\nRULES\n{rule_lines}"
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0, max_tokens=300,
        )
        content = resp.choices[0].message.content or ""
        data = _safe_json(content)
        if isinstance(data, dict) and isinstance(data.get("index"), int):
            idx = data["index"]
            if 0 <= idx < len(rules):
                return {"index": idx, "reason": str(data.get("reason", ""))[:300]}
        return None
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.llm_pick_rule_failed", error=str(exc)[:200])
        return None


def _static_match(rule: dict[str, Any], email: dict[str, str]) -> bool | None:
    """Evaluate a rule's static patterns. Returns None if the rule has none."""
    checks: list[bool] = []
    field_map = [
        ("from_pattern", email.get("from", "")),
        ("to_pattern", email.get("to", "")),
        ("subject_pattern", email.get("subject", "")),
        ("body_pattern", email.get("body", "")),
    ]
    for key, value in field_map:
        pat = rule.get(key)
        if pat:
            checks.append(pat.lower() in (value or "").lower())
    if not checks:
        return None
    return all(checks) if rule.get("conditional_operator", "AND") == "AND" else any(checks)


def _category_ok(rule: dict[str, Any], sender_category: str) -> bool:
    """Whether the sender's category satisfies the rule's category condition."""
    cft = rule.get("category_filter_type")
    cfs = rule.get("category_filters") or []
    if not cft or not cfs:
        return True
    sc = sender_category or "Unknown"
    if cft == "INCLUDE":
        return sc in cfs
    if cft == "EXCLUDE":
        return sc not in cfs
    return True


async def _sender_category(db: Any, account_id: str, sender_email: str) -> str:
    """Look up a sender's assigned category, defaulting to 'Unknown'."""
    if not sender_email:
        return "Unknown"
    row = (await db.execute(text(
        "SELECT category FROM email_senders "
        "WHERE account_id = :aid AND email = LOWER(:e)"
    ), {"aid": account_id, "e": sender_email})).fetchone()
    return (row.category if row and row.category else "Unknown")


async def _match_email_to_rule(
    db: Any, account_id: str, email: dict[str, str]
) -> dict[str, Any] | None:
    """Return the first matching rule + reason, or None.

    Evaluation order per rule: category condition (if any) must pass, then static
    patterns (local), then NL instructions (one batched LLM call). Static/category
    first keeps it cheap & deterministic.
    """
    rules = [r for r in await _load_rules(db, account_id) if r["enabled"]]
    if not rules:
        return None

    # Resolve the sender's category once, only if a rule actually filters on it.
    sender_category = "Unknown"
    if any(r.get("category_filter_type") and r.get("category_filters") for r in rules):
        sender_category = await _sender_category(db, account_id, email.get("from", ""))

    instruction_rules: list[dict[str, Any]] = []
    for rule in rules:
        if not _category_ok(rule, sender_category):
            continue
        sm = _static_match(rule, email)
        has_instr = bool((rule.get("instructions") or "").strip())
        has_cat = bool(rule.get("category_filter_type") and rule.get("category_filters"))
        if has_instr:
            # Static (if any) must not contradict; let the LLM decide.
            if sm is not False:
                instruction_rules.append(rule)
            continue
        if sm is True:
            return {"rule": rule, "reason": "Matched static conditions."}
        if sm is False:
            continue
        # No static patterns and no instructions: a passing category filter alone
        # is a match.
        if has_cat:
            return {"rule": rule, "reason": f"Matched category: {sender_category}."}

    if instruction_rules:
        pick = await _llm_pick_rule(email, instruction_rules)
        if pick:
            return {"rule": instruction_rules[pick["index"]],
                    "reason": pick["reason"] or "Matched by AI."}
    return None


async def _email_payload_from_id(db: Any, message_id: str, user_email: str) -> dict[str, str]:
    row = (await db.execute(text(
        """SELECT em.subject, em.body_text, em.snippet, em.from_address, em.to_addresses
           FROM email_messages em JOIN email_accounts ea ON em.account_id = ea.id
           WHERE em.id = :mid AND ea.user_id = :uid"""
    ), {"mid": message_id, "uid": user_email})).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    frm = row.from_address if isinstance(row.from_address, dict) else json.loads(row.from_address or "{}")
    return {
        "subject": row.subject or "",
        "body": row.body_text or row.snippet or "",
        "from": frm.get("email", ""),
        "to": "",
    }


class RuleTestRequest(BaseModel):
    account_id: str
    email_id: str | None = None
    subject: str | None = None
    from_email: str | None = None
    body: str | None = None


@router.post("/rules/test")
async def test_rules(
    req: RuleTestRequest,
    user: UserContext = Depends(get_current_user),
):
    """Test the rules against one email (selected message or a pasted sample)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        if req.email_id:
            email = await _email_payload_from_id(db, req.email_id, user.email or "anonymous")
        else:
            email = {"subject": req.subject or "", "from": req.from_email or "",
                     "body": req.body or "", "to": ""}
        match = await _match_email_to_rule(db, req.account_id, email)
        if not match:
            return {"matched": False, "rule": None, "reason": "No rule matched.",
                    "actions": []}
        return {
            "matched": True,
            "rule": {"id": match["rule"]["id"], "name": match["rule"]["name"]},
            "reason": match["reason"],
            "actions": match["rule"]["actions"],
        }
    finally:
        await db.close()


class RuleTestRecentRequest(BaseModel):
    account_id: str
    limit: int = 8


@router.post("/rules/test/recent")
async def test_rules_recent(
    req: RuleTestRecentRequest,
    user: UserContext = Depends(get_current_user),
):
    """Test the rules against the most recent inbox messages (read-only).

    Returns, per email, which rule would match and the actions it would take —
    inbox-zero's "test on your real inbox" preview. Applies nothing.
    """
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT id, subject, body_text, snippet, from_address
               FROM email_messages
               WHERE account_id = :aid AND LOWER(folder) = 'inbox'
               ORDER BY received_at DESC LIMIT :limit"""
        ), {"aid": req.account_id, "limit": min(req.limit, 15)})).fetchall()
        results = []
        for r in rows:
            frm = r.from_address if isinstance(r.from_address, dict) \
                else json.loads(r.from_address or "{}")
            email = {"subject": r.subject or "", "from": frm.get("email", ""),
                     "body": r.body_text or r.snippet or "", "to": ""}
            match = await _match_email_to_rule(db, req.account_id, email)
            results.append({
                "email_id": str(r.id),
                "subject": r.subject or "(no subject)",
                "from": frm.get("name") or frm.get("email", ""),
                "matched": bool(match),
                "rule": {"id": match["rule"]["id"], "name": match["rule"]["name"]}
                if match else None,
                "reason": match["reason"] if match else "",
                "actions": [a["type"] for a in match["rule"]["actions"]]
                if match else [],
            })
        return {"results": results}
    finally:
        await db.close()


@router.get("/rules/history")
async def rules_history(
    account_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    user: UserContext = Depends(get_current_user),
):
    """Executed-rule audit log for the user's accounts."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous", "limit": limit}
        scope = ("er.account_id IN (SELECT id FROM email_accounts WHERE user_id = :uid")
        if account_id:
            scope += " AND id = :aid"
            params["aid"] = account_id
        scope += ")"
        rows = (await db.execute(text(
            f"""SELECT er.id, er.rule_name, er.subject, er.from_address, er.status,
                       er.automated, er.actions_taken, er.reason, er.created_at,
                       em.snippet
                FROM email_executed_rules er
                LEFT JOIN email_messages em ON er.message_id = em.id
                WHERE {scope} ORDER BY er.created_at DESC LIMIT :limit"""
        ), params)).fetchall()
        return {
            "history": [
                {"id": str(r.id), "rule_name": r.rule_name, "subject": r.subject,
                 "from": r.from_address, "status": r.status, "automated": r.automated,
                 "actions": r.actions_taken if isinstance(r.actions_taken, list)
                 else json.loads(r.actions_taken or "[]"),
                 "reason": r.reason, "snippet": r.snippet or "",
                 "created_at": r.created_at.isoformat() if r.created_at else None}
                for r in rows
            ]
        }
    finally:
        await db.close()


@router.post("/rules/history/{exec_id}/approve")
async def approve_execution(
    exec_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Apply a PENDING (proposed) rule execution — the approval queue."""
    db = await _get_db()
    try:
        row = (await db.execute(text(
            """SELECT er.status, er.rule_id, er.message_id, er.provider_message_id,
                      er.thread_id, er.subject, er.from_address, er.account_id,
                      er.reason, ea.provider, ea.credentials_encrypted,
                      ea.user_id, em.body_text
               FROM email_executed_rules er
               JOIN email_accounts ea ON er.account_id = ea.id
               LEFT JOIN email_messages em ON er.message_id = em.id
               WHERE er.id = :eid AND ea.user_id = :uid"""
        ), {"eid": exec_id, "uid": user.email or "anonymous"})).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Execution not found")
        if row.status != "PENDING":
            raise HTTPException(status_code=400, detail="Not pending")
        if not row.rule_id:
            raise HTTPException(status_code=400, detail="Rule no longer exists")

        act_rows = (await db.execute(text(
            """SELECT type, label, subject, content, to_address, cc_address,
                      bcc_address, url FROM email_actions WHERE rule_id = :rid"""
        ), {"rid": row.rule_id})).fetchall()
        actions = [dict(a._mapping) for a in act_rows]

        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))
        provider = _instantiate_provider(row.provider, creds)
        if not await provider.authenticate():
            raise HTTPException(status_code=502, detail="Provider auth failed")

        about, signature = await _load_assistant_about(db, str(row.account_id))
        email = {"subject": row.subject or "", "from": row.from_address or "",
                 "body": row.body_text or "", "thread_id": row.thread_id or ""}
        taken = await _apply_rule_actions(
            db, provider, str(row.message_id), row.provider_message_id,
            actions, email, about, signature, row.user_id,
            account_id=str(row.account_id),
        )
        await db.execute(text(
            "UPDATE email_executed_rules SET status='APPLIED', actions_taken=:acts "
            "WHERE id=:eid"
        ), {"eid": exec_id, "acts": json.dumps(taken)})
        if row.message_id:
            await db.execute(text(
                "UPDATE email_messages SET rules_processed_at = now() WHERE id=:mid"
            ), {"mid": str(row.message_id)})
        await _persist_rotated_creds(db, store, str(row.account_id), provider)
        await db.commit()
        return {"ok": True, "status": "APPLIED", "actions": taken}
    finally:
        await db.close()


@router.post("/rules/history/{exec_id}/reject")
async def reject_execution(
    exec_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Dismiss a PENDING rule execution without applying it."""
    db = await _get_db()
    try:
        res = await db.execute(text(
            """UPDATE email_executed_rules er
               SET status = 'REJECTED'
               FROM email_accounts ea
               WHERE er.id = :eid AND er.account_id = ea.id
                 AND ea.user_id = :uid AND er.status = 'PENDING'"""
        ), {"eid": exec_id, "uid": user.email or "anonymous"})
        await db.commit()
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Pending execution not found")
        return {"ok": True, "status": "REJECTED"}
    finally:
        await db.close()


class RuleReorderRequest(BaseModel):
    account_id: str
    rule_ids: list[str]  # desired order; index becomes sort_order


@router.patch("/rules/reorder")
async def reorder_rules(
    req: RuleReorderRequest,
    user: UserContext = Depends(get_current_user),
):
    """Persist a new rule priority order (lower sort_order = evaluated first)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        for i, rid in enumerate(req.rule_ids):
            await db.execute(text(
                "UPDATE email_rules SET sort_order = :so, updated_at = now() "
                "WHERE id = :id AND account_id = :aid"
            ), {"so": i, "id": rid, "aid": req.account_id})
        await db.commit()
        return {"reordered": len(req.rule_ids)}
    finally:
        await db.close()


@router.post("/rules/history/{exec_id}/undo")
async def undo_execution(
    exec_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Reverse an APPLIED rule execution where possible: restore the message to
    the inbox (archive/move/trash/spam) and remove any labels the rule added."""
    db = await _get_db()
    try:
        row = (await db.execute(text(
            """SELECT er.status, er.rule_id, er.message_id, er.provider_message_id,
                      er.actions_taken, ea.provider, ea.credentials_encrypted
               FROM email_executed_rules er
               JOIN email_accounts ea ON er.account_id = ea.id
               WHERE er.id = :eid AND ea.user_id = :uid"""
        ), {"eid": exec_id, "uid": user.email or "anonymous"})).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Execution not found")
        if row.status != "APPLIED":
            raise HTTPException(
                status_code=400,
                detail="Only applied executions can be undone")
        taken = row.actions_taken if isinstance(row.actions_taken, list) \
            else json.loads(row.actions_taken or "[]")

        from acb_llm.key_store import get_key_store  # noqa: PLC0415
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))
        provider = _instantiate_provider(row.provider, creds)
        if not await provider.authenticate():
            raise HTTPException(status_code=502, detail="Provider auth failed")

        pmid = row.provider_message_id
        reversed_actions: list[str] = []
        if any(t in ("ARCHIVE", "MOVE_FOLDER", "TRASH", "MARK_SPAM")
               for t in taken):
            await provider.move_to_folder(pmid, "inbox")
            if row.message_id:
                await db.execute(text(
                    "UPDATE email_messages SET folder='inbox', updated_at=now() "
                    "WHERE id=:id"
                ), {"id": str(row.message_id)})
            reversed_actions.append("restored to inbox")
        if "LABEL" in taken and row.rule_id:
            lbl_rows = (await db.execute(text(
                "SELECT label FROM email_actions WHERE rule_id = :rid "
                "AND type = 'LABEL' AND label IS NOT NULL"
            ), {"rid": str(row.rule_id)})).fetchall()
            labels = [r.label for r in lbl_rows if r.label]
            if labels:
                try:
                    await provider.set_labels(pmid, add=[], remove=labels)
                    reversed_actions.append(
                        f"removed label(s): {', '.join(labels)}")
                except Exception:  # noqa: BLE001
                    pass
        await db.execute(text(
            "UPDATE email_executed_rules SET status='UNDONE' WHERE id=:eid"
        ), {"eid": exec_id})
        await db.commit()
        return {"status": "UNDONE", "reversed": reversed_actions}
    finally:
        await db.close()


class RuleRunRequest(BaseModel):
    account_id: str
    limit: int = 20
    dry_run: bool = True


@router.post("/rules/run")
async def run_rules(
    req: RuleRunRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Run enabled rules over recent inbox mail (scheduled in the background).

    `dry_run` (default) only logs what WOULD happen to the history; set it false
    to actually apply the matched actions. Poll GET /email/rules/history for
    results.
    """
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
    finally:
        await db.close()
    background.add_task(
        _run_rules_job, req.account_id, min(req.limit, 50), req.dry_run,
        user.email or "anonymous",
    )
    return {"scheduled": True, "dry_run": req.dry_run}


async def _load_assistant_about(db: Any, account_id: str) -> tuple[str, str]:
    """Return (enriched_about, signature) for draft context.

    `enriched_about` bundles the user's About text with their personal
    instructions, writing style, and knowledge base as tagged blocks, so the
    single `about` string carries the full drafting context into both the LLM
    drafter and the MAF agent. Empty string if nothing is set.
    """
    row = (await db.execute(text(
        """SELECT about, signature, personal_instructions, writing_style
           FROM email_assistant_settings WHERE account_id = :aid"""
    ), {"aid": account_id})).fetchone()
    about = (row.about if row else "") or ""
    signature = (row.signature if row else "") or ""
    personal = (getattr(row, "personal_instructions", None) or "") if row else ""
    style = (getattr(row, "writing_style", None) or "") if row else ""

    kb_rows = (await db.execute(text(
        """SELECT title, content FROM email_knowledge
           WHERE account_id = :aid ORDER BY updated_at DESC LIMIT 20"""
    ), {"aid": account_id})).fetchall()

    parts: list[str] = []
    if about.strip():
        parts.append(f"<about>\n{about.strip()}\n</about>")
    if personal.strip():
        parts.append(
            "<personal_instructions>\n"
            f"{personal.strip()}\n</personal_instructions>"
        )
    if style.strip():
        parts.append(f"<writing_style>\n{style.strip()}\n</writing_style>")
    if kb_rows:
        kb_text, budget = [], 4000
        for k in kb_rows:
            chunk = f"## {k.title}\n{(k.content or '').strip()}"
            if budget - len(chunk) < 0:
                break
            kb_text.append(chunk)
            budget -= len(chunk)
        if kb_text:
            parts.append(
                "<knowledge_base>\n" + "\n\n".join(kb_text) + "\n</knowledge_base>"
            )

    # Patterns learned from how the user edits the assistant's drafts (advisory).
    lp_rows = (await db.execute(text(
        """SELECT pattern FROM email_learned_patterns
           WHERE account_id = :aid ORDER BY weight DESC, updated_at DESC LIMIT 12"""
    ), {"aid": account_id})).fetchall()
    if lp_rows:
        parts.append(
            "<learned_patterns>\n"
            + "\n".join(f"- {r.pattern}" for r in lp_rows)
            + "\n</learned_patterns>"
        )

    return "\n\n".join(parts), signature


def _normalize_text(s: str) -> str:
    return " ".join((s or "").split()).lower()


async def _store_ai_draft(
    db: Any, account_id: str, thread_id: str, draft_text: str
) -> None:
    """Remember the assistant's original draft for a thread, so we can later
    learn from how the user edits it before sending."""
    if not account_id or not thread_id or not (draft_text or "").strip():
        return
    try:
        await db.execute(text(
            """INSERT INTO email_ai_drafts (account_id, thread_id, draft_text)
               VALUES (:aid, :tid, :txt)
               ON CONFLICT (account_id, thread_id) DO UPDATE SET
                 draft_text = EXCLUDED.draft_text, created_at = now()"""
        ), {"aid": account_id, "tid": thread_id, "txt": draft_text})
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.store_ai_draft_failed", error=str(exc)[:160])


async def _llm_distill_edit(original: str, edited: str) -> str:
    """One durable preference from how the user changed the draft, or '' if the
    change is trivial / not generalizable."""
    try:
        import litellm as _litellm  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        from acb_llm.client import ensure_model_registered, _TIER_MODEL  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)
        sys_prompt = (
            "Compare the assistant's DRAFT reply with what the user actually "
            "SENT. Identify ONE durable, generalizable preference about how this "
            "user likes their replies written (tone, length, sign-off, phrasing, "
            "what to include or omit). Ignore one-off factual edits specific to "
            "this email. If there is no generalizable preference, output exactly "
            "NONE. Otherwise output a single short instruction, e.g. 'Keep "
            "sign-offs to just my first name.'"
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user",
                       "content": f"DRAFT:\n{original[:2000]}\n\nSENT:\n{edited[:2000]}"}],
            temperature=0, max_tokens=120,
        )
        out = (resp.choices[0].message.content or "").strip()
        if not out or out.upper().startswith("NONE"):
            return ""
        return out[:200]
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.distill_edit_failed", error=str(exc)[:160])
        return ""


async def _learn_from_sent(account_id: str, thread_id: str, sent_text: str) -> None:
    """Background: if the user edited the assistant's draft for this thread,
    distil a learned preference and store it (best-effort)."""
    if not thread_id or not (sent_text or "").strip():
        return
    db = await _get_db()
    try:
        row = (await db.execute(text(
            "SELECT draft_text FROM email_ai_drafts "
            "WHERE account_id = :aid AND thread_id = :tid"
        ), {"aid": account_id, "tid": thread_id})).fetchone()
        if not row:
            return
        original = row.draft_text or ""
        await db.execute(text(
            "DELETE FROM email_ai_drafts "
            "WHERE account_id = :aid AND thread_id = :tid"
        ), {"aid": account_id, "tid": thread_id})
        await db.commit()
        if not original.strip() or \
                _normalize_text(original) == _normalize_text(sent_text):
            return  # unchanged → nothing to learn
        pattern = await _llm_distill_edit(original, sent_text)
        if not pattern:
            return
        await db.execute(text(
            """INSERT INTO email_learned_patterns (account_id, pattern)
               VALUES (:aid, :p)
               ON CONFLICT (account_id, pattern) DO UPDATE SET
                 weight = email_learned_patterns.weight + 1, updated_at = now()"""
        ), {"aid": account_id, "p": pattern})
        await db.commit()
        _log.info("email.learned_pattern", account_id=account_id,
                  pattern=pattern[:80])
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.learn_from_sent_failed", error=str(exc)[:160])
    finally:
        await db.close()


async def _llm_draft_reply(
    email: dict[str, str], about: str, signature: str,
    instructions: str = "", context: str = "",
) -> str:
    """Draft a reply body with the LLM, using the user's About context plus any
    extra `context` gathered from memory / specialist agents.

    Falls back to a neutral template if the LLM is unavailable.
    """
    try:
        import litellm as _litellm  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        from acb_llm.client import ensure_model_registered, _TIER_MODEL  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)
        sys_prompt = (
            "You are an expert assistant that drafts email replies on behalf of "
            "the user. Use the previous email and the provided context to make the "
            "reply relevant and accurate. Rules: write ONLY the reply body (no "
            "subject line); do not identify yourself as an AI or mention these "
            "instructions; do not repeat the sender's content back — respond to "
            "it; plain text only (markdown links allowed), paragraphs separated by "
            "blank lines; be concise; match the language of the email; ground "
            "every fact in the email or the supplied context and never invent "
            "specifics — if something is missing, keep it open or ask for it. "
            "If the context contains <personal_instructions>, follow them. If it "
            "contains <writing_style>, match that tone, length, and phrasing. If "
            "it contains a <knowledge_base>, use it for facts and details but only "
            "where relevant to this email. If it contains <learned_patterns>, "
            "treat them as advisory preferences learned from the user's past "
            "edits and apply the ones that fit."
        )
        ctx = f"User context:\n{about}\n\n" if about else ""
        if context:
            ctx += f"Context gathered for this reply:\n{context}\n\n"
        user_prompt = (
            f"{ctx}Draft a reply to this email.\n"
            f"From: {email.get('from', '')}\n"
            f"Subject: {email.get('subject', '')}\n"
            f"Body:\n{(email.get('body', '') or '')[:2000]}\n"
        )
        if instructions:
            user_prompt += f"\nExtra instructions: {instructions}\n"
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0.3, max_tokens=700,
        )
        body = (resp.choices[0].message.content or "").strip()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.llm_draft_failed", error=str(exc)[:200])
        body = "Hi,\n\nThanks for your email — I'll review this and get back to you shortly."
    if signature:
        body = f"{body}\n\n{signature}"
    return body


async def _draft_consult_plan(email: dict[str, str]) -> list[dict[str, str]]:
    """Decide which specialist agents (if any) could improve this reply.

    Returns [{"agent": "sales"|"task-manager", "question": "..."}], capped at 2.
    """
    try:
        import litellm as _litellm  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        from acb_llm.client import ensure_model_registered, _TIER_MODEL  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier1") or _TIER_MODEL.get("tier2") or "gpt-4o-mini"
        ensure_model_registered(model)
        sys_prompt = (
            "You plan how to draft an email reply. Decide which internal specialist "
            "agents, if any, would provide context that materially improves the "
            "reply. Available agents:\n"
            "- sales: CRM, deals, pipeline, quotes, customer/account status (Zoho).\n"
            "- task-manager: projects, tasks, deadlines, delivery status (ClickUp).\n"
            "Only include an agent when the email clearly relates to its domain. "
            'Respond ONLY JSON: {"consult": [{"agent": "<name>", "question": '
            '"<specific question to ask that agent>"}]} (empty list if none).'
        )
        user_prompt = (
            f"From: {email.get('from', '')}\nSubject: {email.get('subject', '')}\n"
            f"Body:\n{(email.get('body', '') or '')[:1500]}"
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0, max_tokens=300,
        )
        data = _safe_json(resp.choices[0].message.content or "")
        consult = data.get("consult", []) if isinstance(data, dict) else []
        out = []
        for c in consult:
            if isinstance(c, dict) and c.get("agent") in ("sales", "task-manager") \
                    and c.get("question"):
                out.append({"agent": c["agent"], "question": str(c["question"])})
        return out[:2]
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.draft_plan_failed", error=str(exc)[:200])
        return []


def _strip_draft_markers(text: str) -> str:
    """Remove any standalone '---' fence lines the agent may wrap a draft in."""
    lines = [ln for ln in (text or "").splitlines() if ln.strip() != "---"]
    return "\n".join(lines).strip()


async def _draft_via_maf_agent(
    email: dict[str, str], about: str, signature: str, user_email: str,
    *, instructions: str = "",
) -> str | None:
    """Draft by running the email-assistant MAF agent (which can hand off to
    sales / task-manager and read memory). Returns None on any failure so the
    caller can fall back to the in-gateway orchestrator."""
    try:
        from acb_skills.memory_tools import _set_memory_user_id  # noqa: PLC0415
        _set_memory_user_id(user_email or "")
    except Exception:  # noqa: BLE001
        pass
    try:
        from orchestrator.executor import run_agent  # noqa: PLC0415
        task = instructions or (
            "Draft a reply to the email below. First gather context: use "
            "remember() for the sender, and call_agent('sales' or 'task-manager') "
            "ONLY if the email is clearly about a deal or a project."
        )
        msg = (
            f"{task} Then write ONLY the message body — no subject line, no "
            "preamble, no '---' fences, no confidence line.\n\n"
            f"From: {email.get('from', '')}\nSubject: {email.get('subject', '')}\n"
            f"Body:\n{(email.get('body', '') or '')[:3000]}"
        )
        res = await asyncio.wait_for(
            run_agent(
                "email-assistant",
                {"message": msg, "about": about, "signature": signature,
                 "user_email": user_email},
            ),
            timeout=150.0,
        )
        ans = ""
        if isinstance(res, dict):
            ans = res.get("answer") or ""
            if not ans and isinstance(res.get("result"), dict):
                ans = res["result"].get("content") or ""
            if not ans and isinstance(res.get("result"), str):
                ans = res["result"]
        ans = _strip_draft_markers(ans)
        if ans:
            if signature.strip() and signature.strip() not in ans:
                ans = f"{ans}\n\n{signature}"
            return ans
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.maf_draft_failed", error=str(exc)[:200])
    return None


_FOLLOW_UP_INSTRUCTION = (
    "This is my OWN earlier email that hasn't received a reply yet. Write a "
    "brief, polite follow-up that nudges for a response — keep it short, "
    "reference the original subject, and do NOT repeat the full original message."
)


async def _agent_draft_reply(
    email: dict[str, str], about: str, signature: str, user_email: str,
    *, use_agent: bool = False, max_agents: int = 2, agent_timeout: float = 90.0,
    follow_up: bool = False,
) -> str:
    """Draft a reply (or a follow-up nudge). When ``use_agent`` is set (background
    rule actions), run the email-assistant MAF agent first; otherwise — and on any
    agent failure — use the fast in-gateway orchestrator."""
    instructions = _FOLLOW_UP_INSTRUCTION if follow_up else ""
    if use_agent:
        drafted = await _draft_via_maf_agent(
            email, about, signature, user_email, instructions=instructions,
        )
        if drafted:
            return drafted
    return await _orchestrate_draft(
        email, about, signature, user_email,
        max_agents=max_agents, agent_timeout=agent_timeout,
        instructions=instructions,
    )


async def _orchestrate_draft(
    email: dict[str, str], about: str, signature: str, user_email: str,
    *, max_agents: int = 2, agent_timeout: float = 90.0, instructions: str = "",
) -> str:
    """In-gateway orchestrating drafter: gather context from memory + specialist
    agents (sales / task-manager), then draft. Best-effort; degrades to an
    About-only draft."""
    context_parts: list[str] = []

    # 1) Memory: what do we know about this sender / relationship?
    try:
        from acb_skills.memory_tools import (  # noqa: PLC0415
            _set_memory_user_id, remember,
        )
        _set_memory_user_id(user_email or "")
        mem = await remember(
            f"past context, agreements, and preferences relevant to "
            f"{email.get('from', '')} and: {email.get('subject', '')}"
        )
        if mem and "no relevant" not in mem.lower():
            context_parts.append(f"From memory:\n{mem[:1500]}")
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.draft_memory_failed", error=str(exc)[:160])

    # 2) Specialist agents: delegate via the orchestrator's run_agent.
    plan = await _draft_consult_plan(email)
    if plan:
        try:
            from orchestrator.executor import run_agent  # noqa: PLC0415
            for item in plan[:max_agents]:
                try:
                    res = await asyncio.wait_for(
                        run_agent(
                            item["agent"],
                            {"message": item["question"], "user_email": user_email},
                        ),
                        timeout=agent_timeout,
                    )
                    ans = ""
                    if isinstance(res, dict):
                        ans = str(res.get("answer") or res.get("result") or "")
                    if ans.strip():
                        context_parts.append(
                            f"From the {item['agent']} agent "
                            f"(asked: {item['question']}):\n{ans[:1500]}"
                        )
                except Exception as exc:  # noqa: BLE001
                    _log.warning("email.draft_agent_failed",
                                 agent=item.get("agent"), error=str(exc)[:160])
        except Exception as exc:  # noqa: BLE001
            _log.warning("email.draft_orchestrator_unavailable", error=str(exc)[:160])

    draft = await _llm_draft_reply(
        email, about, signature, instructions=instructions,
        context="\n\n".join(context_parts),
    )

    # 3) Record the interaction so future drafts have more context.
    try:
        from acb_memory import add_episode  # noqa: PLC0415
        await add_episode(
            name=f"email-draft:{(user_email or 'user')[:24]}",
            content=(
                f"Drafted a reply to {email.get('from', '')} regarding "
                f"'{email.get('subject', '')}'."
            ),
            source_description="email-reply-drafter",
            group_id=user_email or "default",
        )
    except Exception:  # noqa: BLE001
        pass

    return draft


async def _run_rules_job(
    account_id: str, limit: int, dry_run: bool, user_email: str
) -> None:
    """Background worker: match UNPROCESSED inbox mail to rules and log/apply.

    Live runs (dry_run=False) apply the actions of *automated* rules and mark the
    message processed; matched non-automated rules are logged PENDING for
    approval. Dry runs only log PENDING and never mark messages processed.
    """
    db = await _get_db()
    try:
        rows = (await db.execute(text(
            """SELECT em.id, em.provider_message_id, em.thread_id, em.subject,
                      em.body_text, em.snippet, em.from_address
               FROM email_messages em
               WHERE em.account_id = :aid AND LOWER(em.folder) = 'inbox'
                 AND em.rules_processed_at IS NULL
               ORDER BY em.received_at DESC LIMIT :limit"""
        ), {"aid": account_id, "limit": limit})).fetchall()
        if not rows:
            return

        about, signature = await _load_assistant_about(db, account_id)
        owner_row = (await db.execute(text(
            "SELECT user_id FROM email_accounts WHERE id = :aid"
        ), {"aid": account_id})).fetchone()
        account_user = owner_row.user_id if owner_row else (user_email or "")
        cold_blocker = "OFF"
        cb_row = (await db.execute(text(
            "SELECT cold_email_blocker FROM email_assistant_settings "
            "WHERE account_id = :aid"
        ), {"aid": account_id})).fetchone()
        if cb_row and cb_row.cold_email_blocker:
            cold_blocker = cb_row.cold_email_blocker

        provider = None
        store = None
        if not dry_run:
            acc = (await db.execute(text(
                "SELECT provider, credentials_encrypted FROM email_accounts WHERE id = :id"
            ), {"id": account_id})).fetchone()
            if acc:
                from acb_llm.key_store import get_key_store
                store = get_key_store()
                creds = json.loads(store.decrypt(acc.credentials_encrypted))
                provider = _instantiate_provider(acc.provider, creds)
                if not await provider.authenticate():
                    provider = None

        for r in rows:
            frm = r.from_address if isinstance(r.from_address, dict) \
                else json.loads(r.from_address or "{}")
            email = {
                "subject": r.subject or "", "from": frm.get("email", ""),
                "body": r.body_text or r.snippet or "", "to": "",
                "thread_id": r.thread_id or "",
            }
            match = await _match_email_to_rule(db, account_id, email)
            if match:
                rule = match["rule"]
                automated = bool(rule.get("automated", True))
                apply = (not dry_run) and automated and provider is not None
                if apply:
                    actions_taken = await _apply_rule_actions(
                        db, provider, str(r.id), r.provider_message_id,
                        rule["actions"], email, about, signature, account_user,
                        account_id=account_id,
                    )
                    status = "APPLIED"
                else:
                    actions_taken = [a["type"] for a in rule["actions"]]
                    status = "PENDING"
                await db.execute(text(
                    """INSERT INTO email_executed_rules
                         (account_id, rule_id, rule_name, message_id,
                          provider_message_id, thread_id, subject, from_address,
                          status, automated, actions_taken, reason)
                       VALUES (:aid, :rid, :rname, :mid, :pmid, :tid, :subj, :frm,
                               :status, :auto, :acts, :reason)"""
                ), {"aid": account_id, "rid": rule["id"], "rname": rule["name"],
                    "mid": str(r.id), "pmid": r.provider_message_id,
                    "tid": r.thread_id, "subj": r.subject or "",
                    "frm": frm.get("email", ""), "status": status,
                    "auto": automated, "acts": json.dumps(actions_taken),
                    "reason": match["reason"]})
            elif (not dry_run) and provider is not None and cold_blocker != "OFF":
                # No rule matched — let the cold-email blocker have a look.
                await _maybe_block_cold(
                    db, provider, account_id, str(r.id),
                    r.provider_message_id, email, cold_blocker,
                )
            if not dry_run:
                await db.execute(text(
                    "UPDATE email_messages SET rules_processed_at = now() "
                    "WHERE id = :id"
                ), {"id": str(r.id)})
            await db.commit()

        if provider is not None and store is not None:
            await _persist_rotated_creds(db, store, account_id, provider)
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.run_rules_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()


async def _apply_rule_actions(
    db: Any, provider: Any, message_id: str, provider_msg_id: str,
    actions: list[dict[str, Any]], email: dict[str, str] | None = None,
    about: str = "", signature: str = "", user_email: str = "",
    account_id: str = "",
) -> list[str]:
    """Apply a rule's actions. Reply/forward/draft create provider DRAFTS (never
    auto-send) so a misfiring rule can't email anyone without review."""
    email = email or {}
    done: list[str] = []
    for a in actions:
        t = a.get("type")
        try:
            if t == "ARCHIVE":
                await db.execute(text("UPDATE email_messages SET folder='archive', updated_at=now() WHERE id=:id"), {"id": message_id})
                await provider.move_to_folder(provider_msg_id, "archive")
            elif t == "TRASH":
                await db.execute(text("UPDATE email_messages SET folder='trash', updated_at=now() WHERE id=:id"), {"id": message_id})
                await provider.trash_message(provider_msg_id)
            elif t == "MARK_SPAM":
                await db.execute(text("UPDATE email_messages SET folder='junk', updated_at=now() WHERE id=:id"), {"id": message_id})
                await provider.move_to_folder(provider_msg_id, "junk")
            elif t == "MARK_READ":
                await db.execute(text("UPDATE email_messages SET is_read=true, updated_at=now() WHERE id=:id"), {"id": message_id})
                await provider.apply_flags(provider_msg_id, is_read=True)
            elif t == "STAR":
                await db.execute(text("UPDATE email_messages SET is_starred=true, updated_at=now() WHERE id=:id"), {"id": message_id})
                await provider.apply_flags(provider_msg_id, is_starred=True)
            elif t == "MOVE_FOLDER" and a.get("label"):
                await db.execute(text("UPDATE email_messages SET folder=:f, updated_at=now() WHERE id=:id"), {"id": message_id, "f": a["label"].lower()})
                await provider.move_to_folder(provider_msg_id, a["label"].lower())
            elif t == "LABEL" and a.get("label"):
                await provider.set_labels(provider_msg_id, add=[a["label"]], remove=[])
            elif t in ("REPLY", "DRAFT_EMAIL"):
                tmpl = (a.get("content") or "").strip()
                # Static template wins; otherwise the orchestrating drafter
                # (memory + sales/task-manager) writes a context-aware reply.
                body = tmpl if tmpl else await _agent_draft_reply(
                    email, about, signature, user_email, use_agent=True,
                )
                subj = a.get("subject") or f"Re: {email.get('subject', '')}"
                to = a.get("to_address") or email.get("from", "")
                if not to:
                    continue
                await provider.create_draft(
                    to=[to], subject=subj, body_text=body,
                    reply_to_message_id=provider_msg_id,
                    thread_id=email.get("thread_id") or None,
                )
                # AI-written (non-template) drafts: remember for edit-learning.
                if not tmpl and account_id:
                    await _store_ai_draft(
                        db, account_id, email.get("thread_id") or "", body)
            elif t == "FORWARD" and a.get("to_address"):
                note = (a.get("content") or "").strip()
                fwd = (
                    f"{note}\n\n" if note else ""
                ) + (
                    "---------- Forwarded message ----------\n"
                    f"From: {email.get('from', '')}\n"
                    f"Subject: {email.get('subject', '')}\n\n"
                    f"{(email.get('body', '') or '')[:4000]}"
                )
                await provider.create_draft(
                    to=[a["to_address"]],
                    subject=a.get("subject") or f"Fwd: {email.get('subject', '')}",
                    body_text=fwd,
                )
            elif t == "CALL_WEBHOOK" and a.get("url"):
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(a["url"], json={"message_id": message_id})
            else:
                continue
            done.append(t)
        except Exception as exc:  # noqa: BLE001
            _log.warning("email.rule_action_failed", action=t, error=str(exc)[:120])
    return done


# ── Assistant: per-account settings ─────────────────────────────────────────

class AssistantSettingsModel(BaseModel):
    account_id: str
    about: str | None = None
    signature: str | None = None
    auto_run: bool = False
    cold_email_blocker: str = "OFF"  # OFF | LABEL | ARCHIVE
    agent_model: str = "tier-balanced"  # tier-fast | tier-balanced | tier-powerful
    digest_frequency: str = "OFF"  # OFF | DAILY | WEEKLY
    personal_instructions: str | None = None
    writing_style: str | None = None
    draft_replies: bool = True
    follow_up_days: int = 0  # 0 = off; remind on awaiting threads older than N


@router.get("/assistant/settings")
async def get_assistant_settings(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """Get the assistant's About/signature/auto-run settings for an account."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        row = (await db.execute(text(
            """SELECT about, signature, auto_run, cold_email_blocker, agent_model,
                      digest_frequency, personal_instructions, writing_style,
                      draft_replies, follow_up_days
               FROM email_assistant_settings WHERE account_id = :aid"""
        ), {"aid": account_id})).fetchone()
        return {
            "account_id": account_id,
            "about": row.about if row else "",
            "signature": row.signature if row else "",
            "auto_run": bool(row.auto_run) if row else False,
            "cold_email_blocker": (row.cold_email_blocker if row else "OFF") or "OFF",
            "agent_model": (row.agent_model if row else "tier-balanced")
            or "tier-balanced",
            "digest_frequency": (row.digest_frequency if row else "OFF") or "OFF",
            "personal_instructions": (
                getattr(row, "personal_instructions", None) if row else ""
            ) or "",
            "writing_style": (
                getattr(row, "writing_style", None) if row else ""
            ) or "",
            "draft_replies": (
                bool(row.draft_replies) if row and row.draft_replies is not None
                else True
            ),
            "follow_up_days": (
                getattr(row, "follow_up_days", 0) if row else 0
            ) or 0,
        }
    finally:
        await db.close()


@router.put("/assistant/settings")
async def put_assistant_settings(
    req: AssistantSettingsModel,
    user: UserContext = Depends(get_current_user),
):
    """Upsert the assistant settings for an account."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        await db.execute(text(
            """INSERT INTO email_assistant_settings
                 (account_id, about, signature, auto_run, cold_email_blocker,
                  agent_model, digest_frequency, personal_instructions,
                  writing_style, draft_replies, follow_up_days, updated_at)
               VALUES (:aid, :about, :sig, :auto, :cold, :model, :digest,
                       :pi, :ws, :dr, :fu, now())
               ON CONFLICT (account_id) DO UPDATE SET
                 about = EXCLUDED.about,
                 signature = EXCLUDED.signature,
                 auto_run = EXCLUDED.auto_run,
                 cold_email_blocker = EXCLUDED.cold_email_blocker,
                 agent_model = EXCLUDED.agent_model,
                 digest_frequency = EXCLUDED.digest_frequency,
                 personal_instructions = EXCLUDED.personal_instructions,
                 writing_style = EXCLUDED.writing_style,
                 draft_replies = EXCLUDED.draft_replies,
                 follow_up_days = EXCLUDED.follow_up_days,
                 updated_at = now()"""
        ), {"aid": req.account_id, "about": req.about, "sig": req.signature,
            "auto": req.auto_run, "cold": req.cold_email_blocker or "OFF",
            "model": req.agent_model or "tier-balanced",
            "digest": req.digest_frequency or "OFF",
            "pi": req.personal_instructions, "ws": req.writing_style,
            "dr": req.draft_replies, "fu": req.follow_up_days or 0})
        await db.commit()
        return {
            "account_id": req.account_id,
            "about": req.about or "",
            "signature": req.signature or "",
            "auto_run": req.auto_run,
            "cold_email_blocker": req.cold_email_blocker or "OFF",
            "agent_model": req.agent_model or "tier-balanced",
            "digest_frequency": req.digest_frequency or "OFF",
            "personal_instructions": req.personal_instructions or "",
            "writing_style": req.writing_style or "",
            "draft_replies": req.draft_replies,
            "follow_up_days": req.follow_up_days or 0,
        }
    finally:
        await db.close()


# ── Draft knowledge base ────────────────────────────────────────────────────

class KnowledgeModel(BaseModel):
    id: str | None = None
    account_id: str
    title: str
    content: str


@router.get("/knowledge")
async def list_knowledge(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """List the account's knowledge-base entries (used when drafting replies)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT id, title, content, updated_at FROM email_knowledge
               WHERE account_id = :aid ORDER BY updated_at DESC"""
        ), {"aid": account_id})).fetchall()
        return {"entries": [
            {"id": str(r.id), "account_id": account_id, "title": r.title,
             "content": r.content,
             "updated_at": r.updated_at.isoformat() if r.updated_at else None}
            for r in rows
        ]}
    finally:
        await db.close()


@router.post("/knowledge")
async def create_knowledge(
    req: KnowledgeModel,
    user: UserContext = Depends(get_current_user),
):
    """Add (or overwrite by title) a knowledge-base entry."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        kid = str(uuid4())
        await db.execute(text(
            """INSERT INTO email_knowledge (id, account_id, title, content)
               VALUES (:id, :aid, :title, :content)
               ON CONFLICT (account_id, title) DO UPDATE SET
                 content = EXCLUDED.content, updated_at = now()"""
        ), {"id": kid, "aid": req.account_id, "title": req.title,
            "content": req.content})
        await db.commit()
        return {"id": kid, "account_id": req.account_id, "title": req.title,
                "content": req.content}
    finally:
        await db.close()


@router.patch("/knowledge/{kid}")
async def update_knowledge(
    kid: str,
    req: KnowledgeModel,
    user: UserContext = Depends(get_current_user),
):
    """Edit a knowledge-base entry."""
    db = await _get_db()
    try:
        owner = (await db.execute(text(
            """SELECT ek.id FROM email_knowledge ek
               JOIN email_accounts ea ON ek.account_id = ea.id
               WHERE ek.id = :id AND ea.user_id = :uid"""
        ), {"id": kid, "uid": user.email or "anonymous"})).fetchone()
        if not owner:
            raise HTTPException(status_code=404, detail="Not found")
        await db.execute(text(
            """UPDATE email_knowledge SET title = :title, content = :content,
                      updated_at = now() WHERE id = :id"""
        ), {"id": kid, "title": req.title, "content": req.content})
        await db.commit()
        return {"id": kid, "account_id": req.account_id, "title": req.title,
                "content": req.content}
    finally:
        await db.close()


@router.delete("/knowledge/{kid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_knowledge(
    kid: str,
    user: UserContext = Depends(get_current_user),
):
    """Delete a knowledge-base entry."""
    db = await _get_db()
    try:
        res = await db.execute(text(
            """DELETE FROM email_knowledge ek USING email_accounts ea
               WHERE ek.id = :id AND ek.account_id = ea.id
                 AND ea.user_id = :uid"""
        ), {"id": kid, "uid": user.email or "anonymous"})
        await db.commit()
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Not found")
    finally:
        await db.close()


async def _llm_writing_style(samples: list[str]) -> str:
    """Summarize the user's writing style from sample sent emails."""
    try:
        import litellm as _litellm  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        from acb_llm.client import ensure_model_registered, _TIER_MODEL  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)
        joined = "\n\n---\n\n".join(samples)
        sys_prompt = (
            "Analyze the user's sent emails and describe their writing style as a "
            "short, reusable style guide (4-6 bullet points). Cover typical "
            "length, greeting/sign-off habits, formality, sentence style, and any "
            "distinctive traits. Phrase each point as an instruction a writer "
            "could follow, e.g. 'Keep replies to 2-3 short sentences.' Output ONLY "
            "the guide."
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": joined[:8000]}],
            temperature=0, max_tokens=400,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.writing_style_failed", error=str(exc)[:200])
        return ""


@router.post("/assistant/writing-style/generate")
async def generate_writing_style(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """Derive a writing-style guide from the account's recent sent mail + save it."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT body_text FROM email_messages
               WHERE account_id = :aid AND LOWER(folder) = 'sent'
               ORDER BY received_at DESC LIMIT 25"""
        ), {"aid": account_id})).fetchall()
        samples = [
            (r.body_text or "").strip()[:1200]
            for r in rows if (r.body_text or "").strip()
        ][:15]
        if not samples:
            raise HTTPException(
                status_code=400, detail="No sent emails to analyze yet.")
        style = await _llm_writing_style(samples)
        if not style:
            raise HTTPException(
                status_code=502, detail="Could not derive a writing style.")
        await db.execute(text(
            """INSERT INTO email_assistant_settings
                 (account_id, writing_style, updated_at)
               VALUES (:aid, :ws, now())
               ON CONFLICT (account_id) DO UPDATE SET
                 writing_style = EXCLUDED.writing_style, updated_at = now()"""
        ), {"aid": account_id, "ws": style})
        await db.commit()
        return {"writing_style": style}
    finally:
        await db.close()


@router.get("/learned-patterns")
async def list_learned_patterns(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """Preferences the assistant has learned from the user's draft edits."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT id, pattern, weight FROM email_learned_patterns
               WHERE account_id = :aid
               ORDER BY weight DESC, updated_at DESC"""
        ), {"aid": account_id})).fetchall()
        return {"patterns": [
            {"id": str(r.id), "pattern": r.pattern, "weight": r.weight}
            for r in rows
        ]}
    finally:
        await db.close()


@router.delete("/learned-patterns/{pid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_learned_pattern(
    pid: str,
    user: UserContext = Depends(get_current_user),
):
    """Forget a learned preference."""
    db = await _get_db()
    try:
        res = await db.execute(text(
            """DELETE FROM email_learned_patterns lp USING email_accounts ea
               WHERE lp.id = :id AND lp.account_id = ea.id
                 AND ea.user_id = :uid"""
        ), {"id": pid, "uid": user.email or "anonymous"})
        await db.commit()
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Not found")
    finally:
        await db.close()


# ══════════════════════════════════════════════════════════════════════════
# Sender categorization · Cold-email blocker · Reply Zero
# ══════════════════════════════════════════════════════════════════════════

EMAIL_CATEGORIES = [
    "Newsletter", "Marketing", "Receipt", "Calendar", "Notification",
    "Cold Email", "Personal", "Support", "Unknown",
]


async def _llm_categorize_senders(
    items: list[dict[str, Any]]
) -> dict[str, str]:
    """Categorize a batch of senders. items: [{email, name, subjects}].

    Returns {email: category}; empty dict on LLM failure (callers default to
    'Unknown').
    """
    if not items:
        return {}
    try:
        import litellm as _litellm  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        from acb_llm.client import ensure_model_registered, _TIER_MODEL  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)
        listing = "\n".join(
            f"{i}. {it.get('name') or ''} <{it['email']}> — subjects: "
            f"{'; '.join((it.get('subjects') or [])[:3])}"
            for i, it in enumerate(items)
        )
        sys_prompt = (
            "Classify each email sender into exactly one category from: "
            f"{', '.join(EMAIL_CATEGORIES)}. Use the sender address and recent "
            "subjects. Respond with ONLY a JSON array of "
            '{"index": <n>, "category": "<one category>"}.'
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": listing}],
            temperature=0, max_tokens=800,
        )
        data = _safe_json(resp.choices[0].message.content or "")
        out: dict[str, str] = {}
        if isinstance(data, list):
            for d in data:
                idx = d.get("index") if isinstance(d, dict) else None
                cat = d.get("category") if isinstance(d, dict) else None
                if isinstance(idx, int) and 0 <= idx < len(items) \
                        and cat in EMAIL_CATEGORIES:
                    out[items[idx]["email"]] = cat
        return out
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.categorize_failed", error=str(exc)[:200])
        return {}


async def _categorize_senders_job(account_id: str, limit: int) -> None:
    """Background: assign categories to the account's busiest uncategorized senders."""
    db = await _get_db()
    try:
        rows = (await db.execute(text(
            """SELECT LOWER(from_address->>'email') AS email,
                      MAX(from_address->>'name') AS name,
                      (array_agg(subject ORDER BY received_at DESC))[1:3] AS subjects
               FROM email_messages
               WHERE account_id = :aid
                 AND COALESCE(from_address->>'email','') <> ''
                 AND LOWER(from_address->>'email') NOT IN (
                   SELECT email FROM email_senders
                   WHERE account_id = :aid AND category IS NOT NULL)
               GROUP BY LOWER(from_address->>'email')
               ORDER BY COUNT(*) DESC LIMIT :limit"""
        ), {"aid": account_id, "limit": limit})).fetchall()
        items = [
            {"email": r.email, "name": r.name or "",
             "subjects": [s for s in (r.subjects or []) if s]}
            for r in rows
        ]
        for i in range(0, len(items), 10):
            batch = items[i:i + 10]
            cats = await _llm_categorize_senders(batch)
            for it in batch:
                await db.execute(text(
                    """INSERT INTO email_senders
                         (account_id, email, name, category, categorized_at)
                       VALUES (:aid, :email, :name, :cat, now())
                       ON CONFLICT (account_id, email) DO UPDATE SET
                         name = COALESCE(EXCLUDED.name, email_senders.name),
                         category = EXCLUDED.category,
                         categorized_at = now(), updated_at = now()"""
                ), {"aid": account_id, "email": it["email"], "name": it["name"],
                    "cat": cats.get(it["email"], "Unknown")})
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.categorize_job_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()


class CategorizeRequest(BaseModel):
    account_id: str
    limit: int = 60


@router.post("/senders/categorize")
async def categorize_senders(
    req: CategorizeRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Schedule LLM categorization of the account's senders (background)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
    finally:
        await db.close()
    background.add_task(_categorize_senders_job, req.account_id, min(req.limit, 300))
    return {"scheduled": True}


@router.get("/senders/categories")
async def sender_categories(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """List the category vocabulary + per-category sender counts."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT category, COUNT(*) AS c FROM email_senders
               WHERE account_id = :aid AND category IS NOT NULL
               GROUP BY category"""
        ), {"aid": account_id})).fetchall()
        return {
            "categories": EMAIL_CATEGORIES,
            "counts": {r.category: r.c for r in rows},
        }
    finally:
        await db.close()


# ── Cold-email blocker ───────────────────────────────────────────────────────

async def _llm_is_cold(email: dict[str, str]) -> tuple[bool, str]:
    """Classify whether an email is cold outreach. (is_cold, reason)."""
    try:
        import litellm as _litellm  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        from acb_llm.client import ensure_model_registered, _TIER_MODEL  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)
        sys_prompt = (
            "Decide if this is a COLD email: unsolicited sales, marketing, or "
            "recruiting outreach from someone with no prior relationship to the "
            'recipient. Respond ONLY JSON {"cold": <bool>, "reason": "<short>"}.'
        )
        user_prompt = (
            f"From: {email.get('from', '')}\nSubject: {email.get('subject', '')}\n"
            f"Body:\n{(email.get('body', '') or '')[:1500]}"
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0, max_tokens=200,
        )
        data = _safe_json(resp.choices[0].message.content or "")
        if isinstance(data, dict):
            return bool(data.get("cold")), str(data.get("reason", ""))[:300]
        return False, ""
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.cold_classify_failed", error=str(exc)[:200])
        return False, ""


async def _maybe_block_cold(
    db: Any, provider: Any, account_id: str, message_id: str,
    provider_msg_id: str, email: dict[str, str], blocker: str,
) -> None:
    """Cold-email gate: for a first-time, non-whitelisted sender, LLM-classify
    and (if cold) label/archive + record. Runs only when no rule matched."""
    sender = (email.get("from") or "").lower()
    if not sender:
        return
    # Already known to the cold-sender table (flagged or whitelisted) → skip.
    seen = (await db.execute(text(
        "SELECT status FROM email_cold_senders "
        "WHERE account_id = :aid AND from_email = :e"
    ), {"aid": account_id, "e": sender})).fetchone()
    if seen:
        return
    # Replied-to / known sender (we've emailed them) → not cold.
    replied = (await db.execute(text(
        """SELECT 1 FROM email_messages
           WHERE account_id = :aid AND LOWER(folder) = 'sent'
             AND to_addresses @> :tojson LIMIT 1"""
    ), {"aid": account_id, "tojson": json.dumps([{"email": sender}])})).fetchone()
    if replied:
        return
    is_cold, reason = await _llm_is_cold(email)
    if not is_cold:
        return
    await db.execute(text(
        """INSERT INTO email_cold_senders (account_id, from_email, status, reason)
           VALUES (:aid, :e, 'AI_LABELED_COLD', :reason)
           ON CONFLICT (account_id, from_email) DO NOTHING"""
    ), {"aid": account_id, "e": sender, "reason": reason})
    actions: list[str] = []
    try:
        if blocker == "ARCHIVE":
            await db.execute(text(
                "UPDATE email_messages SET folder='archive', updated_at=now() "
                "WHERE id=:id"), {"id": message_id})
            await provider.move_to_folder(provider_msg_id, "archive")
            actions = ["ARCHIVE", "LABEL"]
        else:
            actions = ["LABEL"]
        await provider.set_labels(provider_msg_id, add=["Cold Email"], remove=[])
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.cold_action_failed", error=str(exc)[:120])
    await db.execute(text(
        """INSERT INTO email_executed_rules
             (account_id, rule_id, rule_name, message_id, provider_message_id,
              subject, from_address, status, automated, actions_taken, reason)
           VALUES (:aid, NULL, 'Cold Email Blocker', :mid, :pmid, :subj, :frm,
                   'APPLIED', true, :acts, :reason)"""
    ), {"aid": account_id, "mid": message_id, "pmid": provider_msg_id,
        "subj": email.get("subject", ""), "frm": sender,
        "acts": json.dumps(actions), "reason": reason})


class ColdSenderUpdate(BaseModel):
    account_id: str
    from_email: str
    status: str  # AI_LABELED_COLD | USER_REJECTED_COLD


@router.get("/cold-senders")
async def list_cold_senders(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """List cold-email verdicts (flagged + whitelisted) for an account."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT from_email, status, reason, updated_at
               FROM email_cold_senders WHERE account_id = :aid
               ORDER BY updated_at DESC LIMIT 500"""
        ), {"aid": account_id})).fetchall()
        return {
            "cold_senders": [
                {"from_email": r.from_email, "status": r.status,
                 "reason": r.reason,
                 "updated_at": r.updated_at.isoformat() if r.updated_at else None}
                for r in rows
            ]
        }
    finally:
        await db.close()


@router.post("/cold-senders")
async def upsert_cold_sender(
    req: ColdSenderUpdate,
    user: UserContext = Depends(get_current_user),
):
    """Set a sender's cold verdict — USER_REJECTED_COLD whitelists them."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        await db.execute(text(
            """INSERT INTO email_cold_senders
                 (account_id, from_email, status, updated_at)
               VALUES (:aid, LOWER(:e), :status, now())
               ON CONFLICT (account_id, from_email) DO UPDATE SET
                 status = EXCLUDED.status, updated_at = now()"""
        ), {"aid": req.account_id, "e": req.from_email, "status": req.status})
        await db.commit()
        return {"ok": True, "status": req.status}
    finally:
        await db.close()


# ── Reply Zero (reply tracking) ──────────────────────────────────────────────

def _addr_dict(raw: Any) -> dict:
    return raw if isinstance(raw, dict) else json.loads(raw or "{}")


async def _llm_needs_reply(items: list[dict[str, str]]) -> dict[int, dict[str, Any]]:
    """Classify which inbound emails actually need a personal reply.

    items: [{subject, from, body}]. Returns {index: {"needs": bool,
    "reason": str}}; empty on LLM failure (callers default to needs=True).
    """
    if not items:
        return {}
    try:
        import litellm as _litellm  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        from acb_llm.client import ensure_model_registered, _TIER_MODEL  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)
        listing = "\n\n".join(
            f"{i}. From: {it['from']}\nSubject: {it['subject']}\n"
            f"Body: {(it['body'] or '')[:800]}"
            for i, it in enumerate(items)
        )
        sys_prompt = (
            "For each email decide if it NEEDS a personal reply from the "
            "recipient — a real person asking a question, making a request, or "
            "expecting a response — versus FYI / automated / no-action mail "
            "(newsletters, notifications, receipts, marketing, confirmations, "
            "calendar invites). Respond ONLY with a JSON array of "
            '{"index": <n>, "needs_reply": <bool>, "reason": "<short why>"}.'
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": listing}],
            temperature=0, max_tokens=700,
        )
        data = _safe_json(resp.choices[0].message.content or "")
        out: dict[int, dict[str, Any]] = {}
        if isinstance(data, list):
            for d in data:
                if not isinstance(d, dict):
                    continue
                idx = d.get("index")
                if isinstance(idx, int) and 0 <= idx < len(items):
                    out[idx] = {"needs": bool(d.get("needs_reply")),
                                "reason": str(d.get("reason", ""))[:200]}
        return out
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.needs_reply_failed", error=str(exc)[:200])
        return {}


async def _upsert_thread_status(
    db: Any, account_id: str, thread_id: str, status: str,
    msg_id: Any, msg_at: Any, reason: str,
) -> None:
    await db.execute(text(
        """INSERT INTO email_thread_status
             (account_id, thread_id, status, last_message_id, last_message_at,
              reason, classified_at)
           VALUES (:aid, :tid, :st, :mid, :mat, :reason, now())
           ON CONFLICT (account_id, thread_id) DO UPDATE SET
             status = EXCLUDED.status,
             last_message_id = EXCLUDED.last_message_id,
             last_message_at = EXCLUDED.last_message_at,
             reason = EXCLUDED.reason, classified_at = now()"""
    ), {"aid": account_id, "tid": thread_id, "st": status, "mid": msg_id,
        "mat": msg_at, "reason": reason})


async def _maybe_classify_threads(account_id: str) -> None:
    """Reply Zero: store a per-thread status (NEEDS_REPLY / FYI / AWAITING).

    Sent-last threads are AWAITING; inbound-last threads are AI-classified into
    NEEDS_REPLY vs FYI. Only re-classifies a thread when its latest message
    changed; caps the LLM work per cycle. Best-effort (never raises to caller)."""
    db = await _get_db()
    try:
        rows = (await db.execute(text(
            """WITH latest AS (
                 SELECT DISTINCT ON (thread_id) thread_id, id, subject,
                        from_address, body_text, snippet, folder, received_at
                 FROM email_messages
                 WHERE account_id = :aid AND thread_id IS NOT NULL
                   AND received_at > now() - interval '30 days'
                 ORDER BY thread_id, received_at DESC
               )
               SELECT * FROM latest ORDER BY received_at DESC LIMIT 200"""
        ), {"aid": account_id})).fetchall()
        if not rows:
            return
        existing = {
            r.thread_id: str(r.last_message_id)
            for r in (await db.execute(text(
                "SELECT thread_id, last_message_id FROM email_thread_status "
                "WHERE account_id = :aid"
            ), {"aid": account_id})).fetchall()
        }
        to_classify = []
        for r in rows:
            if existing.get(r.thread_id) == str(r.id):
                continue  # latest message unchanged → status still valid
            folder = (r.folder or "").lower()
            if folder == "sent":
                await _upsert_thread_status(
                    db, account_id, r.thread_id, "AWAITING", r.id,
                    r.received_at, "")
            elif folder == "inbox":
                to_classify.append(r)
        await db.commit()

        to_classify = to_classify[:25]  # cap LLM work per cycle
        for i in range(0, len(to_classify), 10):
            batch = to_classify[i:i + 10]
            items = [
                {"subject": r.subject or "",
                 "from": _addr_dict(r.from_address).get("email", ""),
                 "body": r.body_text or r.snippet or ""}
                for r in batch
            ]
            verdicts = await _llm_needs_reply(items)
            for j, r in enumerate(batch):
                v = verdicts.get(j, {"needs": True, "reason": ""})
                status = "NEEDS_REPLY" if v["needs"] else "FYI"
                await _upsert_thread_status(
                    db, account_id, r.thread_id, status, r.id,
                    r.received_at, v.get("reason", ""))
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.classify_threads_failed",
                     account_id=account_id, error=str(exc)[:200])
    finally:
        await db.close()


@router.get("/reply-zero")
async def reply_zero(
    account_id: str = Query(...),
    type: str = Query("needs_reply"),  # needs_reply | awaiting
    limit: int = Query(50, ge=1, le=200),
    user: UserContext = Depends(get_current_user),
):
    """Threads that need a reply or are awaiting one. Prefers the stored,
    AI-classified status (Reply Zero); falls back to the folder heuristic until
    the first classification pass has run."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        has_status = (await db.execute(text(
            "SELECT 1 FROM email_thread_status WHERE account_id = :aid LIMIT 1"
        ), {"aid": account_id})).fetchone() is not None

        if has_status:
            want = "AWAITING" if type == "awaiting" else "NEEDS_REPLY"
            rows = (await db.execute(text(
                """SELECT ts.thread_id, ts.reason, ts.last_message_at,
                          em.id, em.subject, em.from_address, em.is_read
                   FROM email_thread_status ts
                   JOIN email_messages em ON em.id = ts.last_message_id
                   WHERE ts.account_id = :aid AND ts.status = :st
                   ORDER BY ts.last_message_at DESC NULLS LAST LIMIT :limit"""
            ), {"aid": account_id, "st": want, "limit": limit})).fetchall()
            fu_days = 0
            if type == "awaiting":
                fu_row = (await db.execute(text(
                    "SELECT follow_up_days FROM email_assistant_settings "
                    "WHERE account_id = :aid"
                ), {"aid": account_id})).fetchone()
                fu_days = (fu_row.follow_up_days if fu_row else 0) or 0
            now = datetime.now(timezone.utc)
            out = []
            for r in rows:
                frm = _addr_dict(r.from_address)
                days = (now - r.last_message_at).days if r.last_message_at else None
                out.append({
                    "thread_id": r.thread_id, "message_id": str(r.id),
                    "subject": r.subject or "(no subject)",
                    "from": frm.get("name") or frm.get("email", ""),
                    "from_email": frm.get("email", ""),
                    "received_at": (
                        r.last_message_at.isoformat() if r.last_message_at else None
                    ),
                    "is_read": r.is_read, "reason": r.reason or "",
                    "awaiting_days": days,
                    "needs_follow_up": bool(
                        fu_days and days is not None and days >= fu_days),
                })
            return {"threads": out, "type": type}

        # Fallback: folder heuristic (before the first classification pass).
        folder = "sent" if type == "awaiting" else "inbox"
        rows = (await db.execute(text(
            """WITH latest AS (
                 SELECT DISTINCT ON (thread_id)
                        thread_id, id, subject, from_address, folder,
                        received_at, is_read
                 FROM email_messages
                 WHERE account_id = :aid AND thread_id IS NOT NULL
                 ORDER BY thread_id, received_at DESC
               )
               SELECT thread_id, id, subject, from_address, received_at, is_read
               FROM latest WHERE LOWER(folder) = :folder
               ORDER BY received_at DESC LIMIT :limit"""
        ), {"aid": account_id, "folder": folder, "limit": limit})).fetchall()
        out = []
        for r in rows:
            frm = _addr_dict(r.from_address)
            out.append({
                "thread_id": r.thread_id, "message_id": str(r.id),
                "subject": r.subject or "(no subject)",
                "from": frm.get("name") or frm.get("email", ""),
                "from_email": frm.get("email", ""),
                "received_at": r.received_at.isoformat() if r.received_at else None,
                "is_read": r.is_read, "reason": "",
                "awaiting_days": None, "needs_follow_up": False,
            })
        return {"threads": out, "type": type}
    finally:
        await db.close()


class DraftReplyRequest(BaseModel):
    account_id: str
    message_id: str
    create_draft: bool = False  # also save a provider draft (lands in Drafts)
    follow_up: bool = False  # draft a nudge for my own unanswered email instead


@router.post("/draft-reply")
async def draft_reply_smart(
    req: DraftReplyRequest,
    user: UserContext = Depends(get_current_user),
):
    """Draft a context-aware reply with the orchestrating drafter (memory +
    sales/task-manager). Returns the draft text; optionally also creates a
    provider draft in the user's Drafts."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        row = (await db.execute(text(
            """SELECT em.provider_message_id, em.thread_id, em.subject,
                      em.body_text, em.snippet, em.from_address
               FROM email_messages em
               WHERE em.id = :mid AND em.account_id = :aid"""
        ), {"mid": req.message_id, "aid": req.account_id})).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")
        frm = row.from_address if isinstance(row.from_address, dict) \
            else json.loads(row.from_address or "{}")
        email = {
            "subject": row.subject or "", "from": frm.get("email", ""),
            "body": row.body_text or row.snippet or "",
            "thread_id": row.thread_id or "",
        }
        about, signature = await _load_assistant_about(db, req.account_id)
        # Synchronous request → keep the orchestration budget under the proxy
        # timeout (one specialist agent, short timeout).
        draft = await _agent_draft_reply(
            email, about, signature, user.email or "",
            max_agents=1, agent_timeout=18.0, follow_up=req.follow_up,
        )

        # Remember this draft so we can learn from the user's edits on send.
        if not req.follow_up:
            await _store_ai_draft(db, req.account_id, email["thread_id"], draft)

        created = False
        if req.create_draft:
            try:
                provider, pmid, account_id, store = await _provider_for_message(
                    db, req.message_id, user.email or "anonymous"
                )
                if await provider.authenticate():
                    await provider.create_draft(
                        to=[email["from"]],
                        subject=f"Re: {email['subject']}",
                        body_text=draft,
                        reply_to_message_id=pmid,
                        thread_id=email["thread_id"] or None,
                    )
                    await _persist_rotated_creds(db, store, account_id, provider)
                    await db.commit()
                    created = True
            except Exception as exc:  # noqa: BLE001
                _log.warning("email.draft_reply_create_failed", error=str(exc)[:160])

        return {"draft": draft, "created": created}
    finally:
        await db.close()


# ── Digests ──────────────────────────────────────────────────────────────────

async def _generate_digest(db: Any, account_id: str, period_days: int) -> dict:
    """Build an inbox digest for the window: totals, category breakdown, top
    senders, and how many threads need a reply. Deterministic (no LLM)."""
    params: dict[str, Any] = {"aid": account_id, "days": period_days}
    win = ("em.account_id = :aid AND em.received_at >= "
           "now() - make_interval(days => :days)")

    totals = (await db.execute(text(
        f"""SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE is_read = false) AS unread,
                   COUNT(*) FILTER (WHERE LOWER(folder) = 'inbox') AS inbox,
                   COUNT(*) FILTER (WHERE has_attachments) AS attachments
            FROM email_messages em WHERE {win}"""
    ), params)).fetchone()

    cat_rows = (await db.execute(text(
        f"""SELECT COALESCE(s.category, 'Unknown') AS category, COUNT(*) AS c
            FROM email_messages em
            LEFT JOIN email_senders s
              ON s.account_id = em.account_id
             AND s.email = LOWER(em.from_address->>'email')
            WHERE {win} AND LOWER(em.folder) = 'inbox'
            GROUP BY 1 ORDER BY 2 DESC"""
    ), params)).fetchall()

    sender_rows = (await db.execute(text(
        f"""SELECT MAX(from_address->>'name') AS name,
                   LOWER(from_address->>'email') AS email, COUNT(*) AS c
            FROM email_messages em
            WHERE {win} AND LOWER(folder) = 'inbox'
              AND COALESCE(from_address->>'email','') <> ''
            GROUP BY 2 ORDER BY 3 DESC LIMIT 8"""
    ), params)).fetchall()

    needs = (await db.execute(text(
        """WITH latest AS (
             SELECT DISTINCT ON (thread_id) thread_id, folder
             FROM email_messages
             WHERE account_id = :aid AND thread_id IS NOT NULL
             ORDER BY thread_id, received_at DESC)
           SELECT COUNT(*) AS c FROM latest WHERE LOWER(folder) = 'inbox'"""
    ), {"aid": account_id})).scalar() or 0

    period = "day" if period_days <= 1 else ("week" if period_days <= 7 else f"{period_days} days")
    by_category = [{"category": r.category, "count": r.c} for r in cat_rows]
    top_senders = [
        {"name": r.name or r.email, "email": r.email, "count": r.c}
        for r in sender_rows
    ]

    lines = [
        f"# Inbox digest — last {period}",
        "",
        f"**{totals.inbox or 0}** new in inbox · **{totals.unread or 0}** unread · "
        f"**{needs}** threads awaiting your reply · "
        f"**{totals.attachments or 0}** with attachments",
        "",
        "## By category",
    ]
    lines += [f"- **{c['category']}**: {c['count']}" for c in by_category] or ["- (none)"]
    lines += ["", "## Top senders"]
    lines += [f"- {s['name']} — {s['count']}" for s in top_senders] or ["- (none)"]

    return {
        "period_days": period_days,
        "totals": {
            "inbox": totals.inbox or 0,
            "unread": totals.unread or 0,
            "attachments": totals.attachments or 0,
            "needs_reply": needs,
        },
        "by_category": by_category,
        "top_senders": top_senders,
        "markdown": "\n".join(lines),
    }


@router.get("/digest")
async def get_digest(
    account_id: str = Query(...),
    period: str = Query("day"),  # day | week
    user: UserContext = Depends(get_current_user),
):
    """Generate an inbox digest for the account (day or week window)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        days = 7 if period == "week" else 1
        return await _generate_digest(db, account_id, days)
    finally:
        await db.close()


class DigestSendRequest(BaseModel):
    account_id: str
    period: str = "day"


@router.post("/digest/send")
async def send_digest(
    req: DigestSendRequest,
    user: UserContext = Depends(get_current_user),
):
    """Generate the digest and email it to the account's own address."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        days = 7 if req.period == "week" else 1
        digest = await _generate_digest(db, req.account_id, days)
        acc = (await db.execute(text(
            "SELECT provider, credentials_encrypted, email_address "
            "FROM email_accounts WHERE id = :id"
        ), {"id": req.account_id})).fetchone()
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(acc.credentials_encrypted))
        provider = _instantiate_provider(acc.provider, creds)
        if not await provider.authenticate():
            raise HTTPException(status_code=502, detail="Provider auth failed")
        await provider.send_message(
            to=[acc.email_address],
            subject=f"📥 Your inbox digest — last {'week' if days > 1 else 'day'}",
            body_text=digest["markdown"],
        )
        await _persist_rotated_creds(db, store, req.account_id, provider)
        await db.execute(text(
            "UPDATE email_assistant_settings SET last_digest_at = now() "
            "WHERE account_id = :aid"
        ), {"aid": req.account_id})
        await db.commit()
        return {"sent": True, "to": acc.email_address}
    finally:
        await db.close()


async def _maybe_send_digest(account_id: str) -> None:
    """Background: send a digest if one is due per the account's frequency."""
    db = await _get_db()
    try:
        row = (await db.execute(text(
            "SELECT digest_frequency, last_digest_at FROM email_assistant_settings "
            "WHERE account_id = :aid"
        ), {"aid": account_id})).fetchone()
        if not row or (row.digest_frequency or "OFF") == "OFF":
            return
        period_days = 7 if row.digest_frequency == "WEEKLY" else 1
        # Compute due-ness from the already-fetched value (a bare SELECT of a
        # column with no FROM raises, so this can't be done in SQL here).
        last = row.last_digest_at
        due = last is None or last < (
            datetime.now(timezone.utc) - timedelta(days=period_days)
        )
        if not due:
            return
        digest = await _generate_digest(db, account_id, period_days)
        acc = (await db.execute(text(
            "SELECT provider, credentials_encrypted, email_address "
            "FROM email_accounts WHERE id = :id"
        ), {"id": account_id})).fetchone()
        if not acc:
            return
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(acc.credentials_encrypted))
        provider = _instantiate_provider(acc.provider, creds)
        if not await provider.authenticate():
            return
        await provider.send_message(
            to=[acc.email_address],
            subject=f"📥 Your inbox digest — last "
                    f"{'week' if period_days > 1 else 'day'}",
            body_text=digest["markdown"],
        )
        await _persist_rotated_creds(db, store, account_id, provider)
        await db.execute(text(
            "UPDATE email_assistant_settings SET last_digest_at = now() "
            "WHERE account_id = :aid"
        ), {"aid": account_id})
        await db.commit()
        _log.info("email.digest_sent", account_id=account_id)
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.digest_send_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()


# ── Push notifications (Microsoft Graph change subscriptions) ────────────────

async def _webhook_sync(account_id: str) -> None:
    """Triggered by a Graph notification: incremental sync + auto-run rules."""
    try:
        from email_ingestion.scheduler import (  # noqa: PLC0415
            _maybe_auto_run_rules, _sync_account,
        )
        res = await _sync_account(account_id)
        if isinstance(res, dict) and res.get("synced", 0):
            await _maybe_auto_run_rules(account_id)
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.webhook_sync_failed", account_id=account_id,
                     error=str(exc)[:200])


@router.api_route("/webhook/microsoft", methods=["GET", "POST"])
async def microsoft_webhook(request: Request, background: BackgroundTasks):
    """Public Microsoft Graph change-notification endpoint (no auth).

    Handles the validation handshake (echo validationToken) and incoming
    notifications (validate clientState → background incremental sync)."""
    token = request.query_params.get("validationToken")
    if token:
        return PlainTextResponse(content=token, status_code=200)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return PlainTextResponse("", status_code=202)
    notifications = body.get("value", []) if isinstance(body, dict) else []
    affected: set[str] = set()
    for n in notifications:
        if not isinstance(n, dict):
            continue
        sub_id = n.get("subscriptionId")
        client_state = n.get("clientState")
        if not sub_id:
            continue
        db = await _get_db()
        try:
            row = (await db.execute(text(
                "SELECT id, webhook_client_state FROM email_accounts "
                "WHERE webhook_subscription_id = :sid"
            ), {"sid": sub_id})).fetchone()
        finally:
            await db.close()
        if not row:
            continue
        if row.webhook_client_state and client_state != row.webhook_client_state:
            _log.warning("email.webhook_bad_client_state", sub=str(sub_id)[:12])
            continue
        affected.add(str(row.id))
    for aid in affected:
        background.add_task(_webhook_sync, aid)
    return PlainTextResponse("", status_code=202)


async def _ensure_subscription(account_id: str) -> None:
    """Create or renew the account's Graph push subscription (Microsoft only)."""
    public = (
        os.environ.get("GATEWAY_PUBLIC_URL", "")
        or getattr(get_settings(), "gateway_public_url", "")
    ).rstrip("/")
    if not public:
        return
    db = await _get_db()
    try:
        row = (await db.execute(text(
            """SELECT provider, credentials_encrypted, webhook_subscription_id,
                      webhook_client_state, webhook_expires_at
               FROM email_accounts WHERE id = :id"""
        ), {"id": account_id})).fetchone()
        if not row or row.provider != "microsoft":
            return
        now = datetime.now(timezone.utc)
        if (row.webhook_subscription_id and row.webhook_expires_at
                and row.webhook_expires_at > now + timedelta(hours=12)):
            return  # still valid, not expiring soon

        from acb_llm.key_store import get_key_store  # noqa: PLC0415
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))
        provider = _instantiate_provider("microsoft", creds)
        if not await provider.authenticate():
            return
        notify_url = f"{public}/email/webhook/microsoft"
        client_state = row.webhook_client_state or secrets.token_urlsafe(24)

        data = None
        sub_id = row.webhook_subscription_id
        if sub_id:
            try:
                data = await provider.renew_subscription(sub_id)
            except Exception:  # noqa: BLE001
                data = None
        if data is None:
            data = await provider.create_subscription(notify_url, client_state)
            sub_id = data.get("id")
        # Graph returns expirationDateTime as an ISO string; asyncpg needs a
        # real datetime for the TIMESTAMPTZ column.
        exp_raw = data.get("expirationDateTime")
        exp_dt = None
        if exp_raw:
            try:
                exp_dt = datetime.fromisoformat(
                    str(exp_raw).replace("Z", "+00:00")
                )
            except Exception:  # noqa: BLE001
                exp_dt = None
        await _persist_rotated_creds(db, store, account_id, provider)
        await db.execute(text(
            """UPDATE email_accounts
               SET webhook_subscription_id = :sid, webhook_client_state = :cs,
                   webhook_expires_at = :exp, updated_at = now()
               WHERE id = :id"""
        ), {"id": account_id, "sid": sub_id, "cs": client_state, "exp": exp_dt})
        await db.commit()
        _log.info("email.subscription_ready", account_id=account_id,
                  sub=str(sub_id)[:12], expires=exp_raw)
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.subscription_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()


# ── OAuth ────────────────────────────────────────────────────────────────

# In-memory state store (use Redis in production)
_oauth_states: dict[str, dict[str, str]] = {}


@router.get("/oauth/{provider}/authorize")
async def oauth_authorize(
    provider: str,
    user: UserContext = Depends(get_current_user),
    redirect_after: str = Query(default=""),
    user_email: str = Query(default=""),
):
    """Start OAuth flow for an email provider.

    Accepts an optional ``user_email`` query parameter so the workbench can
    pass the authenticated user's email when the browser navigates directly
    to the gateway (bypassing the Next.js proxy).  Falls back to the
    ``X-User-Email`` header (proxy path) or ``"anonymous"``.
    """
    state = secrets.token_urlsafe(32)
    redirect_uri = _build_redirect_uri(provider)

    if provider == "gmail":
        settings = get_settings()
        client_id = settings.gmail_oauth_client_id or os.environ.get("GMAIL_OAUTH_CLIENT_ID", "")
        if not client_id:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Gmail OAuth is not configured. Go to Integrations → APIs → "
                    "'Gmail OAuth' and enter your Google Cloud OAuth client ID "
                    "and secret. Instructions are provided there."
                ),
            )
        auth_url = (
            "https://accounts.google.com/o/oauth2/v2/auth"
            f"?client_id={client_id}"
            "&response_type=code"
            "&scope=https://mail.google.com/"
            f"&redirect_uri={redirect_uri}"
            f"&state={state}"
            "&access_type=offline"
            "&prompt=consent"
        )
    elif provider == "microsoft":
        settings = get_settings()
        # Prefer dedicated email OAuth creds; fall back to sign-in auth creds (shared app registration)
        client_id = (
            settings.msft_oauth_client_id
            or os.environ.get("MSFT_OAUTH_CLIENT_ID", "")
            or os.environ.get("AUTH_MICROSOFT_ENTRA_ID_ID", "")
        )
        # Tenant ID: use MICROSOFT_TENANT_ID (or AUTH_MICROSOFT_ENTRA_ID_TENANT /
        # AUTH_MICROSOFT_TENANT_ID) for single-tenant apps. Falls back to
        # 'common' for multi-tenant apps.
        tenant_id = (
            os.environ.get("MICROSOFT_TENANT_ID", "")
            or os.environ.get("AUTH_MICROSOFT_ENTRA_ID_TENANT", "")
            or os.environ.get("AUTH_MICROSOFT_TENANT_ID", "")
            or "common"
        )
        if not client_id:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Microsoft OAuth is not configured. Go to Integrations → APIs → "
                    "'Microsoft OAuth' and enter your Azure App client ID "
                    "and secret. Instructions are provided there."
                ),
            )
        auth_url = (
            f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize"
            f"?client_id={client_id}"
            "&response_type=code"
            "&scope=offline_access+https://graph.microsoft.com/Mail.ReadWrite"
            "+https://graph.microsoft.com/Mail.Send"
            "+https://graph.microsoft.com/User.Read"
            f"&redirect_uri={redirect_uri}"
            f"&state={state}"
        )
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown provider: {provider}"
        )

    _oauth_states[state] = {
        "provider": provider,
        "user_id": user_email or user.email or "anonymous",
        "redirect_after": redirect_after,
    }

    return RedirectResponse(auth_url, status_code=302)


@router.get("/oauth/{provider}/callback")
async def oauth_callback(
    provider: str,
    code: str = Query(...),
    state: str = Query(...),
):
    """Handle OAuth callback — exchange code for tokens and redirect to workbench."""
    gateway_public = os.environ.get("GATEWAY_PUBLIC_URL", "http://localhost:8000")
    workbench_url = os.environ.get("WORKBENCH_PUBLIC_URL")
    if not workbench_url:
        # Auto-derive workbench URL from gateway: replace "api." → "" for subdomain,
        # or swap :8000 → :3001 for local dev.
        if gateway_public == "http://localhost:8000":
            workbench_url = "http://localhost:3001"
        elif ".a" in gateway_public or "api." in gateway_public:
            workbench_url = gateway_public.replace("api.", "", 1)
        else:
            workbench_url = gateway_public

    # Build the workbench callback page URL
    callback_page = f"{workbench_url}/email/oauth/callback"

    # Validate state
    if state not in _oauth_states:
        return RedirectResponse(
            f"{callback_page}?{urlencode({'error': 'invalid_state'})}",
            status_code=302,
        )

    oauth_data = _oauth_states.pop(state)
    redirect_after = oauth_data.get("redirect_after", "")
    redirect_uri = _build_redirect_uri(provider)

    # Exchange code for tokens
    try:
        if provider == "gmail":
            token_data = await _exchange_gmail_token(code, redirect_uri)
        elif provider == "microsoft":
            token_data = await _exchange_msft_token(code, redirect_uri)
        else:
            return RedirectResponse(
                f"{callback_page}?{urlencode({'error': f'unknown_provider_{provider}'})}",
                status_code=302,
            )
    except Exception as exc:
        _log.error("Token exchange failed: %s", exc)
        return RedirectResponse(
            f"{callback_page}?{urlencode({'error': 'token_exchange_failed'})}",
            status_code=302,
        )

    # Get user email from provider
    try:
        user_email = await _get_provider_email(provider, token_data["access_token"])
    except Exception as exc:
        _log.error("Failed to get provider email: %s", exc)
        return RedirectResponse(
            f"{callback_page}?{urlencode({'error': 'email_fetch_failed'})}",
            status_code=302,
        )

    # Persist the OAuth *app* credentials (client_id/secret, tenant) alongside
    # the user's tokens.  Without these the provider cannot refresh the access
    # token once it expires (~1h) and all sync/folder/message calls start
    # failing with "authentication failed".
    token_data.update(_provider_oauth_app_creds(provider))

    # Store in encrypted DB
    from acb_llm.key_store import get_key_store
    store = get_key_store()
    creds_json = json.dumps(token_data)
    encrypted_creds = store.encrypt(creds_json)

    db = await _get_db()
    try:
        # Check if an account already exists for this user+email.  If so, this
        # is a *reconnect*: refresh the stored credentials in place rather than
        # rejecting as a duplicate (the old behaviour left users with no way to
        # repair an account whose refresh token had gone stale).  Resetting
        # last_history_id forces a full re-sync so messages persisted under the
        # old code path (e.g. raw provider folder IDs) get re-normalised.
        existing = await db.execute(
            text(
                """SELECT id FROM email_accounts
                   WHERE user_id = :user_id
                     AND provider = :provider
                     AND email_address = :email"""
            ),
            {
                "user_id": oauth_data["user_id"],
                "provider": provider,
                "email": user_email,
            },
        )
        existing_row = existing.fetchone()
        if existing_row:
            account_id = str(existing_row.id)
            await db.execute(
                text(
                    """UPDATE email_accounts
                       SET credentials_encrypted = :creds,
                           sync_status = 'idle',
                           sync_error = NULL,
                           last_history_id = NULL,
                           updated_at = now()
                       WHERE id = :id"""
                ),
                {"creds": encrypted_creds, "id": account_id},
            )
            await db.commit()
        else:
            # Create account
            result = await db.execute(
                text(
                    """INSERT INTO email_accounts
                       (id, user_id, provider, email_address, label,
                        avatar_color, credentials_encrypted)
                       VALUES (:id, :user_id, :provider, :email, :label,
                                :color, :creds)
                       RETURNING id"""
                ),
                {
                    "id": str(uuid4()),
                    "user_id": oauth_data["user_id"],
                    "provider": provider,
                    "email": user_email,
                    "label": _default_label(provider),
                    "color": "#6366f1",
                    "creds": encrypted_creds,
                },
            )
            await db.commit()
            account_id = str(result.fetchone()[0])

        # Start (or restart) background sync for the account
        try:
            from email_ingestion.scheduler import refresh_account_sync
            await refresh_account_sync(account_id)
        except Exception:
            pass

        # Success redirect
        params = {
            "account_id": account_id,
            "email": user_email,
            "provider": provider,
        }
        if redirect_after:
            params["redirect_after"] = redirect_after

        return RedirectResponse(
            f"{callback_page}?{urlencode(params)}",
            status_code=302,
        )
    finally:
        await db.close()


# ── OAuth helpers ────────────────────────────────────────────────────────

def _build_redirect_uri(provider: str) -> str:
    """Build the OAuth redirect URI."""
    base = os.environ.get(
        "GATEWAY_PUBLIC_URL",
        "http://localhost:8000",
    )
    return f"{base}/email/oauth/{provider}/callback"


def _provider_oauth_app_creds(provider: str) -> dict[str, str]:
    """Resolve the OAuth *app* credentials (client id/secret, tenant) for a provider.

    These must be stored alongside the user's tokens so the provider can refresh
    the access token later — Microsoft/Google access tokens expire in ~1 hour and
    a refresh requires the client_id/client_secret used at authorize time.
    """
    settings = get_settings()
    if provider == "gmail":
        return {
            "client_id": settings.gmail_oauth_client_id
            or os.environ.get("GMAIL_OAUTH_CLIENT_ID", ""),
            "client_secret": settings.gmail_oauth_client_secret
            or os.environ.get("GMAIL_OAUTH_CLIENT_SECRET", ""),
        }
    if provider == "microsoft":
        return {
            "client_id": settings.msft_oauth_client_id
            or os.environ.get("MSFT_OAUTH_CLIENT_ID", "")
            or os.environ.get("AUTH_MICROSOFT_ENTRA_ID_ID", ""),
            "client_secret": settings.msft_oauth_client_secret
            or os.environ.get("MSFT_OAUTH_CLIENT_SECRET", "")
            or os.environ.get("AUTH_MICROSOFT_ENTRA_ID_SECRET", ""),
            "tenant_id": os.environ.get("MICROSOFT_TENANT_ID", "")
            or os.environ.get("AUTH_MICROSOFT_ENTRA_ID_TENANT", "")
            or os.environ.get("AUTH_MICROSOFT_TENANT_ID", "")
            or "common",
        }
    return {}


async def _exchange_gmail_token(code: str, redirect_uri: str) -> dict[str, Any]:
    """Exchange authorization code for Gmail OAuth tokens."""
    settings = get_settings()
    client_id = settings.gmail_oauth_client_id or os.environ.get("GMAIL_OAUTH_CLIENT_ID", "")
    client_secret = settings.gmail_oauth_client_secret or os.environ.get("GMAIL_OAUTH_CLIENT_SECRET", "")
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def _exchange_msft_token(code: str, redirect_uri: str) -> dict[str, Any]:
    """Exchange authorization code for Microsoft OAuth tokens."""
    settings = get_settings()
    # Prefer dedicated email OAuth creds; fall back to sign-in auth creds (shared app registration)
    client_id = (
        settings.msft_oauth_client_id
        or os.environ.get("MSFT_OAUTH_CLIENT_ID", "")
        or os.environ.get("AUTH_MICROSOFT_ENTRA_ID_ID", "")
    )
    client_secret = (
        settings.msft_oauth_client_secret
        or os.environ.get("MSFT_OAUTH_CLIENT_SECRET", "")
        or os.environ.get("AUTH_MICROSOFT_ENTRA_ID_SECRET", "")
    )
    # Tenant ID: use MICROSOFT_TENANT_ID (or AUTH_MICROSOFT_ENTRA_ID_TENANT /
    # AUTH_MICROSOFT_TENANT_ID) for single-tenant apps. Falls back to
    # 'common' for multi-tenant apps.
    tenant_id = (
        os.environ.get("MICROSOFT_TENANT_ID", "")
        or os.environ.get("AUTH_MICROSOFT_ENTRA_ID_TENANT", "")
        or os.environ.get("AUTH_MICROSOFT_TENANT_ID", "")
        or "common"
    )
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def _get_provider_email(provider: str, access_token: str) -> str:
    """Get the authenticated user's email from the provider."""
    async with httpx.AsyncClient() as client:
        if provider == "gmail":
            resp = await client.get(
                "https://gmail.googleapis.com/gmail/v1/users/me/profile",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            resp.raise_for_status()
            return resp.json()["emailAddress"]
        elif provider == "microsoft":
            resp = await client.get(
                "https://graph.microsoft.com/v1.0/me",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            resp.raise_for_status()
            return resp.json().get("mail") or resp.json().get("userPrincipalName", "")
        raise ValueError(f"Unknown provider: {provider}")


def _default_label(provider: str) -> str:
    labels = {"gmail": "Gmail", "microsoft": "Outlook", "imap": "Email"}
    return labels.get(provider, "Email")


# ── Row → Model mapper ───────────────────────────────────────────────────

def _is_body_truncated(body_text: str, body_html: str) -> bool:
    """Check whether a stored message body was truncated at sync time."""
    if body_text and len(body_text.encode("utf-8", errors="replace")) >= MAX_BODY_TEXT_BYTES:
        return True
    if body_html and len(body_html.encode("utf-8", errors="replace")) >= MAX_BODY_HTML_BYTES:
        return True
    return False


def _row_to_message(row: Any) -> EmailMessageModel:
    """Convert a database row to an EmailMessageModel."""
    def _parse_jsonb(val: Any) -> Any:
        if val is None:
            return None
        if isinstance(val, str):
            return json.loads(val)
        return val

    def _parse_address_list(val: Any) -> list[EmailAddressModel]:
        data = _parse_jsonb(val) or []
        if isinstance(data, list):
            return [
                EmailAddressModel(
                    name=a.get("name", ""),
                    email=a.get("email", ""),
                )
                for a in data
            ]
        return []

    def _parse_address(val: Any) -> EmailAddressModel | None:
        data = _parse_jsonb(val)
        if data:
            return EmailAddressModel(
                name=data.get("name", ""),
                email=data.get("email", ""),
            )
        return None

    return EmailMessageModel(
        id=str(row.id),
        provider_message_id=row.provider_message_id,
        thread_id=row.thread_id,
        account_id=str(row.account_id),
        folder=row.folder,
        labels=list(row.labels) if row.labels else [],
        from_address=_parse_address(row.from_address),
        to_addresses=_parse_address_list(row.to_addresses),
        cc_addresses=_parse_address_list(row.cc_addresses),
        bcc_addresses=_parse_address_list(row.bcc_addresses),
        subject=row.subject or "",
        body_text=row.body_text or "",
        body_html=row.body_html,
        body_truncated=_is_body_truncated(
            row.body_text or "", row.body_html or ""
        ),
        snippet=row.snippet or "",
        has_attachments=row.has_attachments or False,
        attachments=[],  # populated by get_message endpoint
        is_read=row.is_read or False,
        is_starred=row.is_starred or False,
        is_flagged=row.is_flagged or False,
        importance=getattr(row, "importance", None) or "normal",
        categories=list(row.categories) if getattr(row, "categories", None) else [],
        received_at=row.received_at.isoformat() if row.received_at else None,
        synced_at=row.synced_at.isoformat() if row.synced_at else None,
    )


async def _upsert_message(db: Any, account_id: str, msg: Any) -> None:
    """Insert/update one normalized provider message into email_messages.

    Mirrors the persist logic in /sync; used by the on-demand history backfill.
    """
    await db.execute(
        text(
            """INSERT INTO email_messages
               (id, account_id, provider_message_id, thread_id,
                folder, labels, categories, importance,
                from_address, to_addresses,
                cc_addresses, bcc_addresses, subject,
                body_text, body_html, snippet,
                has_attachments, is_read, is_starred, is_flagged,
                unsubscribe_link, received_at, synced_at)
               VALUES
               (:id, :account_id, :provider_id, :thread_id,
                :folder, :labels, :categories, :importance,
                :from_addr, :to_addrs,
                :cc_addrs, :bcc_addrs, :subject,
                :body_text, :body_html, :snippet,
                :has_attachments, :is_read, :is_starred, :is_flagged,
                :unsubscribe_link, :received_at, now())
               ON CONFLICT (account_id, provider_message_id)
               DO UPDATE SET
                thread_id = EXCLUDED.thread_id,
                folder = EXCLUDED.folder,
                labels = EXCLUDED.labels,
                categories = EXCLUDED.categories,
                importance = EXCLUDED.importance,
                from_address = EXCLUDED.from_address,
                to_addresses = EXCLUDED.to_addresses,
                cc_addresses = EXCLUDED.cc_addresses,
                bcc_addresses = EXCLUDED.bcc_addresses,
                subject = EXCLUDED.subject,
                body_text = COALESCE(NULLIF(EXCLUDED.body_text, ''),
                                     email_messages.body_text),
                body_html = COALESCE(NULLIF(EXCLUDED.body_html, ''),
                                     email_messages.body_html),
                snippet = EXCLUDED.snippet,
                has_attachments = EXCLUDED.has_attachments,
                is_read = EXCLUDED.is_read,
                is_starred = EXCLUDED.is_starred,
                is_flagged = EXCLUDED.is_flagged,
                unsubscribe_link = COALESCE(
                    EXCLUDED.unsubscribe_link, email_messages.unsubscribe_link),
                received_at = EXCLUDED.received_at,
                updated_at = now()"""
        ),
        {
            "id": str(uuid4()),
            "account_id": account_id,
            "provider_id": msg.provider_message_id,
            "thread_id": msg.thread_id,
            "folder": msg.folder or "INBOX",
            "labels": msg.labels,
            "categories": getattr(msg, "categories", []) or [],
            "importance": getattr(msg, "importance", "normal") or "normal",
            "from_addr": json.dumps({
                "name": msg.from_address.name if msg.from_address else "",
                "email": msg.from_address.email if msg.from_address else "",
            }),
            "to_addrs": json.dumps(
                [{"name": a.name, "email": a.email} for a in msg.to_addresses]
            ),
            "cc_addrs": json.dumps(
                [{"name": a.name, "email": a.email} for a in msg.cc_addresses]
            ),
            "bcc_addrs": json.dumps(
                [{"name": a.name, "email": a.email} for a in msg.bcc_addresses]
            ),
            "subject": msg.subject,
            "body_text": _truncate_body(msg.body_text, MAX_BODY_TEXT_BYTES),
            "body_html": _truncate_body(msg.body_html, MAX_BODY_HTML_BYTES)
            if msg.body_html else None,
            "snippet": msg.snippet[:200] if msg.snippet else "",
            "has_attachments": msg.has_attachments,
            "is_read": msg.is_read,
            "is_starred": msg.is_starred,
            "is_flagged": msg.is_flagged,
            "unsubscribe_link": getattr(msg, "unsubscribe_link", None),
            "received_at": msg.received_at,
        },
    )
    for att in msg.attachments:
        await db.execute(
            text(
                """INSERT INTO email_attachments
                   (message_id, filename, mime_type, size_bytes,
                    provider_attachment_id)
                   VALUES (
                    (SELECT id FROM email_messages
                     WHERE account_id = :account_id
                       AND provider_message_id = :provider_id),
                    :filename, :mime_type, :size_bytes, :provider_attachment_id
                   )
                   ON CONFLICT DO NOTHING"""
            ),
            {
                "account_id": account_id,
                "provider_id": msg.provider_message_id,
                "filename": att.filename,
                "mime_type": att.mime_type,
                "size_bytes": att.size_bytes,
                "provider_attachment_id": att.provider_attachment_id,
            },
        )


async def _fetch_attachments(db: Any, message_id: str) -> list[AttachmentModel]:
    """Fetch attachment metadata for a message."""
    result = await db.execute(
        text(
            "SELECT id, filename, mime_type, size_bytes, download_url "
            "FROM email_attachments WHERE message_id = :mid ORDER BY filename"
        ),
        {"mid": message_id},
    )
    rows = result.fetchall()
    gateway_url = os.environ.get("GATEWAY_EXTERNAL_URL", "")
    return [
        AttachmentModel(
            id=str(r.id),
            filename=r.filename,
            mime_type=r.mime_type,
            size_bytes=r.size_bytes,
            download_url=f"{gateway_url}/email/attachments/{r.id}/download" if gateway_url else None,
        )
        for r in rows
    ]
