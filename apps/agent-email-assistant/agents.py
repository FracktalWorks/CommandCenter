"""Email Assistant Agent.

A MAF agent that checks the inbox, categorizes mail, manages automation rules,
takes inbox actions, and drafts context-aware replies — handing off to the
sales / task-manager agents and reading memory when an email needs their
context. Modeled on inbox-zero's (elie222/inbox-zero) assistant tool surface.

Registered as a MAF agent (name "email-assistant"); build_agents() is the
Dynamic Agent Loader entry point.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import httpx

from acb_common import get_logger, get_settings

_log = get_logger("agent.email_assistant")

_INSTRUCTIONS_FILE = Path(__file__).parent / "instructions.md"
INSTRUCTIONS = (
    _INSTRUCTIONS_FILE.read_text(encoding="utf-8")
    if _INSTRUCTIONS_FILE.exists()
    else "You are the Email Assistant. Help the user check, categorize, and "
    "reply to their email using the provided tools."
)


# ── Gateway access (user-scoped) ─────────────────────────────────────────────

def _gateway_url() -> str:
    return os.environ.get("GATEWAY_URL", "http://localhost:8080").rstrip("/")


def _current_user_email() -> str:
    """The user the agent is acting for. Primary source is the memory ContextVar
    the executor sets; the Copilot SDK runs tool callbacks in a context that can
    drop ContextVars, so fall back to ACB_AGENT_USER_EMAIL (set by the gateway
    per run). Without either, gateway calls are unscoped."""
    try:
        from acb_skills.memory_tools import _get_memory_user_id  # noqa: PLC0415
        user = _get_memory_user_id() or ""
        if user:
            return user
    except Exception:  # noqa: BLE001
        pass
    return os.environ.get("ACB_AGENT_USER_EMAIL", "")


def _internal_token() -> str:
    """The gateway's internal bearer token. The Settings field is
    ``litellm_master_key``; ``gateway_internal_token`` isn't a real attribute."""
    settings = get_settings()
    return (
        getattr(settings, "gateway_internal_token", "")
        or getattr(settings, "litellm_master_key", "")
        or "sk-local"
    )


def _headers() -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {_internal_token()}",
        "Content-Type": "application/json",
    }
    user = _current_user_email()
    if user:
        headers["X-User-Email"] = user
    return headers


def _raise_if_error(resp: httpx.Response, method: str, path: str) -> None:
    """Surface gateway errors as a concise, user-facing message.

    The agent relays a tool's raised exception to the user, so a raw
    ``httpx.HTTPStatusError`` (status line + URL + a help link) reads badly.
    Turn 4xx/5xx into a short ``RuntimeError`` with the gateway's own
    ``detail``/``error`` message instead.
    """
    if resp.status_code < 400:
        return
    detail = ""
    try:
        body = resp.json()
        if isinstance(body, dict):
            detail = str(body.get("detail") or body.get("error") or "")
    except Exception:  # non-JSON body
        detail = (resp.text or "")[:200]
    raise RuntimeError(
        f"Email {method} {path} failed ({resp.status_code})"
        + (f": {detail}" if detail else "")
    )


async def _request(
    method: str,
    path: str,
    *,
    timeout: float = 30.0,
    **kwargs: Any,
) -> httpx.Response:
    """Single gateway round-trip: build the URL + auth headers, fire the
    request, and turn any 4xx/5xx into a concise user-facing error.

    All the verb helpers below delegate here so the client config, headers, and
    error handling live in exactly one place.  (Still one client per call — a
    shared pooled client is a possible perf follow-up, pending confirmation that
    the agent always runs on a single long-lived event loop.)
    """
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.request(
            method, f"{_gateway_url()}{path}", headers=_headers(), **kwargs
        )
        _raise_if_error(resp, method, path)
        return resp


async def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    return (await _request("GET", path, params=params or {})).json()


async def _post(path: str, body: dict[str, Any]) -> Any:
    return (await _request("POST", path, timeout=60.0, json=body)).json()


async def _patch(path: str, body: dict[str, Any]) -> Any:
    return (await _request("PATCH", path, json=body)).json()


async def _delete(path: str) -> Any:
    resp = await _request("DELETE", path)
    # DELETEs commonly return 204 with no body.
    if resp.status_code == 204 or not resp.content:
        return {}
    return resp.json()


# ── Read / triage tools ──────────────────────────────────────────────────────

async def _account_labels() -> dict[str, str]:
    """Map ``account_id`` → human label, for tagging cross-account results.

    Used by the tools whose ``account_id`` is optional: when none is given the
    gateway spans ALL of the user's accounts, so results from different inboxes
    get mixed together with no way to tell them apart. Tagging each line with
    its account fixes that for multi-account users (a no-op for single-account).
    """
    try:
        accounts = await _get("/email/accounts")
        return {
            str(a.get("id")): (a.get("label") or a.get("email_address") or "")
            for a in (accounts or [])
            if a.get("id")
        }
    except Exception:
        return {}


async def list_accounts() -> str:
    """List the user's connected email accounts (id, address, unread count)."""
    accounts = await _get("/email/accounts")
    if not accounts:
        return "No email accounts are connected."
    lines = ["Connected accounts:"]
    for a in accounts:
        lines.append(
            f"• {a.get('label') or a.get('email_address')} "
            f"({a.get('email_address')}) — id={a.get('id')}, "
            f"{a.get('unread_count', 0)} unread"
        )
    return "\n".join(lines)


async def search_emails(
    query: str, folder: str = "inbox", account_id: str | None = None
) -> str:
    """Search emails (subject/body/sender). Returns matches with their ids."""
    params: dict[str, Any] = {"query": query, "folder": folder}
    if account_id:
        params["account_id"] = account_id
    data = await _get("/email/messages", params)
    emails = data.get("emails", [])
    total = data.get("total", 0)
    labels = {} if account_id else await _account_labels()
    multi = len(labels) > 1
    lines = [f"Found {total} emails matching '{query}' in {folder}:"]
    for e in emails[:10]:
        frm = e.get("from_address", {}) or {}
        acct = f" [{labels.get(str(e.get('account_id')), '?')}]" if multi else ""
        lines.append(
            f"• id={e.get('id')}{acct} | {frm.get('name') or frm.get('email')}: "
            f"{e.get('subject', '(no subject)')} — {(e.get('snippet') or '')[:90]}"
        )
    if total > 10:
        lines.append(f"… and {total - 10} more")
    return "\n".join(lines)


def _fmt_recipients(lst: Any) -> str:
    """A list of {name, email} → "Name <email>, …" for display."""
    out: list[str] = []
    for it in lst or []:
        if not isinstance(it, dict):
            continue
        nm, em = (it.get("name") or "").strip(), (it.get("email") or "").strip()
        val = f"{nm} <{em}>" if nm and em else (em or nm)
        if val:
            out.append(val)
    return ", ".join(out)


async def read_email(email_id: str) -> str:
    """Fetch the full content of one email by id — incl. To/Cc and attachments."""
    e = await _get(f"/email/messages/{email_id}")
    frm = e.get("from_address", {}) or {}
    you_sent = " (you sent)" if (e.get("folder") or "").lower() == "sent" else ""
    lines = [f"From: {frm.get('name')} <{frm.get('email')}>{you_sent}"]
    to = _fmt_recipients(e.get("to_addresses"))
    cc = _fmt_recipients(e.get("cc_addresses"))
    if to:
        lines.append(f"To: {to}")
    if cc:
        lines.append(f"Cc: {cc}")
    lines.append(f"Subject: {e.get('subject', '(no subject)')}")
    lines.append(f"Date: {e.get('received_at', '')}")
    atts = [a for a in (e.get("attachments") or []) if isinstance(a, dict)]
    if atts:
        names = ", ".join(
            f"{a.get('filename') or 'file'} ({a.get('mime_type') or ''})"
            for a in atts)
        lines.append(f"Attachments: {names}")
    return "\n".join(lines) + "\n---\n" + (e.get("body_text") or "")[:4000]


