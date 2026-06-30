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
    _match_email_to_rule,
    _match_email_to_rules_multi,
    email_dict_from_row,
)
from gateway.routes.email.automation.rules import _upsert_rule_pattern
from gateway.routes.email.automation.senders import _maybe_block_cold
from gateway.routes.email.core import (
    _assert_account_owner,
    _date_range_clause,
    _get_db,
    _instantiate_provider,
    _log,
    _parse_iso_date,
    _persist_rotated_creds,
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
        results = []
        for r in rows:
            frm = r.from_address if isinstance(r.from_address, dict) \
                else json.loads(r.from_address or "{}")
            email = email_dict_from_row(r, self_email, about)
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
                "UPDATE email_messages SET rules_processed_at = now() WHERE id=:mid"
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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _past_job_start(account_id: str, owner: str, total: int, dry_run: bool) -> int:
    """Seed the tracker for a new run; returns a token the background job passes
    back so a superseded (older) run can't mutate the newer entry."""
    global _PAST_JOB_SEQ
    _PAST_JOB_SEQ += 1
    token = _PAST_JOB_SEQ
    _PAST_JOBS[account_id] = {
        "token": token,
        "owner": owner,
        "status": "running" if total > 0 else "done",
        "total": total,
        "processed": 0,
        "applied": 0,
        "skipped": 0,
        "dry_run": dry_run,
        "started_at": _now_iso(),
        "finished_at": None if total > 0 else _now_iso(),
        "error": None,
    }
    return token


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
) -> None:
    job = _PAST_JOBS.get(account_id)
    if not job:
        return
    if token is not None and job.get("token") != token:
        return  # a newer run replaced this one — leave it running
    job["status"] = "error" if error else "done"
    job["error"] = error
    job["finished_at"] = _now_iso()


class RuleProcessPastRequest(BaseModel):
    account_id: str
    start_date: str | None = None  # ISO date (YYYY-MM-DD), inclusive
    end_date: str | None = None    # ISO date (YYYY-MM-DD), inclusive
    is_test: bool = False          # True = dry-run preview; False = apply for real
    include_read: bool = True      # False = only process unread mail in the range
    limit: int = 1000


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
    """
    start_dt = _parse_iso_date(req.start_date, end_of_day=False)
    end_dt = _parse_iso_date(req.end_date, end_of_day=True)
    only_unread = not req.include_read
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        # Count what will be processed so the dialog can report it.
        clause, params = _date_range_clause(
            req.account_id, start_dt, end_dt, only_unread)
        n = (await db.execute(text(
            f"SELECT COUNT(*) AS c FROM email_messages em "
            f"WHERE {clause}"
        ), params)).fetchone()
        count = int(n.c) if n else 0
    finally:
        await db.close()
    # Initialise the live-progress tracker BEFORE scheduling so the UI can poll
    # immediately (a zero-count run is marked done on the spot — no job needed).
    token = _past_job_start(
        req.account_id, user.email or "anonymous", count, req.is_test)
    if count > 0:
        background.add_task(
            _process_past_emails_job, req.account_id, start_dt, end_dt,
            min(req.limit, 2000), not req.is_test, user.email or "anonymous",
            only_unread, token,
        )
    return {"scheduled": True, "count": count, "dry_run": req.is_test}


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
        email = email_dict_from_row(
            row, await _account_self_email(db, req.account_id), about)
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
            )
        await db.execute(text(
            "UPDATE email_messages SET rules_processed_at = now() WHERE id = :id"
        ), {"id": str(row.id)})
        await _persist_rotated_creds(db, store, req.account_id, provider)
        await db.commit()
        primary = matches[0]
        return {
            "matched": True, "applied": True,
            "rule": {"id": primary["rule"]["id"], "name": primary["rule"]["name"]},
            "reason": primary["reason"],
            "actions": primary["rule"]["actions"],
            "applied_rules": [m["rule"]["name"] for m in matches],
        }
    finally:
        await db.close()


_AUTO_LEARN_MIN_CONSISTENT = 3


async def _sender_consistent_for_rule(
    db: Any, account_id: str, sender: str, rule_id: str,
) -> bool:
    """Whether to auto-learn a sender→rule classification pattern yet.

    inbox-zero's analyze-sender-pattern only commits a learned pattern once a
    sender's mail has CONSISTENTLY matched one rule. We mirror that: require at
    least ``_AUTO_LEARN_MIN_CONSISTENT`` matches (counting the current one) and
    no *other* rule ever matched this sender — so a single early misclassification
    can't entrench itself. The current match isn't logged yet, hence the +1."""
    sender = (sender or "").strip().lower()
    if not sender:
        return False
    try:
        rows = (await db.execute(text(
            """SELECT rule_id, COUNT(*) AS n FROM email_executed_rules
               WHERE account_id = :aid AND rule_id IS NOT NULL
                 AND status NOT IN ('SKIPPED', 'REJECTED')
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
    account_user: str, account_id: str,
) -> None:
    """Apply one matched rule's actions (or compute a dry-run preview) and log an
    email_executed_rules row. Shared by the auto-run and process-past jobs so
    multi-rule execution behaves identically in both."""
    rule = match["rule"]
    action_errors: list[dict[str, str]] = []
    if apply:
        actions_taken = await _apply_rule_actions(
            db, provider, str(r.id), r.provider_message_id,
            rule["actions"], email, about, signature, account_user,
            account_id=account_id, errors_out=action_errors,
        )
        status = "APPLIED"
        # inbox-zero parity: when the AI (not a static/learned-pattern rule)
        # picks a rule, cache the sender→rule as a learned FROM pattern so future
        # mail from that sender short-circuits the LLM. Consistency-gated like
        # inbox-zero's analyze-sender-pattern: only learn once the sender has
        # CONSISTENTLY matched this one rule (≥3 incl. now), so a single early
        # misclassification can't entrench itself. Best-effort.
        #
        # NEVER auto-learn a sender→rule pattern for the conversation-status rules
        # (To Reply / Awaiting / FYI / Actioned): a person's mail flows between
        # those states per-thread, so pinning a sender to one (e.g. "accounts team
        # → always FYI") is wrong — and futile, since reply status is re-derived
        # from the full thread and overrides any learned pattern. Sender→rule only
        # makes sense for the stable cleanup categories (Newsletter/Receipt/etc.).
        sender = (frm.get("email") or "").strip()
        if (match.get("source") == "ai" and sender and rule.get("id")
                and not _is_conversation_status_rule(rule)
                and await _sender_consistent_for_rule(
                    db, account_id, sender, str(rule["id"]))):
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
        "mid": str(r.id), "pmid": r.provider_message_id, "tid": r.thread_id,
        "subj": r.subject or "", "frm": frm.get("email", ""), "status": status,
        "acts": json.dumps(actions_taken), "reason": match["reason"],
        "msrc": match.get("source"), "aerr": json.dumps(action_errors)})


