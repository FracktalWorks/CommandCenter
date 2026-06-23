"""Automation · rule configuration — Rule models, CRUD, presets, NL rule
generation, reordering, and rule-pattern/feedback management."""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, Query, status
from gateway.routes.email.core import _assert_account_owner, _get_db, _log, _safe_json, router
from pydantic import BaseModel
from sqlalchemy import text


class RuleActionAttachment(BaseModel):
    """A draft attachment sourced from the email-assistant workspace.

    ``path`` is the workspace-relative path (e.g. ``agent-data/budget.pdf``)
    the file was uploaded to / picked from; ``name`` is the display name.
    ``ai_selected`` marks sources the assistant may pick from at draft time
    rather than always attaching."""
    path: str | None = None
    artifact_id: str | None = None
    name: str | None = None
    ai_selected: bool = False


class RuleActionModel(BaseModel):
    id: str | None = None
    type: str
    label: str | None = None
    subject: str | None = None
    content: str | None = None
    to_address: str | None = None
    cc_address: str | None = None
    bcc_address: str | None = None
    url: str | None = None
    # inbox-zero parity: optional per-action delay + draft attachments.
    delay_minutes: int | None = None
    attachments: list[RuleActionAttachment] = []
    # inbox-zero per-field AI-vs-manual model:
    #   label_ai       — `label` is an AI prompt ({{...}}) resolved per-email.
    #   content_manual — use the authored `content` template (else AI drafts).
    label_ai: bool = False
    content_manual: bool = False


class RuleModel(BaseModel):
    id: str | None = None
    account_id: str
    name: str
    instructions: str | None = None
    enabled: bool = True
    automated: bool = True
    run_on_threads: bool = False
    conditional_operator: str = "AND"
    from_pattern: str | None = None
    to_pattern: str | None = None
    subject_pattern: str | None = None
    body_pattern: str | None = None
    system_type: str | None = None
    sort_order: int = 0
    actions: list[RuleActionModel] = []


async def _load_rules(db: Any, account_id: str) -> list[dict[str, Any]]:
    """Load rules + their actions for an account, ordered by sort_order."""
    rule_rows = (await db.execute(text(
        """SELECT id, account_id, name, instructions, enabled, automated,
                  run_on_threads, conditional_operator, from_pattern, to_pattern,
                  subject_pattern, body_pattern, system_type, sort_order
           FROM email_rules WHERE account_id = :aid
           ORDER BY sort_order, created_at"""
    ), {"aid": account_id})).fetchall()
    rules: list[dict[str, Any]] = []
    for r in rule_rows:
        act_rows = (await db.execute(text(
            """SELECT id, type, label, subject, content, to_address, cc_address,
                      bcc_address, url, delay_minutes, attachments,
                      label_ai, content_manual
               FROM email_actions WHERE rule_id = :rid
               ORDER BY created_at"""
        ), {"rid": r.id})).fetchall()
        rules.append({
            "id": str(r.id), "account_id": str(r.account_id), "name": r.name,
            "instructions": r.instructions, "enabled": r.enabled,
            "automated": r.automated,
            "run_on_threads": r.run_on_threads,
            "conditional_operator": r.conditional_operator,
            "from_pattern": r.from_pattern, "to_pattern": r.to_pattern,
            "subject_pattern": r.subject_pattern, "body_pattern": r.body_pattern,
            "system_type": r.system_type, "sort_order": r.sort_order,
            "actions": [
                {"id": str(a.id), "type": a.type, "label": a.label,
                 "subject": a.subject, "content": a.content,
                 "to_address": a.to_address, "cc_address": a.cc_address,
                 "bcc_address": a.bcc_address, "url": a.url,
                 "delay_minutes": a.delay_minutes,
                 "label_ai": bool(a.label_ai),
                 "content_manual": bool(a.content_manual),
                 "attachments": a.attachments if isinstance(a.attachments, list)
                 else json.loads(a.attachments or "[]")}
                for a in act_rows
            ],
        })
    return rules


