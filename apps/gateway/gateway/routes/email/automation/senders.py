"""Automation · senders & triage — analytics, sender list, newsletters, bulk
actions, auto-archive, sender categorization, and cold-email blocking."""

from __future__ import annotations

import json
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import BackgroundTasks, Depends, HTTPException, Query
from gateway.routes.email.core import (
    _account_scope,
    _assert_account_owner,
    _get_db,
    _instantiate_provider,
    _log,
    _persist_rotated_creds,
    _safe_json,
    router,
)
from pydantic import BaseModel
from sqlalchemy import text


@router.get("/analytics/overview")
async def analytics_overview(
    account_id: str | None = Query(None),
    days: int = Query(30, ge=1, le=365),
    user: UserContext = Depends(get_current_user),
):
    """Inbox analytics: totals, read-rate, volume-over-time, top senders, folders."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous", "days": days}
        scope = _account_scope(account_id, params)

        totals = (await db.execute(text(
            f"""SELECT
                  COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE is_read = false) AS unread,
                  COUNT(*) FILTER (WHERE LOWER(folder) = 'sent') AS sent,
                  COUNT(*) FILTER (WHERE LOWER(folder) = 'archive') AS archived,
                  COUNT(*) FILTER (WHERE is_starred) AS starred,
                  COUNT(*) FILTER (WHERE has_attachments) AS with_attachments
                FROM email_messages em WHERE {scope}"""
        ), params)).fetchone()

        total = totals.total or 0
        read = total - (totals.unread or 0)
        read_rate = round(read / total, 4) if total else 0.0

        volume_rows = (await db.execute(text(
            f"""SELECT to_char(date_trunc('day', received_at), 'YYYY-MM-DD') AS day,
                       COUNT(*) FILTER (WHERE LOWER(folder) <> 'sent') AS received,
                       COUNT(*) FILTER (WHERE LOWER(folder) = 'sent') AS sent
                FROM email_messages em
                WHERE {scope} AND received_at >= now() - make_interval(days => :days)
                GROUP BY day ORDER BY day"""
        ), params)).fetchall()

        sender_rows = (await db.execute(text(
            f"""SELECT from_address->>'email' AS email,
                       MAX(from_address->>'name') AS name,
                       COUNT(*) AS count,
                       COUNT(*) FILTER (WHERE is_read = false) AS unread
                FROM email_messages em
                WHERE {scope} AND COALESCE(from_address->>'email','') <> ''
                GROUP BY email ORDER BY count DESC LIMIT 12"""
        ), params)).fetchall()

        folder_rows = (await db.execute(text(
            f"""SELECT LOWER(folder) AS folder, COUNT(*) AS count
                FROM email_messages em WHERE {scope}
                GROUP BY LOWER(folder) ORDER BY count DESC"""
        ), params)).fetchall()

        # Assistant automation stats (inbox-zero "Assistant processed emails" +
        # email-actions breakdown), from the executed-rules log. Best-effort.
        rule_scope = ("er.account_id IN (SELECT id FROM email_accounts "
                      "WHERE user_id = :uid)")
        if account_id:
            rule_scope += " AND er.account_id = :aid"
        rule_rows: list[Any] = []
        action_rows: list[Any] = []
        try:
            rule_rows = (await db.execute(text(
                f"""SELECT COALESCE(er.rule_name, '(no match)') AS rule_name,
                           COUNT(*) AS count
                    FROM email_executed_rules er
                    WHERE {rule_scope} AND er.status = 'APPLIED'
                      AND er.created_at >= now() - make_interval(days => :days)
                    GROUP BY er.rule_name ORDER BY count DESC LIMIT 10"""
            ), params)).fetchall()
            action_rows = (await db.execute(text(
                f"""SELECT act AS action, COUNT(*) AS count
                    FROM email_executed_rules er,
                         LATERAL jsonb_array_elements_text(er.actions_taken) AS act
                    WHERE {rule_scope} AND er.status = 'APPLIED'
                      AND er.created_at >= now() - make_interval(days => :days)
                    GROUP BY act ORDER BY count DESC"""
            ), params)).fetchall()
        except Exception:  # noqa: BLE001 — log table optional / empty
            rule_rows, action_rows = [], []
        processed_total = sum(r.count for r in rule_rows)

        return {
            "totals": {
                "total": total,
                "unread": totals.unread or 0,
                "sent": totals.sent or 0,
                "archived": totals.archived or 0,
                "starred": totals.starred or 0,
                "with_attachments": totals.with_attachments or 0,
                "read_rate": read_rate,
            },
            "volume": [
                {"day": r.day, "received": r.received or 0, "sent": r.sent or 0}
                for r in volume_rows
            ],
            "top_senders": [
                {"email": r.email, "name": r.name or "", "count": r.count,
                 "unread": r.unread or 0}
                for r in sender_rows
            ],
            "by_folder": [
                {"folder": r.folder, "count": r.count} for r in folder_rows
            ],
            "rule_stats": {
                "processed": processed_total,
                "by_rule": [
                    {"rule_name": r.rule_name, "count": r.count}
                    for r in rule_rows
                ],
            },
            "action_stats": [
                {"action": r.action, "count": r.count} for r in action_rows
            ],
        }
    finally:
        await db.close()


@router.get("/senders")
async def list_senders(
    account_id: str | None = Query(None),
    folder: str | None = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    user: UserContext = Depends(get_current_user),
):
    """Aggregate messages by sender, merged with newsletter status.

    Powers Archiver (volume per sender) and Unsubscriber (read-rate +
    unsubscribe link + approve/unsubscribe disposition).
    """
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous", "limit": limit}
        scope = _account_scope(account_id, params)
        folder_sql = ""
        if folder:
            folder_sql = " AND LOWER(em.folder) = LOWER(:folder)"
            params["folder"] = folder

        rows = (await db.execute(text(
            f"""SELECT LOWER(from_address->>'email') AS email,
                       MAX(from_address->>'name') AS name,
                       COUNT(*) AS count,
                       COUNT(*) FILTER (WHERE is_read = false) AS unread,
                       COUNT(*) FILTER (WHERE LOWER(folder) = 'archive') AS archived,
                       MAX(received_at) AS last_received,
                       MAX(unsubscribe_link) AS unsubscribe_link
                FROM email_messages em
                WHERE {scope}{folder_sql}
                  AND COALESCE(from_address->>'email','') <> ''
                GROUP BY LOWER(from_address->>'email')
                ORDER BY count DESC LIMIT :limit"""
        ), params)).fetchall()

        # Merge newsletter disposition (APPROVED/UNSUBSCRIBED/AUTO_ARCHIVED).
        nl_params: dict[str, Any] = {"uid": user.email or "anonymous"}
        nl_scope = (
            "account_id IN (SELECT id FROM email_accounts WHERE user_id = :uid"
        )
        if account_id:
            nl_scope += " AND id = :aid"
            nl_params["aid"] = account_id
        nl_scope += ")"
        nl_rows = (await db.execute(text(
            f"SELECT LOWER(email) AS email, status FROM email_newsletters WHERE {nl_scope}"
        ), nl_params)).fetchall()
        status_by_email = {r.email: r.status for r in nl_rows}

        # Merge assigned categories (same account scope as newsletters).
        cat_rows = (await db.execute(text(
            f"SELECT LOWER(email) AS email, category FROM email_senders "
            f"WHERE {nl_scope}"
        ), nl_params)).fetchall()
        category_by_email = {r.email: r.category for r in cat_rows if r.category}

        return {
            "senders": [
                {
                    "email": r.email,
                    "name": r.name or "",
                    "count": r.count,
                    "unread": r.unread or 0,
                    "archived": r.archived or 0,
                    "read_rate": round((r.count - (r.unread or 0)) / r.count, 4)
                    if r.count else 0.0,
                    "last_received": r.last_received.isoformat()
                    if r.last_received else None,
                    "unsubscribe_link": r.unsubscribe_link,
                    # "UNHANDLED" = no decision yet (inbox-zero parity); only the
                    # three real dispositions are ever persisted.
                    "status": status_by_email.get(r.email, "UNHANDLED"),
                    "category": category_by_email.get(r.email),
                }
                for r in rows
            ]
        }
    finally:
        await db.close()


class BulkActionRequest(BaseModel):
    action: str  # archive | trash | read | unread | star | unstar
    account_id: str | None = None
    message_ids: list[str] | None = None
    sender_email: str | None = None
    folder: str | None = None
    older_than_days: int | None = None
    only_read: bool | None = None


_BULK_DB_UPDATE = {
    "archive": "folder = 'archive'",
    "trash": "folder = 'trash'",
    "read": "is_read = true",
    "unread": "is_read = false",
    "star": "is_starred = true",
    "unstar": "is_starred = false",
}


_BULK_MAX = 1000


@router.post("/messages/bulk")
async def bulk_action(
    req: BulkActionRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Apply an action to many messages at once (archive/trash/read/star).

    The local DB is updated synchronously (authoritative for the UI); the
    provider is reconciled in the background so the request stays fast.
    """
    if req.action not in _BULK_DB_UPDATE:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown action '{req.action}'. "
            f"Supported: {', '.join(_BULK_DB_UPDATE)}",
        )

    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous"}
        scope = _account_scope(req.account_id, params)
        clauses = [scope]
        if req.message_ids:
            clauses.append("em.id::text = ANY(:ids)")
            params["ids"] = req.message_ids
        if req.sender_email:
            clauses.append("LOWER(em.from_address->>'email') = LOWER(:sender)")
            params["sender"] = req.sender_email
        if req.folder:
            clauses.append("LOWER(em.folder) = LOWER(:folder)")
            params["folder"] = req.folder
        if req.older_than_days:
            clauses.append("em.received_at < now() - make_interval(days => :odays)")
            params["odays"] = req.older_than_days
        if req.only_read:
            clauses.append("em.is_read = true")
        where_sql = " AND ".join(clauses)

        # Resolve target rows (capped) — keep provider ids for reconciliation.
        rows = (await db.execute(text(
            f"""SELECT em.id, em.provider_message_id, em.account_id, ea.provider
                FROM email_messages em
                JOIN email_accounts ea ON em.account_id = ea.id
                WHERE {where_sql}
                LIMIT {_BULK_MAX}"""
        ), params)).fetchall()
        if not rows:
            return {"affected": 0}

        ids = [str(r.id) for r in rows]
        await db.execute(text(
            f"UPDATE email_messages SET {_BULK_DB_UPDATE[req.action]}, "
            f"updated_at = now() WHERE id::text = ANY(:ids)"
        ), {"ids": ids})
        await db.commit()

        # Group provider message ids per account for background reconciliation.
        per_account: dict[str, list[str]] = {}
        for r in rows:
            per_account.setdefault(str(r.account_id), []).append(r.provider_message_id)
        for aid, pmids in per_account.items():
            background.add_task(_bulk_reconcile_provider, aid, pmids, req.action)

        return {"affected": len(ids)}
    finally:
        await db.close()


