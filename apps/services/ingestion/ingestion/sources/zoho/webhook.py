"""Zoho CRM webhook receiver (WBS 1.1).

Zoho doesn't sign webhook payloads natively, so we follow the common pattern
of provisioning a shared secret in the webhook URL (``?token=<secret>``) or as
a custom header (``X-Zoho-Token``) and verifying it server-side.

Mount under the gateway (preferred for v1) or run standalone via
``uv run uvicorn ingestion.sources.zoho.webhook:standalone --reload``.
"""
from __future__ import annotations

import hmac

from fastapi import APIRouter, FastAPI, Header, HTTPException, Query, Request

from acb_audit import AuditEvent, record
from acb_common import get_logger, get_settings

router = APIRouter(prefix="/webhooks/zoho", tags=["ingestion:zoho"])
_log = get_logger("ingestion.zoho")


def _verify(token: str | None) -> bool:
    expected = get_settings().zoho_webhook_secret
    if not expected:
        # Mis-config: refuse all calls rather than silently accept.
        return False
    if not token:
        return False
    return hmac.compare_digest(expected, token)


@router.post("")
async def receive(
    request: Request,
    token: str | None = Query(default=None),
    x_zoho_token: str | None = Header(default=None),
) -> dict[str, str]:
    """Receive a Zoho CRM notification. Verifies a shared secret then enqueues
    the payload for asynchronous normalisation (Phase-0: just audit-log it)."""
    if not _verify(token or x_zoho_token):
        raise HTTPException(status_code=401, detail="invalid token")
    payload = await request.json()
    module = (
        payload.get("module")
        or payload.get("Module")
        or (payload.get("data") or [{}])[0].get("module")
    )
    event = payload.get("event") or payload.get("operation") or "unknown"
    _log.info("zoho.webhook", event=event, module=module)
    record(
        AuditEvent(
            actor="webhook:zoho",
            action="received",
            target=f"zoho:{module or 'unknown'}",
            payload={"event": event, "size": len(str(payload))},
        )
    )
    # TODO WBS 0.3: enqueue to Redis Streams; today we ack and let the next
    # scheduler tick pick up the change via If-Modified-Since.
    return {"status": "accepted"}


# Lightweight standalone app for local testing.
standalone = FastAPI(title="acb-ingest-zoho-webhook", version="0.1.0")
standalone.include_router(router)
