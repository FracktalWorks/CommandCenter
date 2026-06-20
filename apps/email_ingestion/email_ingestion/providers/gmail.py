"""Gmail API provider.

Uses the Gmail REST API with OAuth 2.0 authentication.
Supports service accounts (domain-wide delegation) and standard OAuth.

API reference: https://developers.google.com/gmail/api/reference/rest
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from email.mime.text import MIMEText
from typing import Any

import httpx

from .base import (
    Attachment,
    BaseEmailProvider,
    EmailAddress,
    EmailFolder,
    EmailMessage,
    SyncResult,
    canonical_folder,
)

# Gmail label IDs → canonical folder keys.  A message can carry several labels;
# the first match (in this priority order) wins.
_GMAIL_LABEL_TO_FOLDER = [
    ("TRASH", "trash"),
    ("SPAM", "junk"),
    ("DRAFT", "drafts"),
    ("SENT", "sent"),
    ("INBOX", "inbox"),
]


def _gmail_folder_from_labels(label_ids: list[str]) -> str:
    labels = set(label_ids or [])
    for label, folder in _GMAIL_LABEL_TO_FOLDER:
        if label in labels:
            return folder
    return "inbox"


GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1"
GMAIL_SCOPES = ["https://mail.google.com/"]


class GmailProvider(BaseEmailProvider):
    """Gmail API email provider."""

    def __init__(self, credentials: dict[str, Any]):
        super().__init__(credentials)
        self._access_token: str | None = credentials.get("access_token")
        self._refresh_token: str | None = credentials.get("refresh_token")
        self._client_id: str | None = credentials.get("client_id")
        self._client_secret: str | None = credentials.get("client_secret")
        self._token_expiry: str | None = credentials.get("token_expiry")
        self._http: httpx.AsyncClient | None = None
        self._creds_dirty = False

    def credentials_dirty(self) -> bool:
        return self._creds_dirty

    def export_credentials(self) -> dict[str, Any]:
        """Return credentials with the latest (possibly refreshed) tokens."""
        return {
            **self.credentials,
            "access_token": self._access_token,
            "refresh_token": self._refresh_token,
        }

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http is None:
            await self.authenticate()
            self._http = httpx.AsyncClient(
                base_url=GMAIL_API_BASE,
                headers={
                    "Authorization": f"Bearer {self._access_token}",
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
        return self._http

    async def _refresh_access_token(self) -> None:
        """Refresh the OAuth access token using the refresh token."""
        if not self._refresh_token or not self._client_id or not self._client_secret:
            raise ValueError("Missing OAuth credentials for token refresh")

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "refresh_token": self._refresh_token,
                    "grant_type": "refresh_token",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            self._access_token = data["access_token"]
            if "refresh_token" in data:
                self._refresh_token = data["refresh_token"]
            self._creds_dirty = True

    async def authenticate(self) -> bool:
        """Validate and refresh token if needed."""
        if not self._access_token:
            if self._refresh_token:
                await self._refresh_access_token()
            else:
                return False

        # Test the token with a lightweight API call
        try:
            async with httpx.AsyncClient(
                headers={"Authorization": f"Bearer {self._access_token}"},
                timeout=10.0,
            ) as client:
                resp = await client.get(f"{GMAIL_API_BASE}/users/me/profile")
                if resp.status_code == 401 and self._refresh_token:
                    await self._refresh_access_token()
                    return True
                return resp.is_success
        except Exception:
            return False

    async def list_folders(self) -> list[EmailFolder]:
        client = await self._get_client()
        resp = await client.get("/users/me/labels")
        resp.raise_for_status()
        data = resp.json()

        folders: list[EmailFolder] = []
        for label in data.get("labels", []):
            folders.append(EmailFolder(
                provider_folder_id=label["id"],
                name=label["name"],
                type=label.get("type", "user"),
                message_count=label.get("messagesTotal", 0),
                unread_count=label.get("messagesUnread", 0),
            ))
        return folders

    async def list_messages(
        self,
        folder: str = "INBOX",
        query: str | None = None,
        max_results: int = 50,
        page_token: str | None = None,
    ) -> tuple[list[EmailMessage], str | None]:
        client = await self._get_client()
        params: dict[str, Any] = {
            "maxResults": min(max_results, 500),
            "labelIds": [folder],
        }
        if query:
            params["q"] = query
        if page_token:
            params["pageToken"] = page_token

        resp = await client.get("/users/me/messages", params=params)
        resp.raise_for_status()
        data = resp.json()

        canon = canonical_folder(folder)
        messages: list[EmailMessage] = []
        for msg_ref in data.get("messages", []):
            # Fetch full message
            try:
                msg = await self.get_message(msg_ref["id"])
                msg.folder = canon
                messages.append(msg)
            except Exception:
                continue

        next_token = data.get("nextPageToken")
        return messages, next_token

    async def get_message(self, provider_message_id: str) -> EmailMessage:
        client = await self._get_client()
        resp = await client.get(
            f"/users/me/messages/{provider_message_id}",
            params={"format": "full"},
        )
        resp.raise_for_status()
        return self._parse_gmail_message(resp.json())

    async def send_message(
        self,
        to: list[str],
        subject: str,
        body_text: str,
        body_html: str | None = None,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        reply_to_message_id: str | None = None,
    ) -> str:
        # Build RFC 2822 message
        msg = MIMEText(body_text, "plain" if not body_html else "html")
        msg["To"] = ", ".join(to)
        msg["Subject"] = subject
        if cc:
            msg["Cc"] = ", ".join(cc)

        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()

        body: dict[str, Any] = {"raw": raw}
        if reply_to_message_id:
            body["threadId"] = reply_to_message_id

        client = await self._get_client()
        resp = await client.post("/users/me/messages/send", json=body)
        resp.raise_for_status()
        data = resp.json()
        return data["id"]

    async def modify_message(
        self,
        provider_message_id: str,
        add_labels: list[str] | None = None,
        remove_labels: list[str] | None = None,
    ) -> None:
        client = await self._get_client()
        body: dict[str, Any] = {}
        if add_labels:
            body["addLabelIds"] = add_labels
        if remove_labels:
            body["removeLabelIds"] = remove_labels

        resp = await client.post(
            f"/users/me/messages/{provider_message_id}/modify",
            json=body,
        )
        resp.raise_for_status()

    async def trash_message(self, provider_message_id: str) -> None:
        client = await self._get_client()
        resp = await client.post(
            f"/users/me/messages/{provider_message_id}/trash"
        )
        resp.raise_for_status()

    async def apply_flags(
        self,
        provider_message_id: str,
        *,
        is_read: bool | None = None,
        is_starred: bool | None = None,
        is_flagged: bool | None = None,
    ) -> None:
        """Translate flag changes into Gmail label add/remove operations."""
        add: list[str] = []
        remove: list[str] = []
        if is_read is not None:
            (remove if is_read else add).append("UNREAD")
        if is_starred is not None:
            (add if is_starred else remove).append("STARRED")
        if is_flagged is not None:
            # Gmail's closest analogue to a flag is the IMPORTANT marker.
            (add if is_flagged else remove).append("IMPORTANT")
        if add or remove:
            await self.modify_message(
                provider_message_id, add_labels=add or None, remove_labels=remove or None
            )

    async def move_to_folder(self, provider_message_id: str, folder: str) -> None:
        """Move via Gmail label mutation (Gmail has labels, not folders)."""
        folder = (folder or "").lower()
        if folder == "trash":
            await self.trash_message(provider_message_id)
        elif folder == "archive":
            # Archiving in Gmail = removing the INBOX label.
            await self.modify_message(provider_message_id, remove_labels=["INBOX"])
        elif folder == "inbox":
            await self.modify_message(
                provider_message_id, add_labels=["INBOX"], remove_labels=["TRASH", "SPAM"]
            )
        elif folder in ("junk", "spam"):
            await self.modify_message(
                provider_message_id, add_labels=["SPAM"], remove_labels=["INBOX"]
            )

    async def sync_messages(
        self,
        history_id: str | None = None,
        max_results: int = 100,
    ) -> SyncResult:
        client = await self._get_client()

        if history_id:
            # Incremental sync via history.list
            params: dict[str, Any] = {
                "startHistoryId": history_id,
                "maxResults": max_results,
                "historyTypes": ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
            }
            resp = await client.get("/users/me/history", params=params)
            resp.raise_for_status()
            data = resp.json()

            result = SyncResult(new_history_id=data.get("historyId"))
            message_ids_to_fetch: set[str] = set()
            message_ids_deleted: set[str] = set()

            for history in data.get("history", []):
                for msg_added in history.get("messagesAdded", []):
                    mid = msg_added.get("message", {}).get("id")
                    if mid:
                        message_ids_to_fetch.add(mid)
                for msg_deleted in history.get("messagesDeleted", []):
                    mid = msg_deleted.get("message", {}).get("id")
                    if mid:
                        message_ids_deleted.add(mid)

            # Mark deleted messages as such
            for mid in message_ids_deleted:
                result.messages.append(EmailMessage(
                    provider_message_id=mid,
                    folder="TRASH",
                    labels=["TRASH"],
                    subject="[DELETED]",
                ))

            # Fetch full message for each added/updated message
            for mid in message_ids_to_fetch:
                try:
                    msg = await self.get_message(mid)
                    result.messages.append(msg)
                    result.messages_synced += 1
                except Exception as e:
                    result.errors.append(f"Failed to fetch message {mid}: {e}")

            result.messages_synced += len(message_ids_deleted)
            return result
        else:
            # Initial full sync — fetch the standard system labels so messages
            # land in the right folder in the UI (not just inbox/sent).
            messages: list[EmailMessage] = []
            for label in ("INBOX", "SENT", "DRAFT", "SPAM", "TRASH"):
                try:
                    label_msgs, _ = await self.list_messages(
                        folder=label, max_results=max_results
                    )
                    messages.extend(label_msgs)
                except Exception:
                    continue

            return SyncResult(
                messages_synced=len(messages),
                messages=messages,
                new_history_id=None,  # will be set after first history call
            )

    async def get_attachment(
        self, provider_message_id: str, provider_attachment_id: str
    ) -> bytes:
        client = await self._get_client()
        resp = await client.get(
            f"/users/me/messages/{provider_message_id}/attachments/{provider_attachment_id}"
        )
        resp.raise_for_status()
        data = resp.json()
        return base64.urlsafe_b64decode(data["data"])

    # ── Helpers ──────────────────────────────────────────────────────────

    def _parse_gmail_message(self, raw: dict[str, Any]) -> EmailMessage:
        """Parse a Gmail API message into our normalized EmailMessage."""
        headers = self._parse_headers(raw.get("payload", {}).get("headers", []))

        # Extract body
        body_text = ""
        body_html = None
        payload = raw.get("payload", {})
        if "parts" in payload:
            for part in payload["parts"]:
                mime = part.get("mimeType", "")
                data = part.get("body", {}).get("data", "")
                if data:
                    decoded = base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
                    if mime == "text/plain":
                        body_text = decoded
                    elif mime == "text/html":
                        body_html = decoded
        else:
            data = payload.get("body", {}).get("data", "")
            if data:
                decoded = base64.urlsafe_b64decode(data).decode("utf-8", errors="replace")
                body_text = decoded

        # Snippet
        snippet = raw.get("snippet", "")

        # Attachments
        attachments: list[Attachment] = []
        if "parts" in payload:
            for part in payload["parts"]:
                if part.get("filename"):
                    attachments.append(Attachment(
                        id=f"{raw['id']}_{part.get('body', {}).get('attachmentId', '')}",
                        filename=part["filename"],
                        mime_type=part.get("mimeType", "application/octet-stream"),
                        size_bytes=int(part.get("body", {}).get("size", 0)),
                        provider_attachment_id=part.get("body", {}).get("attachmentId", ""),
                    ))

        # Labels
        label_ids = raw.get("labelIds", [])
        is_read = "UNREAD" not in label_ids
        is_starred = "STARRED" in label_ids
        is_flagged = "IMPORTANT" in label_ids
        importance = "high" if "IMPORTANT" in label_ids else "normal"
        # Gmail user-label *names* require a separate label-map lookup; expose
        # only the raw IDs as labels and leave categories empty for now.
        categories: list[str] = []

        return EmailMessage(
            provider_message_id=raw["id"],
            thread_id=raw.get("threadId"),
            folder=_gmail_folder_from_labels(label_ids),
            labels=label_ids,
            from_address=EmailAddress(
                name=headers.get("From", "").split("<")[0].strip(),
                email=self._extract_email(headers.get("From", "")),
            ),
            to_addresses=self._parse_address_list(headers.get("To", "")),
            cc_addresses=self._parse_address_list(headers.get("Cc", "")),
            bcc_addresses=self._parse_address_list(headers.get("Bcc", "")),
            subject=headers.get("Subject", "(no subject)"),
            body_text=body_text,
            body_html=body_html,
            snippet=snippet[:200] if snippet else body_text[:200],
            has_attachments=len(attachments) > 0,
            attachments=attachments,
            is_read=is_read,
            is_starred=is_starred,
            is_flagged=is_flagged,
            importance=importance,
            categories=categories,
            received_at=self._parse_internal_date(raw.get("internalDate")),
            raw=raw,
        )

    @staticmethod
    def _parse_internal_date(internal_date: str | None) -> datetime | None:
        """Parse Gmail's internalDate (epoch ms as string) into a datetime."""
        if not internal_date:
            return None
        try:
            return datetime.fromtimestamp(int(internal_date) / 1000, tz=timezone.utc)
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _parse_headers(headers: list[dict]) -> dict[str, str]:
        result: dict[str, str] = {}
        for h in headers:
            name = h.get("name", "")
            value = h.get("value", "")
            if name not in result:
                result[name] = value
        return result

    @staticmethod
    def _extract_email(header: str) -> str:
        """Extract email address from a header like 'Name <email>'."""
        if "<" in header and ">" in header:
            return header.split("<")[1].split(">")[0].strip()
        return header.strip()

    @staticmethod
    def _parse_address_list(header: str) -> list[EmailAddress]:
        """Parse a comma-separated list of addresses."""
        if not header:
            return []
        addresses: list[EmailAddress] = []
        for part in header.split(","):
            part = part.strip()
            if not part:
                continue
            if "<" in part:
                name = part.split("<")[0].strip()
                email = part.split("<")[1].split(">")[0].strip()
            else:
                name = ""
                email = part
            addresses.append(EmailAddress(name=name, email=email))
        return addresses