async def _bulk_reconcile_provider(
    account_id: str, provider_msg_ids: list[str], action: str
) -> None:
    """Best-effort: push a bulk action to the provider (runs in background)."""
    db = await _get_db()
    try:
        row = (await db.execute(text(
            "SELECT provider, credentials_encrypted FROM email_accounts WHERE id = :id"
        ), {"id": account_id})).fetchone()
        if not row:
            return
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))
        provider = _instantiate_provider(row.provider, creds)
        if not await provider.authenticate():
            return
        for pmid in provider_msg_ids:
            try:
                if action == "archive":
                    await provider.move_to_folder(pmid, "archive")
                elif action == "trash":
                    await provider.trash_message(pmid)
                elif action == "read":
                    await provider.apply_flags(pmid, is_read=True)
                elif action == "unread":
                    await provider.apply_flags(pmid, is_read=False)
                elif action == "star":
                    await provider.apply_flags(pmid, is_starred=True)
                elif action == "unstar":
                    await provider.apply_flags(pmid, is_starred=False)
            except Exception as exc:  # noqa: BLE001
                _log.warning("email.bulk_reconcile_item_failed",
                             pmid=pmid, action=action, error=str(exc)[:120])
        await _persist_rotated_creds(db, store, account_id, provider)
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.bulk_reconcile_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()


