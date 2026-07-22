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
from gateway.routes.email.automation.senders import canonical_cleanup_category
from gateway.routes.email.core import (
    _assert_account_owner,
    _get_db,
    _instantiate_provider,
    _log,
    _persist_rotated_creds,
    router,
)
from pydantic import BaseModel
from sqlalchemy import text


# The digest is a PROJECTION of the same windowed inbox aggregates the Analytics
# screen reports — never a parallel re-derivation with its own (drifting) rules.
# Each section below is one small aggregate helper so _generate_digest just
# composes them, and each can be pinned by a test. The window is inbound inbox
# mail only, and the account's OWN address is excluded everywhere: self-notes,
# BCC-to-self, automation — and the digest email itself, which lands in the inbox
# from the account and would otherwise inflate the NEXT digest's counts.
#
# ``_INBOUND`` is the shared predicate: inbox folder, not from self. ``em`` is the
# table alias; ``:aid``/``:days``/``:self`` come from the shared params.
_DIGEST_WIN = ("em.account_id = :aid AND em.received_at >= "
               "now() - make_interval(days => :days)")
_DIGEST_INBOUND = ("LOWER(em.folder) = 'inbox' "
                   "AND (:self = '' OR LOWER(em.from_address->>'email') <> :self)")


async def _digest_totals(db: Any, params: dict[str, Any]) -> dict[str, int]:
    """New inbound inbox mail in the window: count, unread, with-attachments."""
    row = (await db.execute(text(
        f"""SELECT COUNT(*) AS inbox,
                   COUNT(*) FILTER (WHERE is_read = false) AS unread,
                   COUNT(*) FILTER (WHERE has_attachments) AS attachments
            FROM email_messages em
            WHERE {_DIGEST_WIN} AND {_DIGEST_INBOUND}"""
    ), params)).fetchone()
    return {
        "inbox": (row.inbox if row else 0) or 0,
        "unread": (row.unread if row else 0) or 0,
        "attachments": (row.attachments if row else 0) or 0,
    }


async def _digest_categories(
    db: Any, params: dict[str, Any], cat_clause: str,
) -> list[dict[str, Any]]:
    """Category breakdown of the window's inbound inbox mail, by sender category
    (the same email_senders rollup the Analytics category chart reads)."""
    rows = (await db.execute(text(
        f"""SELECT COALESCE(s.category, 'Unknown') AS category, COUNT(*) AS c
            FROM email_messages em
            LEFT JOIN email_senders s
              ON s.account_id = em.account_id
             AND s.email = LOWER(em.from_address->>'email')
            WHERE {_DIGEST_WIN} AND {_DIGEST_INBOUND}{cat_clause}
            GROUP BY 1 ORDER BY 2 DESC"""
    ), params)).fetchall()
    return [{"category": r.category, "count": r.c} for r in rows]


async def _digest_top_senders(
    db: Any, params: dict[str, Any],
) -> list[dict[str, Any]]:
    """The window's noisiest inbound senders (Analytics' 'noisy senders', capped
    to the digest's shorter list)."""
    rows = (await db.execute(text(
        f"""SELECT MAX(em.from_address->>'name') AS name,
                   LOWER(em.from_address->>'email') AS email, COUNT(*) AS c
            FROM email_messages em
            WHERE {_DIGEST_WIN} AND {_DIGEST_INBOUND}
              AND COALESCE(em.from_address->>'email','') <> ''
            GROUP BY 2 ORDER BY 3 DESC LIMIT 8"""
    ), params)).fetchall()
    return [
        {"name": r.name or r.email, "email": r.email, "count": r.c}
        for r in rows
    ]


async def _digest_needs_reply(db: Any, account_id: str) -> int:
    """Threads the user actually owes a reply on — the Reply Zero classification
    (email_thread_status), the SAME source analytics._backlog reads. Never the
    old heuristic that counted every inbox-tailed thread all-time."""
    return (await db.execute(text(
        """SELECT COUNT(*) FROM email_thread_status
           WHERE account_id = :aid AND status = 'NEEDS_REPLY'"""
    ), {"aid": account_id})).scalar() or 0


def _digest_is_empty(digest: dict) -> bool:
    """A digest with no new mail AND nothing awaiting a reply is noise — the
    scheduler suppresses it rather than mailing an empty summary every morning."""
    t = digest["totals"]
    return (t["inbox"] == 0 and t["needs_reply"] == 0
            and not digest["by_category"] and not digest["top_senders"])


def _render_digest_markdown(
    period: str, totals: dict, needs: int,
    by_category: list[dict], top_senders: list[dict],
) -> str:
    lines = [
        f"# Inbox digest — last {period}",
        "",
        f"**{totals['inbox']}** new in inbox · **{totals['unread']}** unread · "
        f"**{needs}** threads awaiting your reply · "
        f"**{totals['attachments']}** with attachments",
        "",
        "## By category",
    ]
    lines += [f"- **{c['category']}**: {c['count']}"
              for c in by_category] or ["- (none)"]
    lines += ["", "## Top senders"]
    lines += [f"- {s['name']} — {s['count']}"
              for s in top_senders] or ["- (none)"]
    return "\n".join(lines)


