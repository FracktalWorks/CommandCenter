"""WhatsApp digest — the projection that joins the morning brief.

Same shape as the email digest-dashboard: ONE computation over the classified
state (chat statuses + intents + commitments), rendered as the "needs you first"
list plus the calm counts. Read-only; it never classifies (that's the post-sync
hooks' job) — it projects what they already wrote.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends
from gateway.routes.whatsapp.core import _get_db, router
from pydantic import BaseModel
from sqlalchemy import text

# Intents that mean a message is routine noise, not an obligation — the "muted"
# tally in the trust ledger.
_MUTED_INTENTS = ("social", "spam")


class DigestItem(BaseModel):
    chat_id: str
    name: str
    snippet: str = ""
    intent: str | None = None


class DigestCounts(BaseModel):
    needs_reply: int = 0
    waiting: int = 0
    groups: int = 0
    muted: int = 0


class WhatsAppDigestModel(BaseModel):
    needs_you: list[DigestItem] = []      # the ≤N that need the founder first
    counts: DigestCounts = DigestCounts()


def status_counts(rows: list[Any]) -> DigestCounts:
    """Fold ``(status, n)`` rows into the calm counts. Pure/testable."""
    by = {r.status: int(r.n or 0) for r in rows}
    return DigestCounts(
        needs_reply=by.get("NEEDS_REPLY", 0),
        waiting=by.get("AWAITING", 0),
    )


def top_needs_you(items: list[DigestItem], limit: int = 3) -> list[DigestItem]:
    """The ≤``limit`` items the digest leads with. Pure (the query already orders
    by recency, so this just bounds it — kept separate so the bound is testable)."""
    return items[:limit]


@router.get("/digest", response_model=WhatsAppDigestModel)
async def digest(
    account_id: str | None = None,
    user: UserContext = Depends(get_current_user),
):
    """The WhatsApp section of the morning brief for the user's number(s)."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous"}
        scope = "IN (SELECT id FROM wa_accounts WHERE user_id = :uid"
        if account_id:
            scope += " AND id = :aid"
            params["aid"] = account_id
        scope += ")"

        status_rows = (await db.execute(
            text(f"""SELECT s.status, COUNT(*) AS n
                     FROM wa_chat_status s
                     WHERE s.account_id {scope}
                     GROUP BY s.status"""),
            params,
        )).fetchall()
        counts = status_counts(status_rows)

        counts.groups = int((await db.execute(
            text(f"SELECT COUNT(*) FROM wa_chats WHERE kind = 'group' "
                 f"AND account_id {scope}"),
            params,
        )).scalar() or 0)

        counts.muted = int((await db.execute(
            text(f"""SELECT COUNT(*) FROM wa_messages
                     WHERE intent = ANY(:muted) AND account_id {scope}"""),
            {**params, "muted": list(_MUTED_INTENTS)},
        )).scalar() or 0)

        need_rows = (await db.execute(
            text(f"""SELECT c.id, c.name, c.wa_chat_id,
                            lm.body_text AS snippet, lm.intent AS intent
                     FROM wa_chat_status s
                     JOIN wa_chats c ON c.id = s.chat_id
                     LEFT JOIN LATERAL (
                         SELECT body_text, intent FROM wa_messages m
                         WHERE m.chat_id = c.id
                         ORDER BY m.sent_at DESC NULLS LAST LIMIT 1
                     ) lm ON TRUE
                     WHERE s.status = 'NEEDS_REPLY' AND s.account_id {scope}
                     ORDER BY s.last_message_at DESC NULLS LAST
                     LIMIT 3"""),
            params,
        )).fetchall()
        needs_you = top_needs_you([
            DigestItem(
                chat_id=str(r.id),
                name=r.name or r.wa_chat_id,
                snippet=(r.snippet or "")[:120],
                intent=r.intent,
            )
            for r in need_rows
        ])

        return WhatsAppDigestModel(needs_you=needs_you, counts=counts)
    finally:
        await db.close()
