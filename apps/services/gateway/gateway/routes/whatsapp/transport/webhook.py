"""Transport · webhook — the public Meta Cloud API endpoint.

Two verbs, no auth (Meta calls it):

* ``GET  /whatsapp/webhook`` — the subscription handshake. Meta sends
  ``hub.mode/hub.verify_token/hub.challenge``; we echo the challenge when the
  token matches the configured one.
* ``POST /whatsapp/webhook`` — the event feed. We verify the
  ``X-Hub-Signature-256`` HMAC over the RAW body, parse it, resolve the owning
  account by ``phone_number_id``, persist idempotently, and fire the post-sync
  hooks. We return 200 fast so Meta doesn't retry a slow-but-successful batch.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any

from acb_common import get_logger
from fastapi import Request, Response
from gateway.routes.whatsapp.core import _get_db, router
from sqlalchemy import text

_log = get_logger("gateway.whatsapp.webhook")


def verify_signature(app_secret: str | None, raw_body: bytes, header: str | None) -> bool:
    """Verify Meta's ``X-Hub-Signature-256: sha256=<hex>`` over the raw body.

    Pure + unit-testable. When no ``app_secret`` is configured we return True and
    log a warning (dev/self-host without the secret set) — production MUST set
    ``WHATSAPP_APP_SECRET``. A malformed/missing header with a secret present
    fails closed.
    """
    if not app_secret:
        _log.warning("whatsapp.webhook.signature_unverified_no_secret")
        return True
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(
        app_secret.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    provided = header.split("=", 1)[1]
    return hmac.compare_digest(expected, provided)


@router.get("/webhook")
async def verify_webhook(request: Request):
    """Meta subscription verification handshake."""
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge", "")
    configured = os.environ.get("WHATSAPP_VERIFY_TOKEN")

    ok_token = configured and token == configured
    if not ok_token:
        # Fall back to matching any stored per-account verify token.
        db = await _get_db()
        try:
            row = (await db.execute(
                text("""SELECT 1 FROM wa_accounts
                        WHERE webhook_verify_token = :t LIMIT 1"""),
                {"t": token},
            )).fetchone()
            ok_token = bool(row)
        finally:
            await db.close()

    if mode == "subscribe" and ok_token:
        return Response(content=challenge, media_type="text/plain")
    return Response(status_code=403, content="verification failed")


async def _resolve_account_id(db: Any, phone_number_id: str | None) -> str | None:
    if not phone_number_id:
        return None
    row = (await db.execute(
        text("SELECT id FROM wa_accounts WHERE phone_number_id = :pnid"),
        {"pnid": phone_number_id},
    )).fetchone()
    return str(row.id) if row else None


@router.post("/webhook")
async def receive_webhook(request: Request):
    """Ingest a Meta event batch: verify → parse → persist → hooks."""
    raw = await request.body()
    if not verify_signature(
        os.environ.get("WHATSAPP_APP_SECRET"), raw,
        request.headers.get("X-Hub-Signature-256"),
    ):
        return Response(status_code=403, content="bad signature")

    import json
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        return Response(status_code=400, content="invalid json")

    from whatsapp_ingestion.persist import persist_sync_result
    from whatsapp_ingestion.providers.webhook import parse_webhook

    result = parse_webhook(payload)
    if not result.phone_number_id:
        # A status-only or empty batch with no metadata — ack so Meta stops.
        return Response(status_code=200, content="ok")

    db = await _get_db()
    try:
        account_id = await _resolve_account_id(db, result.phone_number_id)
        if not account_id:
            _log.warning(
                "whatsapp.webhook.unknown_number",
                phone_number_id=result.phone_number_id,
            )
            return Response(status_code=200, content="ok")  # ack; nothing to do

        counts = await persist_sync_result(db, account_id, result)
        await db.commit()

        # Fire the post-sync pipeline (no-op until W2 registers hooks). Best-effort
        # so a hook failure never turns into a Meta retry of an already-stored batch.
        if counts["messages"]:
            try:
                from whatsapp_ingestion.post_sync import (
                    hooks,
                    run_hook,
                )
                await run_hook(hooks.on_new_messages, account_id)
            except Exception as exc:
                _log.warning("whatsapp.webhook.hook_failed", error=str(exc)[:200])

        _log.info(
            "whatsapp.webhook.ingested",
            account_id=account_id, messages=counts["messages"],
            statuses=len(result.statuses),
        )
        return Response(status_code=200, content="ok")
    finally:
        await db.close()
