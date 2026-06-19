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

import json
import io
import os
import secrets
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import httpx
from acb_auth import UserContext, get_current_user
from acb_common import get_logger, get_settings
from urllib.parse import urlencode

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse, StreamingResponse
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
    labels: list[str] = []
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


async def _get_db(request_id: str | None = None):
    """Get an async database session."""
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

    settings = get_settings()
    db_url = os.environ.get(
        "DATABASE_URL",
        f"postgresql+asyncpg://{settings.postgres_user}:{settings.postgres_password}"
        f"@{settings.postgres_host}:{settings.postgres_port}/{settings.postgres_db}",
    )
    engine = create_async_engine(db_url, echo=False)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    return session_factory()


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
                          sync_enabled, sync_status, last_synced_at
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


# ── Messages ─────────────────────────────────────────────────────────────

@router.get("/messages")
async def list_messages(
    account_id: str | None = Query(None),
    folder: str = Query("INBOX"),
    query: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: UserContext = Depends(get_current_user),
):
    """List/search emails across accounts."""
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
        if folder:
            where_clauses.append("em.folder = :folder")
            params["folder"] = folder
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
                          em.received_at, em.synced_at
                   FROM email_messages em
                   JOIN email_accounts ea ON em.account_id = ea.id
                   WHERE {where_sql}
                   ORDER BY em.received_at DESC
                   LIMIT :limit OFFSET :offset"""
            ),
            params,
        )
        rows = result.fetchall()

        messages = [_row_to_message(row) for row in rows]

        return {
            "emails": [m.model_dump() for m in messages],
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

        # Return updated message
        return await get_message(message_id, user)
    finally:
        await db.close()


@router.delete("/messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_message(
    message_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Move email to trash."""
    db = await _get_db()
    try:
        result = await db.execute(
            text(
                """UPDATE email_messages SET folder = 'TRASH', updated_at = now()
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
    finally:
        await db.close()


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
                                folder, labels, from_address, to_addresses,
                                cc_addresses, bcc_addresses, subject,
                                body_text, body_html, snippet,
                                has_attachments, is_read, is_starred, is_flagged,
                                received_at, synced_at)
                               VALUES
                               (:id, :account_id, :provider_id, :thread_id,
                                :folder, :labels, :from_addr, :to_addrs,
                                :cc_addrs, :bcc_addrs, :subject,
                                :body_text, :body_html, :snippet,
                                :has_attachments, :is_read, :is_starred, :is_flagged,
                                :received_at, now())
                               ON CONFLICT (account_id, provider_message_id)
                               DO UPDATE SET
                                thread_id = EXCLUDED.thread_id,
                                folder = EXCLUDED.folder,
                                labels = EXCLUDED.labels,
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
    }

    # If an email is in context, fetch its full content for the agent
    if req.email_context_id:
        try:
            db = await _get_db()
            result = await db.execute(
                text(
                    """SELECT subject, body_text, from_address, received_at
                       FROM email_messages WHERE id = :id"""
                ),
                {"id": req.email_context_id},
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

    # ── Run the agent through the orchestrator ──
    from orchestrator.executor import run_agent_stream  # noqa: PLC0415

    agent_gen = run_agent_stream(
        "email-assistant",
        payload,
        run_id=run_id,
        thread_id=f"email-chat:{user_id}:{run_id}",
    )

    async def event_stream():
        """Translate AG-UI protocol events to frontend SSE format."""
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

    try:
        if req.action == "summarize":
            result = await agent_mod.search_emails(
                query="is:unread",
                folder="INBOX",
                account_id=req.account_id,
            )
        elif req.action == "find_urgent":
            result = await agent_mod.find_urgent(account_id=req.account_id)
        elif req.action == "draft_reply":
            if not req.email_id:
                raise HTTPException(
                    status_code=400,
                    detail="email_id is required for draft_reply",
                )
            result = await agent_mod.draft_reply(email_id=req.email_id)
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


# ── OAuth ────────────────────────────────────────────────────────────────

# In-memory state store (use Redis in production)
_oauth_states: dict[str, dict[str, str]] = {}


@router.get("/oauth/{provider}/authorize")
async def oauth_authorize(
    provider: str,
    user: UserContext = Depends(get_current_user),
    redirect_after: str = Query(default=""),
):
    """Start OAuth flow for an email provider."""
    state = secrets.token_urlsafe(32)
    redirect_uri = _build_redirect_uri(provider)

    if provider == "gmail":
        client_id = os.environ.get("GMAIL_OAUTH_CLIENT_ID", "")
        if not client_id:
            raise HTTPException(
                status_code=500,
                detail="GMAIL_OAUTH_CLIENT_ID not configured"
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
        client_id = os.environ.get("MSFT_OAUTH_CLIENT_ID", "")
        if not client_id:
            raise HTTPException(
                status_code=500,
                detail="MSFT_OAUTH_CLIENT_ID not configured"
            )
        auth_url = (
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
            f"?client_id={client_id}"
            "&response_type=code"
            "&scope=offline_access+https://graph.microsoft.com/Mail.ReadWrite"
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
        "user_id": user.email or "anonymous",
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
    workbench_url = os.environ.get(
        "WORKBENCH_PUBLIC_URL",
        os.environ.get("GATEWAY_PUBLIC_URL", "http://localhost:8000").replace(":8000", ":3001"),
    )

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

    # Store in encrypted DB
    from acb_llm.key_store import get_key_store
    store = get_key_store()
    creds_json = json.dumps(token_data)
    encrypted_creds = store.encrypt(creds_json)

    db = await _get_db()
    try:
        # Check if account already exists for this user+email
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
        if existing.fetchone():
            return RedirectResponse(
                f"{callback_page}?{urlencode({'error': 'duplicate', 'email': user_email, 'provider': provider})}",
                status_code=302,
            )

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

        # Start background sync for the new account
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


async def _exchange_gmail_token(code: str, redirect_uri: str) -> dict[str, Any]:
    """Exchange authorization code for Gmail OAuth tokens."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": os.environ.get("GMAIL_OAUTH_CLIENT_ID", ""),
                "client_secret": os.environ.get("GMAIL_OAUTH_CLIENT_SECRET", ""),
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def _exchange_msft_token(code: str, redirect_uri: str) -> dict[str, Any]:
    """Exchange authorization code for Microsoft OAuth tokens."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            data={
                "client_id": os.environ.get("MSFT_OAUTH_CLIENT_ID", ""),
                "client_secret": os.environ.get("MSFT_OAUTH_CLIENT_SECRET", ""),
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
        received_at=row.received_at.isoformat() if row.received_at else None,
        synced_at=row.synced_at.isoformat() if row.synced_at else None,
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