async def _maybe_auto_archive(account_id: str) -> None:
    """Archive freshly-synced inbox mail from senders marked AUTO_ARCHIVED (the
    bulk-archive 'Auto' action), then reconcile to the provider. This is what
    makes auto-archive apply to FUTURE mail, not just existing. Idempotent."""
    db = await _get_db()
    try:
        rows = (await db.execute(text(
            """SELECT em.id, em.provider_message_id
               FROM email_messages em
               JOIN email_newsletters nl
                 ON nl.account_id = em.account_id
                AND LOWER(nl.email) = LOWER(em.from_address->>'email')
               WHERE em.account_id = :aid AND nl.status = 'AUTO_ARCHIVED'
                 AND LOWER(em.folder) = 'inbox'"""
        ), {"aid": account_id})).fetchall()
        if not rows:
            return
        ids = [str(r.id) for r in rows]
        pmids = [r.provider_message_id for r in rows if r.provider_message_id]
        await db.execute(text(
            "UPDATE email_messages SET folder = 'archive', updated_at = now() "
            "WHERE id::text = ANY(:ids)"
        ), {"ids": ids})
        await db.commit()
        if pmids:
            await _bulk_reconcile_provider(account_id, pmids, "archive")
        _log.info("email.auto_archive_pass",
                  account_id=account_id, archived=len(ids))
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.auto_archive_failed",
                     account_id=account_id, error=str(exc)[:200])
    finally:
        await db.close()


