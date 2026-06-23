"""Inbox digest endpoints + scheduler hook (split out of the big email router).

Routes attach to the shared ``router`` defined in ``gateway.routes.email``; this
module is imported at the bottom of that module so its routes register. The
scheduler imports ``_maybe_send_digest`` via ``gateway.routes.email`` (re-exported
there), so it stays importable from the original location.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text

from gateway.routes.email import (
    _assert_account_owner,
    _get_db,
    _instantiate_provider,
    _log,
    _persist_rotated_creds,
    router,
)


async def _generate_digest(
    db: Any, account_id: str, period_days: int,
    categories: list[str] | None = None,
) -> dict:
    """Build an inbox digest for the window: totals, category breakdown, top
    senders, and how many threads need a reply. Deterministic (no LLM).

    `categories` (optional) restricts the category breakdown to the selected
    sender categories ("Cold Emails" maps to the "Cold Email" category); empty
    or None includes everything.
    """
    params: dict[str, Any] = {"aid": account_id, "days": period_days}
    win = ("em.account_id = :aid AND em.received_at >= "
           "now() - make_interval(days => :days)")
    cats = ["Cold Email" if c == "Cold Emails" else c for c in (categories or [])]
    cat_clause = ""
    if cats:
        params["cats"] = cats
        cat_clause = " AND COALESCE(s.category, 'Unknown') = ANY(:cats)"

    totals = (await db.execute(text(
        f"""SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE is_read = false) AS unread,
                   COUNT(*) FILTER (WHERE LOWER(folder) = 'inbox') AS inbox,
                   COUNT(*) FILTER (WHERE has_attachments) AS attachments
            FROM email_messages em WHERE {win}"""
    ), params)).fetchone()

    cat_rows = (await db.execute(text(
        f"""SELECT COALESCE(s.category, 'Unknown') AS category, COUNT(*) AS c
            FROM email_messages em
            LEFT JOIN email_senders s
              ON s.account_id = em.account_id
             AND s.email = LOWER(em.from_address->>'email')
            WHERE {win} AND LOWER(em.folder) = 'inbox'{cat_clause}
            GROUP BY 1 ORDER BY 2 DESC"""
    ), params)).fetchall()

    sender_rows = (await db.execute(text(
        f"""SELECT MAX(from_address->>'name') AS name,
                   LOWER(from_address->>'email') AS email, COUNT(*) AS c
            FROM email_messages em
            WHERE {win} AND LOWER(folder) = 'inbox'
              AND COALESCE(from_address->>'email','') <> ''
            GROUP BY 2 ORDER BY 3 DESC LIMIT 8"""
    ), params)).fetchall()

    needs = (await db.execute(text(
        """WITH latest AS (
             SELECT DISTINCT ON (thread_id) thread_id, folder
             FROM email_messages
             WHERE account_id = :aid AND thread_id IS NOT NULL
             ORDER BY thread_id, received_at DESC)
           SELECT COUNT(*) AS c FROM latest WHERE LOWER(folder) = 'inbox'"""
    ), {"aid": account_id})).scalar() or 0

    period = "day" if period_days <= 1 else ("week" if period_days <= 7 else f"{period_days} days")
    by_category = [{"category": r.category, "count": r.c} for r in cat_rows]
    top_senders = [
        {"name": r.name or r.email, "email": r.email, "count": r.c}
        for r in sender_rows
    ]

    lines = [
        f"# Inbox digest — last {period}",
        "",
        f"**{totals.inbox or 0}** new in inbox · **{totals.unread or 0}** unread · "
        f"**{needs}** threads awaiting your reply · "
        f"**{totals.attachments or 0}** with attachments",
        "",
        "## By category",
    ]
    lines += [f"- **{c['category']}**: {c['count']}" for c in by_category] or ["- (none)"]
    lines += ["", "## Top senders"]
    lines += [f"- {s['name']} — {s['count']}" for s in top_senders] or ["- (none)"]

    return {
        "period_days": period_days,
        "totals": {
            "inbox": totals.inbox or 0,
            "unread": totals.unread or 0,
            "attachments": totals.attachments or 0,
            "needs_reply": needs,
        },
        "by_category": by_category,
        "top_senders": top_senders,
        "markdown": "\n".join(lines),
    }


@router.get("/digest")
async def get_digest(
    account_id: str = Query(...),
    period: str = Query("day"),  # day | week
    user: UserContext = Depends(get_current_user),
):
    """Generate an inbox digest for the account (day or week window)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        days = 7 if period == "week" else 1
        return await _generate_digest(db, account_id, days)
    finally:
        await db.close()


