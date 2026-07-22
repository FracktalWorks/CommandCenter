"""One-off: backfill ``email_messages.internet_message_id`` for pre-mig-89 rows.

Migration 89 added the stable RFC 5322 Message-ID and every sync now ingests it
via ``$select`` — but the recurring poll only re-reads the newest pages and the
deep resync is floored at the initial-sync window, so rows older than that
window are never re-touched and their ``internet_message_id`` stays NULL
forever. Those NULL rows are exactly what blocks ``merge_ghost_messages.py``
("re-sync them first" — which no sync will ever do for them).

This is that bounded backfill: for every row still NULL it fetches ONLY
``$select=internetMessageId`` through Graph ``$batch`` reads (20 per request).
No mailbox writes, no message upserts — it cannot collide with the running
sync loop. A provider id that 404s is a true re-keyed ghost: its stable id is
unknowable, it stays NULL, and it is counted in the summary (the merge script
keeps reporting those separately).

Outlook/Graph only: other providers are skipped (Gmail keeps its ids stable,
so its rows never ghosted this way).

Usage (from the app root, with the app env):
    uv run python scripts/backfill_internet_message_id.py
"""
from __future__ import annotations

import asyncio
import sys


async def _backfill_account(db, account_id: str, rows: list) -> tuple[int, int]:
    """Fill ``internet_message_id`` for one account's rows; returns
    ``(filled, gone)`` where gone = provider id no longer resolvable (404)."""
    from gateway.routes.email.core import provider_session
    from sqlalchemy import text

    filled = gone = 0
    async with provider_session(db, None, account_id=account_id) as sess:
        http = await sess.provider._get_client()  # noqa: SLF001 — one-off script
        for i in range(0, len(rows), 20):
            chunk = rows[i:i + 20]
            batch = {"requests": [
                {"id": str(j), "method": "GET",
                 "url": (f"/me/messages/{r.provider_message_id}"
                         "?$select=internetMessageId")}
                for j, r in enumerate(chunk)]}
            resp = await http.post("/$batch", json=batch)
            resp.raise_for_status()
            for rsp in resp.json().get("responses", []):
                row = chunk[int(rsp["id"])]
                if rsp.get("status") == 200:
                    imid = (rsp.get("body") or {}).get("internetMessageId")
                    if imid:
                        # Guarded on IS NULL so a concurrent sync that already
                        # reclaimed the row is never overwritten.
                        await db.execute(text(
                            "UPDATE email_messages "
                            "SET internet_message_id = :m "
                            "WHERE id = :i AND internet_message_id IS NULL"
                        ), {"m": imid, "i": str(row.id)})
                        filled += 1
                else:
                    gone += 1
            await db.commit()
            done = i + len(chunk)
            if done % 500 < 20 or done == len(rows):
                print(f"  {done}/{len(rows)} filled={filled} gone={gone}",
                      flush=True)
    await db.commit()  # land any rotated creds staged by the session
    return filled, gone


async def main() -> int:
    from gateway.routes.email.core import _get_db
    from sqlalchemy import text

    db = await _get_db()
    try:
        accounts = (await db.execute(text(
            "SELECT DISTINCT em.account_id, ea.provider "
            "FROM email_messages em "
            "JOIN email_accounts ea ON ea.id = em.account_id "
            "WHERE em.internet_message_id IS NULL "
            "AND em.provider_message_id IS NOT NULL"
        ))).fetchall()
        if not accounts:
            print("nothing to backfill")
            return 0
        for acc in accounts:
            if acc.provider != "microsoft":
                print(f"account {str(acc.account_id)[:8]}… provider="
                      f"{acc.provider}: skipped (Outlook-only backfill)")
                continue
            rows = (await db.execute(text(
                "SELECT id, provider_message_id FROM email_messages "
                "WHERE account_id = :a AND internet_message_id IS NULL "
                "AND provider_message_id IS NOT NULL ORDER BY received_at"
            ), {"a": str(acc.account_id)})).fetchall()
            print(f"account {str(acc.account_id)[:8]}…: "
                  f"{len(rows)} rows to backfill")
            filled, gone = await _backfill_account(db, str(acc.account_id), rows)
            print(f"account {str(acc.account_id)[:8]}… DONE "
                  f"filled={filled} gone(404/re-keyed)={gone}")
        print("next: uv run python scripts/merge_ghost_messages.py  (dry) "
              "then --apply")
        return 0
    finally:
        await db.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