@router.get("/rules")
async def list_rules(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """List assistant rules (with actions) for an account."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        return {"rules": await _load_rules(db, account_id)}
    finally:
        await db.close()


_PRESET_RULES: list[dict[str, Any]] = [
    {"name": "To Reply", "instructions": "Emails I need to respond to.",
     "run_on_threads": True,
     "actions": [{"type": "LABEL", "label": "To Reply"}, {"type": "DRAFT_EMAIL"}]},
    {"name": "Awaiting Reply", "run_on_threads": True,
     "instructions": "Threads where I've already replied and am now waiting to "
                     "hear back from the other person.",
     "actions": [{"type": "LABEL", "label": "Awaiting Reply"}]},
    {"name": "Actioned", "run_on_threads": True,
     "instructions": "Emails I've already handled or replied to that need no "
                     "further action from me.",
     "actions": [{"type": "LABEL", "label": "Actioned"}]},
    {"name": "FYI", "run_on_threads": True,
     "instructions": "Important emails I should know about, but don't need to "
                     "reply to.",
     "actions": [{"type": "LABEL", "label": "FYI"}]},
    {"name": "Newsletter",
     "instructions": "Newsletters: regular content from publications, blogs, or "
                     "services I've subscribed to.",
     "actions": [{"type": "LABEL", "label": "Newsletter"}]},
    {"name": "Marketing",
     "instructions": "Marketing: promotional emails about products, services, "
                     "sales, or offers.",
     "actions": [{"type": "LABEL", "label": "Marketing"}, {"type": "ARCHIVE"}]},
    {"name": "Calendar",
     "instructions": "Calendar: any email related to scheduling, meeting "
                     "invites, or calendar notifications.",
     "actions": [{"type": "LABEL", "label": "Calendar"}]},
    {"name": "Receipt",
     "instructions": "Receipts: purchase confirmations, payment receipts, "
                     "transaction records or invoices.",
     "actions": [{"type": "LABEL", "label": "Receipt"}]},
    {"name": "Notification",
     "instructions": "Notifications: alerts, status updates, or system messages.",
     "actions": [{"type": "LABEL", "label": "Notification"}]},
    {"name": "Cold Email",
     "instructions": "Cold emails: unsolicited sales pitches and outreach from "
                     "people or companies I have no prior relationship with.",
     "actions": [{"type": "LABEL", "label": "Cold Email"}, {"type": "ARCHIVE"}]},
]


@router.post("/rules/install-presets")
async def install_preset_rules(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """Install the default inbox-zero-style rule set (skips ones already present
    by name). Used by the UI's 'Add defaults' and the assistant's setup flow."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        existing = {r["name"].lower() for r in await _load_rules(db, account_id)}
        installed: list[str] = []
        for i, p in enumerate(_PRESET_RULES):
            if p["name"].lower() in existing:
                continue
            rid = str(uuid4())
            await db.execute(text(
                """INSERT INTO email_rules
                     (id, account_id, name, instructions, run_on_threads,
                      sort_order)
                   VALUES (:id, :aid, :name, :instr, :rot, :so)"""
            ), {"id": rid, "aid": account_id, "name": p["name"],
                "instr": p["instructions"], "rot": p.get("run_on_threads", False),
                "so": i})
            await _replace_actions(
                db, rid, [RuleActionModel(**a) for a in p["actions"]]
            )
            installed.append(p["name"])
        await db.commit()
        return {"installed": installed,
                "total_presets": len(_PRESET_RULES)}
    finally:
        await db.close()


async def _replace_actions(db: Any, rule_id: str, actions: list[RuleActionModel]) -> None:
    await db.execute(text("DELETE FROM email_actions WHERE rule_id = :rid"),
                     {"rid": rule_id})
    for a in actions:
        await db.execute(text(
            """INSERT INTO email_actions
                 (rule_id, type, label, subject, content, to_address,
                  cc_address, bcc_address, url, delay_minutes, attachments,
                  label_ai, content_manual)
               VALUES (:rid, :type, :label, :subject, :content, :to_addr,
                       :cc, :bcc, :url, :delay, CAST(:attachments AS JSONB),
                       :label_ai, :content_manual)"""
        ), {"rid": rule_id, "type": a.type, "label": a.label, "subject": a.subject,
            "content": a.content, "to_addr": a.to_address, "cc": a.cc_address,
            "bcc": a.bcc_address, "url": a.url,
            "delay": a.delay_minutes,
            "label_ai": bool(a.label_ai),
            "content_manual": bool(a.content_manual),
            "attachments": json.dumps([
                att.model_dump() for att in (a.attachments or [])
            ])})


async def _insert_rule(db: Any, req: RuleModel) -> str:
    """Insert a rule + its actions; returns the new rule id. Caller commits."""
    rule_id = str(uuid4())
    await db.execute(text(
        """INSERT INTO email_rules
             (id, account_id, name, instructions, enabled, automated,
              run_on_threads, conditional_operator, from_pattern, to_pattern,
              subject_pattern, body_pattern, system_type, sort_order)
           VALUES (:id, :aid, :name, :instr, :enabled, :auto, :rot, :op,
                   :fp, :tp, :sp, :bp, :st, :so)"""
    ), {"id": rule_id, "aid": req.account_id, "name": req.name,
        "instr": req.instructions, "enabled": req.enabled,
        "auto": req.automated, "rot": req.run_on_threads,
        "op": req.conditional_operator,
        "fp": req.from_pattern, "tp": req.to_pattern, "sp": req.subject_pattern,
        "bp": req.body_pattern, "st": req.system_type,
        "so": req.sort_order})
    await _replace_actions(db, rule_id, req.actions)
    return rule_id


@router.post("/rules")
async def create_rule(
    req: RuleModel,
    user: UserContext = Depends(get_current_user),
):
    """Create an assistant rule with its actions."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        rule_id = await _insert_rule(db, req)
        await db.commit()
        rules = await _load_rules(db, req.account_id)
        return next((r for r in rules if r["id"] == rule_id), {"id": rule_id})
    finally:
        await db.close()


_GEN_ACTION_TYPES = {
    "ARCHIVE", "LABEL", "MARK_READ", "STAR", "MARK_SPAM", "TRASH",
    "MOVE_FOLDER", "REPLY", "FORWARD", "DRAFT_EMAIL", "CALL_WEBHOOK",
}


async def _llm_generate_rules(prompt: str) -> list[dict[str, Any]]:
    """Turn a natural-language rule description (one or several, often a bullet
    list) into structured rule specs — inbox-zero's plain-text → rules flow.

    Returns a list of dicts shaped like RuleModel (minus account_id). Best
    effort: returns [] if the LLM is unavailable or nothing parses."""
    try:
        import litellm as _litellm  # noqa: PLC0415
        from acb_llm.client import _TIER_MODEL, ensure_model_registered  # noqa: PLC0415
        from litellm import acompletion  # noqa: PLC0415
        _litellm.drop_params = True
        _litellm.suppress_debug_info = True
        model = _TIER_MODEL.get("tier2") or _TIER_MODEL.get("tier1") or "gpt-4o-mini"
        ensure_model_registered(model)
        sys_prompt = (
            "You convert a user's plain-English description of email rules into "
            "structured automation rules. The user may describe several rules "
            "(often one per line/bullet). Output ONLY a JSON array; each element:\n"
            '{"name": "<short name>", "instructions": "<the AI-matched condition '
            'in plain English, or empty if purely static>", "from_pattern": '
            '"<sender substring/email, or empty>", "subject_pattern": "<subject '
            'substring, or empty>", "conditional_operator": "AND"|"OR", '
            '"actions": [{"type": "<ACTION>", "label": "<label or folder, if '
            'LABEL/MOVE_FOLDER>", "to_address": "<for FORWARD>", "subject": '
            '"<optional>", "content": "<optional draft text; leave empty to let '
            'the AI write it>", "url": "<for CALL_WEBHOOK>"}]}\n'
            "ACTION must be one of: ARCHIVE, LABEL, MARK_READ, STAR, MARK_SPAM, "
            "TRASH, MOVE_FOLDER, REPLY, FORWARD, DRAFT_EMAIL, CALL_WEBHOOK.\n"
            "Rules of thumb: 'label X as Y' → LABEL with label Y; 'archive' → "
            "ARCHIVE; 'forward to a@b.com' → FORWARD to_address a@b.com; 'draft a "
            "reply' → DRAFT_EMAIL; 'reply with …' → REPLY content. Prefer an AI "
            "`instructions` condition for fuzzy intent; use from_pattern/"
            "subject_pattern only for literal sender/subject text. Keep names "
            "short. Omit empty fields. Output [] if nothing is parseable."
        )
        resp = await acompletion(
            model=model,
            messages=[{"role": "system", "content": sys_prompt},
                      {"role": "user", "content": prompt[:4000]}],
            temperature=0, max_tokens=1200,
        )
        data = _safe_json(resp.choices[0].message.content or "")
        return _normalize_generated_rules(data)
    except Exception as exc:  # noqa: BLE001
        _log.warning("email.generate_rules_failed", error=str(exc)[:200])
        return []


def _normalize_generated_rules(data: Any) -> list[dict[str, Any]]:
    """Validate/sanitize the LLM's JSON into rule specs (pure; unit-tested).

    Drops specs without a name or any valid action; clamps action types to the
    supported set; normalizes the conditional operator to AND/OR."""
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for spec in data:
        if not isinstance(spec, dict) or not str(spec.get("name") or "").strip():
            continue
        actions: list[dict[str, Any]] = []
        for a in spec.get("actions") or []:
            if not isinstance(a, dict):
                continue
            atype = str(a.get("type", "")).upper()
            if atype not in _GEN_ACTION_TYPES:
                continue
            actions.append({
                "type": atype,
                "label": a.get("label") or None,
                "to_address": a.get("to_address") or None,
                "subject": a.get("subject") or None,
                "content": a.get("content") or None,
                "url": a.get("url") or None,
            })
        if not actions:
            continue
        op = str(spec.get("conditional_operator", "AND")).upper()
        out.append({
            "name": str(spec["name"]).strip()[:60],
            "instructions": (str(spec.get("instructions") or "")).strip() or None,
            "from_pattern": (str(spec.get("from_pattern") or "")).strip() or None,
            "subject_pattern": (str(spec.get("subject_pattern") or "")).strip() or None,
            "conditional_operator": "OR" if op == "OR" else "AND",
            "actions": actions,
        })
    return out


class RuleGenerateRequest(BaseModel):
    account_id: str
    prompt: str


@router.post("/rules/generate")
async def generate_rules(
    req: RuleGenerateRequest,
    user: UserContext = Depends(get_current_user),
):
    """Create rule(s) from a plain-English description (inbox-zero's prompt flow).

    The text may describe several rules at once; each is turned into a
    structured rule and created. Returns the created rules."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        if not (req.prompt or "").strip():
            return {"created": [], "error": "Describe at least one rule."}
        specs = await _llm_generate_rules(req.prompt)
        if not specs:
            return {"created": [],
                    "error": "Couldn't turn that into a rule — try rephrasing."}
        base = len(await _load_rules(db, req.account_id))
        created_ids: list[str] = []
        for i, spec in enumerate(specs):
            model = RuleModel(
                account_id=req.account_id,
                name=spec["name"],
                instructions=spec.get("instructions"),
                from_pattern=spec.get("from_pattern"),
                subject_pattern=spec.get("subject_pattern"),
                conditional_operator=spec.get("conditional_operator", "AND"),
                sort_order=base + i,
                actions=[RuleActionModel(**a) for a in spec["actions"]],
            )
            created_ids.append(await _insert_rule(db, model))
        await db.commit()
        rules = await _load_rules(db, req.account_id)
        created = [r for r in rules if r["id"] in set(created_ids)]
        return {"created": created}
    finally:
        await db.close()


class RuleReorderRequest(BaseModel):
    account_id: str
    rule_ids: list[str]  # desired order; index becomes sort_order


@router.patch("/rules/reorder")
async def reorder_rules(
    req: RuleReorderRequest,
    user: UserContext = Depends(get_current_user),
):
    """Persist a new rule priority order (lower sort_order = evaluated first)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        for i, rid in enumerate(req.rule_ids):
            await db.execute(text(
                "UPDATE email_rules SET sort_order = :so, updated_at = now() "
                "WHERE id = :id AND account_id = :aid"
            ), {"so": i, "id": rid, "aid": req.account_id})
        await db.commit()
        return {"reordered": len(req.rule_ids)}
    finally:
        await db.close()


@router.patch("/rules/{rule_id}")
async def update_rule(
    rule_id: str,
    req: RuleModel,
    user: UserContext = Depends(get_current_user),
):
    """Update a rule and replace its actions."""
    db = await _get_db()
    try:
        owner = (await db.execute(text(
            """SELECT er.account_id FROM email_rules er
               JOIN email_accounts ea ON er.account_id = ea.id
               WHERE er.id = :rid AND ea.user_id = :uid"""
        ), {"rid": rule_id, "uid": user.email or "anonymous"})).fetchone()
        if not owner:
            raise HTTPException(status_code=404, detail="Rule not found")
        await db.execute(text(
            """UPDATE email_rules SET
                 name = :name, instructions = :instr, enabled = :enabled,
                 automated = :auto, run_on_threads = :rot,
                 conditional_operator = :op,
                 from_pattern = :fp, to_pattern = :tp, subject_pattern = :sp,
                 body_pattern = :bp,
                 system_type = :st, sort_order = :so, updated_at = now()
               WHERE id = :rid"""
        ), {"rid": rule_id, "name": req.name, "instr": req.instructions,
            "enabled": req.enabled, "auto": req.automated,
            "rot": req.run_on_threads,
            "op": req.conditional_operator, "fp": req.from_pattern,
            "tp": req.to_pattern, "sp": req.subject_pattern, "bp": req.body_pattern,
            "st": req.system_type, "so": req.sort_order})
        await _replace_actions(db, rule_id, req.actions)
        await db.commit()
        rules = await _load_rules(db, str(owner.account_id))
        return next((r for r in rules if r["id"] == rule_id), {"id": rule_id})
    finally:
        await db.close()


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(
    rule_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Delete a rule (cascades to actions)."""
    db = await _get_db()
    try:
        res = await db.execute(text(
            """DELETE FROM email_rules er
               USING email_accounts ea
               WHERE er.id = :rid AND er.account_id = ea.id
                 AND ea.user_id = :uid"""
        ), {"rid": rule_id, "uid": user.email or "anonymous"})
        await db.commit()
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Rule not found")
    finally:
        await db.close()


async def _upsert_rule_pattern(
    db: Any, account_id: str, rule_id: str, value: str, exclude: bool,
    source: str, reason: str | None, message_id: str | None, thread_id: str | None,
    pattern_type: str = "FROM",
) -> None:
    """Record a learned classification pattern (FROM sender or SUBJECT keyword)
    for a rule. Removes the opposite (include vs exclude) for the same
    type+value so a correction never contradicts itself."""
    if not (value or "").strip():
        return
    ptype = "SUBJECT" if (pattern_type or "").upper() == "SUBJECT" else "FROM"
    # Drop the opposite disposition for this (rule, type, value) first.
    await db.execute(text(
        "DELETE FROM email_rule_patterns WHERE account_id = :aid AND rule_id = :rid "
        "AND pattern_type = :ptype AND lower(value) = lower(:val) AND exclude = :opp"
    ), {"aid": account_id, "rid": rule_id, "ptype": ptype, "val": value,
        "opp": not exclude})
    await db.execute(text(
        """INSERT INTO email_rule_patterns
             (account_id, rule_id, pattern_type, value, exclude, source, reason,
              message_id, thread_id)
           VALUES (:aid, :rid, :ptype, :val, :exc, :src, :reason, :mid, :tid)
           ON CONFLICT (account_id, rule_id, pattern_type, lower(value), exclude)
           DO UPDATE SET source = EXCLUDED.source, reason = EXCLUDED.reason,
                         created_at = now()"""
    ), {"aid": account_id, "rid": rule_id, "ptype": ptype, "val": value,
        "exc": exclude, "src": source, "reason": reason, "mid": message_id,
        "tid": thread_id})


class RuleFeedbackRequest(BaseModel):
    account_id: str
    sender: str                       # sender email — the FROM pattern value
    expected: str                     # rule_id | "none" | "new"
    matched_rule_ids: list[str] = []  # rules that currently match this email
    explanation: str | None = None
    message_id: str | None = None
    thread_id: str | None = None
    # Optional SUBJECT keyword to learn alongside (or instead of) the sender —
    # inbox-zero's GroupItem supports both SENDER and SUBJECT signals.
    subject_keyword: str | None = None


@router.post("/rules/feedback")
async def rule_feedback(
    req: RuleFeedbackRequest,
    user: UserContext = Depends(get_current_user),
):
    """Persist a Fix correction as learned patterns so it sticks (inbox-zero
    parity). "expected = rule_id" teaches the matcher to ALWAYS apply that rule
    to this sender (and to STOP applying any other rule that wrongly matched);
    "none" teaches it to stop applying the matched rules to this sender; "new"
    is handled by creating a rule (returns created=False, action="new").

    A correction can be taught on the sender (FROM), a subject keyword
    (SUBJECT), or both — whichever signals the request carries."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        sender = (req.sender or "").strip()
        subject_kw = (req.subject_keyword or "").strip()
        reason = (req.explanation or "").strip() or "Taught via Fix"
        if req.expected == "new":
            return {"created": False, "action": "new"}
        # Each correction teaches one or more (pattern_type, value) signals.
        signals: list[tuple[str, str]] = []
        if sender:
            signals.append(("FROM", sender))
        if subject_kw:
            signals.append(("SUBJECT", subject_kw))
        if not signals:
            return {"created": False, "reason": "no sender or subject keyword"}

        async def _teach(rule_id: str, exclude: bool) -> None:
            for ptype, val in signals:
                await _upsert_rule_pattern(
                    db, req.account_id, rule_id, val, exclude, "FIX", reason,
                    req.message_id, req.thread_id, pattern_type=ptype)

        learned: list[dict[str, Any]] = []
        if req.expected == "none":
            for rid in req.matched_rule_ids:
                await _teach(rid, True)
                learned.append({"rule_id": rid, "exclude": True})
        else:  # a specific rule id should have matched
            await _teach(req.expected, False)
            learned.append({"rule_id": req.expected, "exclude": False})
            for rid in req.matched_rule_ids:
                if rid and rid != req.expected:
                    await _teach(rid, True)
                    learned.append({"rule_id": rid, "exclude": True})
        await db.commit()
        return {"created": True, "learned": learned, "sender": sender,
                "subject_keyword": subject_kw or None,
                "signals": [t for t, _ in signals]}
    finally:
        await db.close()


@router.get("/rules/patterns")
async def list_rule_patterns(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """List learned classification patterns (sender → rule include/exclude)."""
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        try:
            rows = (await db.execute(text(
                """SELECT p.id, p.rule_id, r.name AS rule_name, p.pattern_type,
                          p.value, p.exclude, p.source, p.reason, p.created_at
                   FROM email_rule_patterns p
                   LEFT JOIN email_rules r ON p.rule_id = r.id
                   WHERE p.account_id = :aid
                   ORDER BY p.created_at DESC"""
            ), {"aid": account_id})).fetchall()
        except Exception:  # noqa: BLE001 — table may not exist pre-migration
            rows = []
        return {"patterns": [
            {"id": str(r.id), "rule_id": str(r.rule_id),
             "rule_name": r.rule_name, "pattern_type": r.pattern_type,
             "value": r.value, "exclude": bool(r.exclude), "source": r.source,
             "reason": r.reason,
             "created_at": r.created_at.isoformat() if r.created_at else None}
            for r in rows
        ]}
    finally:
        await db.close()


@router.delete("/rules/patterns/{pattern_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule_pattern(
    pattern_id: str,
    user: UserContext = Depends(get_current_user),
):
    """Forget a learned classification pattern."""
    db = await _get_db()
    try:
        res = await db.execute(text(
            """DELETE FROM email_rule_patterns p USING email_accounts ea
               WHERE p.id = :id AND p.account_id = ea.id AND ea.user_id = :uid"""
        ), {"id": pattern_id, "uid": user.email or "anonymous"})
        await db.commit()
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Not found")
    finally:
        await db.close()