class NewsletterUpdate(BaseModel):
    account_id: str
    email: str
    name: str | None = None
    status: str  # APPROVED | UNSUBSCRIBED | AUTO_ARCHIVED
    unsubscribe_link: str | None = None


@router.get("/newsletters")
async def list_newsletters(
    account_id: str | None = Query(None),
    user: UserContext = Depends(get_current_user),
):
    """List newsletter dispositions for the user's accounts."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous"}
        scope = "account_id IN (SELECT id FROM email_accounts WHERE user_id = :uid"
        if account_id:
            scope += " AND id = :aid"
            params["aid"] = account_id
        scope += ")"
        rows = (await db.execute(text(
            f"""SELECT id, account_id, email, name, status, unsubscribe_link, updated_at
                FROM email_newsletters WHERE {scope} ORDER BY updated_at DESC"""
        ), params)).fetchall()
        return {
            "newsletters": [
                {"id": str(r.id), "account_id": str(r.account_id), "email": r.email,
                 "name": r.name or "", "status": r.status,
                 "unsubscribe_link": r.unsubscribe_link,
                 "updated_at": r.updated_at.isoformat() if r.updated_at else None}
                for r in rows
            ]
        }
    finally:
        await db.close()


@router.post("/newsletters")
async def upsert_newsletter(
    req: NewsletterUpdate,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Set a sender's disposition. UNSUBSCRIBED/AUTO_ARCHIVED also archives the
    sender's existing inbox mail (locally + provider in the background)."""
    if req.status not in ("APPROVED", "UNSUBSCRIBED", "AUTO_ARCHIVED"):
        raise HTTPException(status_code=400, detail=f"Bad status: {req.status}")
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        await db.execute(text(
            """INSERT INTO email_newsletters
                 (account_id, email, name, status, unsubscribe_link, updated_at)
               VALUES (:aid, LOWER(:email), :name, :status, :link, now())
               ON CONFLICT (account_id, email) DO UPDATE SET
                 name = COALESCE(EXCLUDED.name, email_newsletters.name),
                 status = EXCLUDED.status,
                 unsubscribe_link = COALESCE(EXCLUDED.unsubscribe_link,
                                             email_newsletters.unsubscribe_link),
                 updated_at = now()"""
        ), {"aid": req.account_id, "email": req.email, "name": req.name,
            "status": req.status, "link": req.unsubscribe_link})
        await db.commit()

        archived = 0
        if req.status in ("UNSUBSCRIBED", "AUTO_ARCHIVED"):
            rows = (await db.execute(text(
                """SELECT em.id, em.provider_message_id
                   FROM email_messages em
                   WHERE em.account_id = :aid
                     AND LOWER(em.from_address->>'email') = LOWER(:email)
                     AND LOWER(em.folder) = 'inbox'"""
            ), {"aid": req.account_id, "email": req.email})).fetchall()
            if rows:
                ids = [str(r.id) for r in rows]
                await db.execute(text(
                    "UPDATE email_messages SET folder = 'archive', updated_at = now() "
                    "WHERE id::text = ANY(:ids)"
                ), {"ids": ids})
                await db.commit()
                archived = len(ids)
                background.add_task(
                    _bulk_reconcile_provider, req.account_id,
                    [r.provider_message_id for r in rows], "archive",
                )

        return {"ok": True, "status": req.status, "archived": archived}
    finally:
        await db.close()


