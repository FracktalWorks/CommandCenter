"""Email Assistant Agent.

A MAF agent that checks the inbox, categorizes mail, manages automation rules,
takes inbox actions, and drafts context-aware replies — handing off to the
sales / task-manager agents and reading memory when an email needs their
context. Modeled on inbox-zero's (elie222/inbox-zero) assistant tool surface.

Registered as a MAF agent (name "email-assistant"); build_agents() is the
Dynamic Agent Loader entry point.
"""

from __future__ import annotations

import os
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


async def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{_gateway_url()}{path}", params=params or {}, headers=_headers()
        )
        resp.raise_for_status()
        return resp.json()


async def _post(path: str, body: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{_gateway_url()}{path}", json=body, headers=_headers()
        )
        resp.raise_for_status()
        return resp.json()


async def _patch(path: str, body: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.patch(
            f"{_gateway_url()}{path}", json=body, headers=_headers()
        )
        resp.raise_for_status()
        return resp.json()


# ── Read / triage tools ──────────────────────────────────────────────────────

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
    lines = [f"Found {total} emails matching '{query}' in {folder}:"]
    for e in emails[:10]:
        frm = e.get("from_address", {}) or {}
        lines.append(
            f"• id={e.get('id')} | {frm.get('name') or frm.get('email')}: "
            f"{e.get('subject', '(no subject)')} — {(e.get('snippet') or '')[:90]}"
        )
    if total > 10:
        lines.append(f"… and {total - 10} more")
    return "\n".join(lines)


async def read_email(email_id: str) -> str:
    """Fetch the full content of one email by id."""
    e = await _get(f"/email/messages/{email_id}")
    frm = e.get("from_address", {}) or {}
    return (
        f"From: {frm.get('name')} <{frm.get('email')}>\n"
        f"Subject: {e.get('subject', '(no subject)')}\n"
        f"Date: {e.get('received_at', '')}\n---\n"
        f"{(e.get('body_text') or '')[:4000]}"
    )


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
    lines = ["Urgent / needs attention:"]
    for e in emails[:10]:
        frm = e.get("from_address", {}) or {}
        lines.append(
            f"• id={e.get('id')} | {frm.get('name') or frm.get('email')}: "
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
    instructions: str,
    action_type: str,
    label: str | None = None,
    automated: bool = True,
) -> str:
    """Create an automation rule.

    Args:
        name: short rule name.
        instructions: plain-English condition the AI matches mail against.
        action_type: ARCHIVE | LABEL | MARK_READ | STAR | MARK_SPAM | TRASH |
                     DRAFT_EMAIL | REPLY | FORWARD.
        label: label/folder name for LABEL/MOVE_FOLDER actions.
        automated: true = apply automatically; false = propose for approval.
    """
    action: dict[str, Any] = {"type": action_type}
    if label:
        action["label"] = label
    rule = {
        "account_id": account_id,
        "name": name,
        "instructions": instructions,
        "enabled": True,
        "automated": automated,
        "run_on_threads": False,
        "conditional_operator": "OR",
        "sort_order": 0,
        "actions": [action],
    }
    res = await _post("/email/rules", rule)
    return f"Created rule '{name}' (id={res.get('id')})."


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
    follow_up_awaiting_days: int | None = None,
    follow_up_needs_reply_days: int | None = None,
    follow_up_auto_draft: bool | None = None,
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
        follow_up_awaiting_days: remind/label when THEY haven't replied after N
            days (0 disables). Pairs with find_follow_ups.
        follow_up_needs_reply_days: remind/label when YOU haven't replied after N
            days (0 disables).
        follow_up_auto_draft: when on, follow-up scans also draft a nudge.
    """
    # Start from the current settings so a PUT preserves EVERY field this tool
    # doesn't explicitly change (digest config, draft_confidence, follow-up
    # windows, multi-rule, sensitive-data protection, …).
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
    setif("follow_up_awaiting_days", follow_up_awaiting_days)
    setif("follow_up_needs_reply_days", follow_up_needs_reply_days)
    setif("follow_up_auto_draft", follow_up_auto_draft)
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
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.put(
            f"{_gateway_url()}/email/assistant/settings",
            json=body, headers=_headers(),
        )
        resp.raise_for_status()
        return resp.json()


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


# ── Tool registry ────────────────────────────────────────────────────────────

# Tools attached to the MAF agent. call_agent / remember / save_memory /
# web_search are injected by the executor, so the agent can hand off to the
# sales / task-manager agents and read memory without listing them here.
_TOOLS = [
    list_accounts,
    search_emails,
    read_email,
    find_urgent,
    find_needs_reply,
    get_unread_count,
    get_account_overview,
    manage_inbox,
    draft_reply,
    categorize_senders,
    get_sender_categories,
    get_rules_and_settings,
    create_rule,
    update_rule_state,
    update_rule,
    learn_rule_pattern,
    update_assistant_settings,
    install_default_rules,
    list_knowledge,
    add_knowledge,
    generate_writing_style,
    find_follow_ups,
    process_past_emails,
    suggest_unsubscribes,
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
    module still loads where the optional deps differ."""
    from agent_framework import Agent  # noqa: PLC0415
    from agent_framework.openai import OpenAIChatClient  # noqa: PLC0415

    prov = _llm_provider()  # {type, base_url=…/v1, api_key=gateway master key}
    client = OpenAIChatClient(
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
