"""Unit tests for the Outlook normaliser + webhook helpers (WBS 1.3)."""
from __future__ import annotations

from ingestion.sources.outlook.client import (
    OutlookMessageRaw,
    _extract_addresses,
    _extract_email,
    _extract_name,
    _to_raw,
)
from ingestion.sources.outlook.normaliser import normalise
from ingestion.sources.outlook.webhook import _verify_client_state


# ---- helper builders -------------------------------------------------------

def _addr(address: str, name: str = "") -> dict:
    return {"emailAddress": {"address": address, "name": name}}


def _raw(**kwargs) -> OutlookMessageRaw:
    defaults = dict(
        id="m-1",
        conversation_id="c-1",
        subject="Test subject",
        body_preview="Preview text",
        body_content="Body content here",
        body_content_type="text",
        sender=_addr("sender@example.com", "Sender Name"),
        to_recipients=[_addr("to@example.com")],
        cc_recipients=[],
        received_at="2026-05-27T10:00:00Z",
        internet_message_headers=[],
        categories=[],
    )
    defaults.update(kwargs)
    return OutlookMessageRaw(**defaults)


# ---- address helpers -------------------------------------------------------

def test_extract_email_and_name() -> None:
    block = _addr("vijay@fracktal.in", "Vijay R")
    assert _extract_email(block) == "vijay@fracktal.in"
    assert _extract_name(block) == "Vijay R"


def test_extract_email_empty_block() -> None:
    assert _extract_email({}) == ""
    assert _extract_name({}) == ""


def test_extract_addresses_multiple() -> None:
    recipients = [
        _addr("sales@fracktal.in", "Sales"),
        _addr("ops@fracktal.in"),
        {"emailAddress": {}},   # empty — should be filtered
    ]
    assert _extract_addresses(recipients) == ["sales@fracktal.in", "ops@fracktal.in"]


# ---- _to_raw ----------------------------------------------------------------

def test_to_raw_projects_graph_message() -> None:
    graph_msg = {
        "id": "AAM...",
        "conversationId": "AAT...",
        "subject": "Quote request",
        "bodyPreview": "Please send a quote",
        "body": {"contentType": "text", "content": "Full body text"},
        "sender": _addr("buyer@acme.com", "Acme Buyer"),
        "toRecipients": [_addr("sales@fracktal.in")],
        "ccRecipients": [_addr("ops@fracktal.in")],
        "receivedDateTime": "2026-05-01T09:00:00Z",
        "internetMessageHeaders": [{"name": "List-Id", "value": ""}],
        "categories": [],
    }
    raw = _to_raw(graph_msg)
    assert raw.id == "AAM..."
    assert raw.conversation_id == "AAT..."
    assert raw.subject == "Quote request"
    assert raw.body_preview == "Please send a quote"
    assert raw.body_content == "Full body text"
    assert raw.body_content_type == "text"
    assert _extract_email(raw.sender) == "buyer@acme.com"


# ---- normalise --------------------------------------------------------------

def test_normalise_full_message() -> None:
    raw = _raw(
        id="m-1",
        conversation_id="c-1",
        subject="Quote request for FDM printer",
        body_preview="Please send a quote",
        body_content="body here",
        sender=_addr("buyer@acme.com", "Acme Buyer"),
        to_recipients=[_addr("sales@fracktal.in")],
        cc_recipients=[_addr("ops@fracktal.in")],
        received_at="2026-05-27T10:00:00Z",
        internet_message_headers=[{"name": "Subject", "value": "Quote request for FDM printer"}],
    )
    msg = normalise(raw)
    assert msg.message_id == "m-1"
    assert msg.thread_id == "c-1"
    assert msg.from_addr == "buyer@acme.com"
    assert msg.from_name == "Acme Buyer"
    assert msg.to_addrs == ["sales@fracktal.in"]
    assert msg.cc_addrs == ["ops@fracktal.in"]
    assert msg.subject.startswith("Quote request")
    assert msg.body == "body here"
    assert msg.snippet == "Please send a quote"
    assert msg.headers["subject"] == "Quote request for FDM printer"


def test_normalise_missing_subject_and_from_get_safe_defaults() -> None:
    raw = _raw(subject="", sender={}, to_recipients=[], received_at="bad")
    msg = normalise(raw)
    assert msg.subject == "(no subject)"
    assert msg.from_addr == "unknown@example.com"


def test_normalise_parses_iso_timestamp() -> None:
    raw = _raw(received_at="2026-01-15T08:30:00Z")
    msg = normalise(raw)
    assert msg.received_at is not None
    assert msg.received_at.year == 2026
    assert msg.received_at.month == 1


# ---- webhook ----------------------------------------------------------------

def test_verify_client_state_matches(monkeypatch) -> None:
    import acb_common.settings as s_mod
    from unittest.mock import MagicMock
    mock_settings = MagicMock()
    mock_settings.outlook_webhook_secret = "my-secret"
    monkeypatch.setattr(s_mod, "get_settings", lambda: mock_settings)
    # Re-import to pick up monkeypatch
    from importlib import import_module, reload
    wh = reload(import_module("ingestion.sources.outlook.webhook"))
    assert wh._verify_client_state("my-secret") is True
    assert wh._verify_client_state("wrong") is False
    assert wh._verify_client_state(None) is False

