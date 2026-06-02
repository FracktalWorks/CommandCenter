"""Microsoft Graph change-notification receiver (WBS 1.3).

Graph webhooks work differently from email-push APIs:
  1. Subscription validation: Graph POSTs ?validationToken=<token> once;
     we echo it back as plain-text/200 to prove ownership.
  2. Ongoing notifications: Graph POSTs a JSON body; we verify clientState,
     ack-200 immediately, and enqueue a follow-up fetch.

Endpoint: POST /webhooks/outlook

Required env: OUTLOOK_WEBHOOK_SECRET — must match the clientState we send
when creating subscriptions (POST /subscriptions).
"""
from __future__ import annotations

import hmac
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response

from acb_audit import AuditEvent, record
from acb_common import get_logger, get_settings

router = APIRouter(prefix="/webhooks/outlook", tags=["ingestion:outlook"])
_log = get_logger("ingestion.outlook")


def _verify_client_state(presented: str | None) -> bool:
    """Validate the clientState Graph includes in every notification."""
    expected = get_settings().outlook_webhook_secret
    if not expected or not presented:
        return False
    return hmac.compare_digest(expected, presented)


@router.post("")
async def receive(
    request: Request,
    validationToken: str | None = Query(default=None),  # noqa: N803 – Graph sends camelCase
) -> Response:
    # --- Subscription validation handshake (Graph calls once on subscribe) ---
    if validationToken:
        return Response(content=validationToken, media_type="text/plain", status_code=200)

    body: dict[str, Any] = await request.json()
    for notification in body.get("value") or []:
        client_state = notification.get("clientState")
        if not _verify_client_state(client_state):
            raise HTTPException(status_code=401, detail="invalid clientState")
        resource = notification.get("resource") or ""
        change_type = notification.get("changeType") or ""
        _log.info("outlook.webhook", resource=resource, change_type=change_type)
        record(
            AuditEvent(
                actor="webhook:outlook",
                action="received",
                target=f"outlook:{resource}",
                payload={"change_type": change_type},
            )
        )
        # TODO WBS 1.3 follow-up: enqueue fetch + normalise + triage chain.
    return Response(
        content='{"status":"accepted"}', media_type="application/json", status_code=200
    )


__all__ = ["router", "_verify_client_state"]