class DigestSendRequest(BaseModel):
    account_id: str
    period: str = "day"


@router.post("/digest/send")
async def send_digest(
    req: DigestSendRequest,
    user: UserContext = Depends(get_current_user),
):
    """Generate the digest and email it to the account's own address."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        days = 7 if req.period == "week" else 1
        digest = await _generate_digest(db, req.account_id, days)
        acc = (await db.execute(text(
            "SELECT provider, credentials_encrypted, email_address "
            "FROM email_accounts WHERE id = :id"
        ), {"id": req.account_id})).fetchone()
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(acc.credentials_encrypted))
        provider = _instantiate_provider(acc.provider, creds)
        if not await provider.authenticate():
            raise HTTPException(status_code=502, detail="Provider auth failed")
        await provider.send_message(
            to=[acc.email_address],
            subject=f"📥 Your inbox digest — last {'week' if days > 1 else 'day'}",
            body_text=digest["markdown"],
        )
        await _persist_rotated_creds(db, store, req.account_id, provider)
        await db.execute(text(
            "UPDATE email_assistant_settings SET last_digest_at = now() "
            "WHERE account_id = :aid"
        ), {"aid": req.account_id})
        await db.commit()
        return {"sent": True, "to": acc.email_address}
    finally:
        await db.close()


async def _maybe_send_digest(account_id: str) -> None:
    """Background: send a digest if one is due per the account's schedule.

    Honors digest_frequency (DAILY/WEEKLY), digest_time_of_day (don't send
    before that UTC time), digest_day_of_week (WEEKLY only; 0=Sun…6=Sat),
    digest_categories (which categories to include) and digest_send_to_email.
    """
    db = await _get_db()
    try:
        row = (await db.execute(text(
            """SELECT digest_frequency, last_digest_at, digest_time_of_day,
                      digest_day_of_week, digest_categories, digest_send_to_email
               FROM email_assistant_settings WHERE account_id = :aid"""
        ), {"aid": account_id})).fetchone()
        if not row or (row.digest_frequency or "OFF") == "OFF":
            return
        if not bool(getattr(row, "digest_send_to_email", True)):
            return  # email is the only channel today; nothing to deliver
        period_days = 7 if row.digest_frequency == "WEEKLY" else 1
        now = datetime.now(timezone.utc)

        # Parse the configured send time (HH:MM, treated as UTC).
        try:
            hh, mm = (getattr(row, "digest_time_of_day", None) or "09:00").split(":")
            send_at = now.replace(
                hour=int(hh), minute=int(mm), second=0, microsecond=0)
        except (ValueError, AttributeError):
            send_at = now.replace(hour=9, minute=0, second=0, microsecond=0)
        if now < send_at:
            return  # too early in the day

        if row.digest_frequency == "WEEKLY":
            # email_assistant_settings uses JS weekdays (0=Sun); Python's
            # weekday() is 0=Mon, so shift.
            js_dow = (now.weekday() + 1) % 7
            if js_dow != int(getattr(row, "digest_day_of_week", 1) or 1):
                return
            min_gap = timedelta(days=6)
        else:
            min_gap = timedelta(hours=20)

        last = row.last_digest_at
        if last is not None and (last > now - min_gap or last >= send_at):
            return  # already sent recently / already sent today after send time

        categories = list(getattr(row, "digest_categories", None) or [])
        digest = await _generate_digest(db, account_id, period_days, categories)
        acc = (await db.execute(text(
            "SELECT provider, credentials_encrypted, email_address "
            "FROM email_accounts WHERE id = :id"
        ), {"id": account_id})).fetchone()
        if not acc:
            return
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(acc.credentials_encrypted))
        provider = _instantiate_provider(acc.provider, creds)
        if not await provider.authenticate():
            return
        await provider.send_message(
            to=[acc.email_address],
            subject=f"📥 Your inbox digest — last "
                    f"{'week' if period_days > 1 else 'day'}",
            body_text=digest["markdown"],
        )
        await _persist_rotated_creds(db, store, account_id, provider)
        await db.execute(text(
            "UPDATE email_assistant_settings SET last_digest_at = now() "
            "WHERE account_id = :aid"
        ), {"aid": account_id})
        await db.commit()
        _log.info("email.digest_sent", account_id=account_id)
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.digest_send_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()
