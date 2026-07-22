"""Automation · rule execution — applying rule actions, the run/test/history/
undo endpoints, and the background run + process-past jobs."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

import httpx
from acb_auth import UserContext, get_current_user
from fastapi import BackgroundTasks, Depends, HTTPException, Query
from gateway.routes.email.automation.assistant import _load_assistant_about
from gateway.routes.email.automation.drafting import (
    _agent_draft_reply,
    _fetch_reply_memories,
    _fetch_sender_reply_examples,
    _fetch_thread_context,
    _is_no_draft,
    _resolve_existing_thread_draft,
    _store_ai_draft,
    _upsert_local_draft,
)
from gateway.routes.email.automation.engine import (
    _email_payload_from_id,
    _is_conversation_status_rule,
    _llm_json,
    _match_email_to_rule,
    _match_email_to_rules_multi,
    email_dict_from_row,
)
from gateway.routes.email.automation.identity import resolve_org_domains
from gateway.routes.email.automation.rules import _upsert_rule_pattern
from gateway.routes.email.automation.senders import _maybe_block_cold
from gateway.routes.email.core import (
    _assert_account_owner,
    _attachment_summaries,
    _date_range_clause,
    _get_db,
    _instantiate_provider,
    _log,
    _parse_iso_date,
    _persist_rotated_creds,
    _provider_for_account,
    router,
)
from pydantic import BaseModel
from sqlalchemy import text


async def _account_self_email(db: Any, account_id: str) -> str:
    """The connected account's own address — passed to the classifier so it can
    tell whether the mailbox owner is a direct recipient (To) or only CC'd."""
    try:
        row = (await db.execute(text(
            "SELECT email_address FROM email_accounts WHERE id = :id"
        ), {"id": account_id})).fetchone()
        return (row.email_address or "") if row else ""
    except Exception:  # noqa: BLE001
        return ""


class RuleTestRequest(BaseModel):
    account_id: str
    email_id: str | None = None
    subject: str | None = None
    from_email: str | None = None
    body: str | None = None


@router.post("/rules/test")
async def test_rules(
    req: RuleTestRequest,
    user: UserContext = Depends(get_current_user),
):
    """Test the rules against one email (selected message or a pasted sample)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        if req.email_id:
            email = await _email_payload_from_id(db, req.email_id, user.email or "anonymous")
        else:
            email = {"subject": req.subject or "", "from": req.from_email or "",
                     "body": req.body or "", "to": ""}
        match = await _match_email_to_rule(db, req.account_id, email)
        if not match:
            return {"matched": False, "rule": None, "reason": "No rule matched.",
                    "actions": []}
        return {
            "matched": True,
            "rule": {"id": match["rule"]["id"], "name": match["rule"]["name"]},
            "reason": match["reason"],
            "actions": match["rule"]["actions"],
        }
    finally:
        await db.close()


class RuleTestRecentRequest(BaseModel):
    account_id: str
    limit: int = 8


@router.post("/rules/test/recent")
async def test_rules_recent(
    req: RuleTestRecentRequest,
    user: UserContext = Depends(get_current_user),
):
    """Test the rules against the most recent inbox messages (read-only).

    Returns, per email, which rule would match and the actions it would take —
    inbox-zero's "test on your real inbox" preview. Applies nothing.
    """
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        self_email = await _account_self_email(db, req.account_id)
        about, _ = await _load_assistant_about(db, req.account_id)
        rows = (await db.execute(text(
            """SELECT id, subject, body_text, snippet, from_address,
                      to_addresses, cc_addresses, thread_id, received_at
               FROM email_messages
               WHERE account_id = :aid AND LOWER(folder) = 'inbox'
               ORDER BY received_at DESC LIMIT :limit"""
        ), {"aid": req.account_id, "limit": min(req.limit, 15)})).fetchall()
        org_domains = await resolve_org_domains(db, req.account_id)
        attach = await _attachment_summaries(db, [r.id for r in rows])
        results = []
        for r in rows:
            frm = r.from_address if isinstance(r.from_address, dict) \
                else json.loads(r.from_address or "{}")
            email = email_dict_from_row(
                r, self_email, about, extra_domains=org_domains,
                attachments=attach.get(str(r.id), ""))
            match = await _match_email_to_rule(db, req.account_id, email)
            results.append({
                "email_id": str(r.id),
                "subject": r.subject or "(no subject)",
                "from": frm.get("name") or frm.get("email", ""),
                "matched": bool(match),
                "rule": {"id": match["rule"]["id"], "name": match["rule"]["name"]}
                if match else None,
                "reason": match["reason"] if match else "",
                "actions": [a["type"] for a in match["rule"]["actions"]]
                if match else [],
            })
        return {"results": results}
    finally:
        await db.close()


@router.get("/rules/history")
async def rules_history(
    account_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=500),
    include_deleted: bool = Query(False),
    user: UserContext = Depends(get_current_user),
):
    """Executed-rule audit log for the user's accounts.

    By default, entries whose underlying message was deleted upstream (moved to
    TRASH by delta reconciliation — e.g. an AI draft the user discarded) are
    hidden, so History reflects the live mailbox. Pass ``include_deleted=true``
    to see the full immutable log."""
    db = await _get_db()
    try:
        params: dict[str, Any] = {"uid": user.email or "anonymous", "limit": limit}
        scope = ("er.account_id IN (SELECT id FROM email_accounts WHERE user_id = :uid")
        if account_id:
            scope += " AND id = :aid"
            params["aid"] = account_id
        scope += ")"
        if not include_deleted:
            # Keep no-match rows (message_id NULL) and rows for messages we
            # never synced; drop only those we know were trashed/deleted.
            scope += (" AND (em.id IS NULL OR "
                      "lower(coalesce(em.folder, '')) NOT IN ('trash', 'deleted'))")
        rows = (await db.execute(text(
            f"""SELECT er.id, er.rule_id, er.rule_name, er.subject, er.from_address,
                       er.status, er.automated, er.actions_taken, er.reason,
                       er.created_at, er.match_source, er.action_errors,
                       er.message_id, em.snippet, em.received_at, em.categories,
                       r.instructions, r.from_pattern, r.to_pattern,
                       r.subject_pattern, r.body_pattern, r.conditional_operator,
                       d.draft_text
                FROM email_executed_rules er
                LEFT JOIN email_messages em ON er.message_id = em.id
                LEFT JOIN email_rules r ON er.rule_id = r.id
                LEFT JOIN email_ai_drafts d
                  ON d.account_id = er.account_id AND d.thread_id = em.thread_id
                WHERE {scope}
                ORDER BY COALESCE(em.received_at, er.created_at) DESC LIMIT :limit"""
        ), params)).fetchall()

        # Fetch each matched rule's action specs once so the hover popover can
        # render the actions (label / to / subject …), not just their types.
        rule_ids = sorted({str(r.rule_id) for r in rows if r.rule_id})
        actions_by_rule: dict[str, list[dict[str, Any]]] = {}
        if rule_ids:
            act_rows = (await db.execute(text(
                """SELECT rule_id, type, label, subject, content, to_address,
                          cc_address, bcc_address, url, delay_minutes, attachments
                   FROM email_actions WHERE rule_id = ANY(:rids)
                   ORDER BY rule_id"""
            ), {"rids": rule_ids})).fetchall()
            for a in act_rows:
                actions_by_rule.setdefault(str(a.rule_id), []).append({
                    "type": a.type, "label": a.label, "subject": a.subject,
                    "content": a.content, "to_address": a.to_address,
                    "cc_address": a.cc_address, "bcc_address": a.bcc_address,
                    "url": a.url, "delay_minutes": a.delay_minutes,
                    "attachments": a.attachments if isinstance(a.attachments, list)
                    else json.loads(a.attachments or "[]"),
                })

        return {
            "history": [
                {"id": str(r.id),
                 "rule_id": str(r.rule_id) if r.rule_id else None,
                 "rule_name": r.rule_name, "subject": r.subject,
                 "from": r.from_address, "status": r.status, "automated": r.automated,
                 "actions": r.actions_taken if isinstance(r.actions_taken, list)
                 else json.loads(r.actions_taken or "[]"),
                 "reason": r.reason, "snippet": r.snippet or "",
                 "message_id": str(r.message_id)
                 if getattr(r, "message_id", None) else None,
                 "match_source": getattr(r, "match_source", None),
                 "action_errors": (
                     r.action_errors if isinstance(r.action_errors, list)
                     else json.loads(r.action_errors or "[]")
                 ) if getattr(r, "action_errors", None) is not None else [],
                 "created_at": r.created_at.isoformat() if r.created_at else None,
                 "received_at": r.received_at.isoformat()
                 if getattr(r, "received_at", None) else None,
                 # The AI draft generated for this thread (DRAFT_EMAIL action),
                 # so the hover pill can preview it. Cleared once the user sends.
                 "draft_preview": (getattr(r, "draft_text", None) or None),
                 "labels": (
                     r.categories if isinstance(r.categories, list)
                     else json.loads(r.categories or "[]")
                 ) if getattr(r, "categories", None) is not None else [],
                 "conditions": {
                     "instructions": r.instructions,
                     "from_pattern": r.from_pattern,
                     "to_pattern": r.to_pattern,
                     "subject_pattern": r.subject_pattern,
                     "body_pattern": r.body_pattern,
                     "conditional_operator": r.conditional_operator or "AND",
                 } if r.rule_id else None,
                 "rule_actions": actions_by_rule.get(
                     str(r.rule_id) if r.rule_id else "", [])}
                for r in rows
            ]
        }
    finally:
        await db.close()


# Actions a retry will never perform, however the original rule was configured.
# A retry re-runs a decision the assistant ALREADY made, possibly weeks ago; the
# label and the move are idempotent and safe to repeat, but sending or drafting
# a reply to a stale conversation is neither, and doing it unattended as part of
# a bulk repair is exactly the kind of outward-facing surprise the user cannot
# undo. If a reply was genuinely wanted, it can be drafted from the message.
_RETRY_SKIPPED_ACTIONS = frozenset({"REPLY", "DRAFT_EMAIL", "FORWARD",
                                    "SEND_EMAIL", "CALL_WEBHOOK"})


async def retry_failed_executions(
    account_id: str, *, limit: int = 200, user_email: str | None = None,
) -> dict[str, Any]:
    """Re-apply rule runs whose every action the mail server refused.

    Deterministic repair, NOT re-classification: it replays the rule the
    assistant already chose, so it costs no model calls and cannot change any
    decision. The only thing that differs from the original run is the message
    id — Outlook re-keys a message when it moves, which is what stranded these
    in the first place, so each one is re-read immediately before acting.

    Safe to run repeatedly: LABEL and MOVE_FOLDER are idempotent, and a row that
    succeeds is flipped to APPLIED so it is not retried again.
    """
    db = await _get_db()
    try:
        owner = user_email
        if owner is None:
            owner = (await db.execute(text(
                "SELECT user_id FROM email_accounts WHERE id = :aid"
            ), {"aid": account_id})).scalar()
        if not owner:
            raise HTTPException(status_code=404, detail="Account not found")

        rows = (await db.execute(text(
            """SELECT er.id, er.rule_id, er.rule_name, er.message_id,
                      em.provider_message_id, em.thread_id, em.subject,
                      em.body_text, em.from_address
                 FROM email_executed_rules er
                 JOIN email_messages em ON em.id = er.message_id
                WHERE er.account_id = :aid AND er.status = 'FAILED'
                  AND er.rule_id IS NOT NULL
                  -- NEVER repair mail the user has since thrown away. Most of
                  -- these failures are the provider racing us, and by far the
                  -- commonest way that happens is the message being deleted or
                  -- junked — 92 of the 138 live failures ended in trash. A
                  -- MOVE_FOLDER replayed against one of those would lift it
                  -- back OUT of the bin into a category folder, resurrecting
                  -- mail the user deleted. A repair must never be able to do
                  -- that.
                  AND LOWER(COALESCE(em.folder, '')) NOT IN
                      ('trash', 'junk', 'spam', 'drafts', 'draft')
                ORDER BY er.created_at DESC
                LIMIT :limit"""
        ), {"aid": account_id, "limit": limit})).fetchall()
        if not rows:
            return {"considered": 0, "repaired": 0, "still_failing": 0,
                    "skipped_actions": []}

        provider, store, _owner_email = await _provider_for_account(
            db, account_id, owner)
        if not await provider.authenticate():
            raise HTTPException(status_code=502, detail="Provider auth failed")
        about, signature = await _load_assistant_about(db, account_id)

        # One lookup per distinct rule rather than per row: a batch repair is
        # usually a handful of rules across many messages.
        actions_by_rule: dict[str, list[dict[str, Any]]] = {}
        for rid in {str(r.rule_id) for r in rows}:
            act_rows = (await db.execute(text(
                """SELECT type, label, subject, content, to_address, cc_address,
                          bcc_address, url FROM email_actions
                    WHERE rule_id = :rid"""
            ), {"rid": rid})).fetchall()
            actions_by_rule[rid] = [dict(a._mapping) for a in act_rows]

        repaired = 0
        still_failing = 0
        skipped: set[str] = set()
        for r in rows:
            actions = [a for a in actions_by_rule.get(str(r.rule_id), [])
                       if a.get("type") not in _RETRY_SKIPPED_ACTIONS]
            skipped.update(
                a["type"] for a in actions_by_rule.get(str(r.rule_id), [])
                if a.get("type") in _RETRY_SKIPPED_ACTIONS)
            if not actions:
                continue
            frm = r.from_address if isinstance(r.from_address, dict) \
                else json.loads(r.from_address or "{}")
            email = {"subject": r.subject or "", "from": frm.get("email", ""),
                     "body": r.body_text or "", "thread_id": r.thread_id or ""}
            errors: list[dict[str, str]] = []
            taken = await _apply_rule_actions(
                db, provider, str(r.message_id), r.provider_message_id,
                actions, email, about, signature, owner,
                account_id=account_id, errors_out=errors,
            )
            status = "FAILED" if (errors and not taken) else "APPLIED"
            if status == "APPLIED":
                repaired += 1
            else:
                still_failing += 1
            await db.execute(text(
                "UPDATE email_executed_rules SET status = :st, "
                "actions_taken = :acts, action_errors = CAST(:aerr AS JSONB) "
                "WHERE id = :eid"
            ), {"eid": str(r.id), "st": status, "acts": json.dumps(taken),
                "aerr": json.dumps(errors)})

        await _persist_rotated_creds(db, store, account_id, provider)
        await db.commit()
        _log.info("email.retry_failed_done", account_id=account_id,
                  considered=len(rows), repaired=repaired,
                  still_failing=still_failing)
        return {"considered": len(rows), "repaired": repaired,
                "still_failing": still_failing,
                "skipped_actions": sorted(skipped)}
    finally:
        await db.close()


class RetryFailedRequest(BaseModel):
    account_id: str
    limit: int = 200


@router.post("/rules/history/retry-failed")
async def retry_failed(
    req: RetryFailedRequest,
    user: UserContext = Depends(get_current_user),
):
    """Repair rule runs the mail server refused. Never drafts or sends."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
    finally:
        await db.close()
    return await retry_failed_executions(
        req.account_id, limit=max(1, min(req.limit, 1000)),
        user_email=user.email or "anonymous")


