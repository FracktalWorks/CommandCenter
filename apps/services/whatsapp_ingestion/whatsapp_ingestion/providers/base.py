"""Abstract base class + normalized dataclasses for WhatsApp providers.

The gateway and ingestion code call these methods and consume these dataclasses
without knowing the transport details — the same contract the email vertical
draws with ``BaseEmailProvider``. Today the only concrete provider is the
official Meta Cloud API (:class:`~whatsapp_ingestion.providers.cloud_api
.WhatsAppCloudProvider`).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

# Message kinds normalized across the whole stack (DB ``wa_messages.kind``, the
# webhook parser, the UI store). Anything Meta sends that we don't model maps to
# ``system`` so the row still lands rather than being dropped.
MESSAGE_KINDS = (
    "text", "image", "video", "audio", "voice", "document",
    "sticker", "location", "contact", "reaction", "system",
)

# Chat kinds. WhatsApp has no threads; a chat is the unit the reply queue ranks.
CHAT_KINDS = ("dm", "group", "broadcast")


@dataclass
class WhatsAppContact:
    """A counterparty identity, as Meta reports it in the webhook ``contacts``."""
    wa_id: str
    phone_number: str = ""
    name: str = ""


@dataclass
class WhatsAppMedia:
    """Normalized media reference. ``wa_media_id`` is Meta's download handle,
    which expires — the actual bytes are fetched lazily via the provider and
    cached under ``storage_path`` by the gateway."""
    wa_media_id: str
    mime_type: str = "application/octet-stream"
    filename: str | None = None
    size_bytes: int | None = None
    sha256: str | None = None


@dataclass
class WhatsAppMessage:
    """A single normalized WhatsApp message, inbound or outbound."""
    wa_message_id: str
    wa_chat_id: str                     # the conversation JID (contact or group)
    direction: str = "in"               # 'in' | 'out'
    kind: str = "text"
    sender_wa_id: str = ""
    sender_name: str = ""
    body_text: str = ""                 # text body or media caption
    quoted_wa_message_id: str | None = None
    mentions: list[str] = field(default_factory=list)
    media: WhatsAppMedia | None = None
    # Group-chat only: the group subject when Meta includes it. DMs leave this None
    # and the chat name comes from the contact profile instead.
    group_subject: str | None = None
    chat_kind: str = "dm"               # 'dm' | 'group' | 'broadcast'
    sent_at: datetime | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class WhatsAppStatus:
    """A delivery/read status callback for a message WE sent (sent → delivered →
    read → failed). Lets the store reflect send state without a re-fetch."""
    wa_message_id: str
    recipient_wa_id: str = ""
    status: str = ""                    # 'sent'|'delivered'|'read'|'failed'
    timestamp: datetime | None = None
    error: str | None = None


@dataclass
class WhatsAppChat:
    """Normalized conversation header (materialized from messages + contacts)."""
    wa_chat_id: str
    kind: str = "dm"
    name: str = ""
    participants: list[WhatsAppContact] = field(default_factory=list)


@dataclass
class SyncResult:
    """Result of parsing one webhook payload (or a history-import page)."""
    messages: list[WhatsAppMessage] = field(default_factory=list)
    statuses: list[WhatsAppStatus] = field(default_factory=list)
    contacts: list[WhatsAppContact] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    # The phone_number_id every event in this payload targeted — the receiver
    # resolves the owning wa_account by it. None if the payload had no metadata.
    phone_number_id: str | None = None


class BaseWhatsAppProvider(ABC):
    """Abstract WhatsApp provider interface.

    Only the official Cloud API implements it today; keeping the ABC means the
    gateway send/media paths never import a concrete provider directly.
    """

    def __init__(self, credentials: dict[str, Any]):
        self.credentials = credentials

    @abstractmethod
    async def send_text(
        self,
        to_wa_id: str,
        body: str,
        *,
        reply_to_wa_message_id: str | None = None,
    ) -> str:
        """Send a free-form text message (valid inside the 24h service window).

        Returns the Meta message id (``wamid.*``) of the sent message.
        """
        ...

    @abstractmethod
    async def send_template(
        self,
        to_wa_id: str,
        template_name: str,
        language: str,
        *,
        components: list[dict[str, Any]] | None = None,
    ) -> str:
        """Send an approved template message (required OUTSIDE the 24h window).

        Returns the Meta message id of the sent message.
        """
        ...

    @abstractmethod
    async def download_media(self, wa_media_id: str) -> tuple[bytes, str]:
        """Fetch a media object's raw bytes. Returns ``(content, mime_type)``.

        Two hops on the Cloud API: resolve the media id to a short-lived URL,
        then GET the URL with the bearer token.
        """
        ...

    async def mark_read(self, wa_message_id: str) -> None:
        """Best-effort read receipt for an inbound message. Default no-op so the
        rest of the pipeline never depends on it."""
        return None
