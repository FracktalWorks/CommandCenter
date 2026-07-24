"""Transport · snooze — defer a chat until later, then let it resurface (W6).

Snooze is an orthogonal overlay on Reply Zero: the chat keeps its real status
(NEEDS_REPLY / AWAITING / …); ``wa_chat_status.snoozed_until`` only hides it from
the triage streams until the time passes. The queue reads filter
``snoozed_until IS NULL OR snoozed_until <= now()``, so a snooze auto-expires with
no batch, and a new inbound message clears it in ``recompute_chat_status``.

The absolute wake time is computed by the CLIENT (which knows the founder's
timezone) and sent as an ISO-8601 instant; the server just validates it is a
real, future timestamp. ``parse_snooze_until`` is pure/testable.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException
from gateway.routes.whatsapp.automation.replyzero import recompute_chat_status
from gateway.routes.whatsapp.core import _get_db, router
from pydantic import BaseModel
from sqlalchemy import text

# A snooze past this horizon is almost certainly a client bug (bad tz math), not
# an intent — reject it rather than bury a chat for years.
_MAX_SNOOZE_DAYS = 400


def parse_snooze_until(until: str | None, now: datetime) -> datetime:
    """Validate a client-supplied ISO-8601 wake time. Pure.

    Returns a timezone-aware UTC datetime, or raises ``ValueError`` when the
    value is missing, unparseable, not in the future, or absurdly far out.
    """
    if not until or not until.strip():
        raise ValueError("a snooze time is required")
    raw = until.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"unparseable snooze time: {until!r}") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    dt = dt.astimezone(UTC)
    if dt <= now:
        raise ValueError("snooze time must be in the future")
    if (dt - now).days > _MAX_SNOOZE_DAYS:
        raise ValueError("snooze time is too far in the future")
    return dt


class SnoozeRequest(BaseModel):
    until: str            # ISO-8601 instant, e.g. "2026-07-25T03:30:00Z"


class SnoozeModel(BaseModel):
    chat_id: str
    snoozed_until: str | None = None


async def _assert_chat_owned(db: Any, chat_id: str, user_email: str) -> str:
    row = (await db.execute(
        text("""SELECT c.account_id, a.phone_number
                FROM wa_chats c JOIN wa_accounts a ON a.id = c.account_id
                WHERE c.id = :cid AND a.user_id = :uid"""),
        {"cid": chat_id, "uid": user_email},
    )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Chat not found")
    return str(row.account_id)


@router.post("/chats/{chat_id}/snooze", response_model=SnoozeModel)
async def snooze_chat(
    chat_id: str, req: SnoozeRequest,
    user: UserContext = Depends(get_current_user),
):
    """Snooze a chat out of the triage queue until ``until``. It reappears on its
    own when the time passes, or immediately if they send a new message."""
    try:
        when = parse_snooze_until(req.until, datetime.now(UTC))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    db = await _get_db()
    try:
        account_id = await _assert_chat_owned(db, chat_id, user.email or "anonymous")
        # Ensure a status row exists (a never-classified chat has none yet), then
        # stamp the snooze onto it.
        await recompute_chat_status(db, account_id, chat_id)
        result = (await db.execute(
            text("""UPDATE wa_chat_status SET snoozed_until = :until
                    WHERE account_id = :aid AND chat_id = :cid
                    RETURNING snoozed_until"""),
            {"until": when, "aid": account_id, "cid": chat_id},
        )).fetchone()
        if result is None:
            # No status row and no messages to classify — nothing to snooze.
            raise HTTPException(
                status_code=422, detail="Nothing to snooze in this chat yet")
        await db.commit()
        return SnoozeModel(chat_id=chat_id, snoozed_until=when.isoformat())
    finally:
        await db.close()


@router.post("/chats/{chat_id}/unsnooze", response_model=SnoozeModel)
async def unsnooze_chat(
    chat_id: str, user: UserContext = Depends(get_current_user),
):
    """Wake a snoozed chat now — it returns to the queue with its real status."""
    db = await _get_db()
    try:
        account_id = await _assert_chat_owned(db, chat_id, user.email or "anonymous")
        await db.execute(
            text("""UPDATE wa_chat_status SET snoozed_until = NULL
                    WHERE account_id = :aid AND chat_id = :cid"""),
            {"aid": account_id, "cid": chat_id},
        )
        await db.commit()
        return SnoozeModel(chat_id=chat_id, snoozed_until=None)
    finally:
        await db.close()
