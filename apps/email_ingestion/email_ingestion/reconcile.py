"""Inbound deletion reconciliation for full-snapshot syncs.

Outlook's delta sync is disabled (it stalled in prod), so deletions made
*directly in Outlook* aren't pushed to us via a change feed.  Instead, the
Outlook sync returns a FULL multi-folder snapshot; this module reconciles it:
a message we have stored that is absent from the snapshot (and not present in
any other swept folder) was removed on the provider, so we trash it locally.

Moved messages need no special handling — they reappear in their new folder in
the same snapshot and the upsert already corrected ``folder``.  Reconciliation
is bounded per folder to the refetched window (its oldest ``received_at``), so
mail older than what we re-fetched this cycle is never touched.

Only runs when ``SyncResult.full_snapshot`` is True (Outlook sweep); incremental
results (Gmail history, IMAP UIDNEXT) emit their own ``[DELETED]`` markers and
must NOT be reconciled (absence there means "unchanged", not "deleted").
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import text


async def reconcile_full_snapshot(db: Any, account_id: str, sync_result: Any) -> int:
    """Trash local messages that vanished from a full provider snapshot.

    Returns the number of messages trashed.  Caller commits.
    """
    if not getattr(sync_result, "full_snapshot", False):
        return 0
    msgs = [m for m in sync_result.messages if m.subject != "[DELETED]"]
    global_seen = {m.provider_message_id for m in msgs}

    # Oldest received_at actually returned per (lowercased) folder = the floor of
    # the window we can safely reconcile.
    folder_min: dict[str, datetime] = {}
    for m in msgs:
        if m.received_at is None:
            continue
        key = (m.folder or "inbox").lower()
        cur = folder_min.get(key)
        if cur is None or m.received_at < cur:
            folder_min[key] = m.received_at

    trashed = 0
    for folder, min_recv in folder_min.items():
        rows = (await db.execute(
            text(
                """SELECT id, provider_message_id
                   FROM email_messages
                   WHERE account_id = :aid
                     AND LOWER(folder) = :folder
                     AND LOWER(folder) <> 'trash'
                     AND received_at >= :min_recv"""
            ),
            {"aid": account_id, "folder": folder, "min_recv": min_recv},
        )).fetchall()
        for r in rows:
            if r.provider_message_id in global_seen:
                continue  # still present (here, or moved to another folder)
            await db.execute(
                text(
                    "UPDATE email_messages SET folder = 'trash', "
                    "updated_at = now() WHERE id = :id"
                ),
                {"id": r.id},
            )
            trashed += 1
    return trashed
