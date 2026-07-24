"""Transport · chats — the triage streams + conversation list (read-only).

Powers the calm home screen: ``/whatsapp/streams`` returns the nav counts (the
single spine), ``/whatsapp/chats`` returns the quiet, filterable conversation
list. No unread count is exposed — obligations, not unreads, by design.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, Query
from gateway.routes.whatsapp.core import WhatsAppChatModel, _get_db, router
from sqlalchemy import text

# The triage streams shown in the nav, in order. Status streams map to
# wa_chat_status.status; 'groups' is a kind filter. Counts are cheap indexed
# queries; a stream with no classifier data yet simply reads 0 (W0 is pre-triage).
_STATUS_STREAMS = {
    "needs_reply": "NEEDS_REPLY",
    "waiting": "AWAITING",
}


def _chat_model(row: Any) -> WhatsAppChatModel:
    window_open = bool(getattr(row, "window_open", False))
    return WhatsAppChatModel(
        id=str(row.id),
        account_id=str(row.account_id),
        wa_chat_id=row.wa_chat_id,
        kind=row.kind or "dm",
        name=row.name or "",
        category=row.category,
        status=getattr(row, "status", None),
        last_message_at=row.last_message_at.isoformat() if row.last_message_at else None,
        last_snippet=(getattr(row, "last_snippet", "") or "")[:140],
        window_open=window_open,
        window_expires_at=(
            row.service_window_expires_at.isoformat()
            if row.service_window_expires_at else None
        ),
    )


async def _user_account_ids(db: Any, user_email: str) -> list[str]:
    rows = (await db.execute(
        text("SELECT id FROM wa_accounts WHERE user_id = :uid"),
        {"uid": user_email},
    )).fetchall()
    return [str(r.id) for r in rows]


@router.get("/streams")
async def list_streams(
    account_id: str | None = None,
    user: UserContext = Depends(get_current_user),
):
    """Return the nav stream counts for the account(s) the user owns."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous"}
        scope = "c.account_id IN (SELECT id FROM wa_accounts WHERE user_id = :uid"
        if account_id:
            scope += " AND id = :aid"
            params["aid"] = account_id
        scope += ")"

        async def _count(where: str) -> int:
            q = f"SELECT COUNT(*) FROM wa_chats c LEFT JOIN wa_chat_status s " \
                f"ON s.account_id = c.account_id AND s.chat_id = c.id " \
                f"WHERE {scope} AND {where}"
            return int((await db.execute(text(q), params)).scalar() or 0)

        counts = {
            "needs_reply": await _count("s.status = 'NEEDS_REPLY'"),
            "waiting": await _count("s.status = 'AWAITING'"),
            "groups": await _count("c.kind = 'group'"),
            "all": await _count("TRUE"),
        }
        return counts
    finally:
        await db.close()


@router.get("/chats", response_model=list[WhatsAppChatModel])
async def list_chats(
    account_id: str | None = None,
    stream: str | None = Query(None, description="needs_reply|waiting|groups|all"),
    category: str | None = None,
    limit: int = Query(50, le=200),
    user: UserContext = Depends(get_current_user),
):
    """List conversations, newest first, optionally scoped to a stream/category."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous", "limit": limit}
        where = ["c.account_id IN (SELECT id FROM wa_accounts WHERE user_id = :uid"]
        if account_id:
            where[0] += " AND id = :aid"
            params["aid"] = account_id
        where[0] += ")"

        if stream in _STATUS_STREAMS:
            where.append("s.status = :status")
            params["status"] = _STATUS_STREAMS[stream]
        elif stream == "groups":
            where.append("c.kind = 'group'")
        if category:
            where.append("c.category = :category")
            params["category"] = category

        # Last message snippet via a lateral pull of the most recent body.
        q = f"""
            SELECT c.id, c.account_id, c.wa_chat_id, c.kind, c.name, c.category,
                   c.last_message_at, c.service_window_expires_at,
                   (c.service_window_expires_at > now()) AS window_open,
                   s.status AS status,
                   lm.body_text AS last_snippet
            FROM wa_chats c
            LEFT JOIN wa_chat_status s
              ON s.account_id = c.account_id AND s.chat_id = c.id
            LEFT JOIN LATERAL (
                SELECT body_text FROM wa_messages m
                WHERE m.chat_id = c.id
                ORDER BY m.sent_at DESC NULLS LAST LIMIT 1
            ) lm ON TRUE
            WHERE {' AND '.join(where)}
            ORDER BY c.last_message_at DESC NULLS LAST
            LIMIT :limit
        """
        rows = (await db.execute(text(q), params)).fetchall()
        return [_chat_model(r) for r in rows]
    finally:
        await db.close()
