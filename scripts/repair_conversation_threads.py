"""One-off repair: converge conversation threads to their single classification.

#110 made the conversation the unit of classification, but repair rides the
classification path — a damaged thread heals on its NEXT inbound message, and a
DONE conversation may never receive one. This walks every statused conversation
that still shows damage and runs EXACTLY the two repair steps the live runner
now runs, through the same functions — not a parallel implementation:

    _reconcile_thread_labels        strip stale cleanup chips, converge to the
                                    thread's one status label (local + provider)
    _restore_conversation_messages  move back messages OUR rules moved out;
                                    a user's re-filing always wins

Scope is only threads that need it: stale cleanup chips, or a message still
sitting in the exact folder an APPLIED rule-move put it in. At the time of
writing that is 51 + 16-message threads of the 309 statused conversations —
touching the rest would be provider chatter for nothing.

Why provider-aware (not a SQL fixup): the sync reads categories back from the
provider, so a local-only strip would be reverted on the next cycle, and a
local-only folder change would be re-broken the same way. Repair must go
through the provider or not at all.

Usage (from the app root, with the app env):
    uv run python scripts/repair_conversation_threads.py            # dry run
    uv run python scripts/repair_conversation_threads.py --apply    # repair
"""
from __future__ import annotations

import asyncio
import json
import sys

# The conversation statuses and their labels. FYI is absent on purpose: it is
# also the default stamp for "nothing matched" (#111), so FYI threads are not
# conversations and are never swept.
_STATUS_LABEL = {
    "NEEDS_REPLY": "Reply",
    "AWAITING": "Awaiting Reply",
    "DONE": "Done",
}

async def _provider_for(db, store, account_id):
    from gateway.routes.email.core import _instantiate_provider
    from sqlalchemy import text
    acc = (await db.execute(text(
        "SELECT provider, credentials_encrypted FROM email_accounts "
        "WHERE id = :id"), {"id": account_id})).fetchone()
    if not acc:
        return None
    try:
        creds = json.loads(store.decrypt(acc.credentials_encrypted))
        prov = _instantiate_provider(acc.provider, creds)
        if not await prov.authenticate():
            print("provider auth FAILED — refusing to repair blind "
                  "(a local-only repair is reverted by the next sync)")
            return None
        return prov
    except Exception as exc:
        print(f"provider init failed: {str(exc)[:140]}")
        return None


async def main(apply: bool) -> int:
    from acb_llm.key_store import get_key_store
    from gateway.routes.email.automation.replyzero import (
        DAMAGED_CONVERSATION_THREADS_SQL,
        _reconcile_thread_labels,
        _restore_conversation_messages,
    )
    from gateway.routes.email.core import _get_db, _persist_rotated_creds
    from sqlalchemy import text

    db = await _get_db()
    try:
        rows = (await db.execute(
            text(DAMAGED_CONVERSATION_THREADS_SQL))).fetchall()
        print(f"threads needing repair: {len(rows)}")
        if not rows:
            return 0
        if not apply:
            for r in rows[:20]:
                print(f"  would repair {r.thread_id[:32]}…  "
                      f"→ {_STATUS_LABEL[r.status]}")
            if len(rows) > 20:
                print(f"  … and {len(rows) - 20} more")
            print("dry run — pass --apply to repair")
            return 0

        store = get_key_store()
        providers = {
            aid: await _provider_for(db, store, aid)
            for aid in {r.account_id for r in rows}
        }
        if all(p is None for p in providers.values()):
            print("no provider available — nothing done")
            return 1

        done = failed = 0
        for r in rows:
            prov = providers.get(r.account_id)
            if prov is None:
                continue
            try:
                # Reconcile FIRST (it reads the pre-move provider ids), then
                # restore — the restore persists Outlook's re-key afterwards.
                await _reconcile_thread_labels(
                    db, prov, str(r.account_id), r.thread_id,
                    _STATUS_LABEL[r.status])
                await _restore_conversation_messages(
                    db, prov, str(r.account_id), r.thread_id)
                await db.commit()
                done += 1
            except Exception as exc:
                await db.rollback()
                failed += 1
                print(f"thread FAILED {r.thread_id[:24]}…: {str(exc)[:140]}")
        print(f"repaired: {done}  failed: {failed}")

        for aid, prov in providers.items():
            if prov is not None and getattr(
                    prov, "credentials_dirty", lambda: False)():
                await _persist_rotated_creds(db, store, aid, prov)
        await db.commit()
        return 0 if failed == 0 else 1
    finally:
        await db.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main(apply="--apply" in sys.argv)))
