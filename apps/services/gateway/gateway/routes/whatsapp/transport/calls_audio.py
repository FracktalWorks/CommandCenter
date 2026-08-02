"""Transport · call audio — duplex microphone/speaker for a live WhatsApp call.

The browser holds the mic and speakers; the bridge holds the WhatsApp session.
This is the pipe between them:

    browser ──WSS──► gateway ──WS──► bridge ──► MLow/SRTP ──► peer
    browser ◄──WSS── gateway ◄──WS── bridge ◄── decoded peer audio

Frames are raw little-endian int16 mono at 16 kHz, one 960-sample (60 ms) frame
per binary message — meowcaller's native framing, so nothing resamples in the
middle. The gateway is a byte pump: it never inspects or transforms audio.

**Why a token instead of the usual auth.** Every other route here is called by
the Next proxy, which attaches the internal bearer and X-User-Email server-side.
A browser WebSocket cannot set headers, and the workbench's session cookie is
scoped to a different origin than the gateway. So the browser first asks the
(normally authenticated) HTTP endpoint for a short-lived signed token, then
presents it on the socket. Same shape as the notes app's live-STT token.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time

from acb_auth import UserContext, get_current_user
from acb_common import get_logger
from fastapi import Depends, HTTPException, WebSocket, WebSocketDisconnect
from gateway.routes.whatsapp.core import router
from gateway.routes.whatsapp.transport.bridge import _bridge_url
from gateway.routes.whatsapp.transport.calls import _assert_owns_account
from pydantic import BaseModel

_log = get_logger("gateway.whatsapp.call_audio")

_SECRET_ENV = "WHATSAPP_BRIDGE_SECRET"
#: Long enough to survive a slow page, short enough that a leaked URL is stale
#: before it's useful. The token authorises one call, not an account.
_TOKEN_TTL_SECS = 120


def _signing_key() -> bytes:
    """Sign with the bridge secret — it's already required for calling to work
    at all, so this adds no new configuration to get wrong."""
    return os.environ.get(_SECRET_ENV, "").strip().encode() or b"dev-insecure"


def mint_audio_token(account_id: str, call_id: str, now: float | None = None) -> str:
    """Sign an account+call pair with an expiry. Pure — unit-testable."""
    payload = {
        "a": account_id,
        "c": call_id,
        "exp": int((now if now is not None else time.time()) + _TOKEN_TTL_SECS),
    }
    raw = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(_signing_key(), raw, hashlib.sha256).digest()
    return f"{raw.decode()}.{base64.urlsafe_b64encode(sig).decode()}"


def verify_audio_token(token: str, now: float | None = None) -> tuple[str, str] | None:
    """Return ``(account_id, call_id)`` for a valid token, else None.

    Constant-time on the signature, and the expiry is checked only after the
    signature verifies so a forged token can't be probed for timing."""
    try:
        raw_b64, sig_b64 = token.split(".", 1)
        raw = raw_b64.encode()
        expected = hmac.new(_signing_key(), raw, hashlib.sha256).digest()
        if not hmac.compare_digest(base64.urlsafe_b64decode(sig_b64), expected):
            return None
        payload = json.loads(base64.urlsafe_b64decode(raw))
    except Exception:
        return None

    if float(payload.get("exp", 0)) < (now if now is not None else time.time()):
        return None
    account_id, call_id = str(payload.get("a", "")), str(payload.get("c", ""))
    if not account_id or not call_id:
        return None
    return account_id, call_id


class AudioTokenModel(BaseModel):
    token: str
    #: Absolute ws(s):// URL the browser opens.
    #:
    #: Built here rather than in the client because the browser talks to the
    #: workbench origin, and Next's App Router cannot proxy a WebSocket upgrade
    #: — so audio has to go straight to the gateway, whose public origin only
    #: the server knows.
    ws_url: str
    expires_in: int


def _public_ws_url(token: str) -> str:
    """Absolute websocket URL for the audio socket.

    Falls back to a same-origin relative URL when GATEWAY_PUBLIC_URL is unset,
    which is the local-dev case where the client can reach the gateway itself."""
    base = os.environ.get("GATEWAY_PUBLIC_URL", "").strip().rstrip("/")
    query = f"?token={token}"
    if not base:
        return f"/whatsapp/calls/audio{query}"
    if base.startswith("https://"):
        base = "wss://" + base[len("https://"):]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://"):]
    return f"{base}/whatsapp/calls/audio{query}"


@router.post("/calls/{call_id}/audio-token", response_model=AudioTokenModel)
async def audio_token(
    call_id: str, account_id: str, user: UserContext = Depends(get_current_user),
) -> AudioTokenModel:
    """Mint a short-lived token for this call's audio socket."""
    await _assert_owns_account(account_id, user)
    if not os.environ.get(_SECRET_ENV, "").strip():
        # Signing with a dev fallback would mean anyone can mint a token.
        raise HTTPException(
            status_code=503,
            detail="Call audio needs WHATSAPP_BRIDGE_SECRET set on the server.")
    token = mint_audio_token(account_id, call_id)
    return AudioTokenModel(
        token=token, ws_url=_public_ws_url(token), expires_in=_TOKEN_TTL_SECS)


def _bridge_ws_url(account_id: str, call_id: str) -> str:
    base = _bridge_url()
    ws = "wss://" + base[len("https://"):] if base.startswith("https://") else \
         "ws://" + base[len("http://"):] if base.startswith("http://") else base
    return f"{ws}/call/audio?session={account_id}&call_id={call_id}"


@router.websocket("/calls/audio")
async def call_audio(ws: WebSocket) -> None:
    """Pump audio frames between the browser and the bridge, both ways.

    Deliberately dumb: no buffering, no transcoding, no inspection. Every added
    millisecond here is a millisecond of conversational lag, and the two ends
    already agree on the frame format."""
    token = ws.query_params.get("token", "")
    claims = verify_audio_token(token)
    if claims is None:
        # 1008 = policy violation. Rejected before accept, so no audio flows.
        await ws.close(code=1008, reason="invalid or expired audio token")
        return
    account_id, call_id = claims

    import websockets

    await ws.accept()
    try:
        headers = {}
        secret = os.environ.get(_SECRET_ENV, "").strip()
        if secret:
            headers["X-Bridge-Secret"] = secret
        async with websockets.connect(
            _bridge_ws_url(account_id, call_id),
            additional_headers=headers,
            max_size=None,
            ping_interval=20,
        ) as bridge:
            _log.info("whatsapp.call_audio.open", call_id=call_id[:32])
            await _pump(ws, bridge)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        _log.warning("whatsapp.call_audio.failed", error=str(exc)[:200])
        try:
            await ws.close(code=1011, reason="bridge audio unavailable")
        except Exception:
            pass
    finally:
        _log.info("whatsapp.call_audio.closed", call_id=call_id[:32])


async def _pump(browser: WebSocket, bridge) -> None:
    """Run both directions until either side hangs up.

    Whichever leg finishes first cancels the other — a half-open audio socket
    is worse than a closed one, because the UI would still look connected."""

    async def up() -> None:
        while True:
            frame = await browser.receive_bytes()
            await bridge.send(frame)

    async def down() -> None:
        async for frame in bridge:
            if isinstance(frame, bytes):
                await browser.send_bytes(frame)

    tasks = [asyncio.create_task(up()), asyncio.create_task(down())]
    try:
        _done, pending = await asyncio.wait(
            tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    finally:
        for t in tasks:
            t.cancel()
