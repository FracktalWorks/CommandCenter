"""Guard: every RECEIVED-message upsert persists ``unsubscribe_link``.

The message-upsert SQL is duplicated across the three inbound paths — manual
sync (``transport/sync.py``), the background scheduler (``scheduler.py``), and
the webhook/push handler (``inbound.py``). They drifted once: the scheduler and
webhook omitted ``unsubscribe_link``, so a background-synced marketing email had
no one-click-unsubscribe link and was Reply-Zero-classified differently than the
same email pulled by a manual sync. This source-guard keeps the copies in sync
until they're unified behind a single helper (C1 in the email audit).
"""
from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# Every path that upserts a *received* provider message. (drafting.py also
# INSERTs into email_messages, but for OUTBOUND drafts, which have no
# unsubscribe link — deliberately excluded.)
_RECEIVED_UPSERT_FILES = [
    "apps/services/gateway/gateway/routes/email/transport/sync.py",
    "apps/services/email_ingestion/email_ingestion/scheduler.py",
    "apps/services/email_ingestion/email_ingestion/inbound.py",
]


def test_received_message_upserts_persist_unsubscribe_link():
    for rel in _RECEIVED_UPSERT_FILES:
        src = (REPO / rel).read_text(encoding="utf-8")
        assert "INSERT INTO email_messages" in src, f"{rel}: no message upsert?"
        # The bind param appearing proves it's in the INSERT ... VALUES, not just
        # a stray mention — this is what actually persists the parsed link.
        assert ":unsubscribe_link" in src, (
            f"{rel} no longer binds unsubscribe_link in its email_messages "
            f"upsert — the received-message ingest paths have drifted again "
            f"(a background/webhook-synced email would lose one-click "
            f"unsubscribe + diverge from manual-sync classification)."
        )