async def find_urgent(account_id: str | None = None) -> str:
    """Find emails that look urgent / need attention soon."""
    params: dict[str, Any] = {
        "query": "urgent OR deadline OR ASAP OR action required OR by EOD",
        "page_size": "20",
    }
    if account_id:
        params["account_id"] = account_id
    data = await _get("/email/messages", params)
    emails = data.get("emails", [])
    if not emails:
        return "No urgent emails found."
    # Tag each result with its account when the query spans multiple accounts
    # (no account_id given) so cross-account results aren't ambiguous.
    labels = {} if account_id else await _account_labels()
    multi = len(labels) > 1
    lines = ["Urgent / needs attention:"]
    for e in emails[:10]:
        frm = e.get("from_address", {}) or {}
        acct = f" [{labels.get(str(e.get('account_id')), '?')}]" if multi else ""
        lines.append(
            f"• id={e.get('id')}{acct} | {frm.get('name') or frm.get('email')}: "
            f"{e.get('subject', '(no subject)')}"
        )
    return "\n".join(lines)


async def find_needs_reply(account_id: str) -> str:
    """List threads whose latest message is inbound and awaiting your reply."""
    data = await _get(
        "/email/reply-zero",
        {"account_id": account_id, "type": "needs_reply", "limit": "30"},
    )
    threads = data.get("threads", [])
    if not threads:
        return "Nothing needs a reply — inbox zero!"
    lines = ["Needs reply:"]
    for t in threads[:15]:
        lines.append(
            f"• id={t.get('message_id')} | {t.get('from')}: {t.get('subject')}"
        )
    return "\n".join(lines)


async def get_unread_count(account_id: str | None = None) -> str:
    """Unread totals across the user's accounts."""
    accounts = await _get("/email/accounts")
    if account_id:
        accounts = [a for a in accounts if a.get("id") == account_id]
    total = sum(a.get("unread_count", 0) for a in accounts)
    lines = [f"{total} unread across {len(accounts)} account(s):"]
    for a in accounts:
        lines.append(f"• {a.get('email_address')}: {a.get('unread_count', 0)} unread")
    return "\n".join(lines)


async def get_account_overview(account_id: str) -> str:
    """High-level snapshot: totals, read-rate, top senders, sender categories."""
    overview = await _get(
        "/email/analytics/overview", {"account_id": account_id, "days": "30"}
    )
    cats = await _get("/email/senders/categories", {"account_id": account_id})
    t = overview.get("totals", {})
    lines = [
        f"Account overview (30d): {t.get('total', 0)} messages, "
        f"{t.get('unread', 0)} unread, "
        f"{round(t.get('read_rate', 0) * 100)}% read.",
        "Top senders: "
        + ", ".join(
            f"{s.get('name') or s.get('email')} ({s.get('count')})"
            for s in overview.get("top_senders", [])[:5]
        ),
    ]
    counts = cats.get("counts", {})
    if counts:
        lines.append(
            "Sender categories: "
            + ", ".join(f"{k}: {v}" for k, v in counts.items())
        )
    return "\n".join(lines)


async def query_inbox(
    account_id: str,
    query: str | None = None,
    folder: str = "inbox",
    days: int | None = None,
    sender_category: str | None = None,
    from_email: str | None = None,
    unread_only: bool = False,
    starred_only: bool = False,
    has_attachments: bool | None = None,
    importance: str | None = None,
    sort: str = "newest",
    limit: int = 25,
) -> str:
    """Search and filter the inbox to answer questions spanning MANY emails.

    Use this for inbox-wide questions — "sales-related emails in the last month",
    "unread mail from Acme", "marketing emails this week", "starred emails with
    attachments". Combine any of the filters:
      query: full-text over subject/body/sender (e.g. "sales", "invoice")
      days: only mail received in the last N days (use 30 for "last month")
      sender_category: the sender's category — one of Newsletter, Marketing,
        Receipt, Calendar, Notification, Cold Email, Personal, Support
      from_email: substring of the sender's address
      unread_only / starred_only / has_attachments / importance (high|normal|low)
      sort: newest | oldest | importance
    Returns matching emails with ids; call read_email for an id's full content.
    """
    params: dict[str, Any] = {
        "folder": folder, "account_id": account_id, "sort": sort,
        "page_size": str(max(1, min(limit, 100))),
    }
    if query:
        params["query"] = query
    if days:
        from datetime import datetime, timedelta, timezone
        params["received_after"] = (
            datetime.now(timezone.utc) - timedelta(days=days)
        ).isoformat()
    if sender_category:
        params["sender_category"] = sender_category
    if from_email:
        params["from_email"] = from_email
    if unread_only:
        params["is_read"] = "false"
    if starred_only:
        params["is_starred"] = "true"
    if has_attachments is not None:
        params["has_attachments"] = "true" if has_attachments else "false"
    if importance:
        params["importance"] = importance
    data = await _get("/email/messages", params)
    emails = data.get("emails", [])
    total = data.get("total", 0)
    if not emails:
        return "No emails matched those filters."
    shown = emails[:limit]
    lines = [f"Found {total} emails ({query or 'filtered'}); showing {len(shown)}:"]
    for e in shown:
        frm = e.get("from_address", {}) or {}
        flags = []
        if not e.get("is_read"):
            flags.append("unread")
        if e.get("is_starred"):
            flags.append("star")
        if e.get("has_attachments"):
            flags.append("attachment")
        flag = f" [{', '.join(flags)}]" if flags else ""
        lines.append(
            f"• id={e.get('id')} | {(e.get('received_at') or '')[:10]} | "
            f"{frm.get('name') or frm.get('email')}: "
            f"{e.get('subject', '(no subject)')}{flag} — "
            f"{(e.get('snippet') or '')[:80]}"
        )
    if total > len(shown):
        lines.append(f"… and {total - len(shown)} more (refine filters or raise limit)")
    return "\n".join(lines)


async def get_important_emails(account_id: str, days: int = 30) -> str:
    """The emails that most need attention — answers "what are the most important
    emails I need to check?".

    Ranks recent inbox threads by needs-reply status, unread, high importance,
    starred, and personal/support senders; excludes newsletters, marketing,
    notifications and cold email so the list stays high-signal."""
    data = await _get(
        "/email/priority",
        {"account_id": account_id, "days": days, "limit": 20},
    )
    emails = data.get("emails", [])
    if not emails:
        return "Nothing pressing — no high-priority emails to check right now."
    lines = ["Most important emails to check:"]
    for e in emails:
        lines.append(
            f"• id={e.get('message_id')} | {e.get('from')}: "
            f"{e.get('subject')} — ({e.get('reason')})"
        )
    return "\n".join(lines)


# ── Inbox action tools ───────────────────────────────────────────────────────

async def manage_inbox(
    action: str, message_ids: list[str], account_id: str | None = None
) -> str:
    """Apply an action to one or more messages.

    Args:
        action: archive | trash | read | unread | star | unstar
        message_ids: ids of the messages to act on
        account_id: optional account scope
    """
    body: dict[str, Any] = {"action": action, "message_ids": message_ids}
    if account_id:
        body["account_id"] = account_id
    res = await _post("/email/messages/bulk", body)
    return f"{action}: affected {res.get('affected', 0)} message(s)."


