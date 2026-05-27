"""Unit tests for the Gmail normaliser + webhook helpers (WBS 1.3)."""
from __future__ import annotations

import base64
import json

from ingestion.sources.gmail.client import GmailMessageRaw, _decode_b64url, _extract_body, _header
from ingestion.sources.gmail.normaliser import _split_addresses, _split_name_addr, normalise
from ingestion.sources.gmail.webhook import _decode_envelope


# ---- helpers -------------------------------------------------------------

def _b64url(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).rstrip(b"=").decode()


# ---- header parsing ------------------------------------------------------

def test_split_addresses_and_name_addr() -> None:
    raw = '"Vijay R" <vijay@fracktal.in>, ops@fracktal.in, "Jane Doe" <jane@example.com>'
    assert _split_addresses(raw) == ["vijay@fracktal.in", "ops@fracktal.in", "jane@example.com"]
    assert _split_name_addr('"Vijay R" <vijay@fracktal.in>') == ("Vijay R", "vijay@fracktal.in")
    assert _split_name_addr("bare@example.com") == ("", "bare@example.com")
    assert _split_addresses("") == []


def test_header_lookup_is_case_insensitive() -> None:
    payload = {"headers": [{"name": "From", "value": "x@y"}, {"name": "Subject", "value": "Hi"}]}
    assert _header(payload, "from") == "x@y"
    assert _header(payload, "SUBJECT") == "Hi"
    assert _header(payload, "missing") == ""


def test_extract_body_prefers_text_plain_then_html() -> None:
    payload = {
        "parts": [
            {"mimeType": "text/html", "body": {"data": _b64url("<p>html</p>")}},
            {"mimeType": "text/plain", "body": {"data": _b64url("hello plain")}},
        ]
    }
    assert _extract_body(payload) == "hello plain"
    payload_html_only = {"parts": [{"mimeType": "text/html", "body": {"data": _b64url("<p>hi</p>")}}]}
    assert _extract_body(payload_html_only) == "<p>hi</p>"
    # Top-level body (no parts):
    assert _extract_body({"body": {"data": _b64url("top body")}}) == "top body"


def test_decode_b64url_handles_missing_padding() -> None:
    assert _decode_b64url(base64.urlsafe_b64encode(b"abc").rstrip(b"=").decode()) == "abc"


# ---- end-to-end normalise -----------------------------------------------

def test_normalise_full_message() -> None:
    raw = GmailMessageRaw(
        id="m-1",
        thread_id="t-1",
        label_ids=["INBOX"],
        snippet="Please send a quote",
        payload={
            "headers": [
                {"name": "From", "value": '"Acme Buyer" <buyer@acme.com>'},
                {"name": "To", "value": "sales@fracktal.in"},
                {"name": "Cc", "value": "ops@fracktal.in"},
                {"name": "Subject", "value": "Quote request for FDM printer"},
                {"name": "List-Id", "value": ""},
            ],
            "parts": [{"mimeType": "text/plain", "body": {"data": _b64url("body here")}}],
        },
        internal_date_ms=1_700_000_000_000,
    )
    msg = normalise(raw)
    assert msg.message_id == "m-1"
    assert msg.thread_id == "t-1"
    assert msg.from_addr == "buyer@acme.com"
    assert msg.from_name == "Acme Buyer"
    assert msg.to_addrs == ["sales@fracktal.in"]
    assert msg.cc_addrs == ["ops@fracktal.in"]
    assert msg.subject.startswith("Quote request")
    assert msg.body == "body here"
    assert msg.snippet == "Please send a quote"
    assert msg.headers["subject"] == "Quote request for FDM printer"


def test_normalise_missing_subject_and_from_get_safe_defaults() -> None:
    raw = GmailMessageRaw(id="x", thread_id="y", label_ids=[], snippet="", payload={"headers": []}, internal_date_ms=0)
    msg = normalise(raw)
    assert msg.subject == "(no subject)"
    assert msg.from_addr == "unknown@example.com"


# ---- pubsub envelope ----------------------------------------------------

def test_decode_envelope_extracts_inner_json() -> None:
    inner = {"emailAddress": "sales@fracktal.in", "historyId": "12345"}
    envelope = {"message": {"data": base64.b64encode(json.dumps(inner).encode()).decode()}}
    assert _decode_envelope(envelope) == inner


def test_decode_envelope_returns_empty_on_garbage() -> None:
    assert _decode_envelope({}) == {}
    assert _decode_envelope({"message": {"data": "!!!not-base64!!!"}}) == {}
