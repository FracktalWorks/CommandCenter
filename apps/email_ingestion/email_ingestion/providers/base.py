"""Abstract base class for email providers.

All email providers (Gmail, Microsoft Graph, IMAP) implement this interface.
The sync engine calls these methods without knowing the provider details.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

# Canonical folder keys shared by the whole stack (DB, gateway query, UI store).
# Provider-specific folder names/IDs (Outlook ``parentFolderId``, Gmail label IDs,
# IMAP mailbox names) MUST be normalized to one of these before persisting so the
# inbox query ``WHERE folder = 'inbox'`` actually matches.  The workbench email
# store uses these exact lowercase keys.
_CANONICAL_FOLDERS: dict[str, str] = {
    "inbox": "inbox",
    "sent": "sent",
    "sentitems": "sent",
    "sent items": "sent",
    "sent mail": "sent",
    "drafts": "drafts",
    "draft": "drafts",
    "trash": "trash",
    "deleteditems": "trash",
    "deleted items": "trash",
    "bin": "trash",
    "archive": "archive",
    "junk": "junk",
    "junkemail": "junk",
    "junk email": "junk",
    "spam": "junk",
}


def canonical_folder(name: str | None) -> str:
    """Normalize a provider folder name/ID to a canonical lowercase key.

    Unknown names fall through lowercased (so user-created folders keep a stable
    key) and a missing name defaults to ``inbox``.
    """
    if not name:
        return "inbox"
    key = name.strip().lower()
    return _CANONICAL_FOLDERS.get(key, key)


@dataclass
class EmailAddress:
    name: str
    email: str


@dataclass
class Attachment:
    id: str
    filename: str
    mime_type: str
    size_bytes: int
    provider_attachment_id: str


@dataclass
class EmailMessage:
    """Normalized email message across all providers."""
    provider_message_id: str
    thread_id: str | None
    folder: str
    labels: list[str] = field(default_factory=list)
    from_address: EmailAddress | None = None
    to_addresses: list[EmailAddress] = field(default_factory=list)
    cc_addresses: list[EmailAddress] = field(default_factory=list)
    bcc_addresses: list[EmailAddress] = field(default_factory=list)
    subject: str = ""
    body_text: str = ""
    body_html: str | None = None
    snippet: str = ""
    has_attachments: bool = False
    attachments: list[Attachment] = field(default_factory=list)
    is_read: bool = False
    is_starred: bool = False
    is_flagged: bool = False
    received_at: datetime | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class EmailFolder:
    """Normalized folder/label."""
    provider_folder_id: str
    name: str
    type: str  # 'system' | 'user'
    message_count: int = 0
    unread_count: int = 0


@dataclass
class SyncResult:
    """Result of a sync operation."""
    messages_synced: int = 0
    messages_skipped: int = 0
    new_history_id: str | None = None
    messages: list[EmailMessage] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class BaseEmailProvider(ABC):
    """Abstract email provider interface."""

    def __init__(self, credentials: dict[str, Any]):
        self.credentials = credentials

    def credentials_dirty(self) -> bool:
        """Whether the in-memory credentials changed (e.g. token refresh).

        Providers that rotate OAuth tokens override this so the caller can
        persist the refreshed credentials back to storage.  Defaults to False
        for providers (like IMAP) that never mutate their credentials.
        """
        return False

    def export_credentials(self) -> dict[str, Any]:
        """Return the current credentials for persistence after a refresh."""
        return self.credentials

    @abstractmethod
    async def authenticate(self) -> bool:
        """Validate credentials and obtain an access token.

        Returns True if authentication succeeded.
        """
        ...

    @abstractmethod
    async def list_folders(self) -> list[EmailFolder]:
        """List all folders/labels for the account."""
        ...

    @abstractmethod
    async def list_messages(
        self,
        folder: str = "INBOX",
        query: str | None = None,
        max_results: int = 50,
        page_token: str | None = None,
    ) -> tuple[list[EmailMessage], str | None]:
        """List email headers (without full body) for a folder.

        Returns (messages, next_page_token).
        """
        ...

    @abstractmethod
    async def get_message(self, provider_message_id: str) -> EmailMessage:
        """Get full email message including body."""
        ...

    @abstractmethod
    async def send_message(
        self,
        to: list[str],
        subject: str,
        body_text: str,
        body_html: str | None = None,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        reply_to_message_id: str | None = None,
    ) -> str:
        """Send an email. Returns the provider message ID of the sent message."""
        ...

    @abstractmethod
    async def modify_message(
        self,
        provider_message_id: str,
        add_labels: list[str] | None = None,
        remove_labels: list[str] | None = None,
    ) -> None:
        """Modify labels/read-state on a message."""
        ...

    @abstractmethod
    async def trash_message(self, provider_message_id: str) -> None:
        """Move message to trash."""
        ...

    @abstractmethod
    async def sync_messages(
        self,
        history_id: str | None = None,
        max_results: int = 100,
    ) -> SyncResult:
        """Incremental sync — fetch new/updated messages since history_id.

        If history_id is None, performs an initial full sync.
        """
        ...

    @abstractmethod
    async def get_attachment(
        self, provider_message_id: str, provider_attachment_id: str
    ) -> bytes:
        """Download an attachment's raw bytes."""
        ...