async def draft_reply(email_id: str, account_id: str, save: bool = False) -> str:
    """Draft a context-aware reply to an email. Set save=true to also create a
    provider draft in the user's Drafts folder."""
    res = await _post(
        "/email/draft-reply",
        {"account_id": account_id, "message_id": email_id, "create_draft": save},
    )
    note = " (saved to Drafts)" if res.get("created") else ""
    return f"Draft{note}:\n\n{res.get('draft', '')}"


# ── Sender categorization tools ──────────────────────────────────────────────

async def categorize_senders(account_id: str) -> str:
    """Kick off AI categorization of the account's senders (runs in background)."""
    await _post("/email/senders/categorize", {"account_id": account_id, "limit": 100})
    return (
        "Categorization started in the background. Ask for the account overview "
        "in a moment to see category counts."
    )


async def get_sender_categories(account_id: str) -> str:
    """Show the category vocabulary and how many senders fall in each."""
    data = await _get("/email/senders/categories", {"account_id": account_id})
    counts = data.get("counts", {})
    if not counts:
        return (
            "No senders categorized yet. Run categorize_senders first. "
            f"Categories: {', '.join(data.get('categories', []))}."
        )
    return "Sender categories:\n" + "\n".join(
        f"• {k}: {v}" for k, v in counts.items()
    )


# ── Rule / automation tools ──────────────────────────────────────────────────

async def get_rules_and_settings(account_id: str) -> str:
    """List the account's automation rules and assistant settings."""
    rules = (await _get("/email/rules", {"account_id": account_id})).get("rules", [])
    settings_obj = await _get(
        "/email/assistant/settings", {"account_id": account_id}
    )
    lines = [f"{len(rules)} rule(s):"]
    for r in rules:
        actions = ", ".join(
            a["type"] + (f":{a['label']}" if a.get("label") else "")
            for a in r.get("actions", [])
        )
        state = "auto" if r.get("automated") else "manual"
        on = "on" if r.get("enabled") else "off"
        lines.append(
            f"• id={r.get('id')} | {r.get('name')} [{state}/{on}] — "
            f"if: {r.get('instructions') or '(static)'} → {actions}"
        )
    lines.append(
        f"\nSettings: auto-run={settings_obj.get('auto_run')}, "
        f"cold-blocker={settings_obj.get('cold_email_blocker')}, "
        f"about set={'yes' if settings_obj.get('about') else 'no'}."
    )
    return "\n".join(lines)


async def create_rule(
    account_id: str,
    name: str,
    instructions: str = "",
    action_type: str = "LABEL",
    label: str | None = None,
    automated: bool = True,
    from_pattern: str | None = None,
    to_pattern: str | None = None,
    subject_pattern: str | None = None,
    body_pattern: str | None = None,
    conditional_operator: str = "OR",
    run_on_threads: bool = False,
    forward_to: str | None = None,
    draft_subject: str | None = None,
    draft_content: str | None = None,
    second_action_type: str | None = None,
    second_action_label: str | None = None,
) -> str:
    """Create an automation rule (inbox-zero parity — full condition + action set).

    Conditions (all optional; combined with ``conditional_operator``):
        instructions: plain-English condition the AI matches mail against.
        from_pattern / to_pattern / subject_pattern / body_pattern: literal
            substrings matched deterministically (no LLM).
        conditional_operator: "AND" (all conditions) or "OR" (any). Default OR.
        run_on_threads: also evaluate replies in a thread, not just new mail.

    Actions:
        action_type: ARCHIVE | LABEL | MARK_READ | STAR | MARK_SPAM | TRASH |
                     MOVE_FOLDER | REPLY | FORWARD | DRAFT_EMAIL | CALL_WEBHOOK.
        label: label/folder name for LABEL / MOVE_FOLDER.
        forward_to: recipient for a FORWARD action.
        draft_subject / draft_content: subject + body for REPLY / DRAFT_EMAIL
            (omit draft_content to let the AI write the body).
        second_action_type / second_action_label: optional 2nd action (e.g.
            LABEL + ARCHIVE). For 3+ actions, call update_rule afterwards.
        automated: true = apply automatically; false = propose for approval.
    """
    def _mk_action(a_type: str, a_label: str | None = None) -> dict[str, Any]:
        a: dict[str, Any] = {"type": a_type}
        if a_label:
            a["label"] = a_label
        if a_type == "FORWARD" and forward_to:
            a["to_address"] = forward_to
        if a_type in ("REPLY", "DRAFT_EMAIL"):
            if draft_subject:
                a["subject"] = draft_subject
            if draft_content:
                a["content"] = draft_content
                a["content_manual"] = True
        return a

    actions = [_mk_action(action_type, label)]
    if second_action_type:
        actions.append(_mk_action(second_action_type, second_action_label))
    rule = {
        "account_id": account_id,
        "name": name,
        "instructions": instructions or None,
        "enabled": True,
        "automated": automated,
        "run_on_threads": run_on_threads,
        "conditional_operator": (
            "AND" if str(conditional_operator).upper() == "AND" else "OR"
        ),
        "from_pattern": from_pattern,
        "to_pattern": to_pattern,
        "subject_pattern": subject_pattern,
        "body_pattern": body_pattern,
        "actions": actions,
    }
    res = await _post("/email/rules", rule)
    return f"Created rule '{name}' (id={res.get('id')})."


async def delete_rule(account_id: str, rule_id: str) -> str:
    """Delete an automation rule permanently. Confirm with the user first —
    disabling (update_rule_state) is reversible; deleting is not."""
    await _delete(f"/email/rules/{rule_id}")
    return f"Deleted rule {rule_id}."


async def reset_rules(account_id: str) -> str:
    """Delete ALL of the account's rules and reinstall the default inbox-zero
    set fresh. Destructive — always confirm with the user before running."""
    res = await _post(f"/email/rules/reset?account_id={account_id}", {})
    installed = res.get("installed", [])
    return (
        f"Reset rules: reinstalled {len(installed)} default rule(s) "
        f"({', '.join(installed)})."
    )


async def run_rules_now(
    account_id: str, dry_run: bool = True, limit: int = 20
) -> str:
    """Run the automation rules over recent unprocessed inbox mail now.

    dry_run=true previews matches (nothing changes); dry_run=false applies the
    matched actions. Results stream into the History tab."""
    await _post(
        "/email/rules/run",
        {"account_id": account_id, "limit": limit, "dry_run": dry_run},
    )
    mode = "Previewing" if dry_run else "Applying"
    return (
        f"{mode} rules over up to {limit} recent message(s); results appear in "
        "the History tab."
    )


async def update_rule_state(
    account_id: str, rule_id: str, enabled: bool
) -> str:
    """Enable or disable an existing rule by id."""
    rules = (await _get("/email/rules", {"account_id": account_id})).get("rules", [])
    rule = next((r for r in rules if r.get("id") == rule_id), None)
    if not rule:
        return f"Rule {rule_id} not found."
    rule["enabled"] = enabled
    await _patch(f"/email/rules/{rule_id}", rule)
    return f"Rule '{rule.get('name')}' is now {'enabled' if enabled else 'disabled'}."


