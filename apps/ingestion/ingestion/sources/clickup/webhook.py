"""ClickUp webhook receiver. Mount under the gateway or run standalone."""
from __future__ import annotations

import hashlib
import hmac

from fastapi import APIRouter, Header, HTTPException, Request

from acb_common import get_logger, get_settings

router = APIRouter(prefix="/webhooks/clickup", tags=["ingestion:clickup"])
_log = get_logger("ingestion.clickup")


def _verify(body: bytes, signature: str | None) -> bool:
    """Verify ClickUp's HMAC-SHA256 webhook signature."""
    secret = get_settings().clickup_webhook_secret
    if not secret or not signature:
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, signature)


@router.post("")
async def receive(request: Request, x_signature: str | None = Header(default=None)) -> dict[str, str]:
    body = await request.body()
    if not _verify(body, x_signature):
        raise HTTPException(status_code=401, detail="invalid signature")
    payload = await request.json()
    _log.info("clickup.webhook", event=payload.get("event"))
    # TODO WBS 0.3: enqueue normalisation job onto Redis Streams.
    return {"status": "accepted"}
