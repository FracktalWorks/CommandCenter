"""WhatsApp Pulse — the founder-CEO's "am I keeping up?" projection (W7).

A read-only insights endpoint over the classified store: how fast the founder is
replying, who has waited longest, where the inbound load is coming from, and the
busiest conversations. Like the digest it never classifies — it projects what the
pipeline already wrote. The aggregation helpers (median / percentile / the
response-time fold) are pure so the maths is unit-testable without a database.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, Query
from gateway.routes.whatsapp.core import _get_db, router
from pydantic import BaseModel
from sqlalchemy import text

_MAX_WINDOW_DAYS = 90
_RESPONSE_SAMPLE_CAP = 5000       # bound the reply-latency pull


def median(nums: list[float]) -> float | None:
    """The median of a list, or None if empty. Pure."""
    vals = sorted(n for n in nums if n is not None)
    if not vals:
        return None
    mid = len(vals) // 2
    if len(vals) % 2:
        return float(vals[mid])
    return (vals[mid - 1] + vals[mid]) / 2.0


def percentile(nums: list[float], p: float) -> float | None:
    """The ``p``-th percentile (0-100) via nearest-rank. Pure, None if empty."""
    vals = sorted(n for n in nums if n is not None)
    if not vals:
        return None
    if p <= 0:
        return float(vals[0])
    if p >= 100:
        return float(vals[-1])
    # nearest-rank: ceil(p/100 * N) - 1, clamped
    rank = max(0, min(len(vals) - 1, (int((p / 100.0) * len(vals) + 0.9999)) - 1))
    return float(vals[rank])


def summarize_response_times(minutes: list[float]) -> dict[str, Any]:
    """Fold reply-latency samples (minutes) into replied/median/p90. Pure."""
    clean = [m for m in minutes if m is not None and m >= 0]
    return {
        "replied": len(clean),
        "median_minutes": median(clean),
        "p90_minutes": percentile(clean, 90),
    }


class WaitingItem(BaseModel):
    chat_id: str
    name: str
    waited_hours: float
    snippet: str = ""


class CountItem(BaseModel):
    key: str
    count: int


class BusiestItem(BaseModel):
    chat_id: str
    name: str
    count: int


class PulseModel(BaseModel):
    window_days: int
    inbound: int = 0
    outbound: int = 0
    active_chats: int = 0
    response: dict[str, Any] = {}         # replied / median_minutes / p90_minutes
    waiting_longest: list[WaitingItem] = []
    by_intent: list[CountItem] = []
    busiest: list[BusiestItem] = []


@router.get("/pulse", response_model=PulseModel)
async def pulse(
    account_id: str | None = None,
    days: int = Query(7, ge=1, le=_MAX_WINDOW_DAYS),
    user: UserContext = Depends(get_current_user),
):
    """WhatsApp health over the last ``days``: reply speed, who's waited longest,
    inbound load by intent, and the busiest chats."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous", "days": days}
        scope = "IN (SELECT id FROM wa_accounts WHERE user_id = :uid"
        if account_id:
            scope += " AND id = :aid"
            params["aid"] = account_id
        scope += ")"
        window = "sent_at >= now() - make_interval(days => :days)"

        # Totals in/out + active chats.
        dir_rows = (await db.execute(
            text(f"""SELECT direction, COUNT(*) AS n FROM wa_messages
                     WHERE account_id {scope} AND {window}
                     GROUP BY direction"""),
            params,
        )).fetchall()
        by_dir = {r.direction: int(r.n or 0) for r in dir_rows}
        active = int((await db.execute(
            text(f"""SELECT COUNT(DISTINCT chat_id) FROM wa_messages
                     WHERE account_id {scope} AND {window}"""),
            params,
        )).scalar() or 0)

        # Reply latency: minutes from each answered inbound to the next outbound.
        lat_rows = (await db.execute(
            text(f"""SELECT EXTRACT(EPOCH FROM (o.sent_at - m.sent_at)) / 60.0 AS mins
                     FROM wa_messages m
                     JOIN LATERAL (
                         SELECT sent_at FROM wa_messages o2
                         WHERE o2.chat_id = m.chat_id AND o2.direction = 'out'
                           AND o2.sent_at > m.sent_at
                         ORDER BY o2.sent_at ASC LIMIT 1
                     ) o ON TRUE
                     WHERE m.account_id {scope} AND m.direction = 'in' AND m.{window}
                     LIMIT :cap"""),
            {**params, "cap": _RESPONSE_SAMPLE_CAP},
        )).fetchall()
        response = summarize_response_times(
            [float(r.mins) for r in lat_rows if r.mins is not None])

        # Who has waited longest — open NEEDS_REPLY, not snoozed, oldest first.
        waiting_rows = (await db.execute(
            text(f"""SELECT c.id, c.name, s.last_message_at,
                            EXTRACT(EPOCH FROM (now() - s.last_message_at)) / 3600.0
                              AS waited_hours,
                            lm.body_text AS snippet
                     FROM wa_chat_status s
                     JOIN wa_chats c ON c.id = s.chat_id
                     LEFT JOIN LATERAL (
                         SELECT body_text FROM wa_messages m
                         WHERE m.chat_id = c.id
                         ORDER BY m.sent_at DESC NULLS LAST LIMIT 1
                     ) lm ON TRUE
                     WHERE s.account_id {scope} AND s.status = 'NEEDS_REPLY'
                       AND (s.snoozed_until IS NULL OR s.snoozed_until <= now())
                       AND s.last_message_at IS NOT NULL
                     ORDER BY s.last_message_at ASC LIMIT 5"""),
            params,
        )).fetchall()
        waiting = [
            WaitingItem(
                chat_id=str(r.id), name=r.name or "?",
                waited_hours=round(float(r.waited_hours or 0), 1),
                snippet=(r.snippet or "")[:100],
            )
            for r in waiting_rows
        ]

        # Inbound load by intent.
        intent_rows = (await db.execute(
            text(f"""SELECT intent, COUNT(*) AS n FROM wa_messages
                     WHERE account_id {scope} AND direction = 'in'
                       AND intent IS NOT NULL AND {window}
                     GROUP BY intent ORDER BY n DESC LIMIT 8"""),
            params,
        )).fetchall()
        by_intent = [
            CountItem(key=r.intent, count=int(r.n or 0)) for r in intent_rows
        ]

        # Busiest conversations by message volume.
        busy_rows = (await db.execute(
            text(f"""SELECT c.id, c.name, COUNT(*) AS n
                     FROM wa_messages m JOIN wa_chats c ON c.id = m.chat_id
                     WHERE m.account_id {scope} AND m.{window}
                     GROUP BY c.id, c.name ORDER BY n DESC LIMIT 5"""),
            params,
        )).fetchall()
        busiest = [
            BusiestItem(chat_id=str(r.id), name=r.name or "?", count=int(r.n or 0))
            for r in busy_rows
        ]

        return PulseModel(
            window_days=days,
            inbound=by_dir.get("in", 0),
            outbound=by_dir.get("out", 0),
            active_chats=active,
            response=response,
            waiting_longest=waiting,
            by_intent=by_intent,
            busiest=busiest,
        )
    finally:
        await db.close()
