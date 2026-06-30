"""Email routes — shared kernel.

The shared ``router``, Pydantic models, DB/Redis/provider infrastructure,
message row<->model mappers and small generic helpers used by BOTH the
transport and automation layers. This module depends on nothing inside the
package (it is the leaf), so importing it never pulls in a feature layer.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from acb_common import get_logger, get_settings
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

_log = get_logger("gateway.email")


router = APIRouter(prefix="/email", tags=["email"])


class EmailAddressModel(BaseModel):
    name: str = ""
    email: str


class AttachmentModel(BaseModel):
    id: str
    filename: str
    mime_type: str = "application/octet-stream"
    size_bytes: int | None = None
    download_url: str | None = None


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


async def _provider_for_account(db: Any, account_id: str, user_email: str):
    """Load the provider for an account (no specific message).

    Returns (provider, store, owner_email) or raises 404. Used by the draft
    write-path, which creates/updates/sends provider drafts that aren't tied to
    a single stored message. Persisting rotated creds is the caller's job.
    """
    row = (await db.execute(
        text(
            """SELECT provider, credentials_encrypted, email_address
               FROM email_accounts WHERE id = :id AND user_id = :uid"""
        ),
        {"id": account_id, "uid": user_email},
    )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Account not found")
    from acb_llm.key_store import get_key_store
    store = get_key_store()
    creds = json.loads(store.decrypt(row.credentials_encrypted))
    provider = _instantiate_provider(row.provider, creds)
    return provider, store, row.email_address


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


def _safe_json(content: str) -> Any | None:
    """Extract a JSON object/array from an LLM response.

    Tolerates ``` fences, leading prose, and trailing commentary. First tries a
    naive first-open→last-close slice; if that doesn't parse (e.g. prose contains
    a stray brace, or there's text after the JSON), falls back to a string-aware
    balanced-bracket scan that returns the first complete {...}/[...] span. Still
    returns None for genuinely truncated JSON (no matching close)."""
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
    # Fast path: trim to the last closing bracket and parse.
    end = max(s.rfind("}"), s.rfind("]"))
    if end >= 0:
        try:
            return json.loads(s[:end + 1])
        except Exception:  # noqa: BLE001 — fall through to the tolerant scan
            pass
    # Backstop: decode the first valid JSON value starting at any '{'/'[',
    # ignoring trailing text and stray braces in surrounding prose. Truncated
    # JSON (no matching close) still fails, returning None.
    decoder = json.JSONDecoder()
    for i, ch in enumerate(s):
        if ch in "{[":
            try:
                obj, _ = decoder.raw_decode(s, i)
                return obj
            except Exception:  # noqa: BLE001 — try the next opening bracket
                continue
    return None


def _fmt_addr_list(field: Any) -> str:
    """A JSONB ``[{name, email}]`` list → ``"Name <email>, …"`` for an LLM prompt
    (To/Cc rendering). Empty string when there are none. Mirrors the classifier's
    recipient formatter so every engine renders recipients identically."""
    try:
        items = field if isinstance(field, list) else json.loads(field or "[]")
    except Exception:  # noqa: BLE001
        return ""
    out: list[str] = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        em, nm = (it.get("email") or "").strip(), (it.get("name") or "").strip()
        if em and nm:
            out.append(f"{nm} <{em}>")
        elif em or nm:
            out.append(em or nm)
    return ", ".join(out)


async def _attachment_summaries(db: Any, message_ids: Any) -> dict[str, str]:
    """Batched: ``{str(message_id): "Attachments: invoice.pdf (application/pdf),
    q3.xlsx (…)"}`` for the messages that HAVE attachments. One query, so callers
    can enrich an LLM prompt with attachment metadata (filename + MIME) without an
    N+1. Empty dict on error / none — callers simply omit the line. Metadata only;
    extracting attachment TEXT (PDF/doc) is a separate, larger feature."""
    ids = [str(m) for m in (message_ids or []) if m]
    if not ids:
        return {}
    try:
        rows = (await db.execute(text(
            "SELECT message_id, filename, mime_type FROM email_attachments "
            "WHERE message_id::text = ANY(:ids) ORDER BY filename"
        ), {"ids": ids})).fetchall()
    except Exception:  # noqa: BLE001 — table optional / DB hiccup
        return {}
    by_msg: dict[str, list[str]] = {}
    for r in rows:
        name = (getattr(r, "filename", None) or "file").strip()
        mime = (getattr(r, "mime_type", None) or "").strip()
        mid = str(getattr(r, "message_id", "") or "")
        if mid:
            by_msg.setdefault(mid, []).append(
                f"{name} ({mime})" if mime else name)
    return {mid: "Attachments: " + ", ".join(p) for mid, p in by_msg.items()}


def _parse_iso_date(s: str | None, end_of_day: bool) -> datetime | None:
    """Parse a 'YYYY-MM-DD' string into a UTC datetime (or None)."""
    if not s:
        return None
    try:
        d = datetime.strptime(s.strip()[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        if end_of_day:
            d = d.replace(hour=23, minute=59, second=59)
        return d
    except (ValueError, TypeError):
        return None


def _date_range_clause(
    account_id: str, start: datetime | None, end: datetime | None,
    only_unread: bool = False,
) -> tuple[str, dict[str, Any]]:
    """SQL WHERE clause (+ params) for inbox mail in a received_at date range."""
    clause = "em.account_id = :aid AND LOWER(em.folder) = 'inbox'"
    params: dict[str, Any] = {"aid": account_id}
    if start is not None:
        clause += " AND em.received_at >= :start"
        params["start"] = start
    if end is not None:
        clause += " AND em.received_at <= :end"
        params["end"] = end
    if only_unread:
        clause += " AND em.is_read = false"
    return clause, params


def _default_label(provider: str) -> str:
    labels = {"gmail": "Gmail", "microsoft": "Outlook", "imap": "Email"}
    return labels.get(provider, "Email")


def email_memory_scope(user_email: str, account_id: str | None) -> str:
    """Namespace email-assistant Mem0 memory PER connected account.

    A user with several inboxes (work + personal) must not have one account's
    learned writing style / reply preferences leak into another's drafting.
    Mem0 keys by a single ``user_id`` string, so we fold the account id into it.

    CRITICAL: reads (``remember`` / ``get_memory_context``) and writes
    (``add_memories_background``) for a given account MUST both pass the value
    returned here, or retrieval silently misses. Falls back to the bare user
    email when no account is resolved (legacy / cross-account global scope).

    This is used ONLY for the gateway-side direct Mem0 calls. It is deliberately
    NOT pushed into the agent's memory ContextVar — the email-assistant reuses
    that same var as its ``X-User-Email`` gateway-auth identity, so a scoped
    value there would break the agent's tool calls.
    """
    uid = (user_email or "").strip().lower()
    aid = (account_id or "").strip()
    return f"{uid}#acct:{aid}" if (uid and aid) else uid


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


async def _fetch_attachments_batch(
    db: Any, message_ids: list[str]
) -> dict[str, list[AttachmentModel]]:
    """Attachment metadata for MANY messages in one query, keyed by message id.

    The conversation/thread list uses this so EVERY message in the thread carries
    its own attachments (the single-message detail path uses _fetch_attachments).
    Mirrors that helper's download_url construction. Returns {} on no input."""
    out: dict[str, list[AttachmentModel]] = {}
    if not message_ids:
        return out
    result = await db.execute(
        text(
            "SELECT message_id, id, filename, mime_type, size_bytes "
            "FROM email_attachments WHERE message_id::text = ANY(:mids) "
            "ORDER BY message_id, filename"
        ),
        {"mids": [str(m) for m in message_ids]},
    )
    gateway_url = os.environ.get("GATEWAY_EXTERNAL_URL", "")
    for r in result.fetchall():
        out.setdefault(str(r.message_id), []).append(
            AttachmentModel(
                id=str(r.id),
                filename=r.filename,
                mime_type=r.mime_type,
                size_bytes=r.size_bytes,
                download_url=f"{gateway_url}/email/attachments/{r.id}/download"
                if gateway_url else None,
            )
        )
    return out