async def update_rule(
    account_id: str,
    rule_id: str,
    instructions: str | None = None,
    from_pattern: str | None = None,
    subject_pattern: str | None = None,
    add_action_type: str | None = None,
    add_action_label: str | None = None,
) -> str:
    """Edit an existing rule's matching conditions and/or add an action.

    Use this to FIX a rule that mis-classifies mail — e.g. tighten its
    plain-English ``instructions``, add a literal ``from_pattern`` /
    ``subject_pattern``, or attach another action. Only the fields you pass
    change; everything else on the rule is preserved.

    Args:
        instructions: new plain-English condition the AI matches mail against.
        from_pattern: literal sender substring to match (e.g. "@vendor.com").
        subject_pattern: literal subject substring to match.
        add_action_type: ARCHIVE | LABEL | MARK_READ | STAR | MARK_SPAM | TRASH |
                         MOVE_FOLDER | DRAFT_EMAIL | REPLY | FORWARD.
        add_action_label: label/folder for an added LABEL / MOVE_FOLDER action.
    """
    rules = (await _get("/email/rules", {"account_id": account_id})).get("rules", [])
    rule = next((r for r in rules if r.get("id") == rule_id), None)
    if not rule:
        return f"Rule {rule_id} not found."
    if instructions is not None:
        rule["instructions"] = instructions
    if from_pattern is not None:
        rule["from_pattern"] = from_pattern
    if subject_pattern is not None:
        rule["subject_pattern"] = subject_pattern
    if add_action_type:
        action: dict[str, Any] = {"type": add_action_type}
        if add_action_label:
            action["label"] = add_action_label
        rule.setdefault("actions", []).append(action)
    await _patch(f"/email/rules/{rule_id}", rule)
    return f"Updated rule '{rule.get('name')}'."


async def learn_rule_pattern(
    account_id: str, rule_id: str, sender: str = "", exclude: bool = False,
    subject_keyword: str = "",
) -> str:
    """Teach the matcher a deterministic learned pattern for a rule.

    Provide ``sender`` (an email/domain) and/or ``subject_keyword`` (a phrase
    that appears in the subject) — at least one is required.
    ``exclude=false`` → ALWAYS apply this rule to matching mail.
    ``exclude=true``  → NEVER apply this rule to matching mail.
    Use when the user says "emails from X (or about Y) should / shouldn't be
    labelled Z". This persists and short-circuits future classification (no
    LLM needed).
    """
    if not sender and not subject_keyword:
        return ("Provide at least a sender (email/domain) or a subject_keyword "
                "(phrase in the subject) to learn from.")
    body = {
        "account_id": account_id,
        "sender": sender,
        "subject_keyword": subject_keyword or None,
        "expected": "none" if exclude else rule_id,
        "matched_rule_ids": [rule_id] if exclude else [],
    }
    await _post("/email/rules/feedback", body)
    signal = " / ".join(
        s for s in [sender and f"from {sender}",
                    subject_keyword and f'about "{subject_keyword}"'] if s
    ) or "matching"
    verb = "no longer match" if exclude else "always match"
    return f"Learned: emails {signal} will {verb} that rule."


async def update_assistant_settings(
    account_id: str,
    about: str | None = None,
    signature: str | None = None,
    auto_run: bool | None = None,
    cold_email_blocker: str | None = None,
    personal_instructions: str | None = None,
    writing_style: str | None = None,
    draft_replies: bool | None = None,
    draft_confidence: str | None = None,
    follow_up_awaiting_days: int | None = None,
    follow_up_needs_reply_days: int | None = None,
    follow_up_auto_draft: bool | None = None,
    digest_frequency: str | None = None,
    digest_categories: list[str] | None = None,
    digest_day_of_week: int | None = None,
    digest_time_of_day: str | None = None,
    digest_send_to_email: bool | None = None,
    multi_rule_execution: bool | None = None,
    sensitive_data_protection: bool | None = None,
    rule_model: str | None = None,
    draft_model: str | None = None,
    chat_model: str | None = None,
) -> str:
    """Update assistant settings. Only the fields you pass change; every other
    setting is preserved.

    Args:
        about: free-text context about the user (used when drafting).
        signature: signature appended to drafted replies.
        auto_run: run rules automatically on new mail.
        cold_email_blocker: OFF | LABEL | ARCHIVE.
        personal_instructions: global rules the assistant ALWAYS follows
            (e.g. "Never commit to dates without checking with me.").
        writing_style: tone/length/style guide for drafted replies.
        draft_replies: auto-draft replies for emails that need one.
        draft_confidence: how sure the AI must be before drafting —
            ALL_EMAILS | STANDARD | HIGH_CONFIDENCE.
        follow_up_awaiting_days: remind/label when THEY haven't replied after N
            days (0 disables). Pairs with find_follow_ups.
        follow_up_needs_reply_days: remind/label when YOU haven't replied after N
            days (0 disables).
        follow_up_auto_draft: when on, follow-up scans also draft a nudge.
        digest_frequency: scheduled digest cadence — OFF | DAILY | WEEKLY.
        digest_categories: rule names (+ "Cold Emails") to include; [] = all.
        digest_day_of_week: 0=Sun … 6=Sat (used when digest is WEEKLY).
        digest_time_of_day: "HH:MM" 24h, account-local, the digest is sent.
        digest_send_to_email: email the digest to the account address.
        multi_rule_execution: allow more than one rule per email.
        sensitive_data_protection: skip auto-drafting on sensitive-looking mail.
        rule_model / draft_model / chat_model: LiteLLM tier or model id for rule
            classification / draft writing / the chat panel (e.g. "tier-fast",
            "tier-balanced", "tier-powerful").
    """
    # Start from the current settings so a PUT preserves EVERY field this tool
    # doesn't explicitly change.
    cur = await _get("/email/assistant/settings", {"account_id": account_id})
    body: dict[str, Any] = dict(cur)
    body["account_id"] = account_id

    def setif(key: str, val: Any) -> None:
        if val is not None:
            body[key] = val

    setif("about", about)
    setif("signature", signature)
    setif("auto_run", auto_run)
    setif("cold_email_blocker", cold_email_blocker)
    setif("personal_instructions", personal_instructions)
    setif("writing_style", writing_style)
    setif("draft_replies", draft_replies)
    setif("draft_confidence", draft_confidence)
    setif("follow_up_awaiting_days", follow_up_awaiting_days)
    setif("follow_up_needs_reply_days", follow_up_needs_reply_days)
    setif("follow_up_auto_draft", follow_up_auto_draft)
    setif("digest_frequency", digest_frequency)
    setif("digest_categories", digest_categories)
    setif("digest_day_of_week", digest_day_of_week)
    setif("digest_time_of_day", digest_time_of_day)
    setif("digest_send_to_email", digest_send_to_email)
    setif("multi_rule_execution", multi_rule_execution)
    setif("sensitive_data_protection", sensitive_data_protection)
    setif("rule_model", rule_model)
    setif("draft_model", draft_model)
    setif("chat_model", chat_model)
    await _patch_settings(body)
    return "Assistant settings updated."


async def list_knowledge(account_id: str) -> str:
    """List the account's knowledge-base entries (reference snippets the
    assistant draws on when drafting replies)."""
    entries = (await _get(
        "/email/knowledge", {"account_id": account_id}
    )).get("entries", [])
    if not entries:
        return "Knowledge base is empty."
    return "Knowledge base:\n" + "\n".join(
        f"• {e.get('title')}: {(e.get('content') or '')[:80]}" for e in entries
    )


async def add_knowledge(account_id: str, title: str, content: str) -> str:
    """Add (or overwrite by title) a knowledge-base entry the assistant uses when
    drafting replies — e.g. pricing, FAQs, policies, boilerplate, product facts."""
    await _post("/email/knowledge", {
        "account_id": account_id, "title": title, "content": content,
    })
    return f"Saved knowledge entry '{title}'."


