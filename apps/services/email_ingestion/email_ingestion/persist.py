"""Shared persistence for a normalized provider message (C1 consolidation).

ONE ``INSERT ... ON CONFLICT`` for the ``email_messages`` upsert, plus its
attachment metadata. This SQL used to be copy-pasted into four ingest paths — the
manual-sync route (``transport/sync.py``), the background scheduler
(``scheduler.py``), the on-demand history backfill (``core._upsert_message``) and
the inbound SMTP/webhook handler (``inbound.py``). The copies drifted:

* ``unsubscribe_link`` was added to only two of them (a background-synced
  marketing email lost its one-click-unsubscribe link and was Reply-Zero
  classified differently than the same mail pulled by a manual sync);
* the scheduler/webhook stored the body *untruncated* while the sync/backfill
  paths truncated it;
* the backfill clobbered ``snippet`` with an empty re-send while the others
  preserved it.

Consolidating removes the drift surface: a schema/column change now lands once
and every ingest path stays identical. ``email_ingestion`` is the LOWER layer, so
this module imports nothing from the gateway — the gateway (higher layer) imports
DOWN into here (see ``core._upsert_message``).
"""
from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from sqlalchemy import text

# Bound the stored body. Mirrors the gateway read-path caps
# (``core.MAX_BODY_*_BYTES``): a provider that lists headers-only re-sends an
# empty body, and the rare oversized body is capped here so the reading pane's
# "load full message" backfill stays the single escape hatch.
MAX_BODY_TEXT_BYTES = 500 * 1024       # 500 KB
MAX_BODY_HTML_BYTES = 2 * 1024 * 1024  # 2 MB


def truncate_body(value: str | None, max_bytes: int) -> str | None:
    """Truncate UTF-8 text to fit within ``max_bytes``, appending a marker.

    Returns the input unchanged when it already fits (or is falsy — so a ``None``
    ``body_html`` stays ``None``). The trailing ``" ... [truncated]"`` marker lets
    the UI offer a "Load full message" action.
    """
    if not value:
        return value
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return value
    marker = b" ... [truncated]"
    # Back up off any continuation byte so we never split a multi-byte char.
    cut = max_bytes - len(marker)
    while cut > 0 and (encoded[cut] & 0xC0) == 0x80:
        cut -= 1
    return encoded[:cut].decode("utf-8", errors="replace") + marker.decode()


_INSERT = """INSERT INTO email_messages
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
"""

# On re-sync, refresh every column from the provider EXCEPT keep an already-stored
# body / snippet / unsubscribe link when the incoming row is empty. Outlook lists
# headers-only (empty body) on every tick, which would otherwise clobber a body
# the user had lazily hydrated or the search backfill had filled.
#
# ``categories`` is the same class of hazard but far more destructive, so it gets
# an explicit opt-in instead of an emptiness check: it is the column the RULE
# ENGINE writes its labels to (Newsletter / Marketing / Notification / …), and
# it is what the Email Cleaner, the category chips and the quick filters all read.
# A provider that simply doesn't report categories (generic IMAP; Gmail before it
# resolved user-label IDs to names) would send ``{}`` on every tick and erase the
# lot — permanently, because ``rules_processed_at`` is already stamped so the
# rules never re-apply. Only a provider that genuinely round-trips labels sets
# ``categories_authoritative``, and only then does an empty array mean "the user
# cleared them". See EmailMessage.categories_authoritative.
_ON_CONFLICT_UPDATE = """
   ON CONFLICT (account_id, provider_message_id) DO UPDATE SET
     thread_id = EXCLUDED.thread_id,
     folder = EXCLUDED.folder,
     labels = EXCLUDED.labels,
     categories = CASE WHEN :categories_authoritative
                       THEN EXCLUDED.categories
                       ELSE email_messages.categories END,
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
     snippet = COALESCE(NULLIF(EXCLUDED.snippet, ''),
                        email_messages.snippet),
     has_attachments = EXCLUDED.has_attachments,
     is_read = EXCLUDED.is_read,
     is_starred = EXCLUDED.is_starred,
     is_flagged = EXCLUDED.is_flagged,
     unsubscribe_link = COALESCE(EXCLUDED.unsubscribe_link,
                                 email_messages.unsubscribe_link),
     received_at = EXCLUDED.received_at,
     updated_at = now()
"""

# Insert-only: never touch an existing row (inbound SMTP/webhook — the message is
# authoritative on first arrival and later reconciled by the sync paths).
_ON_CONFLICT_NOTHING = (
    "\n   ON CONFLICT (account_id, provider_message_id) DO NOTHING"
)

_ATTACHMENT_INSERT = """INSERT INTO email_attachments
       (message_id, filename, mime_type, size_bytes, provider_attachment_id)
     VALUES (
       (SELECT id FROM email_messages
        WHERE account_id = :account_id AND provider_message_id = :provider_id),
       :filename, :mime_type, :size_bytes, :provider_attachment_id
     )
     ON CONFLICT DO NOTHING"""


def _message_params(account_id: str, msg: Any) -> dict[str, Any]:
    """Bind params for one message row. Attribute access is duck-typed so both the
    provider :class:`EmailMessage` dataclass and the gateway's message model work;
    ``getattr`` guards the fields older/inbound messages may omit."""
    return {
        "id": str(uuid4()),
        "account_id": account_id,
        "provider_id": msg.provider_message_id,
        "thread_id": msg.thread_id,
        "folder": msg.folder or "INBOX",
        "labels": msg.labels,
        "categories": getattr(msg, "categories", []) or [],
        # Opt-in flag guarding the ON CONFLICT categories replace (see above).
        # Bound for the insert-only path too — the param must exist either way.
        "categories_authoritative": bool(
            getattr(msg, "categories_authoritative", False)
        ),
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
        "body_text": truncate_body(msg.body_text, MAX_BODY_TEXT_BYTES),
        "body_html": truncate_body(msg.body_html, MAX_BODY_HTML_BYTES),
        "snippet": msg.snippet[:200] if msg.snippet else "",
        "has_attachments": msg.has_attachments,
        "is_read": msg.is_read,
        "is_starred": msg.is_starred,
        "is_flagged": msg.is_flagged,
        "unsubscribe_link": getattr(msg, "unsubscribe_link", None),
        "received_at": msg.received_at,
    }


async def upsert_message(
    db: Any, account_id: str, msg: Any, *, on_conflict: str = "update"
) -> None:
    """Insert or update one normalized provider message + its attachment metadata.

    The single ingest write path shared by manual sync, the background scheduler,
    the history backfill and the inbound handler.

    * ``on_conflict="update"`` (default) refreshes an existing row, preserving a
      non-empty stored body / snippet / unsubscribe link.
    * ``on_conflict="nothing"`` inserts brand-new mail only and never touches an
      existing row (inbound SMTP/webhook).

    The caller owns the transaction (``db.commit()``).
    """
    conflict = _ON_CONFLICT_UPDATE if on_conflict == "update" else _ON_CONFLICT_NOTHING
    await db.execute(text(_INSERT + conflict), _message_params(account_id, msg))
    for att in msg.attachments:
        await db.execute(
            text(_ATTACHMENT_INSERT),
            {
                "account_id": account_id,
                "provider_id": msg.provider_message_id,
                "filename": att.filename,
                "mime_type": att.mime_type,
                "size_bytes": att.size_bytes,
                "provider_attachment_id": att.provider_attachment_id,
            },
        )
