"""Automation · rule configuration — Rule models, CRUD, presets, NL rule
generation, reordering, and rule-pattern/feedback management."""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, Query, status
from gateway.routes.email.core import (
    _assert_account_owner,
    _get_db,
    _llm_json,
    _log,
    router,
)
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
    actions: list[RuleActionModel] = []


# Canonical system-rule order (inbox-zero parity — see SYSTEM_RULE_ORDER). Rules
# are presented to the classifier and applied (multi-rule) in this fixed order,
# NOT a user-defined "priority". Matching is AI-first: the most specific rule
# wins regardless of position; order is only a deterministic, stable arrangement.
_SYSTEM_RULE_ORDER = [
    "REPLY", "AWAITING_REPLY", "FYI", "DONE", "NEWSLETTER",
    "MARKETING", "CALENDAR", "RECEIPT", "NOTIFICATION", "COLD_EMAIL",
]


def _canonical_rank(rule: dict[str, Any]) -> int:
    """Index of a rule in the fixed system order. Falls back to the rule name
    (so seeded presets without an explicit system_type still sort correctly);
    custom rules sort after all system rules."""
    key = (rule.get("system_type") or "").upper().strip()
    if not key:
        key = (rule.get("name") or "").upper().strip().replace(" ", "_")
    try:
        return _SYSTEM_RULE_ORDER.index(key)
    except ValueError:
        return len(_SYSTEM_RULE_ORDER)


