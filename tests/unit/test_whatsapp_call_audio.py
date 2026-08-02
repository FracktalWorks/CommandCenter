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
