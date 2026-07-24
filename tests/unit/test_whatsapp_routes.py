"""Unit tests for the WhatsApp gateway route helpers + router assembly.

Covers the pure decision functions (webhook signature verification, the 24h
send-window guard) and asserts the whole route package imports and registers its
paths on the shared router — a cheap guard against an import/wiring regression.
"""

from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException

# ── webhook signature verification ────────────────────────────────────────────

def _sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_valid_signature_passes() -> None:
    from gateway.routes.whatsapp.transport.webhook import verify_signature
    body = b'{"entry": []}'
    assert verify_signature("s3cr3t", body, _sign("s3cr3t", body)) is True


def test_tampered_body_fails() -> None:
    from gateway.routes.whatsapp.transport.webhook import verify_signature
    sig = _sign("s3cr3t", b'{"entry": []}')
    assert verify_signature("s3cr3t", b'{"entry": [{"evil": 1}]}', sig) is False


def test_missing_or_malformed_header_fails_closed_with_secret() -> None:
    from gateway.routes.whatsapp.transport.webhook import verify_signature
    assert verify_signature("s3cr3t", b"x", None) is False
    assert verify_signature("s3cr3t", b"x", "md5=deadbeef") is False


def test_no_secret_configured_passes_with_warning() -> None:
    # Dev / self-host without WHATSAPP_APP_SECRET set: don't hard-block ingest.
    from gateway.routes.whatsapp.transport.webhook import verify_signature
    assert verify_signature(None, b"x", None) is True


# ── 24h send window + regime ──────────────────────────────────────────────────

def test_window_open_only_before_expiry() -> None:
    from gateway.routes.whatsapp.transport.send import window_is_open
    now = datetime(2026, 7, 23, 12, 0, tzinfo=UTC)
    assert window_is_open(now + timedelta(hours=1), now) is True
    assert window_is_open(now - timedelta(hours=1), now) is False
    assert window_is_open(None, now) is False


def test_text_inside_window_is_session_send() -> None:
    from gateway.routes.whatsapp.transport.send import SendRequest, choose_regime
    assert choose_regime(SendRequest(text="hi"), window_open=True) == "session"


def test_text_outside_window_is_blocked() -> None:
    from gateway.routes.whatsapp.transport.send import SendRequest, choose_regime
    with pytest.raises(HTTPException) as exc:
        choose_regime(SendRequest(text="hi"), window_open=False)
    assert exc.value.status_code == 409  # must use a template


def test_template_always_allowed_even_when_window_closed() -> None:
    from gateway.routes.whatsapp.transport.send import SendRequest, choose_regime
    req = SendRequest(template_name="payment_reminder")
    assert choose_regime(req, window_open=False) == "template"


def test_empty_send_is_rejected() -> None:
    from gateway.routes.whatsapp.transport.send import SendRequest, choose_regime
    with pytest.raises(HTTPException) as exc:
        choose_regime(SendRequest(), window_open=True)
    assert exc.value.status_code == 400


# ── router assembly ───────────────────────────────────────────────────────────

def test_router_registers_expected_paths() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    for expected in (
        "/whatsapp/accounts",
        "/whatsapp/streams",
        "/whatsapp/chats",
        "/whatsapp/chats/{chat_id}/messages",
        "/whatsapp/chats/{chat_id}/send",
        "/whatsapp/search",
        "/whatsapp/webhook",
    ):
        assert expected in paths, f"missing route {expected}"