def _sort_rules_canonical(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Order rules exactly like inbox-zero's sortRulesForAutomation: enabled
    first, then the fixed system-rule order, then alphabetically by name."""
    return sorted(rules, key=lambda r: (
        0 if r.get("enabled") else 1,
        _canonical_rank(r),
        (r.get("name") or "").lower(),
        (r.get("instructions") or "").lower(),
    ))


async def _load_rules(db: Any, account_id: str) -> list[dict[str, Any]]:
    """Load rules + their actions for an account, in canonical system order."""
    rule_rows = (await db.execute(text(
        """SELECT id, account_id, name, instructions, enabled, automated,
                  run_on_threads, conditional_operator, from_pattern, to_pattern,
                  subject_pattern, body_pattern, system_type
           FROM email_rules WHERE account_id = :aid
           ORDER BY created_at"""
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
            "system_type": r.system_type,
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
    return _sort_rules_canonical(rules)


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


# Default inbox-zero rule set. Each preset carries a provider-agnostic
# ``category_action`` plus a Microsoft/Outlook override (``category_action_ms``),
# mirroring upstream inbox-zero's ``categoryAction`` / ``categoryActionMicrosoft``
# (reference/.../utils/rule/consts.ts). On Outlook, "cleanup" categories file the
# mail into a same-named FOLDER; on Gmail they apply a LABEL. "Action" categories
# (Reply / Awaiting Reply / FYI / Done / Calendar) stay LABEL/category on
# both so they remain in the inbox. ``extra`` holds non-categorization actions.
#
# On Outlook a cleanup category is BOTH tagged with the category (a colored
# Outlook category == our LABEL) AND filed into a same-named FOLDER — Outlook
# keeps categories and folders independent, so the tag stays visible after the
# move. We never add ARCHIVE there: the folder move already removes the mail
# from the inbox, and a trailing archive would re-file it into Archive and undo
# the categorization. On Gmail there are no folders, so cleanup categories just
# LABEL (+ ARCHIVE for Marketing / Cold Email).
#
# category_action values: "label" | "label_archive" | "move_folder"
# (on Outlook "move_folder" expands to LABEL + MOVE_FOLDER)
_PRESET_RULES: list[dict[str, Any]] = [
    {"name": "Reply", "instructions": "Emails I need to respond to.",
     "run_on_threads": True, "category_action": "label",
     "extra": [{"type": "DRAFT_EMAIL"}]},
    {"name": "Awaiting Reply", "run_on_threads": True,
     "instructions": "Threads where I've already replied and am now waiting to "
                     "hear back from the other person.",
     "category_action": "label"},
    {"name": "Done", "run_on_threads": True,
     "instructions": "Emails I've already handled or replied to that need no "
                     "further action from me.",
     "category_action": "label"},
    {"name": "FYI", "run_on_threads": True,
     "instructions": "Important emails I should know about, but don't need to "
                     "reply to.",
     "category_action": "label"},
    {"name": "Newsletter",
     "instructions": "Newsletters: regular content from publications, blogs, or "
                     "services I've subscribed to.",
     "category_action": "label", "category_action_ms": "move_folder"},
    {"name": "Marketing",
     "instructions": "Marketing: promotional emails about products, services, "
                     "sales, or offers.",
     "category_action": "label_archive",
     "category_action_ms": "move_folder"},
    {"name": "Calendar",
     "instructions": "Calendar: any email related to scheduling, meeting "
                     "invites, or calendar notifications.",
     "category_action": "label"},
    {"name": "Receipt",
     "instructions": "Receipts: purchase confirmations, payment receipts, "
                     "transaction records or invoices.",
     "category_action": "label", "category_action_ms": "move_folder"},
    {"name": "Notification",
     "instructions": "Notifications: alerts, status updates, or system messages.",
     "category_action": "label", "category_action_ms": "move_folder"},
    {"name": "Cold Email",
     "instructions": "Cold emails: unsolicited sales pitches and outreach from "
                     "people or companies I have no prior relationship with.",
     "category_action": "label_archive",
     "category_action_ms": "move_folder"},
]


def _actions_for_preset(preset: dict[str, Any], provider: str) -> list[dict[str, Any]]:
    """Resolve a preset's category_action into concrete actions for a provider.

    On Outlook (``provider == "microsoft"``) the ``category_action_ms`` override
    applies. ``move_folder`` there expands to LABEL **+** MOVE_FOLDER: Outlook
    categories (our LABEL) and folders are independent, so we tag the category
    AND file the mail into the same-named folder (the colored category survives
    the move). No ARCHIVE follows — the folder move already clears the inbox, and
    archiving would re-file the message into Archive. On Gmail (no folders) the
    base ``category_action`` (label-based) is used. ``extra`` actions append.
    """
    name = preset["name"]
    action = preset["category_action"]
    if provider == "microsoft" and preset.get("category_action_ms"):
        action = preset["category_action_ms"]
    actions: list[dict[str, Any]]
    if action == "move_folder":
        # Tag the category first (categories persist across an Outlook move),
        # then file into the folder. No archive (the move already files it).
        actions = [{"type": "LABEL", "label": name},
                   {"type": "MOVE_FOLDER", "label": name}]
    elif action == "label_archive":
        actions = [{"type": "LABEL", "label": name}, {"type": "ARCHIVE"}]
    else:  # "label" (and any unknown value) → categorize only.
        actions = [{"type": "LABEL", "label": name}]
    actions.extend(preset.get("extra", []))
    return actions


async def _account_provider(db: Any, account_id: str) -> str:
    """The account's mail provider ('gmail' | 'microsoft' | 'imap' | '')."""
    row = (await db.execute(
        text("SELECT provider FROM email_accounts WHERE id = :id"),
        {"id": account_id},
    )).fetchone()
    return (row.provider if row else "") or ""


async def _seed_preset_rules(
    db: Any, account_id: str, provider: str, *, skip_existing: bool,
) -> list[str]:
    """Insert the default inbox-zero rule set for an account; returns the names
    installed. With ``skip_existing`` (the additive 'Add defaults' flow) presets
    whose name already exists are left untouched; otherwise every preset is
    created. The ``provider`` decides whether cleanup categories become folders
    (Outlook) or labels (Gmail). Caller commits."""
    existing = (
        {r["name"].lower() for r in await _load_rules(db, account_id)}
        if skip_existing else set()
    )
    installed: list[str] = []
    for p in _PRESET_RULES:
        if p["name"].lower() in existing:
            continue
        rid = str(uuid4())
        await db.execute(text(
            """INSERT INTO email_rules
                 (id, account_id, name, instructions, run_on_threads)
               VALUES (:id, :aid, :name, :instr, :rot)"""
        ), {"id": rid, "aid": account_id, "name": p["name"],
            "instr": p["instructions"], "rot": p.get("run_on_threads", False)})
        await _replace_actions(
            db, rid,
            [RuleActionModel(**a) for a in _actions_for_preset(p, provider)],
        )
        installed.append(p["name"])
    return installed


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
        # The account's provider decides whether cleanup categories become
        # folders (Outlook) or labels (Gmail) — inbox-zero parity.
        provider = await _account_provider(db, account_id)
        installed = await _seed_preset_rules(
            db, account_id, provider, skip_existing=True)
        await db.commit()
        return {"installed": installed,
                "total_presets": len(_PRESET_RULES)}
    finally:
        await db.close()


@router.post("/rules/reset")
async def reset_rules(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """Delete ALL of an account's rules and reinstall the default inbox-zero set
    fresh. Provider-aware: on Outlook the cleanup categories file mail into
    folders, on Gmail they label. Backs Settings → 'Reset rules' (the UI guards
    this destructive action behind a confirmation prompt).

    LEARNED PATTERNS SURVIVE. ``email_rule_patterns.rule_id`` is ON DELETE
    CASCADE, so dropping the rules used to silently destroy every correction the
    user had ever made (Fix, auto-learn, label-sync) — months of training gone,
    unrecoverably, behind a dialog that only mentioned rules. Patterns attached
    to a preset are carried across by NAME and re-pointed at the reseeded rule's
    new id. Patterns belonging to a custom rule the user is deleting here are
    genuinely gone with it, which is the expected meaning of 'reset'.
    """
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        provider = await _account_provider(db, account_id)
        # Snapshot the learned patterns keyed by their rule's NAME — the reseed
        # mints fresh UUIDs, so the name is the only stable join.
        saved = (await db.execute(text(
            """SELECT r.name AS rule_name, p.pattern_type, p.value, p.exclude,
                      p.source, p.reason, p.approved_at, p.rejected_at
                 FROM email_rule_patterns p
                 JOIN email_rules r ON r.id = p.rule_id
                WHERE p.account_id = :aid"""
        ), {"aid": account_id})).fetchall()

        # Drop every existing rule (actions cascade) before reseeding so stale
        # label-only rules are replaced by the current provider-aware defaults.
        await db.execute(
            text("DELETE FROM email_rules WHERE account_id = :aid"),
            {"aid": account_id})
        installed = await _seed_preset_rules(
            db, account_id, provider, skip_existing=False)

        restored = 0
        if saved:
            new_ids = {
                (r["name"] or "").lower(): r["id"]
                for r in await _load_rules(db, account_id)
            }
            for s in saved:
                rid = new_ids.get((s.rule_name or "").lower())
                if not rid:
                    continue  # belonged to a custom rule the reset removed
                await db.execute(text(
                    # Carry the review state across. Resetting the RULES
                    # must not silently un-approve patterns the user has
                    # already confirmed — nor resurrect ones they rejected.
                    """INSERT INTO email_rule_patterns
                         (account_id, rule_id, pattern_type, value, exclude,
                          source, reason, approved_at, rejected_at)
                       VALUES (:aid, :rid, :ptype, :val, :excl, :src, :reason,
                               :approved, :rejected)
                       ON CONFLICT DO NOTHING"""
                ), {"aid": account_id, "rid": rid, "ptype": s.pattern_type,
                    "val": s.value, "excl": s.exclude, "src": s.source,
                    "reason": s.reason, "approved": s.approved_at,
                    "rejected": s.rejected_at})
                restored += 1
        await db.commit()
        return {"installed": installed, "total_presets": len(_PRESET_RULES),
                "reset": True, "patterns_restored": restored}
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


async def sync_draft_reply_action(db: Any, account_id: str, enabled: bool) -> bool:
    """Mirror inbox-zero's ``enableDraftRepliesAction``: the "Auto draft replies"
    toggle adds (or removes) a ``DRAFT_EMAIL`` action on the account's "Reply"
    rule. With the action present, Reply mail gets an AI draft during the
    normal rule run (gated by ``draft_confidence``); without it, no draft —
    exactly how inbox-zero couples auto-drafting to the Reply system rule.

    Returns True if the rule's actions changed. No-ops (returns False) when the
    account has no "Reply" rule, or the action is already in the desired
    state. Caller commits.
    """
    rules = await _load_rules(db, account_id)
    target = next(
        (r for r in rules
         if (r.get("system_type") or "").upper() in ("REPLY", "TO_REPLY")
         or (r.get("name") or "").strip().lower() in ("reply", "to reply")),
        None,
    )
    if not target:
        return False
    actions = target["actions"]
    has_draft = any((a.get("type") or "").upper() == "DRAFT_EMAIL" for a in actions)
    if enabled == has_draft:
        return False
    if enabled:
        actions = [*actions, {"type": "DRAFT_EMAIL"}]
    else:
        actions = [a for a in actions
                   if (a.get("type") or "").upper() != "DRAFT_EMAIL"]
    await _replace_actions(
        db, target["id"], [RuleActionModel(**a) for a in actions])
    return True


async def _insert_rule(db: Any, req: RuleModel) -> str:
    """Insert a rule + its actions; returns the new rule id. Caller commits."""
    rule_id = str(uuid4())
    await db.execute(text(
        """INSERT INTO email_rules
             (id, account_id, name, instructions, enabled, automated,
              run_on_threads, conditional_operator, from_pattern, to_pattern,
              subject_pattern, body_pattern, system_type)
           VALUES (:id, :aid, :name, :instr, :enabled, :auto, :rot, :op,
                   :fp, :tp, :sp, :bp, :st)"""
    ), {"id": rule_id, "aid": req.account_id, "name": req.name,
        "instr": req.instructions, "enabled": req.enabled,
        "auto": req.automated, "rot": req.run_on_threads,
        "op": req.conditional_operator,
        "fp": req.from_pattern, "tp": req.to_pattern, "sp": req.subject_pattern,
        "bp": req.body_pattern, "st": req.system_type})
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
        sys_prompt = (
            "You convert a user's plain-English description of email rules into "
            "structured automation rules. The user may describe several rules "
            "(often one per line/bullet). Output ONLY a JSON object "
            '{"rules": [ ... ]} where each element is:\n'
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
            'short. Omit empty fields. Output {"rules": []} if nothing parses.'
        )
        # Rule authoring is quality-sensitive generation → powerful tier; JSON
        # forced; generous budget so several rules aren't truncated.
        data, _content, _used = await _llm_json(
            "tier-powerful",
            [{"role": "system", "content": sys_prompt},
             {"role": "user", "content": prompt[:4000]}],
            max_tokens=2500,
        )
        rules = data.get("rules") if isinstance(data, dict) else data
        return _normalize_generated_rules(rules)
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
        created_ids: list[str] = []
        for spec in specs:
            model = RuleModel(
                account_id=req.account_id,
                name=spec["name"],
                instructions=spec.get("instructions"),
                from_pattern=spec.get("from_pattern"),
                subject_pattern=spec.get("subject_pattern"),
                conditional_operator=spec.get("conditional_operator", "AND"),
                actions=[RuleActionModel(**a) for a in spec["actions"]],
            )
            created_ids.append(await _insert_rule(db, model))
        await db.commit()
        rules = await _load_rules(db, req.account_id)
        created = [r for r in rules if r["id"] in set(created_ids)]
        return {"created": created}
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
                 system_type = :st, updated_at = now()
               WHERE id = :rid"""
        ), {"rid": rule_id, "name": req.name, "instr": req.instructions,
            "enabled": req.enabled, "auto": req.automated,
            "rot": req.run_on_threads,
            "op": req.conditional_operator, "fp": req.from_pattern,
            "tp": req.to_pattern, "sp": req.subject_pattern, "bp": req.body_pattern,
            "st": req.system_type})
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


# Sources that represent a deliberate human act, so the pattern needs no review:
# the Fix flow, a label the user changed in their own mail client, and patterns
# typed into a rule. Everything else ('AI') is the machine generalising from its
# own output and lands in the review queue — see migration 85.
_USER_AUTHORED_SOURCES = frozenset({
    "FIX", "USER", "LABEL_ADDED", "LABEL_REMOVED",
})


async def _upsert_rule_pattern(
    db: Any, account_id: str, rule_id: str, value: str, exclude: bool,
    source: str, reason: str | None, message_id: str | None, thread_id: str | None,
    pattern_type: str = "FROM",
) -> bool:
    """Record a learned classification pattern (FROM sender or SUBJECT keyword)
    for a rule. Removes the opposite (include vs exclude) for the same
    type+value so a correction never contradicts itself.

    Returns True only if a pattern was actually stored. The guards below refuse
    writes silently, and callers used to report "Learned" regardless — so a user
    whose correction hit a guard was told it worked, forever, while nothing was
    ever recorded. Callers must honour the return value.

    Centralized backstop for two anti-patterns that every learning path (Fix,
    auto-learn, label sync) must avoid — enforced HERE so no single path can
    reintroduce them:
      1. Sender-pinning a conversation-status rule (Reply / Awaiting / FYI /
         Done). Reply state is re-derived from the whole thread and overrides
         any pattern, so "always reply to X" is both wrong and futile.
      2. Pinning the mailbox's OWN address to any rule (e.g. "vjvarada@… →
         Reply") — a meaningless self-reference from a stray label delta."""
    if not (value or "").strip():
        return False
    ptype = "SUBJECT" if (pattern_type or "").upper() == "SUBJECT" else "FROM"
    # (1) Never pin a sender/subject to a conversation-status rule. Mirrors
    #     engine._conversation_rule_key: system_type when set, else the name.
    meta = (await db.execute(text(
        "SELECT name, system_type FROM email_rules WHERE id = :rid"
    ), {"rid": rule_id})).fetchone()
    if meta is not None:
        key = ((meta.system_type or "").upper().strip()
               or (meta.name or "").upper().strip().replace(" ", "_"))
        # + legacy TO_REPLY / ACTIONED so an un-migrated conversation rule is
        # still recognised and never sender-pinned (the anti-pattern this guards).
        if key in {"REPLY", "AWAITING_REPLY", "FYI", "DONE",
                   "TO_REPLY", "ACTIONED"}:
            return False
    # (2) Never pin the mailbox's own address (FROM patterns only).
    if ptype == "FROM":
        acct = (await db.execute(text(
            "SELECT email_address FROM email_accounts WHERE id = :aid"
        ), {"aid": account_id})).fetchone()
        own = (getattr(acct, "email_address", "") or "").strip().lower()
        val_l = value.strip().lower()
        if own and (own in val_l or val_l in own):
            return False
    # (3) A pattern the user REJECTED must not come straight back. The auto-
    #     learner fires on any sender with three consistent AI matches, which is
    #     exactly the sender the user just rejected a pattern for — so without
    #     this, rejecting is futile and the same wrong pattern reappears within
    #     the hour. A deliberate user action (Fix, a label change, a hand-typed
    #     rule) is allowed to overturn it; the machine re-inferring it is not.
    user_authored = source in _USER_AUTHORED_SOURCES
    if not user_authored:
        rejected = (await db.execute(text(
            "SELECT 1 FROM email_rule_patterns WHERE account_id = :aid "
            "AND rule_id = :rid AND pattern_type = :ptype "
            "AND lower(value) = lower(:val) AND rejected_at IS NOT NULL"
        ), {"aid": account_id, "rid": rule_id, "ptype": ptype,
            "val": value})).fetchone()
        if rejected is not None:
            return False
    # Drop the opposite disposition for this (rule, type, value) first.
    await db.execute(text(
        "DELETE FROM email_rule_patterns WHERE account_id = :aid AND rule_id = :rid "
        "AND pattern_type = :ptype AND lower(value) = lower(:val) AND exclude = :opp"
    ), {"aid": account_id, "rid": rule_id, "ptype": ptype, "val": value,
        "opp": not exclude})
    # A pattern the user authored is approved by definition — Fix, a label
    # changed in their own mail client, or a rule they typed IS the confirmation
    # the review queue exists to collect. Only 'AI' arrives unreviewed.
    await db.execute(text(
        """INSERT INTO email_rule_patterns
             (account_id, rule_id, pattern_type, value, exclude, source, reason,
              message_id, thread_id, approved_at)
           VALUES (:aid, :rid, :ptype, :val, :exc, :src, :reason, :mid, :tid,
                   CASE WHEN :authored THEN now() ELSE NULL END)
           ON CONFLICT (account_id, rule_id, pattern_type, lower(value), exclude)
           DO UPDATE SET source = EXCLUDED.source, reason = EXCLUDED.reason,
                         created_at = now(),
                         approved_at = CASE WHEN :authored THEN now()
                                       ELSE email_rule_patterns.approved_at END,
                         rejected_at = CASE WHEN :authored THEN NULL
                                       ELSE email_rule_patterns.rejected_at END"""
    ), {"aid": account_id, "rid": rule_id, "ptype": ptype, "val": value,
        "exc": exclude, "src": source, "reason": reason, "mid": message_id,
        "tid": thread_id, "authored": user_authored})


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

        # Conversation-status rules (Reply / Awaiting / FYI / Done) are
        # re-derived from the full thread, so a learned sender/subject pattern is
        # OVERRIDDEN and pinning a person to one is wrong. For those, the fix that
        # sticks is to set the thread status directly. Cleanup categories
        # (Newsletter/Receipt/…) are sender-stable → learn FROM/SUBJECT patterns.
        meta = {r["id"]: r for r in await _load_rules(db, req.account_id)}

        # The Fix dialog passes the message id; derive its thread for a status fix.
        thread_id = (req.thread_id or "").strip()
        if not thread_id and req.message_id:
            trow = (await db.execute(text(
                "SELECT thread_id FROM email_messages "
                "WHERE id = :mid AND account_id = :aid"
            ), {"mid": req.message_id, "aid": req.account_id})).fetchone()
            thread_id = (trow.thread_id if trow else "") or ""

        def _conv_key(rid: str | None) -> str:
            r = meta.get(str(rid)) or {}
            k = ((r.get("system_type") or "").upper().strip()
                 or (r.get("name") or "").upper().strip().replace(" ", "_"))
            return k if k in {"REPLY", "AWAITING_REPLY", "FYI", "DONE",
                              "TO_REPLY", "ACTIONED"} else ""

        # Pattern signals (only meaningful for cleanup rules).
        signals: list[tuple[str, str]] = []
        if sender:
            signals.append(("FROM", sender))
        if subject_kw:
            signals.append(("SUBJECT", subject_kw))

        async def _teach(rule_id: str, exclude: bool) -> bool:
            """Store the signals for a rule; True if anything was actually saved.

            _upsert_rule_pattern refuses some writes on purpose (conversation
            rules can't be sender-pinned; the mailbox's own address is never
            pinned). Reporting those as "learned" is worse than reporting
            nothing — the user sees a success toast, changes nothing, and repeats
            the same correction forever.
            """
            saved = False
            for ptype, val in signals:
                if await _upsert_rule_pattern(
                    db, req.account_id, rule_id, val, exclude, "FIX", reason,
                    req.message_id, req.thread_id, pattern_type=ptype,
                ):
                    saved = True
            return saved

        learned: list[dict[str, Any]] = []
        status_correction: dict[str, Any] | None = None

        if req.expected == "none":
            # Stop the wrong CLEANUP rules from matching this sender (conversation
            # rules can't be pattern-excluded — they're thread-state).
            for rid in req.matched_rule_ids:
                if rid and not _conv_key(rid) and signals:
                    if await _teach(rid, True):
                        learned.append({"rule_id": rid, "exclude": True})
        else:
            ck = _conv_key(req.expected)
            if ck:
                # Conversation status → set it directly on the thread. Conversation
                # rules never get learned patterns, so with no resolvable thread
                # there's nothing to persist — only report "learned" when the
                # status correction actually landed (otherwise the UI would show a
                # false "Learned — will now match …" toast).
                if thread_id:
                    from gateway.routes.email.automation.replyzero import (  # noqa: PLC0415
                        apply_thread_status_correction,
                    )
                    status_correction = await apply_thread_status_correction(
                        req.account_id, thread_id, ck)
                    if status_correction and status_correction.get("ok"):
                        learned.append({"rule_id": req.expected, "status_set": ck})
            elif signals:
                if await _teach(req.expected, False):
                    learned.append({"rule_id": req.expected, "exclude": False})
            # Stop the wrong CLEANUP rules from matching this sender too.
            for rid in req.matched_rule_ids:
                if (rid and rid != req.expected and not _conv_key(rid)
                        and signals):
                    if await _teach(rid, True):
                        learned.append({"rule_id": rid, "exclude": True})

        await db.commit()
        created = bool(learned or (status_correction and status_correction.get("ok")))
        return {"created": created, "learned": learned, "sender": sender,
                "subject_keyword": subject_kw or None,
                "signals": [t for t, _ in signals],
                "status_correction": status_correction}
    finally:
        await db.close()


@router.get("/rules/patterns")
async def list_rule_patterns(
    account_id: str = Query(...),
    user: UserContext = Depends(get_current_user),
):
    """List learned classification patterns (sender → rule include/exclude).

    Each row carries its REACH: how many messages in the mailbox the pattern
    matches. Without it this screen could not support review — it showed a
    sender, a rule and a delete button, so "is this pattern right?" was
    unanswerable from what was on the page, which is why 45 machine-inferred
    patterns had accumulated on the live account without one being looked at.

    Reach is an approximation of :func:`_pattern_hit` that Postgres can compute:
    a FROM pattern counts mail whose sender contains the value, a SUBJECT pattern
    counts mail whose subject contains it. It skips the generalised-subject and
    address-boundary refinements, so it is a ceiling, not an exact count — the
    UI presents it as "about". One nested-loop join over the mailbox, on an
    explicitly-opened review screen.
    """
    db = await _get_db()
    try:
        await _assert_account_owner(db, account_id, user.email or "anonymous")
        try:
            rows = (await db.execute(text(
                """SELECT p.id, p.rule_id, r.name AS rule_name, p.pattern_type,
                          p.value, p.exclude, p.source, p.reason, p.created_at,
                          p.approved_at, p.rejected_at,
                          (SELECT COUNT(*) FROM email_messages m
                            WHERE m.account_id = p.account_id
                              AND ((p.pattern_type = 'SUBJECT'
                                    AND LOWER(COALESCE(m.subject, ''))
                                        LIKE '%' || LOWER(p.value) || '%')
                                OR (p.pattern_type <> 'SUBJECT'
                                    AND LOWER(COALESCE(
                                          m.from_address->>'email', ''))
                                        LIKE '%' || LOWER(p.value) || '%'))
                          ) AS reach
                   FROM email_rule_patterns p
                   LEFT JOIN email_rules r ON p.rule_id = r.id
                   WHERE p.account_id = :aid
                   ORDER BY p.approved_at NULLS FIRST, p.created_at DESC"""
            ), {"aid": account_id})).fetchall()
        except Exception as e:  # noqa: BLE001 — table may not exist pre-migration
            _log.warning("email.list_rule_patterns_failed",
                         account_id=account_id, error=str(e)[:160])
            rows = []
        return {"patterns": [
            {"id": str(r.id), "rule_id": str(r.rule_id),
             "rule_name": r.rule_name, "pattern_type": r.pattern_type,
             "value": r.value, "exclude": bool(r.exclude), "source": r.source,
             "reason": r.reason, "reach": int(r.reach or 0),
             "approved_at": r.approved_at.isoformat() if r.approved_at else None,
             "rejected_at": r.rejected_at.isoformat() if r.rejected_at else None,
             "created_at": r.created_at.isoformat() if r.created_at else None}
            for r in rows
        ]}
    finally:
        await db.close()


class PatternReviewRequest(BaseModel):
    account_id: str
    # Omit to act on every pattern still awaiting review.
    pattern_ids: list[str] | None = None
    approve: bool = True


@router.post("/rules/patterns/review")
async def review_rule_patterns(
    req: PatternReviewRequest,
    user: UserContext = Depends(get_current_user),
):
    """Approve or reject learned patterns — the gate the Email Cleaner reads.

    Rejecting KEEPS the row, with ``rejected_at`` set. Deleting it would let the
    auto-learner re-infer the same pattern from the same sender within the hour,
    which makes rejection a gesture rather than a decision. ``_upsert_rule_pattern``
    refuses to resurrect a rejected pattern unless the user themselves overturns
    it via Fix or a label change.
    """
    db = await _get_db()
    try:
        await _assert_account_owner(db, req.account_id, user.email or "anonymous")
        params: dict[str, Any] = {"aid": req.account_id}
        where = "account_id = :aid"
        if req.pattern_ids is None:
            # "Approve everything waiting" — deliberately does NOT re-approve or
            # un-reject what has already been decided.
            where += " AND approved_at IS NULL AND rejected_at IS NULL"
        else:
            if not req.pattern_ids:
                return {"updated": 0, "approved": req.approve}
            where += " AND id = ANY(:ids)"
            params["ids"] = [str(p) for p in req.pattern_ids]
        sets = ("approved_at = now(), rejected_at = NULL" if req.approve
                else "rejected_at = now(), approved_at = NULL")
        res = await db.execute(text(
            f"UPDATE email_rule_patterns SET {sets} WHERE {where}"), params)
        await db.commit()
        updated = int(getattr(res, "rowcount", 0) or 0)
        _log.info("email.rule_patterns_reviewed", account_id=req.account_id,
                  approved=req.approve, updated=updated)
        return {"updated": updated, "approved": req.approve}
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
