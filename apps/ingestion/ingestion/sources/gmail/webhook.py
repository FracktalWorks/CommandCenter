"""Gmail push-notification receiver (WBS 1.3).

Google Workspace pushes Gmail change events into a Cloud Pub/Sub topic which
in turn POSTs the message to this endpoint. Each notification body is a
base64-encoded JSON `{ emailAddress, historyId }` blob.

We verify the bearer token (an audience we configure on the Pub/Sub subscription),
ack-200 immediately, and enqueue a follow-up `list_history(historyId)` call.
"""
from __future__ import annotations

import base64
import binascii
import hmac
import json
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from acb_audit import AuditEvent, record
from acb_common import get_logger, get_settings

router = APIRouter(prefix="/webhooks/gmail", tags=["ingestion:gmail"])
_log = get_logger("ingestion.gmail")


def _verify_bearer(authorization: str | None) -> bool:
    """Verify the shared bearer token Pub/Sub sends on every push."""
    expected = get_settings().gmail_pubsub_token
    if not expected or not authorization or not authorization.lower().startswith("bearer "):
        return False
    presented = authorization.split(" ", 1)[1].strip()
    return hmac.compare_digest(expected, presented)


def _decode_envelope(envelope: dict[str, Any]) -> dict[str, Any]:
    """Extract the Gmail notification payload from a Pub/Sub envelope."""
    msg = envelope.get("message") or {}
    data = msg.get("data")
    if not data:
        return {}
    try:
        decoded = base64.b64decode(data).decode("utf-8")
        return json.loads(decoded)  # type: ignore[no-any-return]
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return {}


@router.post("")
async def receive(request: Request, authorization: str | None = Header(default=None)) -> dict[str, str]:
    if not _verify_bearer(authorization):
        raise HTTPException(status_code=401, detail="invalid bearer")
    envelope = await request.json()
    notification = _decode_envelope(envelope)
    email_address = notification.get("emailAddress")
    history_id = notification.get("historyId")
    _log.info("gmail.webhook", email=email_address, history_id=history_id)
    record(
        AuditEvent(
            actor="webhook:gmail",
            action="received",
            target=f"gmail:{email_address or 'unknown'}",
            payload={"history_id": history_id},
        )
    )
    # TODO WBS 1.3 follow-up: enqueue list_history + normalise + triage chain.
    return {"status": "accepted"}


__all__ = ["router", "_decode_envelope", "_verify_bearer"]
