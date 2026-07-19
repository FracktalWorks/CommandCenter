"""Automation · uncategorized-inbox sweep.

The Inbox Cleaner can only clean what it can see, and it sees mail through the
rule engine's per-message labels (``email_messages.categories``). Inbox mail the
rules never reached is therefore invisible to every category chip and filter tab
— it just sits there as an uncategorized sender with no disposition.

There are only two honest ways to close that gap:

1. **Project** what has already been decided onto the mail that looks the same.
   That is this module. It is deterministic, free and instant — no LLM, no new
   opinion. Three sources of evidence, strongest first:

   * a **learned pattern** (``email_rule_patterns``) already pins this sender or
     subject to a rule, and that rule labels with a cleanup category. These are
     the patterns the user taught via Fix / label edits, plus the ones auto-
     learned from confident AI matches — the highest-confidence signal there is.
   * **sender consensus**: the rules already labelled enough of *this sender's*
     mail, consistently, with one cleanup category.
   * **domain consensus**: same, one level up, for a sender too new to have its
     own history (``billing@stripe.com`` inheriting from ``stripe.com``).

2. **Classify** it, which is what the rule engine already does. This module never
   does that — when there is no evidence it reports the message as needing a
   rules run and stops. That is the whole point: a second classifier here would
   be exactly the parallel-categorization drift this codebase keeps paying for.

Everything applied goes through ``runner.apply_label`` (the single label writer)
and is logged to ``email_executed_rules`` so it shows up in History and can be
audited like any other automated action.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import BackgroundTasks, Depends, Query
from gateway.routes.email.automation.engine import (
    _load_rule_patterns,
    _pattern_hit,
)
from gateway.routes.email.automation.senders import (
    _KNOWN_LABELS_LOWER,
    canonical_cleanup_category,
)
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

# Consensus bars. Deliberately conservative: a wrong bulk label is worse than an
# uncategorized sender, because the cleaner offers destructive actions on top of
# it. "dominance" = share of the sender's/domain's labelled mail carrying the
# winning category.
_SENDER_MIN_LABELLED = 2
_SENDER_MIN_DOMINANCE = 0.8
_DOMAIN_MIN_LABELLED = 4
_DOMAIN_MIN_DOMINANCE = 0.9

# Free-mail and other shared domains where "same domain" implies nothing about
# the sender — consensus there would tar every personal contact with whatever
# category one newsletter from the same host happened to get.
_SHARED_DOMAINS = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
    "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "aol.com",
    "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com",
    "qq.com", "163.com", "126.com", "yandex.ru", "msn.com",
}

_MAX_SWEEP = 2000

# In-memory progress, same contract and lifetime as runner._PAST_JOBS: the
# gateway runs a single worker, so the request handler and the background task
# share this dict; a process restart kills the job and the tracker together.
_SWEEP_JOBS: dict[str, dict[str, Any]] = {}


def _domain_of(email: str) -> str:
    return email.rsplit("@", 1)[-1].strip().lower() if "@" in (email or "") else ""


def _consensus(
    counts: dict[str, int], min_labelled: int, min_dominance: float,
) -> str | None:
    """Winning cleanup category for a bag of label counts, or None.

    Requires both enough labelled mail and a clear enough winner — a sender split
    50/50 between Newsletter and Receipt teaches us nothing and must stay
    uncategorized rather than get a coin-flip.
    """
    total = sum(counts.values())
    if total < min_labelled:
        return None
    top, n = max(counts.items(), key=lambda kv: kv[1])
    return top if n / total >= min_dominance else None


async def _rule_label_by_id(db: Any, account_id: str) -> dict[str, str]:
    """``{rule_id: cleanup category}`` for rules whose LABEL action is one.

    A learned pattern points at a rule, not a category; this is how we get from
    one to the other. Rules that label with something outside the cleanup
    vocabulary (Reply / Awaiting Reply / a custom tag) are dropped — the sweep
    only fills in cleanup categories, and conversation state is Reply Zero's job.
    """
    rows = (await db.execute(text(
        """SELECT r.id::text AS rid, a.label
             FROM email_rules r
             JOIN email_actions a ON a.rule_id = r.id
            WHERE r.account_id = :aid AND r.enabled = true
              AND a.type = 'LABEL' AND COALESCE(a.label, '') <> ''
              AND COALESCE(a.label_ai, false) = false"""
    ), {"aid": account_id})).fetchall()
    out: dict[str, str] = {}
    for r in rows:
        cat = canonical_cleanup_category(r.label)
        if cat:
            out[r.rid] = cat
    return out


async def _label_tallies(
    db: Any, account_id: str,
) -> tuple[dict[str, dict[str, int]], dict[str, dict[str, int]]]:
    """Per-sender and per-domain cleanup-label counts across the whole account.

    Deliberately NOT restricted to the inbox: a sender whose mail the user has
    already archived is exactly the sender whose history should teach us what
    their next message is.
    """
    rows = (await db.execute(text(
        """SELECT LOWER(em.from_address->>'email') AS email,
                  LOWER(TRIM(cat)) AS label,
                  COUNT(DISTINCT em.id) AS n
             FROM email_messages em
             CROSS JOIN LATERAL unnest(em.categories) AS cat
            WHERE em.account_id = :aid
              AND LOWER(TRIM(cat)) = ANY(:labels)
              AND COALESCE(em.from_address->>'email','') <> ''
            GROUP BY 1, 2"""
    ), {"aid": account_id, "labels": _KNOWN_LABELS_LOWER})).fetchall()
    by_sender: dict[str, dict[str, int]] = {}
    by_domain: dict[str, dict[str, int]] = {}
    for r in rows:
        cat = canonical_cleanup_category(r.label)
        if not cat:
            continue  # a conversation label — not cleanup evidence
        by_sender.setdefault(r.email, {})[cat] = int(r.n or 0)
        dom = _domain_of(r.email)
        if dom and dom not in _SHARED_DOMAINS:
            d = by_domain.setdefault(dom, {})
            d[cat] = d.get(cat, 0) + int(r.n or 0)
    return by_sender, by_domain


async def _uncategorized_inbox(
    db: Any, account_id: str, limit: int,
) -> list[Any]:
    """Inbox mail carrying NO label the rollup understands.

    "Uncategorized" means no cleanup category *and* no conversation label — a
    thread already marked Reply/Awaiting is classified, it simply isn't cleanup
    material, and re-sweeping it every run would be noise.
    """
    return (await db.execute(text(
        """SELECT em.id, em.provider_message_id, em.subject,
                  em.from_address, em.received_at
             FROM email_messages em
            WHERE em.account_id = :aid AND LOWER(em.folder) = 'inbox'
              AND COALESCE(em.from_address->>'email','') <> ''
              AND NOT EXISTS (
                    SELECT 1 FROM unnest(em.categories) AS c
                     WHERE LOWER(TRIM(c)) = ANY(:labels))
            ORDER BY em.received_at DESC
            LIMIT :limit"""
    ), {"aid": account_id, "labels": _KNOWN_LABELS_LOWER,
        "limit": limit})).fetchall()


def _decide(
    row: Any,
    patterns: dict[str, dict[str, list[tuple[str, str]]]],
    rule_labels: dict[str, str],
    by_sender: dict[str, dict[str, int]],
    by_domain: dict[str, dict[str, int]],
) -> tuple[str, str] | None:
    """(category, reason) for one uncategorized message, or None for no evidence."""
    frm = row.from_address if isinstance(row.from_address, dict) else {}
    sender = (frm.get("email") or "").strip().lower()
    if not sender:
        return None
    # _pattern_hit expects the same email dict shape the rule engine matches on.
    email = {"from": sender, "subject": row.subject or ""}

    # 1. A learned pattern already pins this sender/subject to a labelling rule.
    for rid, cat in rule_labels.items():
        p = patterns.get(rid)
        if not p:
            continue
        if any(_pattern_hit(pt, email) for pt in p["exclude"]):
            continue  # the user taught us this one is NOT that rule
        if any(_pattern_hit(pt, email) for pt in p["include"]):
            return cat, "learned pattern"

    # 2. This sender's own labelled history agrees on one category.
    cat = _consensus(by_sender.get(sender, {}),
                     _SENDER_MIN_LABELLED, _SENDER_MIN_DOMINANCE)
    if cat:
        return cat, "sender history"

    # 3. Fall back to the sending domain (never a shared free-mail host).
    dom = _domain_of(sender)
    if dom and dom not in _SHARED_DOMAINS:
        cat = _consensus(by_domain.get(dom, {}),
                         _DOMAIN_MIN_LABELLED, _DOMAIN_MIN_DOMINANCE)
        if cat:
            return cat, f"domain history ({dom})"
    return None


async def sweep_uncategorized(
    account_id: str, limit: int, *, dry_run: bool, owner: str = "",
) -> dict[str, Any]:
    """Project existing categorization onto uncategorized inbox mail.

    Returns a summary: how many were matched, the per-category breakdown, and
    how many carry no evidence at all (those need an actual rules run — see
    ``/email/rules/process-past``).
    """
    summary: dict[str, Any] = {
        "scanned": 0, "categorized": 0, "no_evidence": 0,
        "by_category": {}, "by_reason": {}, "dry_run": dry_run,
    }
    db = await _get_db()
    provider = None
    store = None
    try:
        rows = await _uncategorized_inbox(db, account_id, limit)
        summary["scanned"] = len(rows)
        if not rows:
            return summary

        patterns = await _load_rule_patterns(db, account_id)
        rule_labels = await _rule_label_by_id(db, account_id)
        by_sender, by_domain = await _label_tallies(db, account_id)

        # Decide everything first — a dry run must never touch the provider, and
        # the preview and the apply must agree on exactly the same verdicts.
        decisions: list[tuple[Any, str, str]] = []
        for r in rows:
            verdict = _decide(r, patterns, rule_labels, by_sender, by_domain)
            if verdict is None:
                summary["no_evidence"] += 1
                continue
            cat, reason = verdict
            decisions.append((r, cat, reason))
            summary["by_category"][cat] = summary["by_category"].get(cat, 0) + 1
            summary["by_reason"][reason] = summary["by_reason"].get(reason, 0) + 1
        summary["categorized"] = len(decisions)
        if dry_run or not decisions:
            return summary

        acc = (await db.execute(text(
            "SELECT provider, credentials_encrypted FROM email_accounts "
            "WHERE id = :id"
        ), {"id": account_id})).fetchone()
        if acc:
            import json  # noqa: PLC0415

            from acb_llm.key_store import get_key_store  # noqa: PLC0415
            store = get_key_store()
            creds = json.loads(store.decrypt(acc.credentials_encrypted))
            provider = _instantiate_provider(acc.provider, creds)
            if not await provider.authenticate():
                provider = None

        from gateway.routes.email.automation.runner import (  # noqa: PLC0415
            apply_label,
        )
        applied = 0
        for r, cat, reason in decisions:
            try:
                await apply_label(
                    db, provider, str(r.id), r.provider_message_id, cat)
                frm = r.from_address if isinstance(r.from_address, dict) else {}
                await db.execute(text(
                    """INSERT INTO email_executed_rules
                         (account_id, rule_id, rule_name, message_id,
                          provider_message_id, subject, from_address, status,
                          automated, actions_taken, reason)
                       VALUES (:aid, NULL, :rname, :mid, :pmid, :subj, :frm,
                               'APPLIED', true, '["LABEL"]', :reason)"""
                ), {"aid": account_id, "rname": f"Inbox Cleaner · {cat}",
                    "mid": str(r.id), "pmid": r.provider_message_id,
                    "subj": r.subject or "", "frm": frm.get("email", ""),
                    "reason": f"Categorized as {cat} from {reason}."})
                await db.commit()
                applied += 1
                _sweep_tick(account_id, applied)
            except Exception as exc:  # noqa: BLE001 — one bad message must not
                # abort the sweep; the rest of the inbox still gets cleaned.
                _log.warning("email.cleanup_apply_failed", account_id=account_id,
                             message_id=str(r.id), error=str(exc)[:160])
        summary["categorized"] = applied
        if provider is not None and store is not None:
            await _persist_rotated_creds(db, store, account_id, provider)
            await db.commit()
        _log.info("email.cleanup_sweep", account_id=account_id, owner=owner,
                  scanned=summary["scanned"], applied=applied,
                  no_evidence=summary["no_evidence"])
        return summary
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.cleanup_sweep_failed", account_id=account_id,
                     error=str(exc)[:200])
        summary["error"] = str(exc)[:200]
        return summary
    finally:
        await db.close()


def _sweep_tick(account_id: str, applied: int) -> None:
    job = _SWEEP_JOBS.get(account_id)
    if job:
        job["applied"] = applied


async def _sweep_job(account_id: str, limit: int, owner: str) -> None:
    """Background wrapper that keeps the polled progress row up to date."""
    try:
        summary = await sweep_uncategorized(
            account_id, limit, dry_run=False, owner=owner)
        _SWEEP_JOBS[account_id] = {
            **_SWEEP_JOBS.get(account_id, {}), **summary,
            "owner": owner, "status": "done",
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:  # noqa: BLE001
        _SWEEP_JOBS[account_id] = {
            **_SWEEP_JOBS.get(account_id, {}), "owner": owner,
            "status": "error", "error": str(exc)[:200],
        }


class CleanupSweepRequest(BaseModel):
    account_id: str
    limit: int = 500
    # Preview only: decide everything, touch nothing. Cheap (no provider calls),
    # so the UI can show "N will be categorized" before the user commits.
    dry_run: bool = False


@router.post("/cleanup/auto-categorize")
async def auto_categorize_inbox(
    req: CleanupSweepRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Fill in categories for uncategorized inbox mail from existing evidence.

    Projects learned patterns and per-sender/per-domain label history onto mail
    the rules never reached. Runs no classifier of its own — anything without
    evidence is reported in ``no_evidence`` and needs a real rules run.

    ``dry_run`` returns the verdicts synchronously without writing. A live run is
    scheduled in the background (it writes to the provider per message); poll
    ``GET /email/cleanup/status``.
    """
    owner = user.email or "anonymous"
    limit = max(1, min(req.limit, _MAX_SWEEP))
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, owner)
    finally:
        await db.close()

    if req.dry_run:
        return await sweep_uncategorized(
            req.account_id, limit, dry_run=True, owner=owner)

    _SWEEP_JOBS[req.account_id] = {
        "owner": owner, "status": "running", "applied": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    background.add_task(_sweep_job, req.account_id, limit, owner)
    return {"scheduled": True}


@router.get("/cleanup/status")
async def cleanup_status(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """Progress of the most recent auto-categorize sweep on this account."""
    job = _SWEEP_JOBS.get(account_id)
    if not job or job.get("owner") != (user.email or "anonymous"):
        return {"status": "idle"}
    return {k: v for k, v in job.items() if k != "owner"}


@router.get("/cleanup/uncategorized")
async def uncategorized_overview(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """How much inbox mail carries no rule label, and who it's from.

    Powers the Inbox Cleaner's "Uncategorized" tab: the count drives the badge,
    the sender breakdown tells the user whether one noisy sender is the problem.
    """
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        total = (await db.execute(text(
            """SELECT COUNT(*) AS c FROM email_messages em
                WHERE em.account_id = :aid AND LOWER(em.folder) = 'inbox'
                  AND NOT EXISTS (
                        SELECT 1 FROM unnest(em.categories) AS c
                         WHERE LOWER(TRIM(c)) = ANY(:labels))"""
        ), {"aid": account_id, "labels": _KNOWN_LABELS_LOWER})).fetchone()
        rows = (await db.execute(text(
            """SELECT LOWER(em.from_address->>'email') AS email,
                      MAX(em.from_address->>'name') AS name,
                      COUNT(*) AS n
                 FROM email_messages em
                WHERE em.account_id = :aid AND LOWER(em.folder) = 'inbox'
                  AND COALESCE(em.from_address->>'email','') <> ''
                  AND NOT EXISTS (
                        SELECT 1 FROM unnest(em.categories) AS c
                         WHERE LOWER(TRIM(c)) = ANY(:labels))
                GROUP BY 1 ORDER BY n DESC LIMIT 25"""
        ), {"aid": account_id, "labels": _KNOWN_LABELS_LOWER})).fetchall()
        return {
            "uncategorized": int(total.c) if total else 0,
            "top_senders": [
                {"email": r.email, "name": r.name or "", "count": int(r.n)}
                for r in rows
            ],
        }
    finally:
        await db.close()
