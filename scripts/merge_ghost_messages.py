"""One-off: merge duplicate "ghost" message rows that share a Message-ID.

Outlook re-keys a message's provider_message_id when it moves folders, so before
migration 89 the same logical message could be stored twice under different ids —
duplicate ghosts that get classified twice and skew per-thread heuristics. Going
forward the ingest upsert reclaims the row by internet_message_id, so no NEW
ghosts appear. This heals the ones already in the table.

It can only run once internet_message_id has been BACKFILLED by a sync cycle:
existing rows carry NULL until re-synced. So run this AFTER the account has
completed at least one full sync on the post-#89 code (check that
internet_message_id is populated), then again if needed.

For each (account_id, internet_message_id) group with more than one row it keeps
the NEWEST by received_at and folds the others into it BEFORE deleting them:
  * categories — union, so a label on any ghost survives on the keeper;
  * rules_processed_at / rules_held_back_at — carried if the keeper lacks them,
    so the message is not re-classified after the merge.
The keeper's provider_message_id (the newest sighting) wins — matching the
upsert's "prefer newest provider id".

Usage (from the app root, with the app env):
    uv run python scripts/merge_ghost_messages.py            # dry run
    uv run python scripts/merge_ghost_messages.py --apply    # merge
"""
from __future__ import annotations

import asyncio
import sys

# Groups of rows sharing one stable Message-ID within an account — the ghosts.
_GHOST_GROUPS_SQL = """
    SELECT account_id, internet_message_id, COUNT(*) AS n
    FROM email_messages
    WHERE internet_message_id IS NOT NULL
    GROUP BY account_id, internet_message_id
    HAVING COUNT(*) > 1
"""

# Within a group: the keeper (newest received_at, then newest synced_at) and the
# folded-in union of the losers' classification state.
_MERGE_ONE_SQL = """
WITH ranked AS (
    SELECT id, categories, rules_processed_at, rules_held_back_at,
           ROW_NUMBER() OVER (
               ORDER BY received_at DESC NULLS LAST, synced_at DESC NULLS LAST
           ) AS rn
    FROM email_messages
    WHERE account_id = :aid AND internet_message_id = :imid
),
keeper AS (SELECT id FROM ranked WHERE rn = 1),
losers AS (SELECT id, categories, rules_processed_at, rules_held_back_at
             FROM ranked WHERE rn > 1),
folded AS (
    SELECT
      (SELECT id FROM keeper) AS keep_id,
      -- union every category seen on any row in the group
      (SELECT ARRAY(SELECT DISTINCT unnest(categories)
                      FROM ranked WHERE categories IS NOT NULL)) AS cats,
      -- earliest processing watermark across the group (if any row had one)
      (SELECT MIN(rules_processed_at) FROM ranked
        WHERE rules_processed_at IS NOT NULL) AS proc_at,
      (SELECT MIN(rules_held_back_at) FROM ranked
        WHERE rules_held_back_at IS NOT NULL) AS held_at
)
UPDATE email_messages m SET
    categories = folded.cats,
    rules_processed_at = COALESCE(m.rules_processed_at, folded.proc_at),
    rules_held_back_at = COALESCE(m.rules_held_back_at, folded.held_at),
    updated_at = now()
FROM folded
WHERE m.id = folded.keep_id
"""

_DELETE_LOSERS_SQL = """
DELETE FROM email_messages
WHERE account_id = :aid AND internet_message_id = :imid
  AND id <> (
      SELECT id FROM email_messages
       WHERE account_id = :aid AND internet_message_id = :imid
       ORDER BY received_at DESC NULLS LAST, synced_at DESC NULLS LAST
       LIMIT 1)
"""


async def main(apply: bool) -> int:
    from gateway.routes.email.core import _get_db
    from sqlalchemy import text

    db = await _get_db()
    try:
        groups = (await db.execute(text(_GHOST_GROUPS_SQL))).fetchall()
        total_dupes = sum(int(g.n) - 1 for g in groups)
        print(f"ghost groups: {len(groups)}  duplicate rows to remove: "
              f"{total_dupes}")
        if not groups:
            return 0
        if not apply:
            for g in groups[:20]:
                print(f"  {g.internet_message_id[:48]}…  ×{g.n}")
            if len(groups) > 20:
                print(f"  … and {len(groups) - 20} more")
            print("dry run — pass --apply to merge")
            return 0

        merged = 0
        for g in groups:
            params = {"aid": str(g.account_id), "imid": g.internet_message_id}
            # Fold classification onto the keeper, THEN delete the losers.
            await db.execute(text(_MERGE_ONE_SQL), params)
            await db.execute(text(_DELETE_LOSERS_SQL), params)
            merged += 1
        await db.commit()
        print(f"merged groups: {merged}  rows removed: {total_dupes}")
        return 0
    finally:
        await db.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main(apply="--apply" in sys.argv)))
