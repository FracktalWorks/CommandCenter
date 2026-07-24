"""Parse a Meta WhatsApp Business Cloud API webhook payload into normalized
:class:`SyncResult` data — the pure, transport-boundary function the gateway's
webhook receiver calls before handing off to persist.

Deliberately total: a malformed entry never raises, it lands in
``SyncResult.errors`` so one bad change in a batch can't drop the good ones.
Signature verification (``X-Hub-Signature-256``) is the receiver's job, not
this parser's — this only decodes an already-trusted body.

Cloud API payload shape (``object: whatsapp_business_account``)::

    entry[].changes[].value = {
        messaging_product, metadata{display_phone_number, phone_number_id},
        contacts[]{profile{name}, wa_id},
        messages[]{from, id, timestamp, type, <type-object>, context{id}},
        statuses[]{id, status, timestamp, recipient_id, errors[]},
    }
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from whatsapp_ingestion.providers.base import (
    SyncResult,
    WhatsAppContact,
    WhatsAppMedia,
    WhatsAppMessage,
    WhatsAppStatus,
)

# Meta ``type`` value → our normalized ``kind``. Audio splits into voice vs audio
# on the ``voice`` flag inside the object; unknown types fall through to system.
_MEDIA_TYPES = {"image", "video", "audio", "document", "sticker"}


def _ts(value: Any) -> datetime | None:
    """Meta timestamps are unix-epoch seconds as a string. Return tz-aware UTC."""
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=UTC)
    except (ValueError, TypeError, OSError):
        return None


def _message_kind(msg: dict[str, Any]) -> str:
    """Normalize Meta's ``type`` to our ``kind`` vocabulary."""
    mtype = msg.get("type") or "text"
    if mtype == "audio":
        # A voice note carries ``voice: true``; a plain audio file does not.
        return "voice" if (msg.get("audio") or {}).get("voice") else "audio"
    if mtype in _MEDIA_TYPES or mtype in (
        "text", "location", "contacts", "reaction", "sticker",
    ):
        # 'contacts' (a shared vCard) normalizes to singular 'contact'.
        return "contact" if mtype == "contacts" else mtype
    # button / interactive / order / system / unknown → keep the row as system so
    # nothing is silently dropped; the raw payload is preserved for later.
    return "system"


def _body_and_media(
    msg: dict[str, Any], kind: str,
) -> tuple[str, WhatsAppMedia | None]:
    """Extract the display text (body or caption) and any media reference."""
    mtype = msg.get("type") or "text"

    if mtype == "text":
        return (msg.get("text") or {}).get("body", "") or "", None

    if mtype == "reaction":
        return (msg.get("reaction") or {}).get("emoji", "") or "", None

    if mtype == "location":
        loc = msg.get("location") or {}
        label = loc.get("name") or loc.get("address") or ""
        coords = f"{loc.get('latitude')},{loc.get('longitude')}"
        return (f"{label} ({coords})" if label else coords), None

    if mtype == "contacts":
        cards = msg.get("contacts") or []
        names = [
            ((c.get("name") or {}).get("formatted_name") or "").strip()
            for c in cards
        ]
        return ", ".join(n for n in names if n), None

    if mtype in _MEDIA_TYPES:
        obj = msg.get(mtype) or {}
        media = WhatsAppMedia(
            wa_media_id=obj.get("id", "") or "",
            mime_type=obj.get("mime_type") or "application/octet-stream",
            filename=obj.get("filename"),
            sha256=obj.get("sha256"),
        )
        # Captions live on image/video/document; audio/sticker have none.
        return obj.get("caption", "") or "", media

    return "", None


def _parse_message(
    msg: dict[str, Any],
    contacts_by_wa_id: dict[str, WhatsAppContact],
) -> WhatsAppMessage:
    """Parse one inbound message object into a normalized message."""
    kind = _message_kind(msg)
    body, media = _body_and_media(msg, kind)
    sender_wa_id = msg.get("from", "") or ""
    contact = contacts_by_wa_id.get(sender_wa_id)

    # Group vs DM: Meta marks group traffic with a group id under metadata/context
    # in the coexistence payloads. Absent that, a message is a DM keyed on the
    # sender's wa_id. We read the (evolving) ``group_id`` defensively.
    group_id = msg.get("group_id") or (msg.get("context") or {}).get("group_id")
    if group_id:
        chat_kind = "group"
        wa_chat_id = str(group_id)
    else:
        chat_kind = "dm"
        wa_chat_id = sender_wa_id

    context = msg.get("context") or {}
    return WhatsAppMessage(
        wa_message_id=msg.get("id", "") or "",
        wa_chat_id=wa_chat_id,
        direction="in",
        kind=kind,
        sender_wa_id=sender_wa_id,
        sender_name=contact.name if contact else "",
        body_text=body,
        quoted_wa_message_id=context.get("id"),
        media=media,
        chat_kind=chat_kind,
        sent_at=_ts(msg.get("timestamp")),
        raw=msg,
    )


def _parse_status(st: dict[str, Any]) -> WhatsAppStatus:
    """Parse one delivery/read status callback."""
    errors = st.get("errors") or []
    err = None
    if errors:
        first = errors[0] or {}
        err = first.get("title") or first.get("message") or str(first)
    return WhatsAppStatus(
        wa_message_id=st.get("id", "") or "",
        recipient_wa_id=st.get("recipient_id", "") or "",
        status=st.get("status", "") or "",
        timestamp=_ts(st.get("timestamp")),
        error=err,
    )


def parse_webhook(payload: dict[str, Any]) -> SyncResult:
    """Turn a full Cloud API webhook body into a :class:`SyncResult`.

    Aggregates messages, statuses and contacts across every ``entry`` /
    ``change`` in the payload. The ``phone_number_id`` is taken from the first
    change's metadata (a single webhook batch targets one number).
    """
    result = SyncResult()
    if not isinstance(payload, dict):
        result.errors.append("payload is not an object")
        return result

    for entry in payload.get("entry", []) or []:
        for change in (entry or {}).get("changes", []) or []:
            try:
                value = (change or {}).get("value") or {}
                meta = value.get("metadata") or {}
                if not result.phone_number_id and meta.get("phone_number_id"):
                    result.phone_number_id = meta["phone_number_id"]

                contacts_by_wa_id: dict[str, WhatsAppContact] = {}
                for c in value.get("contacts", []) or []:
                    wa_id = c.get("wa_id", "") or ""
                    contact = WhatsAppContact(
                        wa_id=wa_id,
                        phone_number=wa_id,
                        name=(c.get("profile") or {}).get("name", "") or "",
                    )
                    contacts_by_wa_id[wa_id] = contact
                    result.contacts.append(contact)

                for msg in value.get("messages", []) or []:
                    result.messages.append(
                        _parse_message(msg, contacts_by_wa_id)
                    )

                for st in value.get("statuses", []) or []:
                    result.statuses.append(_parse_status(st))
            except Exception as exc:
                result.errors.append(f"change parse failed: {exc!r}")

    return result
