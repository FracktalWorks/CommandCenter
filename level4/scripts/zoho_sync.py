"""Pull every Account / Contact / User / Deal from Zoho CRM into the graph.

Run:  uv run python -m scripts.zoho_sync
Idempotent: keyed by zoho_id on every upsert.
"""
from __future__ import annotations

import asyncio

import structlog

from acb_audit import AuditEvent, record
from acb_graph import get_session
from ingestion.sources.zoho import client
from ingestion.sources.zoho.normaliser import (
    normalise_accounts,
    normalise_contacts,
    normalise_deals,
    normalise_users,
)

_log = structlog.get_logger(__name__)


async def main() -> None:
    _log.info("zoho.sync.start")

    accounts = await client.list_accounts()
    contacts = await client.list_contacts()
    users = await client.list_users()
    deals = await client.list_deals()

    _log.info(
        "zoho.sync.fetched",
        accounts=len(accounts),
        contacts=len(contacts),
        users=len(users),
        deals=len(deals),
    )

    with get_session() as s:
        n_users = normalise_users(s, users)
        n_accounts = normalise_accounts(s, accounts)
        n_contacts = normalise_contacts(s, contacts)
        n_deals = normalise_deals(s, deals)

    summary = {
        "accounts": n_accounts,
        "contacts": n_contacts,
        "users": n_users,
        "deals": n_deals,
    }
    record(
        AuditEvent(
            actor="job:zoho_sync",
            action="full_sync",
            target="source:zoho",
            payload=summary,
        )
    )
    print("=== Zoho sync complete ===")
    for k, v in summary.items():
        print(f"  {k:>9}: {v}")


if __name__ == "__main__":
    asyncio.run(main())