async def generate_writing_style(account_id: str) -> str:
    """Analyze the user's recent sent emails and save a writing-style guide the
    assistant follows when drafting. Use when the user asks you to learn or match
    their writing style."""
    res = await _post(
        f"/email/assistant/writing-style/generate?account_id={account_id}", {}
    )
    style = res.get("writing_style", "")
    if style:
        return f"Derived and saved this writing style:\n{style}"
    return "Could not derive a writing style yet (no sent mail to analyze)."


async def install_default_rules(account_id: str) -> str:
    """Install the recommended default rule set: To Reply, FYI, Newsletter,
    Marketing, Calendar, Receipt, Notification, Cold Email. Skips any the user
    already has."""
    res = await _post(
        f"/email/rules/install-presets?account_id={account_id}", {}
    )
    installed = res.get("installed", [])
    if not installed:
        return "The default rules are already installed."
    return (
        f"Installed {len(installed)} default rule(s): {', '.join(installed)}."
    )


async def _patch_settings(body: dict[str, Any]) -> Any:
    return (await _request("PUT", "/email/assistant/settings", json=body)).json()


async def find_follow_ups(account_id: str) -> str:
    """Scan NOW for threads waiting too long for a reply, label them "Follow-up",
    and — when follow-up auto-draft is on — draft nudges. Use when the user asks
    to "find follow-ups", "chase replies", or "draft follow-ups".

    Respects the configured reminder windows; if none are set, ask the user how
    many days to wait and set them via update_assistant_settings first."""
    res = await _post("/email/follow-ups/scan", {"account_id": account_id})
    if not res.get("configured"):
        return (
            "Follow-up reminder windows aren't set yet. Ask the user how many "
            "days to wait before nudging (when they haven't replied, and when "
            "you haven't), set them with update_assistant_settings "
            "(follow_up_awaiting_days / follow_up_needs_reply_days), then scan "
            "again."
        )
    scanned = res.get("scanned", 0)
    if not scanned:
        return "No threads are waiting past the reminder windows — all current."
    drafted = res.get("drafted", 0)
    note = f", drafted {drafted} nudge(s)" if drafted else ""
    return (
        f"Found {scanned} follow-up(s); labelled {res.get('labeled', 0)} "
        f'"Follow-up"{note}. Drafts (if any) are in the Drafts folder for review.'
    )


async def process_past_emails(
    account_id: str, days: int = 7, include_read: bool = True
) -> str:
    """Run the automation rules over PAST inbox mail from the last `days` days
    (inbox-zero "Process past emails"): applies matched rules + drafts and logs
    to History. Use when the user asks to apply rules to existing/old mail.

    Args:
        days: how far back to process (default 7).
        include_read: false = only unread mail in the range.
    """
    start = (date.today() - timedelta(days=max(1, days))).isoformat()
    res = await _post("/email/rules/process-past", {
        "account_id": account_id, "start_date": start,
        "is_test": False, "include_read": include_read,
    })
    n = res.get("count", 0)
    if not n:
        return "No emails found in that range to process."
    return (
        f"Processing {n} past email(s) from the last {days} day(s) — applied "
        "actions stream into the History tab."
    )


async def suggest_unsubscribes(account_id: str | None = None) -> str:
    """Surface likely newsletters/subscriptions to consider unsubscribing from."""
    params: dict[str, Any] = {"folder": "inbox", "limit": "200"}
    if account_id:
        params["account_id"] = account_id
    data = await _get("/email/senders", params)
    senders = [
        s for s in data.get("senders", [])
        if s.get("unsubscribe_link") or s.get("read_rate", 1) < 0.4
    ]
    if not senders:
        return "No obvious newsletters to unsubscribe from."
    lines = ["Unsubscribe candidates (low read-rate / has unsubscribe link):"]
    for s in senders[:10]:
        lines.append(
            f"• {s.get('name') or s.get('email')} — {s.get('count')} emails, "
            f"{round(s.get('read_rate', 0) * 100)}% read"
        )
    return "\n".join(lines)


# ── Labels / folders / send ──────────────────────────────────────────────────

async def apply_labels(
    account_id: str,
    message_ids: list[str],
    add: list[str] | None = None,
    remove: list[str] | None = None,
) -> str:
    """Add and/or remove labels/categories on one or more messages (syncs to the
    provider). Pass label NAMES in ``add`` / ``remove``."""
    if not add and not remove:
        return "Provide at least one label to add or remove."
    body: dict[str, Any] = {}
    if add:
        body["add_labels"] = add
    if remove:
        body["remove_labels"] = remove
    # Patch all messages concurrently instead of one serial round-trip each.
    results = await asyncio.gather(
        *(_patch(f"/email/messages/{mid}", dict(body)) for mid in message_ids),
        return_exceptions=True,
    )
    n = sum(1 for r in results if not isinstance(r, BaseException))
    bits = []
    if add:
        bits.append(f"+{', '.join(add)}")
    if remove:
        bits.append(f"-{', '.join(remove)}")
    failed = len(message_ids) - n
    note = f" ({failed} failed)" if failed else ""
    return f"Updated labels on {n} message(s){note}: {' '.join(bits)}."


async def move_to_folder(
    account_id: str, message_ids: list[str], folder: str
) -> str:
    """Move one or more messages to a folder/mailbox (e.g. 'Archive', a custom
    folder). Creates nothing — the folder must exist (see create_label)."""
    # Move all messages concurrently instead of one serial round-trip each.
    results = await asyncio.gather(
        *(_patch(f"/email/messages/{mid}", {"folder": folder}) for mid in message_ids),
        return_exceptions=True,
    )
    n = sum(1 for r in results if not isinstance(r, BaseException))
    failed = len(message_ids) - n
    note = f" ({failed} failed)" if failed else ""
    return f"Moved {n} message(s) to '{folder}'{note}."


async def list_labels(account_id: str) -> str:
    """List the user-applicable label/folder names on the account."""
    labels = await _get(f"/email/accounts/{account_id}/labels")
    if not labels:
        return "No user labels on this account yet."
    # Labels are {name, color} dicts; surface just the names.
    names = [
        (lbl.get("name") if isinstance(lbl, dict) else lbl) for lbl in labels
    ]
    return "Labels: " + ", ".join(n for n in names if n)


async def create_label(account_id: str, name: str) -> str:
    """Create (or reuse) a label/folder on the account."""
    res = await _post(f"/email/accounts/{account_id}/folders", {"name": name})
    return f"Label/folder ready: {res.get('name', name)}."


def _attachment_refs(attachments: list[str] | None) -> list[dict[str, Any]]:
    """Parse attachment specs into workspace-artifact refs for /email/send.

    Each spec is either ``"outputs/file.pdf"`` (a file in the email assistant's
    own workspace — e.g. one you created with write_artifact) or
    ``"<agent>:outputs/file.pdf"`` (a file produced by another agent, e.g.
    ``"sales-assistant:outputs/quote.pdf"``)."""
    refs: list[dict[str, Any]] = []
    for item in attachments or []:
        s = (item or "").strip()
        if not s:
            continue
        head = s.split(":", 1)[0]
        if ":" in s and "/" not in head and "\\" not in head:
            agent, path = s.split(":", 1)
            refs.append({"agent": agent.strip(), "path": path.strip()})
        else:
            refs.append({"path": s})
    return refs