EMAIL_CATEGORIES = [
    "Newsletter", "Marketing", "Receipt", "Calendar", "Notification",
    "Cold Email", "Personal", "Support", "Unknown",
]


async def _llm_categorize_senders(
    items: list[dict[str, Any]], *, model: str = "tier-fast",
) -> dict[str, str]:
    """Categorize a batch of senders. items: [{email, name, subjects}].

    Runs on the account's rule-evaluation ``model`` (labeling is part of rule
    evaluation). Returns {email: category}; empty dict on LLM failure (callers
    default to 'Unknown').
    """
    if not items:
        return {}
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        listing = "\n".join(
            f"{i}. {it.get('name') or ''} <{it['email']}> — subjects: "
            f"{'; '.join((it.get('subjects') or [])[:3])}"
            for i, it in enumerate(items)
        )
        sys_prompt = (
            "Classify each email sender into exactly one category from: "
            f"{', '.join(EMAIL_CATEGORIES)}. Use the sender address and recent "
            "subjects. Respond with ONLY a JSON object "
            '{"results": [{"index": <n>, "category": "<one category>"}]}.'
        )
        # JSON-forced (object wrapper required by json_object mode); a generous
        # budget so a large sender batch isn't truncated mid-array.
        resp, _ = await acompletion_with_fallback(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": listing}],
            temperature=0, max_tokens=2000,
            response_format={"type": "json_object"},
        )
        data = _safe_json(resp.choices[0].message.content or "")
        rows = data.get("results") if isinstance(data, dict) else (
            data if isinstance(data, list) else None)
        out: dict[str, str] = {}
        if isinstance(rows, list):
            for d in rows:
                idx = d.get("index") if isinstance(d, dict) else None
                cat = d.get("category") if isinstance(d, dict) else None
                if isinstance(idx, int) and 0 <= idx < len(items) \
                        and cat in EMAIL_CATEGORIES:
                    out[items[idx]["email"]] = cat
        return out
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.categorize_failed", error=str(exc)[:200])
        return {}