async def _process_past_emails_job(
    account_id: str, start: datetime | None, end: datetime | None,
    limit: int, dry_run: bool, user_email: str, only_unread: bool = False,
    job_token: int | None = None,
) -> None:
    """Background worker: reprocess PAST inbox mail in a date range (inbox-zero
    'Process past emails'). Reprocesses regardless of rules_processed_at, oldest
    email first so rules/learning build up chronologically.

    Updates the in-memory progress tracker (_PAST_JOBS) per email so the UI's
    'Processing N of M…' indicator advances live and History can auto-refresh."""
    db = await _get_db()
    try:
        clause, params = _date_range_clause(account_id, start, end, only_unread)
        params["limit"] = limit
        rows = (await db.execute(text(
            f"""SELECT em.id, em.provider_message_id, em.thread_id, em.subject,
                       em.body_text, em.snippet, em.from_address,
                       em.to_addresses, em.cc_addresses, em.received_at
                FROM email_messages em
                WHERE {clause}
                ORDER BY em.received_at ASC LIMIT :limit"""
        ), params)).fetchall()
        if not rows:
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

        for r in rows:
            frm = r.from_address if isinstance(r.from_address, dict) \
                else json.loads(r.from_address or "{}")
            email = email_dict_from_row(r, self_email, about)
            if multi_rule:
                matches = await _match_email_to_rules_multi(db, account_id, email)
            else:
                m = await _match_email_to_rule(db, account_id, email)
                matches = [m] if m else []
            apply = (not dry_run) and provider is not None
            if matches:
                for match in matches:
                    await _apply_and_log_match(
                        db, provider, r, frm, email, match, apply,
                        about, signature, account_user, account_id,
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
            if not dry_run:
                await db.execute(text(
                    "UPDATE email_messages SET rules_processed_at = now() "
                    "WHERE id = :id"
                ), {"id": str(r.id)})
            await db.commit()
            _past_job_tick(
                account_id,
                token=job_token,
                applied=1 if matches else 0,
                skipped=0 if matches else 1,
            )
        _past_job_finish(account_id, token=job_token)
    except Exception as e:  # noqa: BLE001 — record failure for the UI, don't crash the worker
        _log.warning("email.process_past_failed", account_id=account_id, error=str(e)[:200])
        _past_job_finish(account_id, token=job_token, error=str(e))
    finally:
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
        org_domains = frozenset(getattr(cb_row, "org_domains", None) or []) \
            if cb_row else frozenset()

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

        for r in rows:
            frm = r.from_address if isinstance(r.from_address, dict) \
                else json.loads(r.from_address or "{}")
            email = email_dict_from_row(r, self_email, about, org_domains)
            # Multi-rule execution (inbox-zero parity): when on, every matching
            # rule applies; otherwise just the single best match.
            if multi_rule:
                matches = await _match_email_to_rules_multi(db, account_id, email)
            else:
                m = await _match_email_to_rule(db, account_id, email)
                matches = [m] if m else []
            # Reply Zero (inbox-zero determineConversationStatus parity): when the
            # match is a conversation, re-determine the status from the FULL thread
            # and apply the determined status rule's actions (so an Actioned thread
            # doesn't auto-draft). Live runs only — skip the dry-run preview.
            if matches and not dry_run:
                from gateway.routes.email.automation.replyzero import (  # noqa: PLC0415
                    resolve_conversation_status_matches,
                )
                matches = await resolve_conversation_status_matches(
                    db, account_id, r, matches)
            if matches:
                apply = (not dry_run) and provider is not None
                for match in matches:
                    await _apply_and_log_match(
                        db, provider, r, frm, email, match, apply,
                        about, signature, account_user, account_id,
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
                    # any stale To Reply / Awaiting / FYI / Follow-up left on
                    # earlier messages (inbox-zero mutually-exclusive labels).
                    if keep_label and provider is not None:
                        await _reconcile_thread_labels(
                            db, provider, account_id, r.thread_id, keep_label)
                except Exception as exc:  # noqa: BLE001
                    _log.warning("email.project_reply_status_failed",
                                 account_id=account_id, error=str(exc)[:160])
            if not dry_run:
                await db.execute(text(
                    "UPDATE email_messages SET rules_processed_at = now() "
                    "WHERE id = :id"
                ), {"id": str(r.id)})
            await db.commit()

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
            if t == "ARCHIVE":
                await db.execute(text("UPDATE email_messages SET folder='archive', updated_at=now() WHERE id=:id"), {"id": message_id})
                await provider.move_to_folder(provider_msg_id, "archive")
            elif t == "TRASH":
                await db.execute(text("UPDATE email_messages SET folder='trash', updated_at=now() WHERE id=:id"), {"id": message_id})
                await provider.trash_message(provider_msg_id)
            elif t == "MARK_SPAM":
                await db.execute(text("UPDATE email_messages SET folder='junk', updated_at=now() WHERE id=:id"), {"id": message_id})
                await provider.move_to_folder(provider_msg_id, "junk")
            elif t == "MARK_READ":
                await db.execute(text("UPDATE email_messages SET is_read=true, updated_at=now() WHERE id=:id"), {"id": message_id})
                await provider.apply_flags(provider_msg_id, is_read=True)
            elif t == "STAR":
                await db.execute(text("UPDATE email_messages SET is_starred=true, updated_at=now() WHERE id=:id"), {"id": message_id})
                await provider.apply_flags(provider_msg_id, is_starred=True)
            elif t == "MOVE_FOLDER" and a.get("label"):
                # Store the canonical (lowercased) key locally, but hand the
                # ORIGINAL-CASE name to the provider so a created folder reads
                # "Cold Email", not "cold email".
                from email_ingestion.providers.base import canonical_folder  # noqa: PLC0415
                dest = a["label"].strip()
                canon = canonical_folder(dest)
                await db.execute(text("UPDATE email_messages SET folder=:f, updated_at=now() WHERE id=:id"), {"id": message_id, "f": canon})
                new_pid = await provider.move_to_folder(provider_msg_id, dest)
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
                    await provider.set_labels(provider_msg_id, add=[lbl], remove=[])
                    # Mirror the label into the local row NOW so the viewer shows
                    # it immediately, instead of waiting for the next upstream sync
                    # to re-fetch categories. Atomic append-if-absent on the
                    # TEXT[] (race-free, no read-modify-write).
                    await db.execute(text(
                        "UPDATE email_messages SET categories = "
                        "CASE WHEN :lbl = ANY(categories) THEN categories "
                        "ELSE array_append(categories, :lbl) END, "
                        "updated_at = now() WHERE id = :id"
                    ), {"id": message_id, "lbl": lbl})
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
                    from gateway.routes.email.core import _attachment_summaries  # noqa: PLC0415
                    draft_email = {
                        **email,
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
                        model=draft_model,
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