async def send_email(
    account_id: str,
    to: list[str],
    subject: str,
    body: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    reply_to_email_id: str | None = None,
    attachments: list[str] | None = None,
) -> str:
    """Send an email immediately. Outward-facing — ALWAYS confirm the recipients
    and body with the user before calling this.

    Args:
        to: recipient address(es).
        subject: subject line.
        body: plain-text body.
        cc / bcc: optional carbon-copy recipients.
        reply_to_email_id: local id of a message this is a reply to (threads it).
        attachments: workspace artifact paths to attach. Each is either
            ``"outputs/file.pdf"`` (a file you made with write_artifact) or
            ``"<agent>:outputs/file.pdf"`` for a sub-agent's file (e.g.
            ``"sales-assistant:outputs/quote.pdf"``). Use list_artifacts to see
            what's available; write_artifact to create one first.
    """
    payload: dict[str, Any] = {
        "account_id": account_id,
        "to": to,
        "subject": subject,
        "body_text": body,
    }
    if cc:
        payload["cc"] = cc
    if bcc:
        payload["bcc"] = bcc
    if reply_to_email_id:
        payload["reply_to_message_id"] = reply_to_email_id
    refs = _attachment_refs(attachments)
    if refs:
        payload["artifacts"] = refs
    # Confirm-before-send: park on a HITL card so the user approves the actual
    # send (outward-facing + irreversible). Degrades to send when there's no
    # interactive stream to deliver the card (automated callers).
    from acb_skills.ask_tools import request_confirmation  # noqa: PLC0415
    _cc_note = f", cc {', '.join(cc)}" if cc else ""
    if not await request_confirmation(
        title="Send this email?",
        detail=f"To {', '.join(to)}{_cc_note} · Subject: {subject or '(none)'}",
        context=body,
    ):
        return "Send cancelled — the email was not sent."
    res = await _post("/email/send", payload)
    note = f" with {len(refs)} attachment(s)" if refs else ""
    return f"Sent email to {', '.join(to)}{note} (id={res.get('id', '')})."


async def send_reply(
    account_id: str,
    email_id: str,
    body: str,
    cc: list[str] | None = None,
    attachments: list[str] | None = None,
) -> str:
    """Reply to an email — derives the recipient + 'Re:' subject from the
    original message and sends it threaded. ALWAYS confirm the body with the user
    first. (To leave it in Drafts instead of sending, use draft_reply.)

    ``attachments`` works exactly like send_email's (workspace artifact paths,
    optionally ``"<agent>:<path>"`` for a sub-agent's file)."""
    orig = await _get(f"/email/messages/{email_id}")
    frm = orig.get("from_address", {}) or {}
    to_addr = frm.get("email", "")
    if not to_addr:
        return "Couldn't resolve the original sender to reply to."
    subj = orig.get("subject", "") or ""
    if not subj.lower().startswith("re:"):
        subj = f"Re: {subj}"
    payload: dict[str, Any] = {
        "account_id": account_id,
        "to": [to_addr],
        "subject": subj,
        "body_text": body,
        "reply_to_message_id": email_id,
    }
    if cc:
        payload["cc"] = cc
    refs = _attachment_refs(attachments)
    if refs:
        payload["artifacts"] = refs
    # Confirm-before-send (see send_email): park on a HITL card before the
    # reply actually goes out.
    from acb_skills.ask_tools import request_confirmation  # noqa: PLC0415
    _cc_note = f", cc {', '.join(cc)}" if cc else ""
    if not await request_confirmation(
        title="Send this reply?",
        detail=f"To {to_addr}{_cc_note} · Subject: {subj}",
        context=body,
    ):
        return "Send cancelled — the reply was not sent."
    res = await _post("/email/send", payload)
    note = f" with {len(refs)} attachment(s)" if refs else ""
    return f"Replied to {to_addr}{note} (id={res.get('id', '')})."


# ── Attachments / artifacts ──────────────────────────────────────────────────

async def list_artifacts(agent_name: str = "email-assistant") -> str:
    """List files available to attach to emails. Defaults to your own workspace;
    pass another agent (e.g. 'sales-assistant', 'task-manager') to see files a
    sub-agent produced. Attach them with the path shown — for another agent's
    file use '<agent_name>:<path>', or import_artifact to copy it into your
    workspace first. Create new files with write_artifact."""
    data = await _get("/agent/artifacts", {"agent": agent_name})
    arts = [a for a in data.get("artifacts", []) if not a.get("is_dir")]
    if not arts:
        return f"No files in {agent_name}'s workspace yet."
    own = agent_name == "email-assistant"
    lines = [f"Files in {agent_name}'s workspace:"]
    for a in arts[:30]:
        p = a.get("path")
        spec = p if own else f"{agent_name}:{p}"
        size = a.get("size", 0)
        lines.append(f"• {spec}  ({size} bytes, {a.get('mime_type', '')})")
    lines.append("Attach any of these by passing its path in `attachments`.")
    return "\n".join(lines)


async def import_artifact(
    source_agent: str, source_path: str, name: str | None = None
) -> str:
    """Pull a file a sub-agent produced (e.g. a quote PDF from sales-assistant,
    a report from task-manager) into your own workspace so you can attach it to
    an email and the user can browse/download it. Returns the new path to pass
    in `attachments`. You can also attach a sub-agent file directly without
    importing by using '<agent>:<path>' in `attachments`."""
    res = await _post("/email/artifacts/import", {
        "source_agent": source_agent,
        "source_path": source_path,
        "name": name,
    })
    return (
        f"Imported to '{res.get('path')}' — attach it by passing that path in "
        "`attachments`."
    )


async def send_draft(account_id: str, draft_id: str) -> str:
    """Send an existing draft natively (Drafts → Sent, no duplicate). Shows a
    confirmation card before sending."""
    from acb_skills.ask_tools import request_confirmation  # noqa: PLC0415
    if not await request_confirmation(
        title="Send this draft?",
        detail="Send the saved draft now? (Drafts → Sent)",
    ):
        return "Send cancelled — the draft was not sent."
    await _post(
        "/email/drafts/send",
        {"account_id": account_id, "draft_id": draft_id},
    )
    return "Draft sent."


# ── Knowledge base (edit/remove) ─────────────────────────────────────────────

async def update_knowledge(
    account_id: str,
    knowledge_id: str,
    title: str | None = None,
    content: str | None = None,
) -> str:
    """Edit a knowledge-base entry by id. Only the fields you pass change."""
    entries = (await _get(
        "/email/knowledge", {"account_id": account_id}
    )).get("entries", [])
    entry = next((e for e in entries if e.get("id") == knowledge_id), None)
    if not entry:
        return f"Knowledge entry {knowledge_id} not found."
    body = dict(entry)
    body["account_id"] = account_id
    if title is not None:
        body["title"] = title
    if content is not None:
        body["content"] = content
    await _patch(f"/email/knowledge/{knowledge_id}", body)
    return f"Updated knowledge entry '{body.get('title')}'."


async def delete_knowledge(account_id: str, knowledge_id: str) -> str:
    """Delete a knowledge-base entry by id."""
    await _delete(f"/email/knowledge/{knowledge_id}")
    return f"Deleted knowledge entry {knowledge_id}."


# ── Unsubscribe / cold senders ───────────────────────────────────────────────

async def unsubscribe_sender(
    account_id: str,
    email: str,
    name: str | None = None,
    unsubscribe_link: str | None = None,
) -> str:
    """Actually unsubscribe from a sender and archive its existing mail.

    Performs a real server-side one-click unsubscribe (RFC 8058) for an https
    List-Unsubscribe target, or sends the unsubscribe email for a mailto: one.
    If there's no usable link or the request fails, the sender is blocked
    instead (future mail auto-archived via a provider filter). Use after
    suggest_unsubscribes once the user confirms."""
    res = await _post("/email/unsubscribe", {
        "account_id": account_id,
        "email": email,
        "name": name,
        "unsubscribe_link": unsubscribe_link,
    })
    archived = res.get("archived", 0)
    if res.get("ok"):
        verb = ("Sent an unsubscribe email for" if res.get("method") == "mailto"
                else "Unsubscribed from")
        return (f"{verb} {email}; archived {archived} existing message(s). "
                "The sender should stop emailing you.")
    return (
        f"Couldn't auto-unsubscribe from {email} (no one-click link), so I "
        f"blocked it instead — future mail is auto-archived and {archived} "
        "existing message(s) were archived."
    )


