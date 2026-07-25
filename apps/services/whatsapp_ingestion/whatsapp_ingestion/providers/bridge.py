"""Bridge provider — sends through a local whatsmeow (QR/multi-device) service.

The counterpart to the official Cloud API provider, for a PERSONAL number paired
by QR. It holds NO WhatsApp session itself — the session lives in the external
whatsmeow bridge service (apps/services/whatsapp_bridge). This class only speaks
HTTP to that bridge: "send this text as this session", "fetch this media". The
bridge URL + shared secret come from the environment (one bridge serves every
paired number); the per-account ``session`` ref (the wa_account id) comes from
the account's stored credentials so the bridge routes to the right client.

Personal WhatsApp has no 24h service window and no approved templates, so
``send_template`` is deliberately unsupported — the composer sends free-form text.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from whatsapp_ingestion.providers.base import BaseWhatsAppProvider

_TIMEOUT = httpx.Timeout(30.0)


class BridgeProvider(BaseWhatsAppProvider):
    """Send/receive a personal WhatsApp number via the whatsmeow bridge."""

    def __init__(self, credentials: dict[str, Any]):
        super().__init__(credentials)
        # The wa_account id the bridge keys the paired client on.
        self.session: str = (
            credentials.get("session")
            or credentials.get("session_ref")
            or credentials.get("account_id")
            or ""
        )
        self.base_url: str = (
            credentials.get("bridge_url")
            or os.environ.get("WHATSAPP_BRIDGE_URL", "http://localhost:8790")
        ).rstrip("/")
        self.secret: str = (
            credentials.get("bridge_secret")
            or os.environ.get("WHATSAPP_BRIDGE_SECRET", "")
        )

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.secret:
            h["X-Bridge-Secret"] = self.secret
        return h

    async def send_text(
        self,
        to_wa_id: str,
        body: str,
        *,
        reply_to_wa_message_id: str | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "session": self.session, "to": to_wa_id, "body": body,
        }
        if reply_to_wa_message_id:
            payload["reply_to"] = reply_to_wa_message_id
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                f"{self.base_url}/send", headers=self._headers(), json=payload)
            resp.raise_for_status()
            data = resp.json()
        mid = data.get("id") or data.get("message_id") if isinstance(data, dict) else None
        if not mid:
            raise RuntimeError(f"bridge send returned no id: {data!r}")
        return str(mid)

    async def send_template(
        self,
        to_wa_id: str,
        template_name: str,
        language: str,
        *,
        components: list[dict[str, Any]] | None = None,
    ) -> str:
        raise NotImplementedError(
            "Templates are a WhatsApp Business Cloud API concept; a personal "
            "whatsmeow number sends free-form text (there is no 24h window).")

    async def download_media(self, wa_media_id: str) -> tuple[bytes, str]:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                f"{self.base_url}/media", headers=self._headers(),
                json={"session": self.session, "media_id": wa_media_id})
            resp.raise_for_status()
            mime = resp.headers.get("Content-Type", "application/octet-stream")
            return resp.content, mime

    async def mark_read(self, wa_message_id: str) -> None:
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                await client.post(
                    f"{self.base_url}/read", headers=self._headers(),
                    json={"session": self.session, "message_id": wa_message_id})
        except Exception:
            return None