@router.post("/rules/history/{exec_id}/approve")
async def approve_execution(
    exec_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Apply a PENDING (proposed) rule execution — the approval queue."""
    db = await _get_db()
    try:
        row = (await db.execute(text(
            """SELECT er.status, er.rule_id, er.message_id, er.provider_message_id,
                      er.thread_id, er.subject, er.from_address, er.account_id,
                      er.reason, ea.provider, ea.credentials_encrypted,
                      ea.user_id, em.body_text
               FROM email_executed_rules er
               JOIN email_accounts ea ON er.account_id = ea.id
               LEFT JOIN email_messages em ON er.message_id = em.id
               WHERE er.id = :eid AND ea.user_id = :uid"""
        ), {"eid": exec_id, "uid": user.email or "anonymous"})).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Execution not found")
        if row.status != "PENDING":
            raise HTTPException(status_code=400, detail="Not pending")
        if not row.rule_id:
            raise HTTPException(status_code=400, detail="Rule no longer exists")

        act_rows = (await db.execute(text(
            """SELECT type, label, subject, content, to_address, cc_address,
                      bcc_address, url FROM email_actions WHERE rule_id = :rid"""
        ), {"rid": row.rule_id})).fetchall()
        actions = [dict(a._mapping) for a in act_rows]

        from acb_llm.key_store import get_key_store
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))
        provider = _instantiate_provider(row.provider, creds)
        if not await provider.authenticate():
            raise HTTPException(status_code=502, detail="Provider auth failed")

        about, signature = await _load_assistant_about(db, str(row.account_id))
        email = {"subject": row.subject or "", "from": row.from_address or "",
                 "body": row.body_text or "", "thread_id": row.thread_id or ""}
        taken = await _apply_rule_actions(
            db, provider, str(row.message_id), row.provider_message_id,
            actions, email, about, signature, row.user_id,
            account_id=str(row.account_id),
        )
        await db.execute(text(
            "UPDATE email_executed_rules SET status='APPLIED', actions_taken=:acts "
            "WHERE id=:eid"
        ), {"eid": exec_id, "acts": json.dumps(taken)})
        if row.message_id:
            await db.execute(text(
                "UPDATE email_messages SET rules_processed_at = now(), "
                "rules_held_back_at = NULL WHERE id=:mid"
            ), {"mid": str(row.message_id)})
        await _persist_rotated_creds(db, store, str(row.account_id), provider)
        await db.commit()
        return {"ok": True, "status": "APPLIED", "actions": taken}
    finally:
        await db.close()


@router.post("/rules/history/{exec_id}/reject")
async def reject_execution(
    exec_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Dismiss a PENDING rule execution without applying it."""
    db = await _get_db()
    try:
        res = await db.execute(text(
            """UPDATE email_executed_rules er
               SET status = 'REJECTED'
               FROM email_accounts ea
               WHERE er.id = :eid AND er.account_id = ea.id
                 AND ea.user_id = :uid AND er.status = 'PENDING'"""
        ), {"eid": exec_id, "uid": user.email or "anonymous"})
        await db.commit()
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Pending execution not found")
        return {"ok": True, "status": "REJECTED"}
    finally:
        await db.close()


@router.post("/rules/history/{exec_id}/undo")
async def undo_execution(
    exec_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Reverse an APPLIED rule execution where possible: restore the message to
    the inbox (archive/move/trash/spam) and remove any labels the rule added."""
    db = await _get_db()
    try:
        row = (await db.execute(text(
            """SELECT er.status, er.rule_id, er.message_id, er.provider_message_id,
                      er.actions_taken, ea.provider, ea.credentials_encrypted
               FROM email_executed_rules er
               JOIN email_accounts ea ON er.account_id = ea.id
               WHERE er.id = :eid AND ea.user_id = :uid"""
        ), {"eid": exec_id, "uid": user.email or "anonymous"})).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Execution not found")
        if row.status != "APPLIED":
            raise HTTPException(
                status_code=400,
                detail="Only applied executions can be undone")
        taken = row.actions_taken if isinstance(row.actions_taken, list) \
            else json.loads(row.actions_taken or "[]")

        from acb_llm.key_store import get_key_store  # noqa: PLC0415
        store = get_key_store()
        creds = json.loads(store.decrypt(row.credentials_encrypted))
        provider = _instantiate_provider(row.provider, creds)
        if not await provider.authenticate():
            raise HTTPException(status_code=502, detail="Provider auth failed")

        pmid = row.provider_message_id
        reversed_actions: list[str] = []
        if any(t in ("ARCHIVE", "MOVE_FOLDER", "TRASH", "MARK_SPAM")
               for t in taken):
            await provider.move_to_folder(pmid, "inbox")
            if row.message_id:
                await db.execute(text(
                    "UPDATE email_messages SET folder='inbox', updated_at=now() "
                    "WHERE id=:id"
                ), {"id": str(row.message_id)})
            reversed_actions.append("restored to inbox")
        if "LABEL" in taken and row.rule_id:
            lbl_rows = (await db.execute(text(
                "SELECT label FROM email_actions WHERE rule_id = :rid "
                "AND type = 'LABEL' AND label IS NOT NULL"
            ), {"rid": str(row.rule_id)})).fetchall()
            labels = [r.label for r in lbl_rows if r.label]
            if labels:
                try:
                    await provider.set_labels(pmid, add=[], remove=labels)
                    reversed_actions.append(
                        f"removed label(s): {', '.join(labels)}")
                except Exception:  # noqa: BLE001
                    pass
        await db.execute(text(
            "UPDATE email_executed_rules SET status='UNDONE' WHERE id=:eid"
        ), {"eid": exec_id})
        await db.commit()
        return {"status": "UNDONE", "reversed": reversed_actions}
    finally:
        await db.close()


class RuleRunRequest(BaseModel):
    account_id: str
    limit: int = 20
    dry_run: bool = True


@router.post("/rules/run")
async def run_rules(
    req: RuleRunRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Run enabled rules over recent inbox mail (scheduled in the background).

    `dry_run` (default) only logs what WOULD happen to the history; set it false
    to actually apply the matched actions. Poll GET /email/rules/history for
    results.
    """
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
    finally:
        await db.close()
    background.add_task(
        _run_rules_job, req.account_id, min(req.limit, 50), req.dry_run,
        user.email or "anonymous",
    )
    return {"scheduled": True, "dry_run": req.dry_run}


# ── "Process past emails" live progress ──────────────────────────────────────
# The process-past job runs as a fire-and-forget BackgroundTask. The frontend
# had no way to know it was running, so the UI showed nothing after the dialog
# closed. We track per-account progress in memory (the gateway runs a single
# uvicorn worker, so the request handler and the background task share this dict)
# and expose it via GET /rules/process-past/status for the UI to poll. State is
# ephemeral by design: if the process restarts the job dies too, so losing the
# tracker with it is correct.
_PAST_JOBS: dict[str, dict[str, Any]] = {}
_PAST_JOB_SEQ = 0  # monotonic token so a stale job can't clobber a newer run


async def apply_label(
    db: Any, provider: Any, message_id: str, provider_msg_id: str, label: str,
) -> None:
    """THE way a category label gets onto a message. One writer, two surfaces.

    Writes the provider FIRST, then mirrors into ``email_messages.categories``
    so the viewer shows the chip immediately instead of waiting for the next
    upstream sync. Both halves matter:

    * local-only would be erased on the next re-sync, because providers that
      round-trip labels are authoritative (see EmailMessage.categories_
      authoritative) — and ``rules_processed_at`` is already stamped, so the
      rules would never re-apply it;
    * provider-only leaves the label invisible in-app until a sync catches up.

    The mirror is an atomic append-if-absent on the TEXT[] (race-free, no
    read-modify-write). Every categorizer — the rule engine's LABEL action and
    the uncategorized-inbox sweep — goes through here, so there is exactly one
    place that decides what "applying a label" means.
    """
    lbl = (label or "").strip()
    if not lbl:
        return
    if provider is not None and provider_msg_id:
        await provider.set_labels(provider_msg_id, add=[lbl], remove=[])
    await db.execute(text(
        "UPDATE email_messages SET categories = "
        "CASE WHEN :lbl = ANY(categories) THEN categories "
        "ELSE array_append(categories, :lbl) END, "
        "updated_at = now() WHERE id = :id"
    ), {"id": message_id, "lbl": lbl})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _past_job_start(
    account_id: str, owner: str, total: int, dry_run: bool,
    *, downloading: bool = False, already_processed: int = 0,
) -> int:
    """Seed the tracker for a new run; returns a token the background job passes
    back so a superseded (older) run can't mutate the newer entry.

    ``downloading`` marks the run as in the pre-apply provider-backfill phase
    (the range is being fetched from upstream). The job then calls
    ``_past_job_begin_processing`` with the real in-range total once mail lands."""
    global _PAST_JOB_SEQ
    _PAST_JOB_SEQ += 1
    token = _PAST_JOB_SEQ
    running = downloading or total > 0
    _PAST_JOBS[account_id] = {
        "token": token,
        "owner": owner,
        "status": "running" if running else "done",
        "phase": "downloading" if downloading else "processing",
        "total": total,
        "processed": 0,
        "applied": 0,
        "skipped": 0,
        # Excluded up front as already-processed — NOT part of `total`, and not
        # a failure. Kept distinct from `skipped` (in range, processed, matched
        # no rule) so the UI can tell "already done" from "nothing applied".
        "already_processed": already_processed,
        "dry_run": dry_run,
        "started_at": _now_iso(),
        "finished_at": None if running else _now_iso(),
        "error": None,
    }
    return token


def _past_job_begin_processing(
    account_id: str, *, token: int | None = None, total: int,
    already_processed: int | None = None,
) -> None:
    """Leave the 'downloading' phase and record the real in-range total once the
    upstream backfill has landed, so the UI's 'N of M' reflects everything that
    will actually be processed (not the pre-download local count).

    ``already_processed`` is re-measured here for the same reason: the endpoint's
    figure predates the download, so mail that arrived (or was first synced)
    during it isn't reflected in it."""
    job = _PAST_JOBS.get(account_id)
    if not job:
        return
    if token is not None and job.get("token") != token:
        return
    job["total"] = total
    if already_processed is not None:
        job["already_processed"] = already_processed
    job["phase"] = "processing"
    if total <= 0:
        job["status"] = "done"
        job["finished_at"] = _now_iso()


def _past_job_tick(
    account_id: str, *, token: int | None = None,
    applied: int = 0, skipped: int = 0,
) -> None:
    job = _PAST_JOBS.get(account_id)
    if not job or job.get("status") != "running":
        return
    if token is not None and job.get("token") != token:
        return  # a newer run replaced this one — don't touch it
    job["processed"] += 1
    job["applied"] += applied
    job["skipped"] += skipped


def _past_job_finish(
    account_id: str, *, token: int | None = None, error: str | None = None,
    drafts_skipped: int = 0,
) -> None:
    job = _PAST_JOBS.get(account_id)
    if not job:
        return
    if token is not None and job.get("token") != token:
        return  # a newer run replaced this one — leave it running
    job["status"] = "error" if error else "done"
    job["error"] = error
    # Report suppressed drafting, so a run that deliberately skipped it doesn't
    # read as one where the rules simply ran in full.
    job["drafts_skipped"] = drafts_skipped
    job["finished_at"] = _now_iso()


# Rule actions that WRITE A DRAFT — the expensive, and on old mail usually
# unwanted, half of a rule. Each one calls the drafting model per message.
DRAFTING_ACTIONS = ("REPLY", "DRAFT_EMAIL", "FORWARD")


def _without_drafting(match: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """A copy of ``match`` with its drafting actions removed.

    Returns ``(match, stripped)``. The rule's other actions — label, archive,
    folder, mark-read — still run, because filing old mail is the point of a
    backfill; writing replies to it is not.
    """
    rule = match.get("rule") or {}
    actions = rule.get("actions") or []
    kept = [a for a in actions if a.get("type") not in DRAFTING_ACTIONS]
    if len(kept) == len(actions):
        return match, False
    return {**match, "rule": {**rule, "actions": kept}}, True


class RuleProcessPastRequest(BaseModel):
    account_id: str
    start_date: str | None = None  # ISO date (YYYY-MM-DD), inclusive
    end_date: str | None = None    # ISO date (YYYY-MM-DD), inclusive
    is_test: bool = False          # True = dry-run preview; False = apply for real
    include_read: bool = True      # False = only process unread mail in the range
    # Write drafts while backfilling. OFF BY DEFAULT, unlike a live run.
    #
    # A backfill walks months of already-resolved mail, and every draft action
    # spends a call on the drafting model. Defaulting this on meant pointing the
    # date picker at 90 days silently generated (and paid for) replies to
    # conversations that ended long ago, which the user then had to delete by
    # hand. Categorizing old mail is the point of a backfill; replying to it is
    # a separate, deliberate choice — so it has to be asked for.
    draft_replies: bool = False
    # Skip mail the rules have already run over (rules_processed_at IS NULL).
    # The date picker is a RANGE, not a cursor, so re-running it — or widening
    # it by a week — re-covers everything already done. Each of those messages
    # costs a classification call and rewrites a label it already has. Default
    # ON; turn it off to deliberately re-apply after changing a rule.
    skip_processed: bool = True
    limit: int = 1000


# Processing past mail is the ONE surface that spends a model call per message
# on a range the user picks by hand, and the picker is a free date input. Since
# "Clean older mail" can pull the whole mailbox into the local store, an
# unbounded range here stopped meaning "a few thousand" and started meaning
# "everything ever received".
#
#   "When processing past emails with AI, display a warning that extensive
#    categorization can be costly; limit processing to a few months up to a
#    year."                                                     — 2026-07-20
#
# Enforced HERE and not only in the dialog: the cap exists to bound spend, and a
# cap that lives only in the client is not a bound. A year is the ceiling, not
# the suggestion — the dialog's presets stop at 90 days.
_PROCESS_PAST_MAX_SPAN_DAYS = 366


def _assert_span_within_cap(
    start: datetime | None, end: datetime | None,
) -> int:
    """Days covered by [start, end]; 400 if it exceeds the cap.

    A missing ``start`` is not "a small range" — it is every message ever
    received, which is the most expensive request the API accepts. It is
    rejected with the same message as an over-wide one so the fix is the same:
    pick a start date.
    """
    if start is None:
        raise HTTPException(
            status_code=400,
            detail=f"Pick a start date. Processing past emails is limited to "
                   f"{_PROCESS_PAST_MAX_SPAN_DAYS} days per run because every "
                   f"email in the range costs an AI call.")
    span = ((end or datetime.now(timezone.utc)) - start).days + 1
    if span > _PROCESS_PAST_MAX_SPAN_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"That range covers {span} days. Processing past emails is "
                   f"limited to {_PROCESS_PAST_MAX_SPAN_DAYS} days per run "
                   f"because every email in the range costs an AI call — run "
                   f"it a year at a time.")
    return span


@router.get("/rules/process-past/estimate")
async def process_past_estimate(
    account_id: str,
    start_date: str | None = None,
    end_date: str | None = None,
    include_read: bool = True,
    skip_processed: bool = True,
    limit: int = 1000,
    user: UserContext = Depends(get_current_user),
):
    """How many emails a Process-past run would send to the model, before it runs.

    The dialog previously offered a free date picker and a Process button with no
    number between them, so the only way to learn that a range covered 4,000
    emails was to spend 4,000 AI calls finding out.

    ``will_process`` is deliberately not ``eligible``: the job reads
    ``LIMIT :limit`` rows, so a range wider than the limit is silently truncated
    and the tracker then reports that truncated figure as the total — which reads
    as "processed everything in the range" when it was "processed the oldest N".

    Counts what is synced LOCALLY. The job downloads the range from the provider
    first, so the real figure can be higher for a range that predates the initial
    365-day sync; the dialog says so rather than presenting this as exact.
    """
    start_dt = _parse_iso_date(start_date, end_of_day=False)
    end_dt = _parse_iso_date(end_date, end_of_day=True)
    only_unread = not include_read
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")

        async def _count(extra: str = "", unprocessed: bool = False) -> int:
            clause, params = _date_range_clause(
                account_id, start_dt, end_dt, only_unread, unprocessed)
            row = (await db.execute(text(
                f"SELECT COUNT(*) AS c FROM email_messages em "
                f"WHERE {clause}{extra}"
            ), params)).fetchone()
            return int(row.c) if row else 0

        in_range = await _count()
        eligible = await _count(unprocessed=skip_processed) \
            if skip_processed else in_range
        # Mail "Clean older mail" downloaded and deliberately kept away from the
        # model. It is eligible here — a deliberate, bounded, user-initiated run
        # is exactly the case the hold-back leaves room for — but the user should
        # know this range is mostly freshly-fetched history.
        held_back = await _count(
            extra=" AND em.rules_held_back_at IS NOT NULL", unprocessed=True)
    finally:
        await db.close()
    capped = max(0, min(limit, 2000))
    return {
        "in_range": in_range,
        "eligible": eligible,
        "already_processed": max(0, in_range - eligible),
        "held_back": held_back,
        "will_process": min(eligible, capped),
        "capped": eligible > capped,
        "limit": capped,
        "max_span_days": _PROCESS_PAST_MAX_SPAN_DAYS,
    }


@router.post("/rules/process-past")
async def process_past_emails(
    req: RuleProcessPastRequest,
    background: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
):
    """Run rules over PAST inbox mail within a date range (inbox-zero parity).

    Unlike /rules/run (which only touches unprocessed mail), this reprocesses
    every inbox email whose received_at falls in [start_date, end_date]. Test
    mode logs a PENDING preview; Apply mode executes the matched actions. Poll
    GET /email/rules/history for results.

    Drafting is OFF unless ``draft_replies`` is set — see the field comment on
    RuleProcessPastRequest. Filing old mail is the point; replying to it costs a
    model call per message on conversations that have usually long since ended.
    """
    start_dt = _parse_iso_date(req.start_date, end_of_day=False)
    end_dt = _parse_iso_date(req.end_date, end_of_day=True)
    _assert_span_within_cap(start_dt, end_dt)
    only_unread = not req.include_read
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        # Best-effort pre-count of what's ALREADY synced locally — just a hint for
        # the caller. The job downloads the range from upstream first, so the real
        # total is recomputed there (the picker can reach past what's been synced).
        clause, params = _date_range_clause(
            req.account_id, start_dt, end_dt, only_unread, req.skip_processed)
        n = (await db.execute(text(
            f"SELECT COUNT(*) AS c FROM email_messages em "
            f"WHERE {clause}"
        ), params)).fetchone()
        count = int(n.c) if n else 0
        # Count what the skip excluded, so a run that finds nothing can say
        # "already done" instead of "no emails found in that range" — otherwise
        # the correct behaviour reads as the feature being broken.
        already_processed = 0
        if req.skip_processed:
            all_clause, all_params = _date_range_clause(
                req.account_id, start_dt, end_dt, only_unread)
            n_all = (await db.execute(text(
                f"SELECT COUNT(*) AS c FROM email_messages em "
                f"WHERE {all_clause}"
            ), all_params)).fetchone()
            already_processed = max(0, (int(n_all.c) if n_all else 0) - count)
    finally:
        await db.close()
    # Always schedule: the job first downloads [start, end] from the provider so a
    # range that predates the local sync still has mail to process, THEN counts +
    # applies. The tracker starts in the 'downloading' phase and the UI polls it
    # (there's no meaningful synchronous count to gate on before the backfill).
    token = _past_job_start(
        req.account_id, user.email or "anonymous", count, req.is_test,
        downloading=True, already_processed=already_processed)
    background.add_task(
        _process_past_emails_job, req.account_id, start_dt, end_dt,
        min(req.limit, 2000), not req.is_test, user.email or "anonymous",
        only_unread, token, req.draft_replies, req.skip_processed,
    )
    return {"scheduled": True, "count": count, "dry_run": req.is_test,
            "draft_replies": req.draft_replies,
            "skip_processed": req.skip_processed,
            "already_processed": already_processed}


@router.get("/rules/process-past/status")
async def process_past_status(
    account_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Live progress for the most recent 'Process past emails' run on this
    account so the UI can show an ongoing indicator + auto-refresh History.

    Returns {"status": "idle"} when no run has happened (or it belongs to a
    different user)."""
    job = _PAST_JOBS.get(account_id)
    if not job or job.get("owner") != (user.email or "anonymous"):
        return {"status": "idle"}
    return {k: v for k, v in job.items() if k != "owner"}


class RuleRunMessageRequest(BaseModel):
    account_id: str
    message_id: str
    is_test: bool = True  # True = dry-run preview; False = apply for real


@router.post("/rules/run-message")
async def run_rules_on_message(
    req: RuleRunMessageRequest,
    user: UserContext = Depends(get_current_user),
):
    """Run rules against a single message — the Test tab's per-row Test/Apply.

    `is_test=True` returns the matched rule + actions without touching the
    mailbox. `is_test=False` applies the matched rule's actions, logs an APPLIED
    (or SKIPPED) row to the history, and marks the message processed.
    """
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        row = (await db.execute(text(
            """SELECT id, provider_message_id, thread_id, subject, body_text,
                      snippet, from_address, to_addresses, cc_addresses,
                      received_at
               FROM email_messages
               WHERE id = :mid AND account_id = :aid"""
        ), {"mid": req.message_id, "aid": req.account_id})).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")

        frm = row.from_address if isinstance(row.from_address, dict) \
            else json.loads(row.from_address or "{}")
        about, _ = await _load_assistant_about(db, req.account_id)
        org_domains = await resolve_org_domains(db, req.account_id)
        attach = (await _attachment_summaries(db, [row.id])).get(str(row.id), "")
        email = email_dict_from_row(
            row, await _account_self_email(db, req.account_id), about,
            extra_domains=org_domains, attachments=attach)
        match = await _match_email_to_rule(db, req.account_id, email)

        if req.is_test:
            if not match:
                return {"matched": False, "applied": False, "rule": None,
                        "reason": "No rule matched.", "actions": []}
            return {
                "matched": True, "applied": False,
                "rule": {"id": match["rule"]["id"], "name": match["rule"]["name"]},
                "reason": match["reason"],
                "actions": match["rule"]["actions"],
            }

        # Apply mode — load the provider and execute.
        if not match:
            await db.execute(text(
                """INSERT INTO email_executed_rules
                     (account_id, rule_id, rule_name, message_id,
                      provider_message_id, thread_id, subject, from_address,
                      status, automated, actions_taken, reason)
                   VALUES (:aid, NULL, NULL, :mid, :pmid, :tid, :subj, :frm,
                           'SKIPPED', true, '[]', 'No rule matched this email.')"""
            ), {"aid": req.account_id, "mid": str(row.id),
                "pmid": row.provider_message_id, "tid": row.thread_id,
                "subj": row.subject or "", "frm": frm.get("email", "")})
            await db.commit()
            return {"matched": False, "applied": False, "rule": None,
                    "reason": "No rule matched.", "actions": []}

        acc = (await db.execute(text(
            "SELECT provider, credentials_encrypted, user_id "
            "FROM email_accounts WHERE id = :id"
        ), {"id": req.account_id})).fetchone()
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        from acb_llm.key_store import get_key_store  # noqa: PLC0415
        store = get_key_store()
        creds = json.loads(store.decrypt(acc.credentials_encrypted))
        provider = _instantiate_provider(acc.provider, creds)
        if not await provider.authenticate():
            raise HTTPException(status_code=502, detail="Provider auth failed")

        about, signature = await _load_assistant_about(db, req.account_id)
        # Multi-rule execution (inbox-zero parity): apply EVERY matching rule.
        mr_row = (await db.execute(text(
            "SELECT multi_rule_execution FROM email_assistant_settings "
            "WHERE account_id = :aid"
        ), {"aid": req.account_id})).fetchone()
        multi_rule = bool(mr_row and getattr(mr_row, "multi_rule_execution", None))
        if multi_rule:
            matches = await _match_email_to_rules_multi(db, req.account_id, email) \
                or [match]
        else:
            matches = [match]
        for m in matches:
            await _apply_and_log_match(
                db, provider, row, frm, email, m, True,
                about, signature, acc.user_id, req.account_id,
                sole_match=len(matches) == 1,
            )
        await db.execute(text(
            "UPDATE email_messages SET rules_processed_at = now(), "
            "rules_held_back_at = NULL WHERE id = :id"
        ), {"id": str(row.id)})
        await _persist_rotated_creds(db, store, req.account_id, provider)
        await db.commit()
        # Return the row's POST-apply category + folder so the caller can refresh
        # its inbox row in place — the "Uncategorized" pill in the list reruns
        # this endpoint and needs the applied label to resolve without a full
        # refetch (the actions above may also have archived/moved the message).
        fresh = (await db.execute(text(
            "SELECT categories, folder FROM email_messages WHERE id = :id"
        ), {"id": str(row.id)})).fetchone()
        primary = matches[0]
        return {
            "matched": True, "applied": True,
            "rule": {"id": primary["rule"]["id"], "name": primary["rule"]["name"]},
            "reason": primary["reason"],
            "actions": primary["rule"]["actions"],
            "applied_rules": [m["rule"]["name"] for m in matches],
            "categories": list(fresh.categories or []) if fresh else [],
            "folder": fresh.folder if fresh else None,
        }
    finally:
        await db.close()


_AUTO_LEARN_MIN_CONSISTENT = 5

# A learned FROM pattern asserts something about the SENDER'S IDENTITY: that this
# address only ever sends one kind of thing. That is true of a newsletter list, a
# marketing blast and a cold-outreach account, and it is the reason those senders
# are worth pinning at all — the mail is defined by who sent it.
#
# It is NOT true of Receipt, Calendar or Notification. Those describe what a
# message IS, and they routinely arrive from people you also have real
# conversations with: a colleague sends a meeting invite on Monday and asks a
# question on Tuesday. Pinning them to Calendar files the question as a calendar
# item. Two of the patterns purged from the live account were exactly this
# (midhun.vm → Calendar, debesh@metafora.sg → Receipt), and the correspondent
# check alone did not stop them.
#
# The user can still pin any category by hand — this restricts only what the
# assistant may decide on its own, unattended.
_AUTO_LEARNABLE_RULES = frozenset({"newsletter", "marketing", "cold email"})


def _is_auto_learnable_rule(rule: dict[str, Any]) -> bool:
    """May the assistant pin a sender to this rule without being asked?"""
    name = (rule.get("name") or "").strip().lower()
    system = (rule.get("system_type") or "").strip().lower().replace("_", " ")
    return name in _AUTO_LEARNABLE_RULES or system in _AUTO_LEARNABLE_RULES


async def _ai_confirms_sender_pattern(
    db: Any, account_id: str, sender: str, rule: dict[str, Any],
) -> bool:
    """Ask the model, once, whether this sender is inherently single-purpose.

    Counting agreements measures CONSISTENCY, not correctness. A classifier that
    is confidently wrong about a sender is wrong the same way five times, and
    without this step that streak is all it takes to write a permanent pin — the
    machine agreeing with itself, recorded as fact. This is the check that makes
    the difference: a separate judgment, over the sender's actual mail, about a
    different question — not "what is this email?" but "will EVERY future email
    from this address be the same kind of thing?"

    Ported from inbox-zero's ``aiDetectRecurringPattern``, which we had omitted:
    their threshold count is only a floor before asking this, whereas ours had
    been the entire bar.

    Fails CLOSED. No model, no samples, unparseable answer, anything unexpected
    → no pattern. Not learning is free; a wrong pin is silent and permanent.
    """
    rows = (await db.execute(text(
        """SELECT subject, snippet FROM email_messages
            WHERE account_id = :aid
              AND LOWER(from_address->>'email') = :sender
              AND LOWER(COALESCE(folder, '')) <> 'sent'
            ORDER BY received_at DESC LIMIT 10"""
    ), {"aid": account_id, "sender": sender})).fetchall()
    if len(rows) < 3:
        return False

    samples = "\n".join(
        f"- {(r.subject or '(no subject)')[:120]}"
        f" — {(r.snippet or '')[:160]}" for r in rows)
    rule_name = rule.get("name") or ""
    try:
        data, _content, _used = await _llm_json(
            "tier-balanced",
            [{"role": "system", "content": (
                "You decide whether a sender's mail should ALWAYS be filed "
                "under one rule, without the classifier ever looking at it "
                "again. Say yes ONLY if you are 90%+ confident that EVERY "
                "future email from this address will serve the same purpose.\n"
                "Yes: list and no-reply addresses whose whole reason to exist "
                "is one kind of message — newsletter@, marketing@, an "
                "outreach account that only ever pitches.\n"
                "No: a person. No: an address at a generic domain "
                "(gmail.com, outlook.com, yahoo.com) unless it is plainly an "
                "automated sender. No: anyone who might also send something "
                "that needs a reply. No: mixed content across the samples.\n"
                "Be conservative. Any doubt at all is a no.\n"
                'Respond with ONLY {"always": true|false, "why": "<short>"}.'
            )},
             {"role": "user", "content": (
                 f"Sender: {sender}\n"
                 f'Proposed rule: "{rule_name}" — '
                 f'{rule.get("instructions") or "(no description)"}\n\n'
                 f"Their {len(rows)} most recent messages:\n{samples}"
             )}],
            max_tokens=200,
        )
    except Exception as exc:  # never fail a rule run on this
        _log.warning("email.auto_learn_verdict_failed",
                     account_id=account_id, error=str(exc)[:160])
        return False
    ok = bool(isinstance(data, dict) and data.get("always") is True)
    _log.info("email.auto_learn_verdict", account_id=account_id,
              sender=sender, rule=rule_name, confirmed=ok,
              why=str((data or {}).get("why", ""))[:120])
    return ok


async def _sender_is_a_correspondent(
    db: Any, account_id: str, sender: str,
) -> bool:
    """Has the user ever actually CONVERSED with this sender?

    A cleanup category (Newsletter / Receipt / Calendar / Notification) is only
    a safe thing to pin to a sender when the sender is a machine. Pin one to a
    person and their next genuine request is filed as a receipt.

    Conversation-status labels are the evidence: Reply / Awaiting Reply / Done /
    FYI are assigned per-thread from the whole conversation, so their presence
    means this address has been in a real exchange. Found on the live account:
    ``midhun.vm@…`` pinned to Calendar while carrying Awaiting Reply AND Done,
    and ``debesh@metafora.sg`` pinned to Receipt while carrying Awaiting Reply —
    both people who send documents *and* ask questions.
    """
    try:
        row = (await db.execute(text(
            """SELECT 1 FROM email_messages m
                WHERE m.account_id = :aid
                  AND LOWER(m.from_address->>'email') = :sender
                  AND m.categories && ARRAY['Reply', 'Awaiting Reply',
                                            'Done', 'FYI']
                LIMIT 1"""
        ), {"aid": account_id, "sender": sender})).fetchone()
    except Exception:  # noqa: BLE001
        return True  # unknown → refuse to pin; the safe direction
    return row is not None


async def _sender_consistent_for_rule(
    db: Any, account_id: str, sender: str, rule_id: str,
) -> bool:
    """Whether to auto-learn a sender→rule classification pattern yet.

    inbox-zero's analyze-sender-pattern only commits a learned pattern once a
    sender's mail has CONSISTENTLY matched one rule. We mirror that: require
    ``_AUTO_LEARN_MIN_CONSISTENT`` DISTINCT messages (counting the current one)
    and no *other* rule ever matched this sender.

    Three things this counted that are not evidence, all found live:

    * **Dry runs.** The filter excluded SKIPPED/REJECTED but not PENDING, which
      is what a *preview* logs. Pressing "Test" three times on one email taught
      a permanent pattern — ``arvind@exinous.com`` → Calendar was learned from 7
      log rows covering ONE message, 5 of them previews. A dry run is documented
      as changing nothing; it must not teach.

    * **The same message, repeatedly.** ``COUNT(*)`` over a log that gets a row
      per rule per run. ``donotreply@gst.gov.in`` had 10 rows for 1 message. The
      bar reads "3 consistent matches" and meant "3 log lines", so re-running a
      backfill over the same mail manufactured its own evidence.

    * **Rows with no message at all.** 616 APPLIED rows carry a NULL message_id.
      They cannot be corroborated, so they no longer count toward the bar.

    Requires APPLIED specifically rather than "not SKIPPED": a status this code
    has never seen should not be assumed to be evidence.
    """
    sender = (sender or "").strip().lower()
    if not sender:
        return False
    try:
        rows = (await db.execute(text(
            """SELECT rule_id, COUNT(DISTINCT message_id) AS n
                 FROM email_executed_rules
                WHERE account_id = :aid AND rule_id IS NOT NULL
                  AND message_id IS NOT NULL
                  AND status = 'APPLIED'
                  AND LOWER(COALESCE(from_address, '')) LIKE :pat
                GROUP BY rule_id"""
        ), {"aid": account_id, "pat": f"%{sender}%"})).fetchall()
    except Exception:  # noqa: BLE001
        return False
    by_rule = {str(row.rule_id): int(row.n) for row in rows}
    if any(rid != str(rule_id) and n > 0 for rid, n in by_rule.items()):
        return False  # a different rule has matched this sender → not consistent
    return by_rule.get(str(rule_id), 0) + 1 >= _AUTO_LEARN_MIN_CONSISTENT


async def _apply_and_log_match(
    db: Any, provider: Any, r: Any, frm: dict[str, Any], email: dict[str, str],
    match: dict[str, Any], apply: bool, about: str, signature: str,
    account_user: str, account_id: str, *, sole_match: bool = True,
) -> None:
    """Apply one matched rule's actions (or compute a dry-run preview) and log an
    email_executed_rules row. Shared by the auto-run and process-past jobs so
    multi-rule execution behaves identically in both."""
    rule = match["rule"]
    if match.get("suppressed"):
        # Single thread classification: this rule DID match the message in
        # isolation, but the thread's classification won. Log it — History must
        # be able to answer "why wasn't this filed as a Receipt?" — and stop.
        # Guarded HERE, at the one choke point every apply path goes through,
        # so no future caller can accidentally run a suppressed match's
        # actions; the same shape as the pattern-write gate in rules._teach.
        await db.execute(text(
            """INSERT INTO email_executed_rules
                 (account_id, rule_id, rule_name, message_id,
                  provider_message_id, thread_id, subject, from_address,
                  status, automated, actions_taken, reason)
               VALUES (:aid, :rid, :rname, :mid, :pmid, :tid, :subj, :frm,
                       'SKIPPED', true, '[]', :reason)"""
        ), {"aid": account_id, "rid": rule.get("id"),
            "rname": rule.get("name"), "mid": str(r.id),
            "pmid": r.provider_message_id, "tid": r.thread_id,
            "subj": r.subject or "", "frm": frm.get("email", ""),
            "reason": ("Suppressed: part of a conversation — the thread's "
                       "status is the classification.")})
        return
    action_errors: list[dict[str, str]] = []
    pmid = r.provider_message_id
    if apply:
        # Outlook RE-KEYS a message when it moves: /move returns a new id and
        # the old one 404s. `r` was fetched once, BEFORE the per-match loop, so
        # with multi_rule_execution on (it is, on the live account) the second
        # rule called Graph with the id the first rule's move had just
        # invalidated. _apply_rule_actions already persists the new id, so
        # re-reading it here is enough — and it also picks up a re-key done by
        # anything else since the row was read.
        #
        # Live evidence: 138 rule applications in 30 days 404'd, 46 of them a
        # sibling rule acting after a successful MOVE_FOLDER in the same run.
        pmid = (await db.execute(text(
            "SELECT provider_message_id FROM email_messages WHERE id = :id"
        ), {"id": str(r.id)})).scalar() or pmid
        actions_taken = await _apply_rule_actions(
            db, provider, str(r.id), pmid,
            rule["actions"], email, about, signature, account_user,
            account_id=account_id, errors_out=action_errors,
        )
        # A row that changed NOTHING must not claim it did. APPLIED is what the
        # auto-learn gate counts as evidence and what Analytics counts as work
        # done, so logging a total failure as APPLIED both overstated the
        # assistant and let a rule that never touched the mailbox teach a
        # permanent sender pattern. Partial success stays APPLIED — the errors
        # ride along in action_errors.
        status = "FAILED" if (action_errors and not actions_taken) else "APPLIED"
        # inbox-zero parity: when the AI (not a static/learned-pattern rule)
        # picks a rule, cache the sender→rule as a learned FROM pattern so future
        # mail from that sender short-circuits the LLM. Consistency-gated like
        # inbox-zero's analyze-sender-pattern: only learn once the sender has
        # CONSISTENTLY matched this one rule (≥3 incl. now), so a single early
        # misclassification can't entrench itself. Best-effort.
        #
        # NEVER auto-learn a sender→rule pattern for the conversation-status rules
        # (Reply / Awaiting / FYI / Done): a person's mail flows between
        # those states per-thread, so pinning a sender to one (e.g. "accounts team
        # → always FYI") is wrong — and futile, since reply status is re-derived
        # from the full thread and overrides any learned pattern. Sender→rule only
        # makes sense for the stable cleanup categories (Newsletter/Receipt/etc.).
        sender = (frm.get("email") or "").strip()
        # `sole_match` is the multi-rule guard. With multi_rule_execution on
        # (it is, on the live account) one message legitimately matches several
        # rules, and _apply_and_log_match is called once per match IN A LOOP —
        # so the first rule's consistency check reads a log that does not yet
        # contain its own siblings, and the "no other rule ever matched this
        # sender" invariant is unenforceable. Live result: Info@yourstory.com
        # was pinned to Marketing although every one of its messages matches
        # Marketing + Newsletter or Marketing + Cold Email, and the pattern then
        # short-circuits the classifier down to the single pinned rule.
        #
        # Pinning a sender only means anything when the classification was
        # unambiguous, so an ambiguous message teaches nothing.
        #
        # A rule whose every action failed taught a pattern anyway, because the
        # gate only ever asked whether a rule MATCHED. Three 404s against a
        # message Outlook had already re-keyed were three votes for pinning that
        # sender forever, off a mailbox that was never touched.
        #
        # Order matters: the cheap local checks gate the one that costs a model
        # call, so the verdict is only ever asked about a sender that has
        # already earned it.
        if (status == "APPLIED"
                and sole_match and match.get("source") == "ai" and sender
                and rule.get("id")
                and not _is_conversation_status_rule(rule)
                and _is_auto_learnable_rule(rule)
                and not await _sender_is_a_correspondent(db, account_id, sender)
                and await _sender_consistent_for_rule(
                    db, account_id, sender, str(rule["id"]))
                and await _ai_confirms_sender_pattern(
                    db, account_id, sender, rule)):
            try:
                await _upsert_rule_pattern(
                    db, account_id, str(rule["id"]), sender, False, "AI",
                    "Auto-learned from a consistent AI match history", str(r.id),
                    getattr(r, "thread_id", None), pattern_type="FROM")
            except Exception as e:  # noqa: BLE001 — never fail a rule run on this
                _log.warning("email.auto_learn_pattern_failed",
                             account_id=account_id, error=str(e)[:160])
    else:
        actions_taken = [a["type"] for a in rule["actions"]]
        status = "PENDING"  # dry-run preview only
    await db.execute(text(
        """INSERT INTO email_executed_rules
             (account_id, rule_id, rule_name, message_id, provider_message_id,
              thread_id, subject, from_address, status, automated, actions_taken,
              reason, match_source, action_errors)
           VALUES (:aid, :rid, :rname, :mid, :pmid, :tid, :subj, :frm,
                   :status, true, :acts, :reason, :msrc,
                   CAST(:aerr AS JSONB))"""
    ), {"aid": account_id, "rid": rule["id"], "rname": rule["name"],
        # The id we actually CALLED, not the one the row was read with — when
        # they differ, the row was re-keyed mid-run and the log should say so.
        "mid": str(r.id), "pmid": pmid, "tid": r.thread_id,
        "subj": r.subject or "", "frm": frm.get("email", ""), "status": status,
        "acts": json.dumps(actions_taken), "reason": match["reason"],
        "msrc": match.get("source"), "aerr": json.dumps(action_errors)})


async def _project_thread_status_for_backfill(
    db: Any, provider: Any, account_id: str,
    latest_by_thread: dict[str, tuple[Any, list[dict[str, Any]]]],
) -> None:
    """Record Reply Zero status + collapse labels for threads a backfill touched.

    The backfill applied per-message labels but never wrote a thread status or
    cleared the superseded conversation labels, so a thread it walked could end
    up carrying Reply AND Awaiting AND Done while Reply Zero showed nothing for
    it at all — the status row and the labels being two views of one decision,
    with only the second written.

    Two deliberate restraints:

    * **Only threads whose newest message was actually in range.** If newer mail
      exists outside the date window, the newest message we saw is NOT the
      thread's newest, and projecting from it would move the thread backwards.
      Those are left for the periodic classifier, which always reads the true
      latest message.
    * **No AI.** This projects the rule the engine already matched
      (``project_reply_status_from_matches`` picks the highest-priority
      conversation rule deterministically). Re-determining each thread from its
      full text would be one model call per thread across a whole mailbox, on
      conversations that are usually long finished. The periodic classifier
      spends that budget where it pays — threads still sitting in the inbox.
    """
    from gateway.routes.email.automation.replyzero import (  # noqa: PLC0415
        _reconcile_thread_labels,
        project_reply_status_from_matches,
    )
    tids = list(latest_by_thread)
    # Threads with mail newer than what this run saw — skip them.
    stale = {
        str(row.thread_id)
        for row in (await db.execute(text(
            """SELECT em.thread_id, MAX(em.received_at) AS newest
                 FROM email_messages em
                WHERE em.account_id = :aid AND em.thread_id = ANY(:tids)
                GROUP BY em.thread_id"""
        ), {"aid": account_id, "tids": tids})).fetchall()
        if (seen := latest_by_thread.get(str(row.thread_id)))
        and getattr(seen[0], "received_at", None) is not None
        and row.newest is not None
        and row.newest > seen[0].received_at
    }
    for tid, (row, matches) in latest_by_thread.items():
        if tid in stale:
            continue
        try:
            keep_label = await project_reply_status_from_matches(
                db, account_id, row, matches)
            if keep_label:
                await _reconcile_thread_labels(
                    db, provider, account_id, tid, keep_label)
            await db.commit()
        except Exception as exc:  # noqa: BLE001 — one thread must not abort the rest
            _log.warning("email.past_project_status_failed",
                         account_id=account_id, thread_id=tid,
                         error=str(exc)[:160])


async def _process_past_emails_job(
    account_id: str, start: datetime | None, end: datetime | None,
    limit: int, dry_run: bool, user_email: str, only_unread: bool = False,
    job_token: int | None = None, draft_replies: bool = False,
    skip_processed: bool = True,
) -> None:
    """Background worker: process PAST inbox mail in a date range (inbox-zero
    'Process past emails'), oldest email first so rules/learning build up
    chronologically.

    By default this touches only mail the rules have never run over. The date
    picker is a range rather than a cursor, so re-running it — or widening it —
    otherwise re-covers everything already done, at one classification call per
    message, to rewrite labels those messages already carry. Pass
    ``skip_processed=False`` to deliberately re-apply after changing a rule.

    Updates the in-memory progress tracker (_PAST_JOBS) per email so the UI's
    'Processing N of M…' indicator advances live and History can auto-refresh."""
    # Download the requested range from the provider BEFORE applying. The date
    # picker can reach back past what's been synced locally; without this the
    # range query below is simply empty and the feature no-ops ("No emails found
    # in that range."). A deep sync from the `start` floor backfills it; the apply
    # itself stays bounded to [start, end] via _date_range_clause. Best-effort —
    # a failed/partial backfill still applies over whatever IS present locally.
    try:
        from email_ingestion.scheduler import _sync_account  # noqa: PLC0415
        await _sync_account(account_id, deep=True, since=start)
    except Exception as e:  # noqa: BLE001 — never abort the apply on a backfill error
        _log.warning("email.process_past_sync_failed",
                     account_id=account_id, error=str(e)[:200])
    # _get_db() is INSIDE the try: if the pool is exhausted or Postgres blips,
    # the exception used to escape the BackgroundTask entirely, leaving the
    # tracker stuck on {"status": "running"} forever. The UI then polls every
    # 1.5s for the rest of the session behind a banner whose dismiss button is
    # hidden precisely because it thinks a run is in flight.
    db = None
    try:
        db = await _get_db()
        clause, params = _date_range_clause(
            account_id, start, end, only_unread, skip_processed)
        params["limit"] = limit
        rows = (await db.execute(text(
            f"""SELECT em.id, em.provider_message_id, em.thread_id, em.subject,
                       em.body_text, em.snippet, em.from_address,
                       em.to_addresses, em.cc_addresses, em.received_at
                FROM email_messages em
                WHERE {clause}
                ORDER BY em.received_at ASC LIMIT :limit"""
        ), params)).fetchall()
        # The backfill may have pulled in mail the pre-schedule count didn't see —
        # record the real total and switch the tracker to per-email progress.
        done_before = 0
        if skip_processed:
            seen_clause, seen_params = _date_range_clause(
                account_id, start, end, only_unread)
            seen_clause += " AND em.rules_processed_at IS NOT NULL"
            seen = (await db.execute(text(
                f"SELECT COUNT(*) AS c FROM email_messages em "
                f"WHERE {seen_clause}"
            ), seen_params)).fetchone()
            done_before = int(seen.c) if seen else 0
        _past_job_begin_processing(account_id, token=job_token, total=len(rows),
                                   already_processed=done_before)
        if not rows:
            # Not an error, and not "no emails found": when done_before > 0 the
            # range was simply already covered. The tracker carries the number so
            # the UI can say which of the two it was.
            _past_job_finish(account_id, token=job_token)
            return

        about, signature = await _load_assistant_about(db, account_id)
        owner_row = (await db.execute(text(
            "SELECT user_id, email_address FROM email_accounts WHERE id = :aid"
        ), {"aid": account_id})).fetchone()
        account_user = owner_row.user_id if owner_row else (user_email or "")
        self_email = (owner_row.email_address or "") if owner_row else ""
        mr_row = (await db.execute(text(
            "SELECT multi_rule_execution FROM email_assistant_settings "
            "WHERE account_id = :aid"
        ), {"aid": account_id})).fetchone()
        multi_rule = bool(mr_row and getattr(mr_row, "multi_rule_execution", None))
        org_domains = await resolve_org_domains(db, account_id)
        attach = await _attachment_summaries(db, [r.id for r in rows])

        provider = None
        if not dry_run:
            acc = (await db.execute(text(
                "SELECT provider, credentials_encrypted FROM email_accounts "
                "WHERE id = :id"
            ), {"id": account_id})).fetchone()
            if acc:
                from acb_llm.key_store import get_key_store
                store = get_key_store()
                creds = json.loads(store.decrypt(acc.credentials_encrypted))
                provider = _instantiate_provider(acc.provider, creds)
                if not await provider.authenticate():
                    provider = None

        # How many messages had a drafting action suppressed — surfaced on the
        # job tracker so the UI can say what was skipped rather than let the run
        # look like the rules ran in full.
        drafts_skipped = 0
        # Newest in-range message per thread + what it matched, for the Reply
        # Zero projection after the loop. This job cannot project inline the way
        # the live runner does: the live runner reads newest-first and takes the
        # first message per thread, while this one reads OLDEST-first, so
        # projecting inline would let a thread's oldest message decide its
        # status — the exact thing the live runner's ordering exists to prevent.
        latest_by_thread: dict[str, tuple[Any, list[dict[str, Any]]]] = {}

        for r in rows:
            frm = r.from_address if isinstance(r.from_address, dict) \
                else json.loads(r.from_address or "{}")
            email = email_dict_from_row(
                r, self_email, about, extra_domains=org_domains,
                attachments=attach.get(str(r.id), ""))
            if multi_rule:
                matches = await _match_email_to_rules_multi(db, account_id, email)
            else:
                m = await _match_email_to_rule(db, account_id, email)
                matches = [m] if m else []
            apply = (not dry_run) and provider is not None
            if matches:
                for match in matches:
                    # Strip drafting unless the run explicitly asked for it, so a
                    # 90-day backfill files old mail without spending a drafting
                    # call per message on threads that ended months ago.
                    if not draft_replies:
                        match, stripped = _without_drafting(match)
                        if stripped:
                            drafts_skipped += 1
                    await _apply_and_log_match(
                        db, provider, r, frm, email, match, apply,
                        about, signature, account_user, account_id,
                        sole_match=len(matches) == 1,
                    )
            elif not dry_run:
                await db.execute(text(
                    """INSERT INTO email_executed_rules
                         (account_id, rule_id, rule_name, message_id,
                          provider_message_id, thread_id, subject, from_address,
                          status, automated, actions_taken, reason)
                       VALUES (:aid, NULL, NULL, :mid, :pmid, :tid, :subj, :frm,
                               'SKIPPED', true, '[]', 'No rule matched this email.')"""
                ), {"aid": account_id, "mid": str(r.id),
                    "pmid": r.provider_message_id, "tid": r.thread_id,
                    "subj": r.subject or "", "frm": frm.get("email", "")})
            # Same rule as _run_rules_job: never burn the watermark on a run
            # that had no provider to act through (see the comment there).
            if not dry_run and provider is not None:
                await db.execute(text(
                    "UPDATE email_messages SET rules_processed_at = now(), "
                    "rules_held_back_at = NULL WHERE id = :id"
                ), {"id": str(r.id)})
            await db.commit()
            # Remember the NEWEST in-range message per thread and what it
            # matched. Rows are oldest-first (deliberately, so learning builds
            # chronologically), so the last write per thread is its newest.
            if r.thread_id:
                latest_by_thread[r.thread_id] = (r, matches)
            _past_job_tick(
                account_id,
                token=job_token,
                applied=1 if matches else 0,
                skipped=0 if matches else 1,
            )

        if not dry_run and latest_by_thread:
            await _project_thread_status_for_backfill(
                db, provider, account_id, latest_by_thread)

        _past_job_finish(account_id, token=job_token,
                         drafts_skipped=drafts_skipped)
    except Exception as e:  # noqa: BLE001 — record failure for the UI, don't crash the worker
        _log.warning("email.process_past_failed", account_id=account_id, error=str(e)[:200])
        _past_job_finish(account_id, token=job_token, error=str(e))
    finally:
        if db is not None:
            await db.close()


async def _run_rules_job(
    account_id: str, limit: int, dry_run: bool, user_email: str
) -> None:
    """Background worker: match UNPROCESSED inbox mail to rules and log/apply.

    Live runs (dry_run=False) apply every matched rule's actions and mark the
    message processed; no-match mail is logged SKIPPED so the History feed shows
    a "No match found" entry (inbox-zero parity). Dry runs only log a PENDING
    preview and never touch the mailbox.
    """
    db = await _get_db()
    try:
        rows = (await db.execute(text(
            """SELECT em.id, em.provider_message_id, em.thread_id, em.subject,
                      em.body_text, em.snippet, em.from_address,
                      em.to_addresses, em.cc_addresses, em.received_at
               FROM email_messages em
               WHERE em.account_id = :aid AND LOWER(em.folder) = 'inbox'
                 AND em.rules_processed_at IS NULL
                 AND em.rules_held_back_at IS NULL
               ORDER BY em.received_at DESC LIMIT :limit"""
        ), {"aid": account_id, "limit": limit})).fetchall()
        if not rows:
            return

        about, signature = await _load_assistant_about(db, account_id)
        owner_row = (await db.execute(text(
            "SELECT user_id, email_address FROM email_accounts WHERE id = :aid"
        ), {"aid": account_id})).fetchone()
        account_user = owner_row.user_id if owner_row else (user_email or "")
        self_email = (owner_row.email_address or "") if owner_row else ""
        cold_blocker = "OFF"
        multi_rule = False
        cb_row = (await db.execute(text(
            "SELECT cold_email_blocker, multi_rule_execution, org_domains "
            "FROM email_assistant_settings WHERE account_id = :aid"
        ), {"aid": account_id})).fetchone()
        if cb_row and cb_row.cold_email_blocker:
            cold_blocker = cb_row.cold_email_blocker
        if cb_row and getattr(cb_row, "multi_rule_execution", None):
            multi_rule = bool(cb_row.multi_rule_execution)
        # Configured extra "your organisation" domains → direction-aware
        # classification (outbound/internal mail isn't a received category).
        # Via resolve_org_domains, like every other caller: reading the column
        # raw skipped normalize_domain, so a user who typed "ops@acme.com" or
        # "https://acme.com" got their org recognised on the test/process-past
        # paths and NOT on this one — the path that actually processes new mail.
        org_domains = await resolve_org_domains(db, account_id)

        provider = None
        store = None
        if not dry_run:
            acc = (await db.execute(text(
                "SELECT provider, credentials_encrypted FROM email_accounts WHERE id = :id"
            ), {"id": account_id})).fetchone()
            if acc:
                from acb_llm.key_store import get_key_store
                store = get_key_store()
                creds = json.loads(store.decrypt(acc.credentials_encrypted))
                provider = _instantiate_provider(acc.provider, creds)
                if not await provider.authenticate():
                    provider = None

        # Reply Zero (unified): project each thread's reply status from the rule
        # the engine matched. Rows are newest-first, so the first message seen per
        # thread is the latest — project only that one (older ones must not clobber
        # a newer status).
        projected_threads: set[str] = set()
        attach = await _attachment_summaries(db, [r.id for r in rows])

        for r in rows:
            frm = r.from_address if isinstance(r.from_address, dict) \
                else json.loads(r.from_address or "{}")
            # extra_domains is a KEYWORD arg — passing it positionally lands it in
            # self_name and silently drops the configured org domains.
            email = email_dict_from_row(
                r, self_email, about, extra_domains=org_domains,
                attachments=attach.get(str(r.id), ""))
            # Multi-rule execution (inbox-zero parity): when on, every matching
            # rule applies; otherwise just the single best match.
            if multi_rule:
                matches = await _match_email_to_rules_multi(db, account_id, email)
            else:
                m = await _match_email_to_rule(db, account_id, email)
                matches = [m] if m else []
            # Thread-unit classification (inbox-zero determineConversationStatus
            # parity, widened): a conversation has ONE classification, and every
            # new message re-evaluates it with the full thread as context. The
            # resolver — not the per-message match — decides whether this thread
            # is a conversation, so it runs even when nothing matched: a bare
            # "ok noted" that matches no rule must still refresh the thread's
            # status rather than leave it stale. For bulk mail it returns the
            # per-message matches untouched without spending a model call.
            # Live runs only — the dry-run preview stays per-message and cheap.
            if not dry_run:
                from gateway.routes.email.automation.replyzero import (  # noqa: PLC0415
                    resolve_conversation_status_matches,
                )
                matches = await resolve_conversation_status_matches(
                    db, account_id, r, matches, provider=provider)
            if matches:
                apply = (not dry_run) and provider is not None
                for match in matches:
                    await _apply_and_log_match(
                        db, provider, r, frm, email, match, apply,
                        about, signature, account_user, account_id,
                        sole_match=len(matches) == 1,
                    )
            elif not dry_run:
                # No rule matched — log a SKIPPED row so History shows a
                # "No match found" entry, then let the cold-email blocker look.
                await db.execute(text(
                    """INSERT INTO email_executed_rules
                         (account_id, rule_id, rule_name, message_id,
                          provider_message_id, thread_id, subject, from_address,
                          status, automated, actions_taken, reason)
                       VALUES (:aid, NULL, NULL, :mid, :pmid, :tid, :subj, :frm,
                               'SKIPPED', true, '[]', 'No rule matched this email.')"""
                ), {"aid": account_id, "mid": str(r.id),
                    "pmid": r.provider_message_id, "tid": r.thread_id,
                    "subj": r.subject or "", "frm": frm.get("email", "")})
                if provider is not None and cold_blocker != "OFF":
                    await _maybe_block_cold(
                        db, provider, account_id, str(r.id),
                        r.provider_message_id, email, cold_blocker,
                    )
            # Reply Zero: project this thread's status from the matched rule
            # (latest message per thread only). Read-only of the mailbox — runs
            # even when the provider failed to authenticate.
            if not dry_run and r.thread_id and r.thread_id not in projected_threads:
                projected_threads.add(r.thread_id)
                try:
                    from gateway.routes.email.automation.replyzero import (  # noqa: PLC0415
                        _reconcile_thread_labels,
                        project_reply_status_from_matches,
                    )
                    keep_label = await project_reply_status_from_matches(
                        db, account_id, r, matches)
                    # Collapse the thread to that one conversation label, clearing
                    # any stale Reply / Awaiting / FYI / Follow-up left on
                    # earlier messages (inbox-zero mutually-exclusive labels).
                    if keep_label and provider is not None:
                        await _reconcile_thread_labels(
                            db, provider, account_id, r.thread_id, keep_label)
                except Exception as exc:  # noqa: BLE001
                    _log.warning("email.project_reply_status_failed",
                                 account_id=account_id, error=str(exc)[:160])
            # Stamp the watermark ONLY when the run could actually act. The
            # watermark is permanent — /rules/run selects `rules_processed_at IS
            # NULL` — so stamping a message we couldn't apply anything to burns
            # it forever. That is what an expired refresh token used to do: one
            # scheduler tick with a failed authenticate() marked 50 emails
            # processed, applied nothing, and they were never looked at again.
            if not dry_run and provider is not None:
                await db.execute(text(
                    "UPDATE email_messages SET rules_processed_at = now(), "
                    "rules_held_back_at = NULL WHERE id = :id"
                ), {"id": str(r.id)})
            await db.commit()

        if not dry_run and provider is None:
            _log.warning("email.run_rules_no_provider", account_id=account_id,
                         messages=len(rows),
                         reason="provider auth failed — nothing applied, "
                                "mail left unprocessed for the next run")

        if provider is not None and store is not None:
            await _persist_rotated_creds(db, store, account_id, provider)
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.run_rules_failed", account_id=account_id,
                     error=str(exc)[:200])
    finally:
        await db.close()


_SENSITIVE_RE = re.compile(
    r"\b("
    r"one[\s-]?time\s*(pass(word|code)|code)|\bOTP\b|verification\s+code|"
    r"security\s+code|2fa|two[\s-]?factor|"
    r"password\s*[:=]|reset\s+your\s+password|"
    r"social\s+security|ssn|sort\s+code|routing\s+number|iban|"
    r"card\s+number|cvv|cvc|account\s+number"
    r")\b",
    re.IGNORECASE,
)


_LONG_NUMBER_RE = re.compile(r"(?:\d[ -]?){13,16}")


def _email_looks_sensitive(email: dict[str, str] | None) -> bool:
    """True if the email subject/body looks like it carries secrets (OTP,
    password, card/account numbers). Conservative — favours false negatives."""
    if not email:
        return False
    blob = f"{email.get('subject', '')}\n{email.get('body', '')}"
    if not blob.strip():
        return False
    if _SENSITIVE_RE.search(blob):
        return True
    return bool(_LONG_NUMBER_RE.search(blob))


def _load_action_attachments(a: dict[str, Any]) -> list[dict[str, Any]]:
    """Read the files a draft/forward action attaches (stored as
    ``attachments: [{path, name}]`` referencing the email-assistant workspace),
    returning ``[{filename, content, mime_type}]`` for the provider. Best-effort
    and path-traversal-safe."""
    atts = a.get("attachments") or []
    if not atts:
        return []
    out: list[dict[str, Any]] = []
    try:
        import mimetypes  # noqa: PLC0415

        from gateway.routes.workspace import (  # noqa: PLC0415
            _agent_workspace_dir,
        )
        ws = _agent_workspace_dir("email-assistant")
        if not ws:
            return []
        ws_root = ws.resolve()
        for att in atts:
            if not isinstance(att, dict):
                continue
            rel = (att.get("path") or "").strip()
            if not rel:
                continue
            full = (ws / rel).resolve()
            if not str(full).startswith(str(ws_root)) or not full.is_file():
                continue
            mime, _ = mimetypes.guess_type(full.name)
            out.append({
                "filename": att.get("name") or full.name,
                "content": full.read_bytes(),
                "mime_type": mime or "application/octet-stream",
            })
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.attachment_load_failed", error=str(exc)[:120])
    return out


async def _render_template(template: str, email: dict[str, str]) -> str:
    """Fill an inbox-zero-style ``{{...}}`` template against the email context.

    Placeholders describe what to generate, e.g. ``{{choose "urgent",
    "normal"}}`` for a LABEL prompt or ``{{summarize the request}}`` in a draft.
    Returns the input unchanged when it has no ``{{`` placeholders (the common
    case) so static fields never incur an LLM call. Best-effort: falls back to
    the raw template on any error."""
    if not template or "{{" not in template:
        return template
    try:
        from acb_llm.context import acompletion_with_fallback  # noqa: PLC0415
        ctx = (
            f"From: {email.get('from', '')}\n"
            f"Subject: {email.get('subject', '')}\n\n"
            f"{(email.get('body', '') or '')[:3000]}"
        )
        sys_prompt = (
            "You fill in templates for an email automation rule. The template "
            "contains {{...}} placeholders describing the value to generate "
            '(e.g. {{choose "urgent","normal"}} or {{summarize the request}}). '
            "Replace every {{...}} with an appropriate value based on the email. "
            "Keep all text outside the braces exactly as written. Output ONLY "
            "the filled-in result — no quotes, labels, or commentary."
        )
        # Field-fill is part of rule evaluation → fast tier. Prose output (a
        # filled template), so no JSON mode.
        resp, _ = await acompletion_with_fallback(
            model="tier-fast",
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user",
                       "content": f"Template:\n{template}\n\nEmail:\n{ctx}"}],
            temperature=0, max_tokens=1000,
        )
        out = (resp.choices[0].message.content or "").strip()
        return out or template
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.template_render_failed", error=str(exc)[:200])
        return template


async def _apply_rule_actions(
    db: Any, provider: Any, message_id: str, provider_msg_id: str,
    actions: list[dict[str, Any]], email: dict[str, str] | None = None,
    about: str = "", signature: str = "", user_email: str = "",
    account_id: str = "", errors_out: list[dict[str, str]] | None = None,
) -> list[str]:
    """Apply a rule's actions. Reply/forward/draft create provider DRAFTS (never
    auto-send) so a misfiring rule can't email anyone without review.

    If ``errors_out`` is provided, each action that raises is appended as
    ``{"type", "error"}`` so the History view can show inbox-zero-style
    "Action issues" (the action is still dropped from the returned list)."""
    email = email or {}
    done: list[str] = []
    # Draft-confidence threshold (gates AI-written REPLY/DRAFT_EMAIL drafts).
    draft_conf = "ALL_EMAILS"
    sensitive_protection = True
    # The draft-writing model for AI rule actions (REPLY / DRAFT_EMAIL).
    # Defaults to the powerful tier; overridden from settings below.
    draft_model = "tier-powerful"
    if account_id and any(
        a.get("type") in ("REPLY", "DRAFT_EMAIL") and not (a.get("content") or "").strip()
        for a in actions
    ):
        cr = (await db.execute(text(
            "SELECT draft_confidence, sensitive_data_protection, draft_model "
            "FROM email_assistant_settings WHERE account_id = :aid"
        ), {"aid": account_id})).fetchone()
        if cr and cr.draft_confidence:
            draft_conf = cr.draft_confidence
        if cr and getattr(cr, "sensitive_data_protection", None) is not None:
            sensitive_protection = bool(cr.sensitive_data_protection)
        if cr and getattr(cr, "draft_model", None):
            draft_model = cr.draft_model
    # Sensitive-data protection: don't auto-draft on emails that look like they
    # carry secrets (OTPs, passwords, card/account numbers) when the setting is on.
    skip_ai_drafts = sensitive_protection and _email_looks_sensitive(email)
    for a in actions:
        t = a.get("type")
        try:
            # PROVIDER FIRST, then mirror locally — the same order apply_label
            # uses, and the opposite of what these branches used to do. A rule
            # action that the mail server refuses (Outlook re-keyed or deleted
            # the message, a 404, throttling) must leave NO local change: the
            # old order stamped folder='trash'/'archive' locally, the provider
            # call then raised into errors_out, and the fabricated folder was
            # committed anyway — analytics read it as truth, and a failed TRASH
            # even excluded itself from its own repair. With provider-first, a
            # raised call skips the local UPDATE below and the row is untouched.
            if t == "ARCHIVE":
                await provider.move_to_folder(provider_msg_id, "archive")
                await db.execute(text("UPDATE email_messages SET folder='archive', updated_at=now() WHERE id=:id"), {"id": message_id})
            elif t == "TRASH":
                await provider.trash_message(provider_msg_id)
                await db.execute(text("UPDATE email_messages SET folder='trash', updated_at=now() WHERE id=:id"), {"id": message_id})
            elif t == "MARK_SPAM":
                await provider.move_to_folder(provider_msg_id, "junk")
                await db.execute(text("UPDATE email_messages SET folder='junk', updated_at=now() WHERE id=:id"), {"id": message_id})
            elif t == "MARK_READ":
                await provider.apply_flags(provider_msg_id, is_read=True)
                await db.execute(text("UPDATE email_messages SET is_read=true, updated_at=now() WHERE id=:id"), {"id": message_id})
            elif t == "STAR":
                await provider.apply_flags(provider_msg_id, is_starred=True)
                await db.execute(text("UPDATE email_messages SET is_starred=true, updated_at=now() WHERE id=:id"), {"id": message_id})
            elif t == "MOVE_FOLDER" and a.get("label"):
                # Store the canonical (lowercased) key locally, but hand the
                # ORIGINAL-CASE name to the provider so a created folder reads
                # "Cold Email", not "cold email".
                from email_ingestion.providers.base import canonical_folder  # noqa: PLC0415
                dest = a["label"].strip()
                canon = canonical_folder(dest)
                # Provider first: if the move raises, the local folder is NOT
                # rewritten to a destination the message never reached.
                new_pid = await provider.move_to_folder(provider_msg_id, dest)
                await db.execute(text("UPDATE email_messages SET folder=:f, updated_at=now() WHERE id=:id"), {"id": message_id, "f": canon})
                if new_pid:
                    # Outlook /move re-keys the message — keep follow-up actions valid.
                    await db.execute(text("UPDATE email_messages SET provider_message_id=:pid WHERE id=:id"), {"id": message_id, "pid": new_pid})
                    provider_msg_id = new_pid
                elif canon not in ("inbox", "sent", "drafts", "trash", "junk", "archive"):
                    # A user folder that produced no move id usually means the
                    # provider couldn't resolve/create it — surface it.
                    _log.info("email.move_folder_noop", account_id=account_id, folder=canon)
            elif t == "LABEL" and a.get("label"):
                # label_ai: the label is an AI prompt ({{...}}) resolved per-email.
                lbl = a["label"]
                if a.get("label_ai"):
                    lbl = (await _render_template(lbl, email)).strip()
                if lbl:
                    await apply_label(
                        db, provider, message_id, provider_msg_id, lbl)
            elif t in ("REPLY", "DRAFT_EMAIL"):
                # Manual template wins; otherwise the AI drafts. A template with
                # {{...}} placeholders is rendered against the email first.
                raw = (a.get("content") or "").strip()
                manual = bool(a.get("content_manual")) or bool(raw)
                tmpl = await _render_template(raw, email) if (manual and raw) else ""
                # Sensitive-data protection: never auto-draft an AI reply on an
                # email that looks like it carries secrets (static templates are
                # fine — the user authored them).
                if not tmpl and skip_ai_drafts:
                    _log.info("email.draft_skipped_sensitive", account_id=account_id)
                    continue
                # Dedup (inbox-zero handlePreviousDraftDeletion parity): at most
                # one AI draft per thread — replace an unmodified prior draft,
                # preserve one the user edited. Checked BEFORE generating so we
                # don't waste an LLM call when preserving the user's draft.
                tid = email.get("thread_id") or ""
                if tid and account_id and provider is not None:
                    if await _resolve_existing_thread_draft(
                            db, provider, account_id, tid) == "keep":
                        _log.info("email.draft_skipped_existing",
                                  account_id=account_id)
                        continue
                # Static template wins; otherwise the orchestrating drafter
                # (memory + sales/task-manager + thread history) writes a
                # context-aware reply. Only the AI path needs the thread.
                if tmpl:
                    body = tmpl
                else:
                    # Hydrate the FULL incoming body before AI drafting — a
                    # header-only row (Outlook/Graph) otherwise hands the drafter
                    # a ~200-char snippet cut off mid-sentence. Just-in-time for
                    # the one message being drafted (no batch-wide provider cost).
                    from gateway.routes.email.core import (  # noqa: PLC0415
                        hydrate_message_body,
                    )
                    _hb = await hydrate_message_body(db, str(message_id), user_email)
                    draft_email = {
                        **email,
                        "body": (_hb or "").strip() or email.get("body", ""),
                        "thread": await _fetch_thread_context(
                            db, account_id, email.get("thread_id", ""),
                            provider_msg_id) if email.get("thread_id") else "",
                        "sender_examples": await _fetch_sender_reply_examples(
                            db, account_id, email.get("from", "")),
                        "reply_memories": await _fetch_reply_memories(
                            db, account_id, email),
                        # Attachment metadata on the message being replied to.
                        "attachments": (await _attachment_summaries(
                            db, [message_id])).get(str(message_id), ""),
                    }
                    body = await _agent_draft_reply(
                        draft_email, about, signature, user_email, use_agent=True,
                        confidence=draft_conf,
                        model=draft_model, account_id=account_id,
                    )
                # Draft-confidence gate: the drafter returns the NO_DRAFT
                # sentinel (or empty) when it isn't confident enough — skip.
                if not tmpl and _is_no_draft(body):
                    _log.info("email.draft_skipped_low_confidence",
                              account_id=account_id, confidence=draft_conf)
                    continue
                subj = await _render_template(
                    a.get("subject") or f"Re: {email.get('subject', '')}", email)
                to = a.get("to_address") or email.get("from", "")
                if not to:
                    continue
                draft_pid = await provider.create_draft(
                    to=[to], subject=subj, body_text=body,
                    reply_to_message_id=provider_msg_id,
                    thread_id=email.get("thread_id") or None,
                    attachments=_load_action_attachments(a) or None,
                )
                # Mirror the draft locally so it shows in the Drafts folder and
                # in-thread immediately (matches the manual draft write-path).
                if draft_pid and account_id:
                    await _upsert_local_draft(
                        db, account_id, draft_pid,
                        thread_id=email.get("thread_id") or None,
                        owner_email=user_email, to_email=to,
                        subject=subj, body=body,
                    )
                # AI-written (non-template) drafts: remember for edit-learning.
                if not tmpl and account_id:
                    await _store_ai_draft(
                        db, account_id, email.get("thread_id") or "", body)
            elif t == "FORWARD" and a.get("to_address"):
                note = await _render_template(
                    (a.get("content") or "").strip(), email)
                fwd = (
                    f"{note}\n\n" if note else ""
                ) + (
                    "---------- Forwarded message ----------\n"
                    f"From: {email.get('from', '')}\n"
                    f"Subject: {email.get('subject', '')}\n\n"
                    f"{(email.get('body', '') or '')[:4000]}"
                )
                fwd_subject = a.get("subject") or f"Fwd: {email.get('subject', '')}"
                fwd_pid = await provider.create_draft(
                    to=[a["to_address"]],
                    subject=fwd_subject,
                    body_text=fwd,
                    attachments=_load_action_attachments(a) or None,
                )
                if fwd_pid and account_id:
                    await _upsert_local_draft(
                        db, account_id, fwd_pid, thread_id=None,
                        owner_email=user_email, to_email=a["to_address"],
                        subject=fwd_subject, body=fwd,
                    )
            elif t == "CALL_WEBHOOK" and a.get("url"):
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(a["url"], json={"message_id": message_id})
            else:
                continue
            done.append(t)
        except Exception as exc:  # noqa: BLE001
            _log.warning("email.rule_action_failed", action=t, error=str(exc)[:120])
            if errors_out is not None:
                errors_out.append({"type": t or "?", "error": str(exc)[:160]})
    return done