async def keep_newsletter(account_id: str, email: str) -> str:
    """Keep receiving a sender's mail (undo an unsubscribe / mark approved)."""
    await _post("/email/newsletters", {
        "account_id": account_id, "email": email, "status": "APPROVED",
    })
    return f"Keeping {email} — marked approved."


async def list_cold_senders(account_id: str) -> str:
    """List senders flagged by the cold-email blocker."""
    data = await _get("/email/cold-senders", {"account_id": account_id})
    senders = data.get("cold_senders", [])
    if not senders:
        return "No cold senders flagged."
    lines = ["Cold senders:"]
    for s in senders[:20]:
        lines.append(f"• {s.get('from_email')} [{s.get('status')}]")
    return "\n".join(lines)


async def set_cold_sender(
    account_id: str, from_email: str, is_cold: bool = True
) -> str:
    """Flag a sender as cold (is_cold=true) or clear the flag (is_cold=false,
    'this sender is NOT cold')."""
    status = "AI_LABELED_COLD" if is_cold else "USER_REJECTED_COLD"
    await _post("/email/cold-senders", {
        "account_id": account_id, "from_email": from_email, "status": status,
    })
    verb = "flagged as cold" if is_cold else "cleared (not cold)"
    return f"{from_email} {verb}."


# ── Reply Zero ───────────────────────────────────────────────────────────────

async def mark_thread_done(
    account_id: str, thread_id: str, done: bool = True
) -> str:
    """Mark a Reply-Zero thread done (handled) or reopen it (done=false)."""
    await _post("/email/reply-zero/resolve", {
        "account_id": account_id, "thread_id": thread_id, "done": done,
    })
    return f"Thread {'marked done' if done else 'reopened'}."


async def reclassify_reply_zero(account_id: str) -> str:
    """Rebuild Reply Zero (To Reply / Awaiting / FYI) with the current rules.
    Runs in the background; check find_needs_reply afterwards."""
    await _post("/email/reply-zero/reclassify", {"account_id": account_id})
    return "Reply Zero is reclassifying in the background."


# ── Rules history (approve / reject / undo) ──────────────────────────────────

async def list_rule_history(account_id: str, limit: int = 15) -> str:
    """List recent rule executions (what rules did to which mail), including
    PENDING items awaiting approval and APPLIED items you can undo."""
    data = await _get(
        "/email/rules/history", {"account_id": account_id, "limit": limit}
    )
    history = data.get("history", [])
    if not history:
        return "No rule history yet."
    lines = ["Recent rule activity:"]
    for h in history[:limit]:
        acts = ", ".join(h.get("actions", []))
        lines.append(
            f"• id={h.get('id')} [{h.get('status')}] {h.get('rule_name')}: "
            f"{(h.get('subject') or '')[:50]} → {acts}"
        )
    return "\n".join(lines)


async def approve_execution(execution_id: str) -> str:
    """Approve a PENDING rule execution so its actions are applied."""
    res = await _post(f"/email/rules/history/{execution_id}/approve", {})
    return f"Approved — applied: {', '.join(res.get('actions', []))}."


async def reject_execution(execution_id: str) -> str:
    """Reject a PENDING rule execution (its actions are NOT applied)."""
    await _post(f"/email/rules/history/{execution_id}/reject", {})
    return "Rejected — no actions taken."


async def undo_execution(execution_id: str) -> str:
    """Undo an already-APPLIED rule execution (reverses its actions)."""
    res = await _post(f"/email/rules/history/{execution_id}/undo", {})
    return f"Undone: reversed {', '.join(res.get('reversed', []))}."


# ── Digest ───────────────────────────────────────────────────────────────────

async def get_digest(account_id: str, period: str = "day") -> str:
    """Preview the inbox digest for 'day' or 'week' (counts + highlights)."""
    data = await _get(
        "/email/digest", {"account_id": account_id, "period": period}
    )
    sections = data.get("sections", data)
    return f"Digest ({period}): {json.dumps(sections, default=str)[:1500]}"


async def send_digest(account_id: str, period: str = "day") -> str:
    """Send the inbox digest email now for 'day' or 'week'."""
    res = await _post(
        "/email/digest/send", {"account_id": account_id, "period": period}
    )
    return f"Digest sent to {res.get('to', 'your inbox')}."


# ── Account sync ─────────────────────────────────────────────────────────────

async def sync_account(account_id: str) -> str:
    """Pull new mail for the account from the provider now (incremental)."""
    await _post("/email/sync", {"account_id": account_id})
    return "Sync started — new mail will appear shortly."


async def resync_account(account_id: str, purge: bool = False) -> str:
    """Force a COMPLETE re-sync from the provider. purge=true deletes local mail
    first (for stale/corrupt local data). Confirm purge with the user."""
    res = await _post(
        f"/email/accounts/{account_id}/resync?purge="
        f"{'true' if purge else 'false'}", {},
    )
    n = res.get("messages_synced")
    return f"Re-synced{' (purged)' if purge else ''}: {n} message(s)."


# ── Learned draft patterns ───────────────────────────────────────────────────

async def list_learned_patterns(account_id: str) -> str:
    """List preferences the assistant learned from how you edit its drafts."""
    data = await _get(
        "/email/learned-patterns", {"account_id": account_id}
    )
    patterns = data.get("patterns", [])
    if not patterns:
        return "No learned draft patterns yet."
    lines = ["Learned draft preferences:"]
    for p in patterns[:20]:
        scope = p.get("scope_value") or p.get("scope_type") or "global"
        lines.append(f"• id={p.get('id')} [{scope}] {p.get('pattern')}")
    return "\n".join(lines)


async def delete_learned_pattern(pattern_id: str) -> str:
    """Forget a learned draft preference by id."""
    await _delete(f"/email/learned-patterns/{pattern_id}")
    return f"Forgot learned pattern {pattern_id}."


async def get_full_body_email(email_id: str) -> str:
    """Fetch the COMPLETE, untruncated body of an email straight from the
    provider. Use this when read_email shows a cut-off body (long emails are
    capped in local storage) and you need the full text to summarize, answer a
    detailed question, or draft an accurate reply."""
    e = await _get(f"/email/messages/{email_id}/full-body")
    body = (e.get("body_text") or "").strip()
    if not body:
        html = (e.get("body_html") or "").strip()
        body = re.sub(r"<[^>]+>", " ", html) if html else ""
    if not body:
        return "(The provider returned an empty body for this email.)"
    return (
        f"Subject: {e.get('subject', '(no subject)')}\n"
        f"From: {e.get('from', '')}\n---\n{body[:12000]}"
    )


async def list_senders(
    account_id: str | None = None, folder: str = "inbox", limit: int = 25
) -> str:
    """Who emails you the most — aggregate the inbox by sender (volume, unread
    count, and whether a one-click unsubscribe is available). Use for "who are
    my top senders?", high-volume triage, or finding newsletters to cut."""
    params: dict[str, Any] = {
        "folder": folder, "limit": str(max(1, min(limit, 200))),
    }
    if account_id:
        params["account_id"] = account_id
    data = await _get("/email/senders", params)
    senders = data.get("senders", []) if isinstance(data, dict) else (data or [])
    if not senders:
        return "No senders found."
    lines = ["Top senders by volume:"]
    for s in senders[:limit]:
        rr = s.get("read_rate")
        rr_str = f", {round((rr or 0) * 100)}% read" if rr is not None else ""
        unsub = " [has unsubscribe]" if s.get("unsubscribe_link") else ""
        lines.append(
            f"• {s.get('name') or s.get('email')} <{s.get('email')}> — "
            f"{s.get('count', 0)} emails, {s.get('unread', 0)} unread"
            f"{rr_str}{unsub}"
        )
    return "\n".join(lines)


