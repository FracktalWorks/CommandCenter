"""Microsoft 365 / Outlook provider.

Uses the Microsoft Graph REST API with OAuth 2.0 authentication.
Supports both personal Outlook.com accounts and Microsoft 365 work/school accounts.

API reference: https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview
"""

from __future__ import annotations

from typing import Any

import httpx

from .base import (
    Attachment,
    BaseEmailProvider,
    EmailAddress,
    EmailFolder,
    EmailMessage,
    SyncResult,
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
            if "refresh_token" in data:
                self._refresh_token = data["refresh_token"]

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
    ) -> tuple[list[EmailMessage], str | None]:
        client = await self._get_client()

        # Use well-known folder names for system folders
        well_known: dict[str, str] = {
            "inbox": "inbox",
            "sent": "sentitems",
            "drafts": "drafts",
            "trash": "deleteditems",
            "archive": "archive",
        }
        folder_path = well_known.get(folder.lower(), folder)

        url = f"/me/mailFolders/{folder_path}/messages"
        params: dict[str, Any] = {
            "$top": min(max_results, 100),
            "$orderby": "receivedDateTime desc",
            "$select": "id,subject,from,toRecipients,ccRecipients,"
                       "bccRecipients,receivedDateTime,isRead,hasAttachments,"
                       "flag,bodyPreview,categories,parentFolderId,"
                       "conversationId",
        }
        if query:
            params["$search"] = f'"{query}"'
        if page_token:
            params["$skipToken"] = page_token

        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

        messages: list[EmailMessage] = []
        for msg_data in data.get("value", []):
            messages.append(self._parse_graph_message(msg_data))

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
        client = await self._get_client()
        resp = await client.delete(f"/me/messages/{provider_message_id}")
        resp.raise_for_status()

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

            result = SyncResult(
                messages_synced=len(data.get("value", [])),
                new_history_id=data.get("@odata.deltaLink"),
            )
            return result
        else:
            # Initial sync
            messages, _ = await self.list_messages(
                folder="inbox", max_results=max_results
            )
            return SyncResult(
                messages_synced=len(messages),
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

        # Categories → labels
        categories = raw.get("categories", [])

        # Flag status
        flag = raw.get("flag", {})
        is_flagged = flag.get("flagStatus") == "flagged"

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
            is_starred=False,  # Outlook doesn't have stars — use categories
            is_flagged=is_flagged,
            received_at=None,
            raw=raw,
        )