async def _categorize_senders_job(account_id: str, limit: int) -> None:
    """Background: assign categories to the account's busiest uncategorized senders."""
    db = await _get_db()
    try:
        rows = (await db.execute(text(
            """SELECT LOWER(from_address->>'email') AS email,
                      MAX(from_address->>'name') AS name,
                      (array_agg(subject ORDER BY received_at DESC))[1:3] AS subjects
               FROM email_messages
               WHERE account_id = :aid
                 AND COALESCE(from_address->>'email','') <> ''
                 AND LOWER(from_address->>'email') NOT IN (
                   SELECT email FROM email_senders
                   WHERE account_id = :aid AND category IS NOT NULL)
               GROUP BY LOWER(from_address->>'email')
               ORDER BY COUNT(*) DESC LIMIT :limit"""
        ), {"aid": account_id, "limit": limit})).fetchall()
        items = [
            {"email": r.email, "name": r.name or "",
             "subjects": [s for s in (r.subjects or []) if s]}
            for r in rows
        ]
        from gateway.routes.email.automation.assistant import (  # noqa: PLC0415
            _account_models)
        rule_model = (await _account_models(db, account_id))["rule"]
        for i in range(0, len(items), 10):
            batch = items[i:i + 10]
            cats = await _llm_categorize_senders(batch, model=rule_model)
            for it in batch:
                await db.execute(text(
                    """INSERT INTO email_senders
                         (account_id, email, name, category, categorized_at)
                       VALUES (:aid, :email, :name, :cat, now())
                       ON CONFLICT (account_id, email) DO UPDATE SET
                         name = COALESCE(EXCLUDED.name, email_senders.name),
                         category = EXCLUDED.category,
                         categorized_at = now(), updated_at = now()"""
                ), {"aid": account_id, "email": it["email"], "name": it["name"],
                    "cat": cats.get(it["email"], "Unknown")})
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.categorize_job_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()


class CategorizeRequest(BaseModel):
    account_id: str
    limit: int = 60


@router.post("/senders/categorize")
async def categorize_senders(
    req: CategorizeRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Schedule LLM categorization of the account's senders (background)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
    finally:
        await db.close()
    background.add_task(_categorize_senders_job, req.account_id, min(req.limit, 300))
    return {"scheduled": True}


@router.get("/senders/categories")
async def sender_categories(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """List the category vocabulary + per-category sender counts."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT category, COUNT(*) AS c FROM email_senders
               WHERE account_id = :aid AND category IS NOT NULL
               GROUP BY category"""
        ), {"aid": account_id})).fetchall()
        return {
            "categories": EMAIL_CATEGORIES,
            "counts": {r.category: r.c for r in rows},
        }
    finally:
        await db.close()


async def _llm_is_cold(email: dict[str, str]) -> tuple[bool, str]:
    """Classify whether an email is cold outreach. (is_cold, reason)."""
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        sys_prompt = (
            "Decide if this is a COLD email: unsolicited sales, marketing, or "
            "recruiting outreach from someone with no prior relationship to the "
            'recipient. Respond ONLY JSON {"cold": <bool>, "reason": "<short>"}.'
        )
        user_prompt = (
            f"From: {email.get('from', '')}\nSubject: {email.get('subject', '')}\n"
            f"Body:\n{(email.get('body', '') or '')[:1500]}"
        )
        resp, _ = await acompletion_with_fallback(
            model="tier-fast",
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": user_prompt}],
            temperature=0, max_tokens=500,
            response_format={"type": "json_object"},
        )
        data = _safe_json(resp.choices[0].message.content or "")
        if isinstance(data, dict):
            return bool(data.get("cold")), str(data.get("reason", ""))[:300]
        return False, ""
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.cold_classify_failed", error=str(exc)[:200])
        return False, ""