def _esc(s: Any) -> str:
    """Minimal HTML escape for the small, trusted digest strings."""
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;"))


def _render_digest_html(
    period: str, totals: dict, needs: int,
    by_category: list[dict], top_senders: list[dict],
) -> str:
    """A simple, self-contained HTML body so the emailed digest renders as more
    than a wall of Markdown asterisks in a mail client."""
    def _ul(items: list[str]) -> str:
        if not items:
            return "<p style='color:#888'>(none)</p>"
        lis = "".join(f"<li>{it}</li>" for it in items)
        return f"<ul style='margin:4px 0 12px;padding-left:20px'>{lis}</ul>"

    cats = _ul([f"<b>{_esc(c['category'])}</b>: {c['count']}"
                for c in by_category])
    senders = _ul([f"{_esc(s['name'])} — {s['count']}" for s in top_senders])
    return (
        "<div style='font-family:-apple-system,Segoe UI,Roboto,sans-serif;"
        "max-width:560px;color:#1a1a1a'>"
        f"<h2 style='margin:0 0 4px'>Inbox digest — last {_esc(period)}</h2>"
        "<p style='font-size:15px;margin:8px 0 16px'>"
        f"<b>{totals['inbox']}</b> new in inbox &middot; "
        f"<b>{totals['unread']}</b> unread &middot; "
        f"<b>{needs}</b> awaiting your reply &middot; "
        f"<b>{totals['attachments']}</b> with attachments</p>"
        "<h3 style='margin:0 0 4px;font-size:13px;text-transform:uppercase;"
        f"color:#666'>By category</h3>{cats}"
        "<h3 style='margin:0 0 4px;font-size:13px;text-transform:uppercase;"
        f"color:#666'>Top senders</h3>{senders}"
        "</div>"
    )


async def _generate_digest(
    db: Any, account_id: str, period_days: int,
    categories: list[str] | None = None,
) -> dict:
    """Build an inbox digest for the window by COMPOSING the shared aggregates
    above (totals, category breakdown, top senders, needs-reply). Deterministic
    (no LLM). Returns both a Markdown and an HTML body.

    `categories` (optional) restricts the category breakdown to the selected
    sender categories ("Cold Emails" maps to the "Cold Email" category); empty
    or None includes everything.
    """
    params: dict[str, Any] = {"aid": account_id, "days": period_days}
    self_row = (await db.execute(text(
        "SELECT LOWER(email_address) AS self FROM email_accounts WHERE id = :aid"
    ), {"aid": account_id})).fetchone()
    params["self"] = (getattr(self_row, "self", "") or "") if self_row else ""
    # The UI offers rule names ("Cold Emails", "newsletter", " Marketing "); the
    # sender rollup stores canonical cleanup categories. Normalise each selection
    # through the same canonicaliser the cleaner uses, so casing/whitespace/plural
    # variants match and a name that isn't a category (which could never match a
    # sender category anyway) is dropped rather than silently emptying the section.
    raw_cats = ["Cold Email" if c == "Cold Emails" else c
                for c in (categories or [])]
    cats = sorted({canonical_cleanup_category(c) for c in raw_cats} - {None})
    cat_clause = ""
    if cats:
        params["cats"] = cats
        cat_clause = " AND COALESCE(s.category, 'Unknown') = ANY(:cats)"

    totals = await _digest_totals(db, params)
    by_category = await _digest_categories(db, params, cat_clause)
    top_senders = await _digest_top_senders(db, params)
    needs = await _digest_needs_reply(db, account_id)
    totals["needs_reply"] = needs

    period = ("day" if period_days <= 1
              else ("week" if period_days <= 7 else f"{period_days} days"))
    return {
        "period_days": period_days,
        "totals": totals,
        "by_category": by_category,
        "top_senders": top_senders,
        "markdown": _render_digest_markdown(
            period, totals, needs, by_category, top_senders),
        "html": _render_digest_html(
            period, totals, needs, by_category, top_senders),
    }


async def _configured_categories(db: Any, account_id: str) -> list[str]:
    """The account's saved digest_categories, so the manual preview and the
    'send now' endpoint filter exactly like the scheduled digest — otherwise the
    user previews one thing and the scheduler emails another."""
    row = (await db.execute(text(
        "SELECT digest_categories FROM email_assistant_settings "
        "WHERE account_id = :aid"
    ), {"aid": account_id})).fetchone()
    return list(getattr(row, "digest_categories", None) or []) if row else []


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
        cats = await _configured_categories(db, account_id)
        return await _generate_digest(db, account_id, days, cats)
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
        cats = await _configured_categories(db, req.account_id)
        digest = await _generate_digest(db, req.account_id, days, cats)
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
            body_html=digest["html"],
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
        # Empty-digest suppression: a scheduled digest with no new mail and
        # nothing awaiting a reply is noise. Skip the send WITHOUT stamping
        # last_digest_at, so the moment real mail arrives (still past the send
        # time) the next cycle delivers one.
        if _digest_is_empty(digest):
            _log.info("email.digest_suppressed_empty", account_id=account_id)
            return
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
            body_html=digest["html"],
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
