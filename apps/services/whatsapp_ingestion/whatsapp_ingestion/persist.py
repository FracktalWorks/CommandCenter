"""Shared persistence for normalized WhatsApp messages — the ONE idempotent
write path, mirroring ``email_ingestion.persist``.

Every inbound event (webhook batch, history-import page) and every outbound send
lands here, so a schema change touches one place and the ingest paths never
drift. ``whatsapp_ingestion`` is the LOWER layer: this module imports nothing
from the gateway.

Dedupe key is the Meta message id (``wa_messages.wa_message_id``), which is
stable, so re-delivery of the same webhook (Meta retries at-least-once) is a
no-op UPDATE rather than a duplicate row. As in the email upsert, an existing
row's ``categories`` and ``rules_processed_at`` are PRESERVED on conflict — those
are the rule engine's, not the transport's, and a re-delivered message must not
reset them (which would re-run automation on already-processed mail).
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import text

from whatsapp_ingestion.providers.base import (
    SyncResult,
    WhatsAppContact,
    WhatsAppMessage,
)

# The Cloud API customer-service window: free-form replies are allowed for 24h
# after the customer's last inbound message.
SERVICE_WINDOW = timedelta(hours=24)

MAX_BODY_TEXT_BYTES = 64 * 1024  # WhatsApp bodies are short; cap defensively.

# Media we can turn into text — voice notes (the dominant medium for Indian
# dealers) and any audio attachment. The canonical predicate lives here (the
# lower layer) so the ingest path and the gateway transcription pass never drift.
_VOICE_KINDS = frozenset({"voice", "audio"})
_AUDIO_MIME_PREFIX = "audio/"


def is_transcribable(kind: str | None, mime: str | None) -> bool:
    """True when a media attachment is a voice note / audio we can transcribe.
    Pure — used to mark media 'pending' at ingest and to gate the STT pass."""
    return (kind or "") in _VOICE_KINDS or (mime or "").startswith(_AUDIO_MIME_PREFIX)


def service_window_expiry(sent_at: Any) -> Any:
    """The instant the 24h window closes for an inbound message, or None.

    Pure so the window rule is unit-testable without a database. Only inbound
    (customer) messages open the window; the caller passes ``sent_at`` only for
    inbound.
    """
    if sent_at is None:
        return None
    return sent_at + SERVICE_WINDOW


def _truncate(value: str | None, max_bytes: int) -> str | None:
    if not value:
        return value
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return value
    marker = b" ... [truncated]"
    cut = max_bytes - len(marker)
    while cut > 0 and (encoded[cut] & 0xC0) == 0x80:
        cut -= 1
    return encoded[:cut].decode("utf-8", errors="replace") + marker.decode()


# ── chats ────────────────────────────────────────────────────────────────────

def _chat_name(msg: WhatsAppMessage) -> str:
    """Best display name for the chat this message belongs to."""
    if msg.chat_kind == "group":
        return msg.group_subject or ""
    return msg.sender_name or ""


_CHAT_UPSERT = """INSERT INTO wa_chats
    (id, account_id, wa_chat_id, kind, name, last_message_at,
     service_window_expires_at)
  VALUES
    (:id, :account_id, :wa_chat_id, :kind, :name, :last_message_at,
     :window_expires)
  ON CONFLICT (account_id, wa_chat_id) DO UPDATE SET
    kind = EXCLUDED.kind,
    name = COALESCE(NULLIF(EXCLUDED.name, ''), wa_chats.name),
    last_message_at = GREATEST(
        wa_chats.last_message_at, EXCLUDED.last_message_at),
    -- Only an inbound message carries a window; keep the latest expiry, never
    -- shrink it (an out-of-order older inbound must not close a live window).
    service_window_expires_at = GREATEST(
        wa_chats.service_window_expires_at, EXCLUDED.service_window_expires_at),
    updated_at = now()
  RETURNING id
"""


async def upsert_chat(
    db: Any, account_id: str, msg: WhatsAppMessage, *, direction: str
) -> str:
    """Ensure the chat row exists and is current; return its UUID (as str)."""
    window = service_window_expiry(msg.sent_at) if direction == "in" else None
    result = await db.execute(text(_CHAT_UPSERT), {
        "id": str(uuid4()),
        "account_id": account_id,
        "wa_chat_id": msg.wa_chat_id,
        "kind": msg.chat_kind or "dm",
        "name": _chat_name(msg),
        "last_message_at": msg.sent_at,
        "window_expires": window,
    })
    row = result.fetchone()
    return str(row.id) if row else ""


# ── contacts ──────────────────────────────────────────────────────────────────

_CONTACT_UPSERT = """INSERT INTO wa_contacts
    (id, account_id, phone_number, wa_id, display_name)
  VALUES (:id, :account_id, :phone_number, :wa_id, :display_name)
  ON CONFLICT (account_id, phone_number) DO UPDATE SET
    display_name = COALESCE(
        NULLIF(EXCLUDED.display_name, ''), wa_contacts.display_name),
    wa_id = COALESCE(EXCLUDED.wa_id, wa_contacts.wa_id),
    updated_at = now()
