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

def _skiptoken(value: str | None) -> str | None:
    """Return a bare Graph ``$skiptoken`` value.

    ``list_messages`` surfaces Graph's ``@odata.nextLink`` (a full URL) as its
    page token, but the paging param Graph expects is the bare ``$skiptoken``
    embedded in that URL — feeding the whole URL back as ``$skipToken`` makes
    Graph reject the request and paging never advances.  Accepts either a full
    nextLink URL or an already-bare token and always returns the bare token.
    """
    if not value:
        return None
    if "://" not in value:
        return value
    from urllib.parse import parse_qs, urlparse

    qs = parse_qs(urlparse(value).query)
    # Graph spells it ``$skiptoken`` (lowercase) on the nextLink.
    tok = qs.get("$skiptoken") or qs.get("$skipToken")
    return tok[0] if tok else None


GRAPH_API_BASE = "https://graph.microsoft.com/v1.0"
GRAPH_SCOPES = [
    # offline_access is REQUIRED on refresh — without it Microsoft returns a new
    # access token but NOT a renewed refresh token, so the refresh chain expires
    # and the account eventually needs a manual "reconnect".
    "offline_access",
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

    @staticmethod
    def _folder_from_graph(folder: dict[str, Any]) -> EmailFolder:
        return EmailFolder(
            provider_folder_id=folder["id"],
            name=folder["displayName"],
            type="system" if folder.get("wellKnownName") else "user",
            message_count=folder.get("totalItemCount", 0),
            unread_count=folder.get("unreadItemCount", 0),
        )

    async def list_folders(self) -> list[EmailFolder]:
        """List ALL mail folders, including user-created and nested ones.

        Graph's ``/me/mailFolders`` defaults to ~10 top-level folders and omits
        children, so we request ``$top=200``, follow ``@odata.nextLink``, and
        descend into ``childFolders`` (one level covers inbox-zero's flat set;
        deeper nesting is followed only when a child reports its own children).
        """
        client = await self._get_client()
        select = "id,displayName,wellKnownName,totalItemCount,unreadItemCount,childFolderCount"

        async def _page(url: str, params: dict[str, Any] | None) -> list[dict[str, Any]]:
            items: list[dict[str, Any]] = []
            # First request uses params; subsequent ones follow the absolute
            # @odata.nextLink URL verbatim (httpx keeps the client's auth header).
            resp = await client.get(url, params=params)
            while True:
                resp.raise_for_status()
                data = resp.json()
                items.extend(data.get("value", []))
                next_link = data.get("@odata.nextLink")
                if not next_link:
                    return items
                resp = await client.get(next_link)

        async def _descend(raw: dict[str, Any]) -> list[EmailFolder]:
            out = [self._folder_from_graph(raw)]
            if raw.get("childFolderCount"):
                try:
                    children = await _page(
                        f"/me/mailFolders/{raw['id']}/childFolders",
                        {"$top": 200, "$select": select},
                    )
                    for child in children:
                        out.extend(await _descend(child))
                except Exception:  # noqa: BLE001
                    pass  # a forbidden subtree shouldn't drop the parent
            return out

        top = await _page("/me/mailFolders", {"$top": 200, "$select": select})
        folders: list[EmailFolder] = []
        for raw in top:
            folders.extend(await _descend(raw))
        return folders

    async def _get_or_create_folder_id(self, name: str) -> str | None:
        """Return the Graph id of the folder named ``name``, creating it if absent.

        Dedups by ``displayName`` and tolerates the create race
        (``ErrorFolderExists`` / HTTP 409) by re-reading — mirrors upstream
        inbox-zero's ``getOrCreateOutlookFolderIdByName``.
        """
        if not name or not name.strip():
            return None
        name = name.strip()
        client = await self._get_client()
        esc = name.replace("'", "''")

        async def _find() -> str | None:
            resp = await client.get(
                "/me/mailFolders",
                params={"$filter": f"displayName eq '{esc}'",
                        "$select": "id,displayName", "$top": 1},
            )
            resp.raise_for_status()
            vals = resp.json().get("value", [])
            return vals[0]["id"] if vals else None

        existing = await _find()
        if existing:
            return existing
        resp = await client.post("/me/mailFolders", json={"displayName": name})
        if resp.is_success:
            return resp.json().get("id")
        if resp.status_code == 409 or "ErrorFolderExists" in resp.text:
            return await _find()
        resp.raise_for_status()
        return None

    async def create_folder(self, name: str) -> EmailFolder:
        """Create (or reuse) a top-level mail folder; return it normalized."""
        folder_id = await self._get_or_create_folder_id(name)
        if not folder_id:
            raise ValueError(f"Could not create Outlook folder: {name!r}")
        return EmailFolder(
            provider_folder_id=folder_id, name=name.strip(), type="user"
        )

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
                       "conversationId,importance,internetMessageHeaders",
        }
        if query:
            params["$search"] = f'"{query}"'
        if page_token:
            params["$skiptoken"] = _skiptoken(page_token)

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

        # Surface a BARE $skiptoken (not the full nextLink URL) so it can be fed
        # straight back into ``page_token`` above.
        next_token = _skiptoken(data.get("@odata.nextLink"))
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

    async def create_draft(
        self,
        to: list[str],
        subject: str,
        body_text: str,
        body_html: str | None = None,
        reply_to_message_id: str | None = None,
        thread_id: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> str:
        """Create an Outlook draft. For replies, use createReply (keeps threading)
        then set the body; otherwise create a standalone draft message. File
        attachments are added to the draft via the Graph attachments endpoint."""
        client = await self._get_client()
        body_block = {
            "contentType": "html" if body_html else "text",
            "content": body_html or body_text,
        }
        if reply_to_message_id:
            resp = await client.post(
                f"/me/messages/{reply_to_message_id}/createReply"
            )
            resp.raise_for_status()
            draft_id = resp.json().get("id", "")
            patch = await client.patch(
                f"/me/messages/{draft_id}", json={"body": body_block}
            )
            patch.raise_for_status()
            await self._attach_files(client, draft_id, attachments)
            return draft_id
        message: dict[str, Any] = {
            "subject": subject,
            "body": body_block,
            "toRecipients": [
                {"emailAddress": {"address": addr}} for addr in to
            ],
        }
        resp = await client.post("/me/messages", json=message)
        resp.raise_for_status()
        draft_id = resp.json().get("id", "")
        await self._attach_files(client, draft_id, attachments)
        return draft_id

    @staticmethod
    async def _attach_files(
        client: httpx.AsyncClient, draft_id: str,
        attachments: list[dict[str, Any]] | None,
    ) -> None:
        """Attach files to a Graph draft via POST /messages/{id}/attachments."""
        import base64 as _b64  # noqa: PLC0415
        for att in attachments or []:
            try:
                content = att.get("content") or b""
                await client.post(
                    f"/me/messages/{draft_id}/attachments",
                    json={
                        "@odata.type": "#microsoft.graph.fileAttachment",
                        "name": att.get("filename", "attachment"),
                        "contentType": att.get(
                            "mime_type", "application/octet-stream"),
                        "contentBytes": _b64.b64encode(content).decode(),
                    },
                )
            except Exception:  # noqa: BLE001 — one bad attachment shouldn't fail the draft
                continue

    # ── Change-notification subscriptions (push) ─────────────────────────────

    async def create_subscription(
        self,
        notification_url: str,
        client_state: str,
        resource: str = "/me/mailFolders('inbox')/messages",
        minutes: int = 4000,
    ) -> dict[str, Any]:
        """Create a Graph change-notification subscription for new inbox mail.

        Graph validates ``notification_url`` synchronously (it POSTs a
        validationToken that the endpoint must echo within 10s). Mail
        subscriptions live at most ~4230 min, so callers must renew.
        """
        from datetime import datetime, timedelta, timezone  # noqa: PLC0415
        exp = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()
        body = {
            "changeType": "created",
            "notificationUrl": notification_url,
            "resource": resource,
            "expirationDateTime": exp,
            "clientState": client_state,
        }
        client = await self._get_client()
        resp = await client.post("/subscriptions", json=body)
        resp.raise_for_status()
        return resp.json()

    async def renew_subscription(
        self, subscription_id: str, minutes: int = 4000
    ) -> dict[str, Any]:
        """Extend a subscription's expiry."""
        from datetime import datetime, timedelta, timezone  # noqa: PLC0415
        exp = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()
        client = await self._get_client()
        resp = await client.patch(
            f"/subscriptions/{subscription_id}",
            json={"expirationDateTime": exp},
        )
        resp.raise_for_status()
        return resp.json()

    async def delete_subscription(self, subscription_id: str) -> None:
        """Best-effort delete of a subscription."""
        client = await self._get_client()
        try:
            await client.delete(f"/subscriptions/{subscription_id}")
        except Exception:  # noqa: BLE001
            pass

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

    async def trash_message(self, provider_message_id: str) -> str | None:
        # Graph "delete" moves the item to Deleted Items (soft delete), which is
        # what we want for a trash action. /move re-keys the message, so return
        # the new id for the caller to persist.
        return await self.move_to_folder(provider_message_id, "trash")

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

    async def move_to_folder(
        self, provider_message_id: str, folder: str
    ) -> str | None:
        # Well-known system folders use their Graph well-known name; any other
        # name is treated as a user folder and created on demand (inbox-zero
        # parity — promo/automation rules file into same-named folders).
        target = self._MOVE_TARGETS.get((folder or "").lower())
        if not target:
            target = await self._get_or_create_folder_id(folder)
        if not target:
            return None
        client = await self._get_client()
        resp = await client.post(
            f"/me/messages/{provider_message_id}/move",
            json={"destinationId": target},
        )
        resp.raise_for_status()
        # Graph /move creates the message in the destination folder with a NEW
        # id; the old id is no longer valid. Return it so the caller can re-key
        # the stored provider_message_id (otherwise follow-up actions 404 until
        # the next full sync).
        try:
            return resp.json().get("id")
        except Exception:  # noqa: BLE001
            return None

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

    async def _ensure_categories(self, names: list[str]) -> None:
        """Create any missing Outlook master categories so an applied category is
        a real, coloured category (matches Gmail's label-on-apply behaviour)."""
        if not names:
            return
        client = await self._get_client()
        try:
            resp = await client.get("/me/outlook/masterCategories")
            resp.raise_for_status()
            existing = {
                (c.get("displayName") or "").lower()
                for c in resp.json().get("value", [])
            }
        except Exception:  # noqa: BLE001
            existing = set()
        for name in names:
            if not name or name.lower() in existing:
                continue
            # Stable colour from the name so the same category is consistent.
            color = f"preset{sum(ord(ch) for ch in name) % 25}"
            try:
                await client.post(
                    "/me/outlook/masterCategories",
                    json={"displayName": name, "color": color},
                )
                existing.add(name.lower())
            except Exception:  # noqa: BLE001
                pass  # best-effort — applying the category still works

    async def set_labels(
        self,
        provider_message_id: str,
        add: list[str] | None = None,
        remove: list[str] | None = None,
    ) -> None:
        """Add/remove categories on a message (categories are plain names).

        Missing categories are first created in the account's master category
        list so they show up as real, coloured Outlook categories."""
        await self._ensure_categories(add or [])
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

    # Initial full sweep depth per folder (≈ pages × max_results messages kept
    # locally per folder). Deeper history is pulled lazily by the /backfill path.
    INITIAL_SYNC_MAX_PAGES = 10

    async def _sweep_folder(
        self,
        folder: str,
        max_results: int,
        canonical_override: str | None = None,
    ) -> list[EmailMessage]:
        """Page a single folder up to ``INITIAL_SYNC_MAX_PAGES`` and return all
        messages, following Graph's ``@odata.nextLink`` token."""
        out: list[EmailMessage] = []
        token: str | None = None
        for _ in range(self.INITIAL_SYNC_MAX_PAGES):
            msgs, token = await self.list_messages(
                folder=folder,
                max_results=max_results,
                page_token=token,
                canonical_override=canonical_override,
            )
            out.extend(msgs)
            if not token:
                break
        return out

    async def sync_messages(
        self,
        history_id: str | None = None,
        max_results: int = 100,
    ) -> SyncResult:
        client = await self._get_client()

        # Delta sync is DISABLED: in production the inbox delta token returned 0
        # changes every cycle even as new mail arrived, silently halting sync.
        # Force the reliable multi-folder full sweep and return
        # new_history_id=None — which also auto-clears any stuck token already
        # persisted on the account (the scheduler writes it back), so a
        # previously-broken account self-heals on its next cycle. Re-enable delta
        # only behind a verified implementation.
        history_id = None

        if history_id:
            # We persist Graph's @odata.deltaLink (a full URL) as history_id, but
            # the delta endpoint wants only the bare $deltatoken value — extract
            # it (handles both a stored deltaLink URL and an already-bare token).
            token = history_id
            if "://" in history_id:
                from urllib.parse import parse_qs, urlparse  # noqa: PLC0415
                token = parse_qs(urlparse(history_id).query).get(
                    "$deltatoken", [history_id]
                )[0]
            # Delta query for incremental sync
            resp = await client.get(
                "/me/mailFolders/inbox/messages/delta",
                params={"$deltatoken": token, "$top": max_results},
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
            # right place in the UI (not just inbox/sent).  Page each folder up to
            # INITIAL_SYNC_MAX_PAGES so a fresh connect lands a deep window of
            # history (≈ pages × max_results / folder), not just the newest page.
            # Going further back stays on-demand via the /backfill endpoint.
            messages = []
            for folder_key in ("inbox", "sent", "drafts", "archive", "junk", "trash"):
                try:
                    messages.extend(
                        await self._sweep_folder(folder_key, max_results)
                    )
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
                    messages.extend(await self._sweep_folder(
                        f.provider_folder_id, max_results, canonical_override=canon
                    ))
                except Exception:
                    continue

            # IMPORTANT: keep the account in full-sync mode (new_history_id=None).
            #
            # We previously seeded an inbox delta token here (via
            # _bootstrap_inbox_delta) to detect upstream deletions. In production
            # that delta token returned 0 changes every cycle even when new mail
            # had arrived — i.e. it SILENTLY STOPPED syncing new email. The
            # multi-folder full sweep above is the reliable path (it reliably
            # picks up new mail), so we stay on it. Deletion-detection needs a
            # different, verified approach before delta is re-enabled.
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

        # List-Unsubscribe (present when internetMessageHeaders was $select'd).
        unsubscribe_link = None
        for h in raw.get("internetMessageHeaders", []) or []:
            if str(h.get("name", "")).lower() == "list-unsubscribe":
                unsubscribe_link = _parse_list_unsubscribe(h.get("value", ""))
                break

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
            unsubscribe_link=unsubscribe_link,
            received_at=self._parse_received_datetime(raw.get("receivedDateTime")),
            raw=raw,
        )


def _parse_list_unsubscribe(header: str) -> str | None:
    """Pick the best link from a List-Unsubscribe header (https preferred)."""
    if not header:
        return None
    targets: list[str] = []
    for part in header.split(","):
        p = part.strip()
        if p.startswith("<") and p.endswith(">"):
            p = p[1:-1].strip()
        if p:
            targets.append(p)
    for t in targets:
        if t.lower().startswith("http"):
            return t
    for t in targets:
        if t.lower().startswith("mailto:"):
            return t
    return targets[0] if targets else None
