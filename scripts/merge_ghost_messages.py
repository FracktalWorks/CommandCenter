"""One-off: merge Outlook re-key "ghost" rows onto their surviving message.

Outlook re-keys ``provider_message_id`` when a message moves between folders. The
OLD ingest keyed the upsert on ``(account_id, provider_message_id)``, so a
re-keyed message did not conflict with its existing row — it was INSERTed again
as a duplicate "ghost". The ghosts skew per-thread heuristics and, when re-fetched,
get classified a second time.

Migration 89 added ``internet_message_id`` (the stable RFC 5322 Message-ID) and
the ingest now reclaims a row by it before inserting, so NO NEW ghosts form. This
script cleans the duplicates that predate the fix: it merges rows that now share
the same ``(account_id, internet_message_id)``. For each such group it —

  * keeps the RICHEST row (a classified row — ``rules_processed_at`` set — wins,
    then the newest ``received_at``; "prefer the newest provider id" from mig 89),
  * carries a sibling's categories / ``rules_processed_at`` onto the survivor if
    the survivor lacks them (so a merge never loses a classification),
  * repoints the FK rows that ``SET NULL`` on delete — ``email_executed_rules``
    and ``email_rule_guidance`` — onto the survivor (history keeps its message),
  * deletes the siblings (their attachments / embeddings CASCADE away, being
    duplicates of the survivor's).

Only rows whose ``internet_message_id`` has been BACKFILLED (a sync populated it
via ``$select``) can be paired here. Legacy ghosts still NULL are reported, not
merged — their stable id can't be known until they re-sync, exactly as migration
89 notes. Run a sync (or a bounded backfill) first, then this.

Usage (from the app root, with the app env):
    uv run python scripts/merge_ghost_messages.py            # dry run
    uv run python scripts/merge_ghost_messages.py --apply    # merge
"""
from __future__ import annotations

import asyncio
import sys

# Groups of duplicate rows that share a (now-known) stable Message-ID. The survivor
# is ids[0]: a classified row first, then the newest — so the merge keeps the most
# complete, most recent copy and drops the stale re-key ghosts behind it.
_GROUPS_SQL = """
    SELECT account_id,
           internet_message_id,
           COUNT(*) AS n,
           ARRAY_AGG(id::text ORDER BY
               (rules_processed_at IS NOT NULL) DESC,
               received_at DESC NULLS LAST,
               updated_at DESC NULLS LAST) AS ids
    FROM email_messages
    WHERE internet_message_id IS NOT NULL
    GROUP BY account_id, internet_message_id
    HAVING COUNT(*) > 1
"""


async def _merge_group(db, survivor: str, dupes: list[str]) -> None:
    from sqlalchemy import text

    # Carry a sibling's signal onto the survivor only where the survivor lacks
    # it — categories (keep the survivor's if non-empty, else take a dupe's) and
    # the rules-processed / held-back watermarks (keep the survivor's if set).
    await db.execute(text("""
        UPDATE email_messages s SET
            categories = CASE
                WHEN COALESCE(array_length(s.categories, 1), 0) > 0
                    THEN s.categories
                ELSE COALESCE(
                    (SELECT d.categories FROM email_messages d
                      WHERE d.id::text = ANY(:dupes)
                        AND COALESCE(array_length(d.categories, 1), 0) > 0
                      ORDER BY d.received_at DESC NULLS LAST
                      LIMIT 1),
                    s.categories)
            END,
            rules_processed_at = COALESCE(
                s.rules_processed_at,
                (SELECT MIN(d.rules_processed_at) FROM email_messages d
                  WHERE d.id::text = ANY(:dupes))),
            rules_held_back_at = COALESCE(
                s.rules_held_back_at,
                (SELECT MIN(d.rules_held_back_at) FROM email_messages d
                  WHERE d.id::text = ANY(:dupes)))
        WHERE s.id::text = :survivor
    """), {"survivor": survivor, "dupes": dupes})

    # Repoint the SET-NULL foreign keys onto the survivor BEFORE deleting, so the
    # audit / guidance rows keep pointing at the message instead of going NULL.
    for tbl in ("email_executed_rules", "email_rule_guidance"):
        await db.execute(text(
            f"UPDATE {tbl} SET message_id = CAST(:survivor AS uuid) "
            f"WHERE message_id::text = ANY(:dupes)"),
            {"survivor": survivor, "dupes": dupes})

    # Drop the ghosts. Their email_attachments / email_embeddings CASCADE away —
    # duplicates of the survivor's, which keeps its own.
    await db.execute(text(
        "DELETE FROM email_messages WHERE id::text = ANY(:dupes)"),
        {"dupes": dupes})


async def main(apply: bool) -> int:
    from gateway.routes.email.core import _get_db
    from sqlalchemy import text

    db = await _get_db()
    try:
        groups = (await db.execute(text(_GROUPS_SQL))).fetchall()
        null_ghosts = (await db.execute(text(
            "SELECT COUNT(*) FROM email_messages "
            "WHERE internet_message_id IS NULL"))).scalar() or 0

        total_dupes = sum(g.n - 1 for g in groups)
        print(f"backfilled ghost groups: {len(groups)}  "
              f"duplicate rows to merge: {total_dupes}")
        print(f"rows still lacking internet_message_id (NOT merged — re-sync "
              f"them first): {null_ghosts}")
        if not groups:
            return 0

        if not apply:
            for g in groups[:20]:
                survivor, *dupes = g.ids
                print(f"  {(g.internet_message_id or '')[:44]}…  "
                      f"keep {survivor[:8]}  drop {len(dupes)}")
            if len(groups) > 20:
                print(f"  … and {len(groups) - 20} more groups")
            print("dry run — pass --apply to merge")
            return 0

        merged = failed = 0
        for g in groups:
            survivor, *dupes = g.ids
            try:
                await _merge_group(db, survivor, dupes)
                await db.commit()
                merged += 1
            except Exception as exc:  # noqa: BLE001
                await db.rollback()
                failed += 1
                print(f"group FAILED {(g.internet_message_id or '')[:32]}…: "
                      f"{str(exc)[:140]}")
        print(f"merged groups: {merged}  failed: {failed}")
        return 0 if failed == 0 else 1
    finally:
        await db.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main(apply="--apply" in sys.argv)))
