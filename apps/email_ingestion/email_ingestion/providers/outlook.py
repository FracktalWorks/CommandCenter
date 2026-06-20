"""Microsoft 365 / Outlook provider.

Uses the Microsoft Graph REST API with OAuth 2.0 authentication.
Supports both personal Outlook.com accounts and Microsoft 365 work/school accounts.

API reference: https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview
"""

from __future__ import annotations

from datetime import datetime
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

GRAPH_API_BASE = "https://graph.microsoft.com/v1.0"
GRAPH_SCOPES = [
    "https://graph.microsoft.com/Mail.ReadWrite",
    "https://graph.microsoft.com/Mail.Send",
    "https://graph.microsoft.com/User.Read",
]


class OutlookProvider(BaseEmailProvider):
    """Microsoft Graph API email provider."""

    def __init__(self, credentials: dict[str, Any]):
        super().__init__(credentials)
        self._access_token: str | None = credentials.get("access_token")
        self._refresh_token: str | None = credentials.get("refresh_token")
        self._client_id: str | None = credentials.get("client_id")
        self._client_secret: str | None = credentials.get("client_secret")
        self._tenant_id: str = credentials.get("tenant_id", "common")
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
                base_url=GRAPH_API_BASE,
                headers={
                    "Authorization": f"Bearer {self._access_token}",
                    "Content-Type": "application/json",
                },
                timeout=30.0,
            )
        return self._http

    async def _refresh_access_token(self) -> None:
        """Refresh the OAuth access token."""
        if not self._refresh_token or not self._client_id or not self._client_secret:
            raise ValueError("Missing OAuth credentials for token refresh")

        token_url = (
            f"https://login.microsoftonline.com/{self._tenant_id}/oauth2/v2.0/token"
        )
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                token_url,
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "refresh_token": self._refresh_token,
                    "grant_type": "refresh_token",
                    "scope": " ".join(GRAPH_SCOPES),
                },
            )
            resp.raise_for_status()
            data = resp.json()
            self._access_token = data["access_token"]
            # Microsoft rotates refresh tokens on every use — persist the new one
            # or subsequent refreshes will fail with the stale token.
            if "refresh_token" in data:
                self._refresh_token = data["refresh_token"]
            self._creds_dirty = True

    async def authenticate(self) -> bool:
        """Validate the access token."""
        if not self._access_token:
            if self._refresh_token:
                await self._refresh_access_token()
            else:
                return False

        try:
            async with httpx.AsyncClient(
                headers={"Authorization": f"Bearer {self._access_token}"},
                timeout=10.0,
            ) as client:
                resp = await client.get(f"{GRAPH_API_BASE}/me")
                if resp.status_code == 401 and self._refresh_token:
                    await self._refresh_access_token()
                    return True
                return resp.is_success
        except Exception:
            return False

    async def list_folders(self) -> list[EmailFolder]:
        client = await self._get_client()
        resp = await client.get("/me/mailFolders")
        resp.raise_for_status()
        data = resp.json()

        folders: list[EmailFolder] = []
        for folder in data.get("value", []):
            folders.append(EmailFolder(
                provider_folder_id=folder["id"],
                name=folder["displayName"],
                type="system" if folder.get("wellKnownName") else "user",
                message_count=folder.get("totalItemCount", 0),
                unread_count=folder.get("unreadItemCount", 0),
            ))
        return folders

    async def list_messages(
        self,
        folder: str = "inbox",
        query: str | None = None,
        max_results: int = 50,
        page_token: str | None = None,
        canonical_override: str | None = None,
    ) -> tuple[list[EmailMessage], str | None]:
        client = await self._get_client()

        # Use well-known folder names for system folders
        well_known: dict[str, str] = {
            "inbox": "inbox",
            "sent": "sentitems",
            "sentitems": "sentitems",
            "drafts": "drafts",
            "trash": "deleteditems",
            "deleteditems": "deleteditems",
            "archive": "archive",
            "junk": "junkemail",
            "junkemail": "junkemail",
        }
        folder_path = well_known.get(folder.lower(), folder)

        url = f"/me/mailFolders/{folder_path}/messages"
        params: dict[str, Any] = {
            "$top": min(max_results, 100),
            "$orderby": "receivedDateTime desc",
            "$select": "id,subject,from,toRecipients,ccRecipients,"
                       "bccRecipients,receivedDateTime,isRead,hasAttachments,"
                       "flag,bodyPreview,categories,parentFolderId,"
                       "conversationId,importance",
        }
        if query:
            params["$search"] = f'"{query}"'
        if page_token:
            params["$skipToken"] = page_token

        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

        # Normalize every message to the canonical folder key for the folder we
        # queried — Graph's ``parentFolderId`` is an opaque ID that would never
        # match the gateway's ``WHERE folder = 'inbox'`` filter.
        canon = canonical_override or canonical_folder(folder)
        messages: list[EmailMessage] = []
        for msg_data in data.get("value", []):
            msg = self._parse_graph_message(msg_data)
            msg.folder = canon
            messages.append(msg)

        next_token = data.get("@odata.nextLink")
        return messages, next_token

    async def get_message(self, provider_message_id: str) -> EmailMessage:
        client = await self._get_client()
        resp = await client.get(
            f"/me/messages/{provider_message_id}",
            params={"$expand": "attachments"},
        )
        resp.raise_for_status()
        return self._parse_graph_message(resp.json())

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
        client = await self._get_client()

        message: dict[str, Any] = {
            "subject": subject,
            "body": {
                "contentType": "html" if body_html else "text",
                "content": body_html or body_text,
            },
            "toRecipients": [{"emailAddress": {"address": addr}} for addr in to],
        }
        if cc:
            message["ccRecipients"] = [
                {"emailAddress": {"address": addr}} for addr in cc
            ]
        if bcc:
            message["bccRecipients"] = [
                {"emailAddress": {"address": addr}} for addr in bcc
            ]

        if reply_to_message_id:
            # Send as reply
            resp = await client.post(
                f"/me/messages/{reply_to_message_id}/reply",
                json={"message": message},
            )
        else:
            resp = await client.post("/me/sendMail", json={"message": message})

        resp.raise_for_status()
        return "sent"  # Graph API doesn't return the sent message ID

    async def modify_message(
        self,
        provider_message_id: str,
        add_labels: list[str] | None = None,
        remove_labels: list[str] | None = None,
    ) -> None:
        client = await self._get_client()
        patch: dict[str, Any] = {}

        if add_labels:
            if "READ" in add_labels:
                patch["isRead"] = True
            if "UNREAD" in add_labels:
                patch["isRead"] = False
            if "FLAGGED" in add_labels:
                patch["flag"] = {"flagStatus": "flagged"}
        if remove_labels:
            if "UNREAD" in remove_labels:
                patch["isRead"] = True

        if patch:
            resp = await client.patch(
                f"/me/messages/{provider_message_id}",
                json=patch,
            )
            resp.raise_for_status()

    async def trash_message(self, provider_message_id: str) -> None:
        # Graph "delete" moves the item to Deleted Items (soft delete), which is
        # what we want for a trash action.
        await self.move_to_folder(provider_message_id, "trash")

    # Canonical folder key → Graph well-known folder name for moves.
    _MOVE_TARGETS = {
        "inbox": "inbox",
        "archive": "archive",
        "trash": "deleteditems",
        "drafts": "drafts",
        "junk": "junkemail",
        "sent": "sentitems",
    }

    async def apply_flags(
        self,
        provider_message_id: str,
        *,
        is_read: bool | None = None,
        is_starred: bool | None = None,
        is_flagged: bool | None = None,
    ) -> None:
        """PATCH read state / flag on the Graph message.

        Outlook has no "star" concept, so ``is_starred`` is ignored (the star is
        kept as a local-only marker in CommandCenter).
        """
        patch: dict[str, Any] = {}
        if is_read is not None:
            patch["isRead"] = is_read
        if is_flagged is not None:
            patch["flag"] = {"flagStatus": "flagged" if is_flagged else "notFlagged"}
        if patch:
            client = await self._get_client()
            resp = await client.patch(f"/me/messages/{provider_message_id}", json=patch)
            resp.raise_for_status()

    async def move_to_folder(self, provider_message_id: str, folder: str) -> None:
        target = self._MOVE_TARGETS.get((folder or "").lower())
        if not target:
            return
        client = await self._get_client()
        resp = await client.post(
            f"/me/messages/{provider_message_id}/move",
            json={"destinationId": target},
        )
        resp.raise_for_status()

    # ── Labels (Outlook categories) ──────────────────────────────────────

    async def list_labels(self) -> list[str]:
        """Outlook master category names."""
        client = await self._get_client()
        resp = await client.get("/me/outlook/masterCategories")
        resp.raise_for_status()
        return sorted(
            c.get("displayName")
            for c in resp.json().get("value", [])
            if c.get("displayName")
        )

    async def set_labels(
        self,
        provider_message_id: str,
        add: list[str] | None = None,
        remove: list[str] | None = None,
    ) -> None:
        """Add/remove categories on a message (categories are plain names)."""
        client = await self._get_client()
        resp = await client.get(
            f"/me/messages/{provider_message_id}",
            params={"$select": "categories"},
        )
        resp.raise_for_status()
        current: list[str] = list(resp.json().get("categories", []) or [])
        for name in add or []:
            if name not in current:
                current.append(name)
        for name in remove or []:
            if name in current:
                current.remove(name)
        patch = await client.patch(
            f"/me/messages/{provider_message_id}",
            json={"categories": current},
        )
        patch.raise_for_status()

    async def sync_messages(
        self,
        history_id: str | None = None,
        max_results: int = 100,
    ) -> SyncResult:
        client = await self._get_client()

        if history_id:
            # Delta query for incremental sync
            resp = await client.get(
                "/me/mailFolders/inbox/messages/delta",
                params={"$deltatoken": history_id, "$top": max_results},
            )
            resp.raise_for_status()
            data = resp.json()

            messages: list[EmailMessage] = []
            removed_count = 0
            for item in data.get("value", []):
                if item.get("@removed"):
                    removed_count += 1
                    messages.append(EmailMessage(
                        provider_message_id=item["id"],
                        folder="TRASH",
                        labels=["TRASH"],
                        subject="[DELETED]",
                    ))
                else:
                    msg = self._parse_graph_message(item)
                    # The delta query runs against the inbox folder.
                    msg.folder = "inbox"
                    messages.append(msg)

            return SyncResult(
                messages_synced=len(data.get("value", [])),
                messages_skipped=removed_count,
                messages=messages,
                new_history_id=data.get("@odata.deltaLink"),
            )
        else:
            # Initial sync — fetch all standard folders so messages land in the
            # right place in the UI (not just inbox/sent).
            messages = []
            for folder_key in ("inbox", "sent", "drafts", "archive", "junk", "trash"):
                try:
                    folder_msgs, _ = await self.list_messages(
                        folder=folder_key, max_results=max_results
                    )
                    messages.extend(folder_msgs)
                except Exception:
                    # A missing/forbidden folder shouldn't abort the whole sync.
                    continue

            # User-created folders — each Outlook message lives in exactly one
            # folder, so storing folder=canonical(displayName) is unambiguous and
            # makes the user's own folders openable in the UI.
            try:
                folders = await self.list_folders()
            except Exception:
                folders = []
            for f in folders:
                if f.type == "system":
                    continue
                canon = canonical_folder(f.name)
                if canon in ("inbox", "sent", "drafts", "trash", "junk", "archive"):
                    continue
                try:
                    folder_msgs, _ = await self.list_messages(
                        folder=f.provider_folder_id,
                        max_results=max_results,
                        canonical_override=canon,
                    )
                    messages.extend(folder_msgs)
                except Exception:
                    continue

            return SyncResult(
                messages_synced=len(messages),
                messages=messages,
                new_history_id=None,
            )

    async def get_attachment(
        self, provider_message_id: str, provider_attachment_id: str
    ) -> bytes:
        client = await self._get_client()
        resp = await client.get(
            f"/me/messages/{provider_message_id}/attachments/{provider_attachment_id}"
        )
        resp.raise_for_status()
        data = resp.json()
        # Graph API returns content as base64 in contentBytes
        import base64
        return base64.b64decode(data.get("contentBytes", ""))

    # ── Helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _parse_received_datetime(received_dt: str | None) -> datetime | None:
        """Parse Microsoft Graph receivedDateTime ISO string into datetime."""
        if not received_dt:
            return None
        try:
            from datetime import timezone
            return datetime.fromisoformat(received_dt.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None

    def _parse_graph_message(self, raw: dict[str, Any]) -> EmailMessage:
        """Parse a Microsoft Graph message into our normalized EmailMessage."""

        def _parse_recipients(recipients: list[dict] | None) -> list[EmailAddress]:
            if not recipients:
                return []
            return [
                EmailAddress(
                    name=r.get("emailAddress", {}).get("name", ""),
                    email=r.get("emailAddress", {}).get("address", ""),
                )
                for r in recipients
            ]

        from_addr = None
        if raw.get("from"):
            fa = raw["from"].get("emailAddress", {})
            from_addr = EmailAddress(name=fa.get("name", ""), email=fa.get("address", ""))

        # Categories (Outlook user categories, e.g. "Red category")
        categories = raw.get("categories", []) or []

        # Flag status
        flag = raw.get("flag", {})
        is_flagged = flag.get("flagStatus") == "flagged"

        # Importance: 'low' | 'normal' | 'high'
        importance = str(raw.get("importance", "normal")).lower()
        if importance not in ("low", "normal", "high"):
            importance = "normal"

        # Attachments
        attachments: list[Attachment] = []
        for att in raw.get("attachments", []):
            attachments.append(Attachment(
                id=att["id"],
                filename=att.get("name", "attachment"),
                mime_type=att.get("contentType", "application/octet-stream"),
                size_bytes=att.get("size", 0),
                provider_attachment_id=att["id"],
            ))

        # Body
        body = raw.get("body", {})
        body_text = body.get("content", "") if body.get("contentType") == "text" else ""
        body_html = body.get("content") if body.get("contentType") == "html" else None

        return EmailMessage(
            provider_message_id=raw["id"],
            thread_id=raw.get("conversationId"),
            folder=raw.get("parentFolderId", "inbox"),
            labels=categories,
            from_address=from_addr,
            to_addresses=_parse_recipients(raw.get("toRecipients")),
            cc_addresses=_parse_recipients(raw.get("ccRecipients")),
            bcc_addresses=_parse_recipients(raw.get("bccRecipients")),
            subject=raw.get("subject", "(no subject)"),
            body_text=body_text,
            body_html=body_html,
            snippet=raw.get("bodyPreview", "") or body_text[:200],
            has_attachments=raw.get("hasAttachments", False),
            attachments=attachments,
            is_read=raw.get("isRead", False),
            is_starred=False,  # Outlook doesn't have stars — use flag/categories
            is_flagged=is_flagged,
            importance=importance,
            categories=categories,
            received_at=self._parse_received_datetime(raw.get("receivedDateTime")),
            raw=raw,
        )
