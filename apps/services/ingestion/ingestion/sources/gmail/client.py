"""Async Gmail API client (WBS 1.3 scaffold).

Uses a Google Workspace service account with domain-wide delegation so we can
impersonate any mailbox in the domain. v1 only needs read access; we'll add
the `gmail.modify` scope when we wire up Push.

Env vars (loaded via acb_common.settings, see additions to settings.py):
  GMAIL_SA_JSON_PATH        path to the service-account key JSON
  GMAIL_WORKSPACE_DOMAIN    e.g. fracktal.in
  GMAIL_DEFAULT_USER        mailbox to impersonate when none specified

The real google-api-python-client dependency is intentionally NOT imported at
module top-level so the scaffold ships green; callers must `pip install
google-api-python-client google-auth` before the first live call.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

from acb_common import get_logger, get_settings

_log = get_logger("ingestion.gmail")

_SCOPES = (
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.metadata",
)


@dataclass
class GmailMessageRaw:
    """Lightweight projection of a single Gmail API message resource."""

    id: str
    thread_id: str
    label_ids: list[str]
    snippet: str
    payload: dict[str, Any]
    internal_date_ms: int


def _decode_b64url(data: str) -> str:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding).decode("utf-8", errors="replace")


def _extract_body(payload: dict[str, Any]) -> str:
    """Walk the MIME tree and return the best-effort plain-text body."""
    if (body := payload.get("body")) and body.get("data"):
        return _decode_b64url(body["data"])
    for part in payload.get("parts") or []:
        mime = part.get("mimeType") or ""
        if mime == "text/plain" and part.get("body", {}).get("data"):
            return _decode_b64url(part["body"]["data"])
    # second pass: text/html as fallback
    for part in payload.get("parts") or []:
        mime = part.get("mimeType") or ""
        if mime == "text/html" and part.get("body", {}).get("data"):
            return _decode_b64url(part["body"]["data"])
    return ""


def _header(payload: dict[str, Any], name: str) -> str:
    name_lc = name.lower()
    for h in payload.get("headers") or []:
        if (h.get("name") or "").lower() == name_lc:
            return h.get("value") or ""
    return ""


async def _service(user: str | None = None):  # pragma: no cover - live dep
    """Build an authenticated Gmail API service. Live-only."""
    from google.oauth2 import service_account  # type: ignore[import-not-found]
    from googleapiclient.discovery import build  # type: ignore[import-not-found]

    s = get_settings()
    subject = user or s.gmail_default_user
    if not s.gmail_sa_json_path or not subject:
        raise RuntimeError("GMAIL_SA_JSON_PATH and a mailbox to impersonate are required")
    creds = service_account.Credentials.from_service_account_file(
        s.gmail_sa_json_path, scopes=list(_SCOPES)
    ).with_subject(subject)
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


async def fetch_message(message_id: str, *, user: str | None = None) -> GmailMessageRaw:  # pragma: no cover - live
    svc = await _service(user)
    msg = svc.users().messages().get(userId="me", id=message_id, format="full").execute()
    return GmailMessageRaw(
        id=msg["id"],
        thread_id=msg["threadId"],
        label_ids=msg.get("labelIds") or [],
        snippet=msg.get("snippet") or "",
        payload=msg.get("payload") or {},
        internal_date_ms=int(msg.get("internalDate") or 0),
    )


async def list_history(start_history_id: str, *, user: str | None = None) -> list[dict[str, Any]]:  # pragma: no cover - live
    """Page through users.history.list since a checkpoint and return raw items."""
    svc = await _service(user)
    out: list[dict[str, Any]] = []
    page_token: str | None = None
    while True:
        resp = svc.users().history().list(
            userId="me",
            startHistoryId=start_history_id,
            historyTypes=["messageAdded"],
            pageToken=page_token,
        ).execute()
        out.extend(resp.get("history") or [])
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return out


__all__ = ["GmailMessageRaw", "_decode_b64url", "_extract_body", "_header", "fetch_message", "list_history"]
