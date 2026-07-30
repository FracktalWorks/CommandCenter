"""Inbound webhook trigger — the one public route in the package (spec F8).

``POST /workflows/hooks/{hook_token}``: the token IS the credential — an
unguessable per-workflow ``secrets.token_urlsafe(24)`` minted at creation.
Defense in depth on top of the token: optional HMAC (an enabled webhook
trigger whose config carries ``secret`` requires ``X-CC-Signature``, same
scheme as the agent webhook), a per-token rate limit, a body-size cap, and
the run only fires when the workflow is published with an enabled webhook
trigger. Listed in ``main.PUBLIC_ROUTES`` and the router's exempt set.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections import deque
from typing import Any

from fastapi import HTTPException, Request
from gateway.routes.workflows.core import (
    HOOK_RATE_LIMIT_PER_MINUTE,
    MAX_TRIGGER_PAYLOAD_BYTES,
    _get_db,
    _log,
    parse_jsonb,
    router,
)
from gateway.routes.workflows.service import (
    RunRejected,
    load_version_serialized,
    start_run,
)
from sqlalchemy import text

_RATE: dict[str, deque[float]] = {}


def _rate_limited(token: str) -> bool:
    now = time.monotonic()
    bucket = _RATE.setdefault(token, deque())
    while bucket and now - bucket[0] > 60.0:
        bucket.popleft()
    if len(bucket) >= HOOK_RATE_LIMIT_PER_MINUTE:
        return True
    bucket.append(now)
    return False


def verify_hook_signature(secret: str, body: bytes, presented: str | None) -> None:
    """HMAC-SHA256 over the raw body — same scheme as the agent webhook."""
    supplied = (presented or "").strip()
    if supplied.startswith("sha256="):
        supplied = supplied[len("sha256=") :]
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    if not supplied or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="Invalid webhook signature.")


@router.post("/hooks/{hook_token}", status_code=202)
async def workflow_hook(hook_token: str, request: Request) -> dict[str, Any]:
    if _rate_limited(hook_token):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    body = await request.body()
    if len(body) > MAX_TRIGGER_PAYLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Payload too large")

    db = await _get_db()
    try:
        row = (
            await db.execute(
                text(
                    "SELECT id, name, status, latest_version, variables "
                    "FROM workflows WHERE hook_token = :token"
                ),
                {"token": hook_token},
            )
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Unknown hook")
        trigger = (
            await db.execute(
                text(
                    "SELECT config FROM workflow_triggers "
                    "WHERE workflow_id = :wid AND kind = 'webhook' AND enabled "
                    "LIMIT 1"
                ),
                {"wid": str(row.id)},
            )
        ).fetchone()
        if trigger is None or row.status != "published" or not row.latest_version:
            # The token was right, but nothing may fire: say so honestly
            # without leaking whether the token exists to guessers (the 404
            # above covers guessing; this is a configured caller).
            raise HTTPException(
                status_code=409,
                detail="Workflow is not published with an enabled webhook trigger",
            )
        config = parse_jsonb(trigger.config, {}) or {}
        secret = str(config.get("secret") or "")
        if secret:
            verify_hook_signature(
                secret,
                body,
                request.headers.get("X-CC-Signature"),
            )
        serialized = await load_version_serialized(
            db,
            str(row.id),
            int(row.latest_version),
        )
        if serialized is None:
            raise HTTPException(status_code=500, detail="Published version missing")
        variables = parse_jsonb(row.variables, {})
    finally:
        await db.close()

    try:
        payload = json.loads(body.decode()) if body else {}
        if not isinstance(payload, dict):
            payload = {"body": payload}
    except (ValueError, UnicodeDecodeError):
        payload = {"raw": body.decode(errors="replace")[:10000]}

    try:
        run_id = await start_run(
            workflow_id=str(row.id),
            workflow_name=row.name,
            version=int(row.latest_version),
            serialized=serialized,
            trigger_kind="webhook",
            trigger_payload=payload,
            variables=variables,
            started_by="webhook",
        )
    except RunRejected as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    _log.info("workflows.hook_fired", workflow_id=str(row.id), run_id=run_id)
    return {"run_id": run_id, "status": "queued"}
