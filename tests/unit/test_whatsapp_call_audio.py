"""Unit tests for the call-audio socket token (transport/calls_audio.py).

This token is the only thing standing between a browser WebSocket and someone
else's live call audio — the socket can't carry the internal bearer, so the
signature *is* the authentication. These tests pin that.
"""

from __future__ import annotations

import time

import pytest

import gateway.routes.whatsapp.transport.calls_audio as audio


@pytest.fixture(autouse=True)
def _secret(monkeypatch) -> None:
    monkeypatch.setenv("WHATSAPP_BRIDGE_SECRET", "test-secret-please-ignore")


def test_round_trip() -> None:
    token = audio.mint_audio_token("acct-1", "CALL123")
    assert audio.verify_audio_token(token) == ("acct-1", "CALL123")


def test_expired_token_is_rejected() -> None:
    token = audio.mint_audio_token("acct-1", "CALL123", now=time.time() - 10_000)
    assert audio.verify_audio_token(token) is None


def test_token_from_a_different_secret_is_rejected(monkeypatch) -> None:
    token = audio.mint_audio_token("acct-1", "CALL123")
    monkeypatch.setenv("WHATSAPP_BRIDGE_SECRET", "a-different-secret")
    assert audio.verify_audio_token(token) is None


def test_tampering_with_the_payload_is_rejected() -> None:
    """The claims are base64, not encrypted — swapping in another account id has
    to fail on the signature, or the token is worthless."""
    token = audio.mint_audio_token("acct-1", "CALL123")
    raw, sig = token.split(".", 1)
    forged = audio.mint_audio_token("acct-2", "CALL999").split(".", 1)[0]
    assert audio.verify_audio_token(f"{forged}.{sig}") is None


@pytest.mark.parametrize(
    "bad",
    ["", "garbage", "no-dot-here", "a.b", "....", "!!!.???"],
)
def test_malformed_tokens_return_none_not_an_exception(bad: str) -> None:
    """A malformed token must be a clean rejection — an exception here would
    become a 500 on the socket handshake instead of a policy close."""
    assert audio.verify_audio_token(bad) is None


def test_token_is_scoped_to_one_call() -> None:
    """Two calls on the same account must not share a token: the socket
    authorises a specific call, not the account's audio in general."""
    a = audio.verify_audio_token(audio.mint_audio_token("acct", "CALL-A"))
    b = audio.verify_audio_token(audio.mint_audio_token("acct", "CALL-B"))
    assert a == ("acct", "CALL-A")
    assert b == ("acct", "CALL-B")


# ── public websocket URL ──────────────────────────────────────────────────────

def test_ws_url_upgrades_https_to_wss(monkeypatch) -> None:
    monkeypatch.setenv("GATEWAY_PUBLIC_URL", "https://api.example.com")
    url = audio._public_ws_url("tok")
    assert url == "wss://api.example.com/whatsapp/calls/audio?token=tok"


def test_ws_url_upgrades_http_to_ws(monkeypatch) -> None:
    monkeypatch.setenv("GATEWAY_PUBLIC_URL", "http://localhost:8000/")
    url = audio._public_ws_url("tok")
    assert url == "ws://localhost:8000/whatsapp/calls/audio?token=tok"


def test_ws_url_falls_back_to_same_origin(monkeypatch) -> None:
    """Unset public URL is the local-dev case, where the client can reach the
    gateway itself and resolves the scheme from its own page."""
    monkeypatch.delenv("GATEWAY_PUBLIC_URL", raising=False)
    assert audio._public_ws_url("tok") == "/whatsapp/calls/audio?token=tok"


# ── the handshake itself ──────────────────────────────────────────────────────

def _ws_app():
    """A minimal app carrying only the WebSocket router."""
    from fastapi import FastAPI

    from gateway.routes.whatsapp import ws_router

    app = FastAPI()
    app.include_router(ws_router)
    return app


def test_socket_rejects_a_bad_token_cleanly() -> None:
    """The regression this exists for.

    The audio socket first shipped on the feature-gated router, whose check
    takes an HTTP ``Request`` — a parameter FastAPI never populates for a
    WebSocket. The dependency raised before the handler ran, so the socket died
    at the handshake and BOTH audio directions failed with nothing in the log.
    Every unit test still passed, because none of them opened a socket.

    A bad token must therefore produce a clean policy close (1008), which only
    happens if our handler actually runs."""
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(_ws_app())
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/whatsapp/calls/audio?token=nonsense") as ws:
            ws.receive_bytes()
    assert exc.value.code == 1008


def test_socket_rejects_a_missing_token_cleanly() -> None:
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(_ws_app())
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/whatsapp/calls/audio") as ws:
            ws.receive_bytes()
    assert exc.value.code == 1008


def test_a_gated_router_cannot_serve_a_websocket() -> None:
    """Pins the reason the separate router exists.

    ``require_feature_router``'s check takes an HTTP ``Request``. FastAPI only
    populates that for HTTP routes, so on a WebSocket the dependency is called
    without it and dies with a TypeError — before any handler, and before any
    close code the client could interpret. Exempting the path does not help,
    since the dependency must still run to read the path.

    If a future change makes gated routers websocket-safe, this test fails and
    the workaround can go."""
    from fastapi import APIRouter, FastAPI, WebSocket
    from starlette.testclient import TestClient

    from acb_auth import require_feature_router

    gated = APIRouter(
        prefix="/x",
        dependencies=[require_feature_router("whatsapp", exempt=["/x/ws"])],
    )

    @gated.websocket("/ws")
    async def _ep(websocket: WebSocket) -> None:  # pragma: no cover - never runs
        await websocket.accept()

    app = FastAPI()
    app.include_router(gated)

    with pytest.raises(TypeError, match="request"):
        with TestClient(app).websocket_connect("/x/ws"):
            pass


def test_audio_socket_is_not_on_the_feature_gated_router() -> None:
    """Belt and braces: if someone moves it back onto `router`, the handshake
    breaks again in a way that's invisible until a human tries to talk."""
    from gateway.routes.whatsapp import router

    paths = {getattr(r, "path", None) for r in router.routes}
    assert "/whatsapp/calls/audio" not in paths


# ── dependencies ──────────────────────────────────────────────────────────────

def test_websocket_client_is_available() -> None:
    """The audio proxy imports `websockets` lazily, inside the socket handler.

    That means a missing dependency wouldn't fail at startup or in any other
    test — it would fail the first time someone pressed Talk. This is the guard
    that catches it in CI instead."""
    import websockets  # noqa: F401

    assert hasattr(websockets, "connect")


# ── bridge URL ────────────────────────────────────────────────────────────────

def test_bridge_ws_url_carries_session_and_call(monkeypatch) -> None:
    monkeypatch.setenv("WHATSAPP_BRIDGE_URL", "http://localhost:8790")
    url = audio._bridge_ws_url("acct", "CALL1")
    assert url == "ws://localhost:8790/call/audio?session=acct&call_id=CALL1"
