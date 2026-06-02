"""Async Microsoft Graph API client for Outlook/Exchange Online (WBS 1.3).

Uses OAuth 2.0 client-credentials (app-only auth).  An Entra ID application
with Mail.Read + Mail.ReadBasic.All *application* permissions grants access to
every mailbox in the tenant without per-user interaction.

Env vars (loaded via acb_common.settings):
  OUTLOOK_CLIENT_ID       Azure app registration client ID
  OUTLOOK_CLIENT_SECRET   Azure app registration secret
  OUTLOOK_TENANT_ID       Entra ID / Azure AD tenant ID
  OUTLOOK_DEFAULT_USER    UPN of the mailbox to watch when none specified

The live httpx calls are guarded under ``# pragma: no cover - live dep`` so
unit tests run without real credentials.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from acb_common import get_logger, get_settings

_log = get_logger("ingestion.outlook")

_TOKEN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
_GRAPH_BASE = "https://graph.microsoft.com/v1.0"
_SCOPES = "https://graph.microsoft.com/.default"


@dataclass
class OutlookMessageRaw:
    """Lightweight projection of a single Graph API message resource."""

    id: str
    conversation_id: str                    # Graph conversationId — equivalent to thread_id
    subject: str
    body_preview: str                       # Graph bodyPreview — short snippet
    body_content: str                       # Graph body.content (text or HTML)
    body_content_type: str                  # "text" | "html"
    sender: dict[str, Any]                  # {"emailAddress": {"address": ..., "name": ...}}
    to_recipients: list[dict[str, Any]]
    cc_recipients: list[dict[str, Any]]
    received_at: str                        # ISO-8601 string from Graph
    internet_message_headers: list[dict[str, Any]] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)


def _extract_email(addr_block: dict[str, Any]) -> str:
    """Pull address out of {"emailAddress": {"address": ..., "name": ...}}."""
    ea = addr_block.get("emailAddress") or {}
    return (ea.get("address") or "").strip().lower()


def _extract_name(addr_block: dict[str, Any]) -> str:
    ea = addr_block.get("emailAddress") or {}
    return (ea.get("name") or "").strip()


def _extract_addresses(recipients: list[dict[str, Any]]) -> list[str]:
    return [a for r in recipients if (a := _extract_email(r))]


def _to_raw(m: dict[str, Any]) -> OutlookMessageRaw:
    """Project a Graph API message dict into OutlookMessageRaw."""
    body = m.get("body") or {}
    return OutlookMessageRaw(
        id=m.get("id") or "",
        conversation_id=m.get("conversationId") or "",
        subject=m.get("subject") or "",
        body_preview=m.get("bodyPreview") or "",
        body_content=body.get("content") or "",
        body_content_type=body.get("contentType") or "text",
        sender=m.get("sender") or {},
        to_recipients=m.get("toRecipients") or [],
        cc_recipients=m.get("ccRecipients") or [],
        received_at=m.get("receivedDateTime") or "",
        internet_message_headers=m.get("internetMessageHeaders") or [],
        categories=m.get("categories") or [],
    )


async def _get_access_token() -> str:  # pragma: no cover - live dep
    """Acquire a client-credentials bearer token from Entra ID."""
    s = get_settings()
    if not s.outlook_client_id or not s.outlook_client_secret or not s.outlook_tenant_id:
        raise RuntimeError("OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET / OUTLOOK_TENANT_ID not configured")
    url = _TOKEN_URL.format(tenant=s.outlook_tenant_id)
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            url,
            data={
                "client_id": s.outlook_client_id,
                "client_secret": s.outlook_client_secret,
                "scope": _SCOPES,
                "grant_type": "client_credentials",
            },
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


async def list_messages(
    user: str | None = None,
    *,
    top: int = 50,
    filter_expr: str | None = None,
) -> list[OutlookMessageRaw]:  # pragma: no cover - live dep
    """Fetch recent messages for a mailbox via the Graph API."""
    s = get_settings()
    upn = user or s.outlook_default_user
    if not upn:
        raise RuntimeError("No Outlook user specified and OUTLOOK_DEFAULT_USER not set")
    token = await _get_access_token()
    url = f"{_GRAPH_BASE}/users/{upn}/messages"
    params: dict[str, Any] = {
        "$top": top,
        "$select": (
            "id,conversationId,subject,bodyPreview,body,"
            "sender,toRecipients,ccRecipients,receivedDateTime,"
            "internetMessageHeaders,categories"
        ),
    }
    if filter_expr:
        params["$filter"] = filter_expr
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            url, params=params, headers={"Authorization": f"Bearer {token}"}
        )
        resp.raise_for_status()
    return [_to_raw(m) for m in resp.json().get("value") or []]


__all__ = [
    "OutlookMessageRaw",
    "_extract_email",
    "_extract_name",
    "_extract_addresses",
    "_to_raw",
]


__all__ = ["GmailMessageRaw", "_decode_b64url", "_extract_body", "_header", "fetch_message", "list_history"]
