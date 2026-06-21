"""Email Assistant Agent.

An AI-powered email management agent that helps users read, search, summarize,
and draft replies across connected Gmail and Microsoft email accounts.

Registered as a MAF agent at /agent/run/stream with name "email-assistant".
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from acb_common import get_logger, get_settings

_log = get_logger("agent.email_assistant")

_INSTRUCTIONS_FILE = Path(__file__).parent / "instructions.md"
INSTRUCTIONS = (
    _INSTRUCTIONS_FILE.read_text(encoding="utf-8")
    if _INSTRUCTIONS_FILE.exists()
    else "You are the Email Assistant. Help the user check, categorize, and "
    "reply to their email using the provided tools."
)


async def search_emails(
    query: str,
    folder: str = "INBOX",
    account_id: str | None = None,
) -> str:
    """Search emails across connected accounts.

    Args:
        query: Search query (matches subject, body, sender)
        folder: Folder to search (INBOX, SENT, DRAFTS, etc.)
        account_id: Optional specific account to search

    Returns:
        JSON list of matching emails with id, subject, sender, snippet, date
    """
    settings = get_settings()
    gateway_url = os.environ.get(
        "GATEWAY_URL", "http://localhost:8080"
    ).rstrip("/")

    import httpx
    params: dict[str, str] = {"query": query, "folder": folder}
    if account_id:
        params["account_id"] = account_id

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{gateway_url}/email/messages",
            params=params,
            headers={"Authorization": f"Bearer {settings.gateway_internal_token}"},
        )
        resp.raise_for_status()
        data = resp.json()

    emails = data.get("emails", [])
    total = data.get("total", 0)

    summary = [f"Found {total} emails matching '{query}' in {folder}:"]
    for e in emails[:10]:
        sender = e.get("from_address", {}).get("name", "Unknown")
        subject = e.get("subject", "(no subject)")
        snippet = (e.get("snippet", "") or "")[:100]
        summary.append(f"• {sender}: {subject} — {snippet}")

    if total > 10:
        summary.append(f"... and {total - 10} more")

    return "\n".join(summary)


async def get_email(email_id: str) -> str:
    """Fetch the full content of a specific email.

    Args:
        email_id: The email's unique ID

    Returns:
        Full email content with headers and body
    """
    settings = get_settings()
    gateway_url = os.environ.get(
        "GATEWAY_URL", "http://localhost:8080"
    ).rstrip("/")

    import httpx
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{gateway_url}/email/messages/{email_id}",
            headers={"Authorization": f"Bearer {settings.gateway_internal_token}"},
        )
        resp.raise_for_status()
        email = resp.json()

    sender = email.get("from_address", {}).get("name", "Unknown")
    sender_email = email.get("from_address", {}).get("email", "")
    subject = email.get("subject", "(no subject)")
    body = email.get("body_text", "")[:3000]

    return (
        f"From: {sender} <{sender_email}>\n"
        f"Subject: {subject}\n"
        f"---\n{body}"
    )


async def find_urgent(account_id: str | None = None) -> str:
    """Find emails that need urgent attention.

    Args:
        account_id: Optional specific account to check

    Returns:
        Ranked list of urgent emails
    """
    settings = get_settings()
    gateway_url = os.environ.get(
        "GATEWAY_URL", "http://localhost:8080"
    ).rstrip("/")

    import httpx
    # Search for emails with urgent/important signals
    urgent_keywords = "urgent OR deadline OR ASAP OR action required OR by Friday OR by EOD"
    params: dict[str, str] = {"query": urgent_keywords, "page_size": "20"}
    if account_id:
        params["account_id"] = account_id

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{gateway_url}/email/messages",
            params=params,
            headers={"Authorization": f"Bearer {settings.gateway_internal_token}"},
        )
        resp.raise_for_status()
        data = resp.json()

    emails = data.get("emails", [])
    if not emails:
        return "No urgent emails found. Your inbox looks clear! 🎉"

    lines = ["🔴 **Urgent / Needs Attention**\n"]
    for e in emails[:10]:
        sender = e.get("from_address", {}).get("name", "Unknown")
        subject = e.get("subject", "(no subject)")
        snippet = (e.get("snippet", "") or "")[:120]
        lines.append(f"— **{sender}**: {subject}")
        lines.append(f"  {snippet}\n")

    return "\n".join(lines)


async def draft_reply(
    email_id: str,
    tone: str = "professional",
    instructions: str = "",
) -> str:
    """Generate a professional reply draft for an email.

    Args:
        email_id: The email to reply to
        tone: 'formal', 'casual', 'concise', or 'detailed'
        instructions: Any specific points to include in the reply

    Returns:
        Draft reply text
    """
    # Fetch the email first
    email_content = await get_email(email_id)

    # Build a simple reply template (in production, this would use the LLM)
    tone_guidance = {
        "formal": "Use formal language. Keep it professional and respectful.",
        "casual": "Use casual, friendly language. Keep it conversational.",
        "concise": "Be brief and to the point. Max 3-4 sentences.",
        "detailed": "Be thorough. Address all points raised in the original email.",
    }.get(tone, "Be professional and concise.")

    reply = (
        f"Here's a draft reply ({tone} tone):\n\n"
        f"---\n"
        f"Hi [Name],\n\n"
        f"Thank you for your email. "
        f"[I'll review this and get back to you / This looks good / I've noted the details].\n\n"
        f"{instructions}\n\n"
        f"Best regards,\n"
        f"[Your name]\n"
        f"---\n\n"
        f"Guidance: {tone_guidance}\n\n"
        f"Would you like me to adjust the tone or add specific details? "
        f"I have the full email content loaded for context."
    )

    return reply


async def suggest_unsubscribes(account_id: str | None = None) -> str:
    """Find newsletter subscriptions to consider unsubscribing from.

    Args:
        account_id: Optional specific account

    Returns:
        List of suggested unsubscribes
    """
    settings = get_settings()
    gateway_url = os.environ.get(
        "GATEWAY_URL", "http://localhost:8080"
    ).rstrip("/")

    import httpx
    # Search for newsletter-like emails
    params: dict[str, str] = {
        "query": "unsubscribe OR digest OR newsletter OR weekly",
        "page_size": "30",
    }
    if account_id:
        params["account_id"] = account_id

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{gateway_url}/email/messages",
            params=params,
            headers={"Authorization": f"Bearer {settings.gateway_internal_token}"},
        )
        resp.raise_for_status()
        data = resp.json()

    emails = data.get("emails", [])
    if not emails:
        return "No newsletter subscriptions detected. You're doing great!"

    lines = ["📬 **Newsletter / Subscription suggestions**\n"]
    for e in emails[:8]:
        sender = e.get("from_address", {}).get("name", "Unknown")
        subject = e.get("subject", "(no subject)")
        lines.append(f"• **{sender}** — {subject}")

    lines.append(
        "\nThese are based on common newsletter patterns in your inbox. "
        "I can help draft unsubscribe requests for any of these."
    )

    return "\n".join(lines)


async def get_unread_count(account_id: str | None = None) -> str:
    """Get unread email count for connected accounts.

    Args:
        account_id: Optional specific account

    Returns:
        Unread count summary
    """
    settings = get_settings()
    gateway_url = os.environ.get(
        "GATEWAY_URL", "http://localhost:8080"
    ).rstrip("/")

    import httpx
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{gateway_url}/email/accounts",
            headers={"Authorization": f"Bearer {settings.gateway_internal_token}"},
        )
        resp.raise_for_status()
        accounts = resp.json()

    if account_id:
        accounts = [a for a in accounts if a["id"] == account_id]

    total = sum(a.get("unread_count", 0) for a in accounts)
    lines = [f"📧 **{total} unread** across {len(accounts)} account(s):"]
    for a in accounts:
        lines.append(
            f"• {a['label']} ({a['email_address']}): "
            f"{a['unread_count']} unread"
        )

    return "\n".join(lines)


def _register_agent_tools() -> dict[str, Any]:
    """Return the tool definitions for this agent.

    Called by the orchestrator executor to inject email-specific tools.
    """
    return {
        "search_emails": search_emails,
        "get_email": get_email,
        "find_urgent": find_urgent,
        "draft_reply": draft_reply,
        "suggest_unsubscribes": suggest_unsubscribes,
        "get_unread_count": get_unread_count,
    }


# ---------------------------------------------------------------------------
# MAF agent factory — Dynamic Agent Loader entry point (build_agents)
# ---------------------------------------------------------------------------
#
# The loader requires agents.py to export build_agents() -> list[Agent].
# call_agent / memory / web_search are injected by the executor at run time,
# so this agent can hand off to the sales / task-manager agents and read the
# user's memory without listing those tools here.

_TOOLS = [
    search_emails,
    get_email,
    find_urgent,
    get_unread_count,
    suggest_unsubscribes,
]


def _llm_provider() -> dict[str, Any]:
    """BYOK provider config pointing at the gateway's /v1 (litellm SDK)."""
    base_url = os.environ.get("LITELLM_BASE_URL", "http://127.0.0.1:8080")
    api_key = os.environ.get("LITELLM_MASTER_KEY", "sk-local")
    return {"type": "openai", "base_url": f"{base_url}/v1", "api_key": api_key}


def build_agents() -> list[Any]:
    """Construct the Email Assistant MAF agent.

    Imported lazily so the module still loads (for the gateway's direct
    quick-action tool calls) even where the Copilot SDK isn't importable.
    """
    from agent_framework_github_copilot import GitHubCopilotAgent  # noqa: PLC0415
    from copilot.types import PermissionHandler  # noqa: PLC0415

    return [
        GitHubCopilotAgent(
            instructions=INSTRUCTIONS,
            tools=_TOOLS,
            default_options={
                "model": "tier-balanced",
                "provider": _llm_provider(),
                "mcp_servers": {},
                "on_permission_request": PermissionHandler.approve_all,
            },
        )
    ]


__all__ = ["build_agents", "INSTRUCTIONS", "_register_agent_tools"]
