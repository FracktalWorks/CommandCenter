"""Regression tests for email folder normalization.

The inbox appeared empty because providers persisted opaque provider folder
identifiers (Outlook ``parentFolderId``, Gmail label IDs) while the gateway/UI
query the canonical lowercase key ``inbox``.  These tests lock in the
normalization so ``WHERE folder = 'inbox'`` keeps matching synced mail.
"""
from __future__ import annotations

from email_ingestion.providers.base import canonical_folder
from email_ingestion.providers.gmail import _gmail_folder_from_labels


def test_canonical_folder_maps_provider_names():
    assert canonical_folder("Inbox") == "inbox"
    assert canonical_folder("INBOX") == "inbox"
    assert canonical_folder("sentItems") == "sent"
    assert canonical_folder("Sent Items") == "sent"
    assert canonical_folder("deletedItems") == "trash"
    assert canonical_folder("Deleted Items") == "trash"
    assert canonical_folder("Junk Email") == "junk"


def test_canonical_folder_defaults_and_passthrough():
    assert canonical_folder(None) == "inbox"
    assert canonical_folder("") == "inbox"
    # Unknown user folders fall through lowercased but stable.
    assert canonical_folder("My Project") == "my project"


def test_gmail_folder_from_labels_priority():
    assert _gmail_folder_from_labels(["INBOX", "UNREAD"]) == "inbox"
    assert _gmail_folder_from_labels(["SENT"]) == "sent"
    assert _gmail_folder_from_labels(["DRAFT"]) == "drafts"
    assert _gmail_folder_from_labels(["TRASH", "INBOX"]) == "trash"
    assert _gmail_folder_from_labels(["SPAM"]) == "junk"
    # No recognizable label → default inbox rather than an opaque label id.
    assert _gmail_folder_from_labels(["CATEGORY_PERSONAL"]) == "inbox"
    assert _gmail_folder_from_labels([]) == "inbox"
