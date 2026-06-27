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
    importance: str = "normal"  # 'high' | 'normal' | 'low'
    categories: list[str] = field(default_factory=list)
    # Best unsubscribe target parsed from the List-Unsubscribe header (https
    # one-click preferred, else mailto:). Powers bulk unsubscribe.
    unsubscribe_link: str | None = None
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
    # Canonical colour token ('preset0'..'preset24') for user labels, or None
    # when uncoloured. See providers/label_colors.py.
    color: str | None = None


@dataclass
class SyncResult:
    """Result of a sync operation."""
    messages_synced: int = 0
    messages_skipped: int = 0
    new_history_id: str | None = None
    messages: list[EmailMessage] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    # True when ``messages`` is a complete multi-folder snapshot (every folder
    # swept), so the caller may reconcile provider-side deletions: a stored
    # message absent from the snapshot was removed on the provider.  False for
    # incremental syncs (Gmail history, IMAP UIDNEXT) where absence means
    # "unchanged", not "deleted".
    full_snapshot: bool = False


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
        attachments: list[dict[str, Any]] | None = None,
    ) -> str:
        """Send an email. Returns the provider message ID of the sent message.

        ``attachments`` is a list of ``{"filename", "content" (bytes),
        "mime_type"}`` dicts to attach to the outgoing message."""
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
    async def trash_message(self, provider_message_id: str) -> str | None:
        """Move message to trash.

        Returns the message's new provider id if the operation re-keys it
        (e.g. Outlook /move issues a new id), otherwise ``None``.
        """
        ...

    async def apply_flags(
        self,
        provider_message_id: str,
        *,
        is_read: bool | None = None,
        is_starred: bool | None = None,
        is_flagged: bool | None = None,
    ) -> None:
        """Push read/star/flag state changes to the provider (two-way sync).

        Default implementation is a no-op so providers that don't support a
        given flag (e.g. IMAP stars) degrade gracefully.  Gmail/Outlook override.
        """
        return None

    async def move_to_folder(
        self, provider_message_id: str, folder: str
    ) -> str | None:
        """Move a message to the given canonical folder on the provider.

        ``folder`` is a canonical key (inbox/archive/trash/junk/...).  Default
        implementation is a no-op; providers override with their semantics
        (Gmail = label changes, Outlook = /move, IMAP = COPY+EXPUNGE).

        Returns the message's new provider id if the move re-keys it (Outlook
        /move returns a fresh id), otherwise ``None`` (id unchanged).
        """
        return None

    async def create_folder(self, name: str) -> EmailFolder:
        """Create (or reuse) a folder named ``name`` and return it normalized.

        Default raises NotImplementedError so callers can log and skip on
        providers without a folder concept.  Outlook creates a mail folder;
        Gmail creates a label; IMAP creates a mailbox.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support creating folders"
        )

    async def list_labels(self) -> list[dict[str, str | None]]:
        """User-applicable labels/categories as ``{name, color}`` dicts.

        ``color`` is a canonical preset token ('preset0'..'preset24') or None.
        Gmail = user labels, Outlook = master categories.  Default (e.g. generic
        IMAP, which has no label concept) returns nothing.
        """
        return []

    async def set_labels(
        self,
        provider_message_id: str,
        add: list[str] | None = None,
        remove: list[str] | None = None,
    ) -> None:
        """Apply/remove labels (by name) on a message; creating labels if needed.

        Default is a no-op so providers without labels degrade gracefully.
        """
        return None

    async def set_label_color(self, name: str, color: str) -> None:
        """Set a label/category's colour (canonical 'presetN' token).

        Creates the label/category if it doesn't exist yet so the colour
        sticks.  Default is a no-op for providers without label colours.
        """
        return None

    async def create_draft(
        self,
        to: list[str],
        subject: str,
        body_text: str,
        body_html: str | None = None,
        reply_to_message_id: str | None = None,
        thread_id: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> str:
        """Create a DRAFT message (not sent) on the provider; return its id.

        ``attachments`` (optional): a list of ``{"filename": str, "content":
        bytes, "mime_type": str}`` to attach to the draft.

        Used by Assistant reply/forward/draft rule actions. Raises
        NotImplementedError if the provider doesn't support drafts so the caller
        can log and skip rather than fail the whole rule.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support drafts"
        )

    async def update_draft(
        self,
        draft_id: str,
        to: list[str] | None = None,
        subject: str | None = None,
        body_text: str | None = None,
        body_html: str | None = None,
    ) -> str:
        """Update an existing draft in place; return the (possibly new) draft id.

        Default raises NotImplementedError so callers can fall back to creating a
        fresh draft on providers without an update primitive.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support updating drafts"
        )

    async def send_draft(self, draft_id: str) -> str | None:
        """Send an existing draft natively (Drafts → Sent), no duplicate.

        Default raises NotImplementedError so callers can fall back to sending a
        fresh message and deleting the draft.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support sending drafts"
        )

    @abstractmethod
    async def sync_messages(
        self,
        history_id: str | None = None,
        max_results: int = 100,
        deep: bool = False,
        since: datetime | None = None,
    ) -> SyncResult:
        """Incremental sync — fetch new/updated messages since history_id.

        If history_id is None, performs an initial full sync.  ``deep`` requests
        the one-time deep backfill (page each folder back to ``since``); when
        False the sync stays shallow/incremental.  ``since`` is the history floor
        for a deep sync (providers that support a server-side date filter use it).
        """
        ...

    @abstractmethod
    async def get_attachment(
        self, provider_message_id: str, provider_attachment_id: str
    ) -> bytes:
        """Download an attachment's raw bytes."""
        ...