"""


async def upsert_contact(
    db: Any, account_id: str, contact: WhatsAppContact
) -> None:
    """Insert/update a contact identity (phone → name), never clobbering a known
    name with an empty one."""
    phone = contact.phone_number or contact.wa_id
    if not phone:
        return
    await db.execute(text(_CONTACT_UPSERT), {
        "id": str(uuid4()),
        "account_id": account_id,
        "phone_number": phone,
        "wa_id": contact.wa_id or None,
        "display_name": contact.name or "",
    })


# ── messages ──────────────────────────────────────────────────────────────────

_MESSAGE_INSERT = """INSERT INTO wa_messages
    (id, account_id, chat_id, wa_message_id, direction, sender, kind,
     body_text, quoted_wa_message_id, mentions, send_regime, template_name,
     sent_at, synced_at)
  VALUES
    (:id, :account_id, :chat_id, :wa_message_id, :direction, :sender, :kind,
     :body_text, :quoted, :mentions, :send_regime, :template_name,
     :sent_at, now())
  ON CONFLICT (account_id, wa_message_id) DO UPDATE SET
    -- Refresh transport fields on re-delivery, but NEVER touch the rule engine's
    -- columns (categories / rules_processed_at) or a re-sent webhook would
    -- re-run automation on already-processed mail. Same discipline as the email
    -- upsert's categories guard.
    body_text = COALESCE(NULLIF(EXCLUDED.body_text, ''), wa_messages.body_text),
    kind = EXCLUDED.kind,
    sender = EXCLUDED.sender,
    updated_at = now()
"""

_MEDIA_INSERT = """INSERT INTO wa_media
    (id, message_id, wa_media_id, mime_type, filename, size_bytes, sha256,
     transcription_status)
  VALUES (
    :id,
    (SELECT id FROM wa_messages
     WHERE account_id = :account_id AND wa_message_id = :wa_message_id),
    :wa_media_id, :mime_type, :filename, :size_bytes, :sha256,
    :transcription_status)
  ON CONFLICT DO NOTHING
"""


def _message_params(
    account_id: str, chat_id: str, msg: WhatsAppMessage, direction: str
) -> dict[str, Any]:
    """Bind params for one message row (pure — unit-testable)."""
    return {
        "id": str(uuid4()),
        "account_id": account_id,
        "chat_id": chat_id,
        "wa_message_id": msg.wa_message_id,
        "direction": direction,
        "sender": json.dumps({
            "wa_id": msg.sender_wa_id, "name": msg.sender_name,
        }),
        "kind": msg.kind or "text",
        "body_text": _truncate(msg.body_text, MAX_BODY_TEXT_BYTES),
        "quoted": msg.quoted_wa_message_id,
        "mentions": list(msg.mentions or []),
        "send_regime": None if direction == "in" else "session",
        "template_name": None,
        "sent_at": msg.sent_at,
    }


async def upsert_message(
    db: Any, account_id: str, chat_id: str, msg: WhatsAppMessage, *,
    direction: str = "in",
) -> None:
    """Insert or update one normalized message + its media metadata.

    Idempotent on ``(account_id, wa_message_id)``. The caller owns the
    transaction (``db.commit()``).
    """
    await db.execute(
        text(_MESSAGE_INSERT), _message_params(account_id, chat_id, msg, direction)
    )
    if msg.media and msg.media.wa_media_id:
        # Voice/audio lands 'pending' so the STT pass can find it; everything
        # else has no transcription lifecycle (NULL).
        status = (
            "pending"
            if is_transcribable(msg.kind, msg.media.mime_type)
            else None
        )
        await db.execute(text(_MEDIA_INSERT), {
            "id": str(uuid4()),
            "account_id": account_id,
            "wa_message_id": msg.wa_message_id,
            "wa_media_id": msg.media.wa_media_id,
            "mime_type": msg.media.mime_type,
            "filename": msg.media.filename,
            "size_bytes": msg.media.size_bytes,
            "sha256": msg.media.sha256,
            "transcription_status": status,
        })


async def persist_sync_result(
    db: Any, account_id: str, result: SyncResult
) -> dict[str, int]:
    """Persist a parsed webhook/import batch: contacts, then each message's chat
    then the message itself. Returns ``{"messages": n, "chats": m}`` counts.

    The caller owns the transaction. Outbound echoes (coexistence) arrive with
    ``direction`` already set on the message; today the parser only emits inbound,
    so ``direction`` defaults to the message's own value.
    """
    for contact in result.contacts:
        await upsert_contact(db, account_id, contact)

    chats_seen: set[str] = set()
    messages = 0
    for msg in result.messages:
        if not msg.wa_message_id:
            continue
        direction = msg.direction or "in"
        chat_id = await upsert_chat(db, account_id, msg, direction=direction)
        if not chat_id:
            continue
        chats_seen.add(chat_id)
        await upsert_message(db, account_id, chat_id, msg, direction=direction)
        messages += 1

    return {"messages": messages, "chats": len(chats_seen)}