async def create_rules_from_prompt(account_id: str, prompt: str) -> str:
    """Create automation rule(s) from a PLAIN-ENGLISH description (inbox-zero's
    natural-language rule flow) — e.g. "Label anything from my bank as Finance
    and archive it", or describe several rules at once. The AI turns the
    description into structured rules and creates them. Confirm the description
    with the user first; afterwards summarize what was created. For precise
    single-rule control (specific conditions/actions), prefer create_rule."""
    res = await _post(
        "/email/rules/generate", {"account_id": account_id, "prompt": prompt}
    )
    created = res.get("created", []) or []
    if not created:
        return (
            "Couldn't turn that into a rule: "
            f"{res.get('error', 'try rephrasing the description.')}"
        )
    names = ", ".join(f"'{c.get('name', '?')}' (id={c.get('id')})" for c in created)
    return f"Created {len(created)} rule(s): {names}."


async def test_rule_match(
    account_id: str,
    email_id: str | None = None,
    subject: str | None = None,
    from_email: str | None = None,
    body: str | None = None,
) -> str:
    """Preview which automation rule WOULD match an email, without applying
    anything. Pass an `email_id`, or a pasted sample (`subject` / `from_email` /
    `body`). Use to debug why mail is (or isn't) being labelled/handled as
    expected before tweaking a rule with update_rule / learn_rule_pattern."""
    payload: dict[str, Any] = {"account_id": account_id}
    if email_id:
        payload["email_id"] = email_id
    if subject:
        payload["subject"] = subject
    if from_email:
        payload["from_email"] = from_email
    if body:
        payload["body"] = body
    res = await _post("/email/rules/test", payload)
    if not res.get("matched"):
        return res.get("reason") or "No rule matched this email."
    rule = res.get("rule", {}) or {}
    actions = ", ".join(
        a.get("type", "") + (f":{a['label']}" if a.get("label") else "")
        for a in res.get("actions", [])
    )
    return (
        f"Matched rule '{rule.get('name')}' (id={rule.get('id')}): "
        f"{res.get('reason', '')} → {actions or '(no actions)'}"
    )


# ── Tool registry ────────────────────────────────────────────────────────────

# Tools attached to the MAF agent. call_agent / remember / save_memory /
# web_search are injected by the executor, so the agent can hand off to the
# sales / task-manager agents and read memory without listing them here.
_TOOLS = [
    # Read / triage
    list_accounts,
    search_emails,
    query_inbox,
    get_important_emails,
    read_email,
    get_full_body_email,
    find_urgent,
    find_needs_reply,
    get_unread_count,
    get_account_overview,
    # Inbox actions
    manage_inbox,
    apply_labels,
    move_to_folder,
    list_labels,
    create_label,
    # Drafting / sending
    draft_reply,
    send_email,
    send_reply,
    send_draft,
    # Attachments / artifacts
    list_artifacts,
    import_artifact,
    # Senders / categorization
    categorize_senders,
    get_sender_categories,
    list_senders,
    # Rules + history
    get_rules_and_settings,
    create_rule,
    create_rules_from_prompt,
    update_rule,
    update_rule_state,
    delete_rule,
    reset_rules,
    run_rules_now,
    test_rule_match,
    learn_rule_pattern,
    install_default_rules,
    list_rule_history,
    approve_execution,
    reject_execution,
    undo_execution,
    process_past_emails,
    # Assistant config
    update_assistant_settings,
    list_knowledge,
    add_knowledge,
    update_knowledge,
    delete_knowledge,
    generate_writing_style,
    list_learned_patterns,
    delete_learned_pattern,
    # Follow-ups / reply zero
    find_follow_ups,
    mark_thread_done,
    reclassify_reply_zero,
    # Unsubscribe / cold senders
    suggest_unsubscribes,
    unsubscribe_sender,
    keep_newsletter,
    list_cold_senders,
    set_cold_sender,
    # Digest
    get_digest,
    send_digest,
    # Account sync
    sync_account,
    resync_account,
]


def _register_agent_tools() -> dict[str, Any]:
    """Tool map for the gateway's direct quick-action calls (importlib path)."""
    return {fn.__name__: fn for fn in _TOOLS}


# ── MAF agent factory (Dynamic Agent Loader entry point) ─────────────────────

def _llm_provider() -> dict[str, Any]:
    """BYOK provider config pointing at the gateway's /v1 (litellm SDK).

    Prefer the gateway's real key from Settings (``litellm_master_key``) over a
    bare ``sk-local`` fallback — an unauthenticated /v1 call makes the Copilot
    SDK drop to a NATIVE Copilot session (402). The executor also re-applies this
    provider for Copilot-SDK agents, but keep it correct here for any path that
    doesn't (e.g. direct quick-action tool calls)."""
    settings = get_settings()
    base_url = (
        os.environ.get("LITELLM_BASE_URL", "")
        or getattr(settings, "litellm_base_url", "")
        or "http://127.0.0.1:8080"
    ).rstrip("/")
    api_key = (
        os.environ.get("LITELLM_MASTER_KEY", "")
        or getattr(settings, "litellm_master_key", "")
        or "sk-local"
    )
    return {"type": "openai", "base_url": f"{base_url}/v1", "api_key": api_key}


def build_agents() -> list[Any]:
    """Construct the Email Assistant as a NATIVE MAF agent backed by the LiteLLM
    gateway.

    A pure tool+instructions assistant doesn't need the GitHub Copilot SDK's
    shell/file/git/session machinery (that's for coding agents). So we use
    agent_framework's native ``Agent`` with an OpenAI-compatible client pointed
    at the gateway's ``/v1``. The gateway resolves the ``tier-balanced`` alias to
    the configured provider model (DeepSeek), so the agent always runs on the
    chosen LiteLLM tier — never native GitHub Copilot. Imported lazily so the
    module still loads where the optional deps differ.

    Use ``OpenAIChatCompletionClient`` (the Chat Completions client), NOT
    ``OpenAIChatClient`` — the latter targets OpenAI's *Responses* API
    (``client.responses.create`` → ``POST /v1/responses``), which the gateway's
    ``v1_compat`` shim does not implement, so it 404s with
    ``{'detail': 'Not Found'}``. The gateway only serves ``/v1/chat/completions``
    (same client the orchestrator MAF agent uses)."""
    from agent_framework import Agent  # noqa: PLC0415
    from agent_framework.openai import OpenAIChatCompletionClient  # noqa: PLC0415

    prov = _llm_provider()  # {type, base_url=…/v1, api_key=gateway master key}
    client = OpenAIChatCompletionClient(
        model=os.environ.get("EMAIL_AGENT_MODEL", "tier-balanced"),
        api_key=prov["api_key"],
        base_url=prov["base_url"],
    )
    return [
        Agent(
            client=client,
            instructions=INSTRUCTIONS,
            name="email-assistant",
            description=(
                "Reads, triages, categorizes, automates, and drafts email; "
                "manages rules, follow-ups, and the knowledge base."
            ),
            tools=list(_TOOLS),
        )
    ]


__all__ = ["build_agents", "INSTRUCTIONS", "_register_agent_tools"]