async def _maybe_block_cold(
    db: Any, provider: Any, account_id: str, message_id: str,
    provider_msg_id: str, email: dict[str, str], blocker: str,
) -> None:
    """Cold-email gate: for a first-time, non-whitelisted sender, LLM-classify
    and (if cold) label/archive + record. Runs only when no rule matched."""
    sender = (email.get("from") or "").lower()
    if not sender:
        return
    # Already known to the cold-sender table (flagged or whitelisted) → skip.
    seen = (await db.execute(text(
        "SELECT status FROM email_cold_senders "
        "WHERE account_id = :aid AND from_email = :e"
    ), {"aid": account_id, "e": sender})).fetchone()
    if seen:
        return
    # Replied-to / known sender (we've emailed them) → not cold.
    replied = (await db.execute(text(
        """SELECT 1 FROM email_messages
           WHERE account_id = :aid AND LOWER(folder) = 'sent'
             AND to_addresses @> :tojson LIMIT 1"""
    ), {"aid": account_id, "tojson": json.dumps([{"email": sender}])})).fetchone()
    if replied:
        return
    is_cold, reason = await _llm_is_cold(email)
    if not is_cold:
        return
    await db.execute(text(
        """INSERT INTO email_cold_senders (account_id, from_email, status, reason)
           VALUES (:aid, :e, 'AI_LABELED_COLD', :reason)
           ON CONFLICT (account_id, from_email) DO NOTHING"""
    ), {"aid": account_id, "e": sender, "reason": reason})
    actions: list[str] = []
    try:
        if blocker == "ARCHIVE":
            await db.execute(text(
                "UPDATE email_messages SET folder='archive', updated_at=now() "
                "WHERE id=:id"), {"id": message_id})
            await provider.move_to_folder(provider_msg_id, "archive")
            actions = ["ARCHIVE", "LABEL"]
        else:
            actions = ["LABEL"]
        await provider.set_labels(provider_msg_id, add=["Cold Email"], remove=[])
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.cold_action_failed", error=str(exc)[:120])
    await db.execute(text(
        """INSERT INTO email_executed_rules
             (account_id, rule_id, rule_name, message_id, provider_message_id,
              subject, from_address, status, automated, actions_taken, reason)
           VALUES (:aid, NULL, 'Cold Email Blocker', :mid, :pmid, :subj, :frm,
                   'APPLIED', true, :acts, :reason)"""
    ), {"aid": account_id, "mid": message_id, "pmid": provider_msg_id,
        "subj": email.get("subject", ""), "frm": sender,
        "acts": json.dumps(actions), "reason": reason})


class ColdSenderUpdate(BaseModel):
    account_id: str
    from_email: str
    status: str  # AI_LABELED_COLD | USER_REJECTED_COLD


@router.get("/cold-senders")
async def list_cold_senders(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """List cold-email verdicts (flagged + whitelisted) for an account."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        rows = (await db.execute(text(
            """SELECT from_email, status, reason, updated_at
               FROM email_cold_senders WHERE account_id = :aid
               ORDER BY updated_at DESC LIMIT 500"""
        ), {"aid": account_id})).fetchall()
        return {
            "cold_senders": [
                {"from_email": r.from_email, "status": r.status,
                 "reason": r.reason,
                 "updated_at": r.updated_at.isoformat() if r.updated_at else None}
                for r in rows
            ]
        }
    finally:
        await db.close()


@router.post("/cold-senders")
async def upsert_cold_sender(
    req: ColdSenderUpdate,
    user: UserContext = Depends(get_current_user),
):
    """Set a sender's cold verdict — USER_REJECTED_COLD whitelists them."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        await db.execute(text(
            """INSERT INTO email_cold_senders
                 (account_id, from_email, status, updated_at)
               VALUES (:aid, LOWER(:e), :status, now())
               ON CONFLICT (account_id, from_email) DO UPDATE SET
                 status = EXCLUDED.status, updated_at = now()"""
        ), {"aid": req.account_id, "e": req.from_email, "status": req.status})
        await db.commit()
        return {"ok": True, "status": req.status}
    finally:
        await db.close()
