"""Unit tests for sender identity / direction-aware classification (Phase 1).

The fix: classification looked at one email in isolation with no DIRECTION
signal, so an OUTBOUND/internal document (e.g. an invoice the user's sales team
sent a customer) was mislabelled as a received ``Receipt``. ``sender_scope``
(self / internal / external) is the primitive that feeds the rule classifier and
the sender categorizer so they refuse receive-only categories for own/org mail.
"""
from __future__ import annotations

from types import SimpleNamespace

from gateway.routes.email.automation import engine as _eng
from gateway.routes.email.automation import identity as _id

# ── sender_scope ─────────────────────────────────────────────────────────────

def test_sender_scope_self() -> None:
    assert _id.sender_scope("me@acme.com", "me@acme.com") == "self"
    # Case-insensitive on both sides.
    assert _id.sender_scope("Me@Acme.com", "me@acme.com") == "self"


def test_sender_scope_internal_same_domain() -> None:
    # The exact bug: a teammate sends an invoice from the same org domain.
    assert _id.sender_scope("sales@acme.com", "me@acme.com") == "internal"
    assert _id.sender_scope("billing@acme.com", "me@acme.com") == "internal"


def test_sender_scope_external() -> None:
    assert _id.sender_scope("customer@other.com", "me@acme.com") == "external"


def test_sender_scope_extra_domains_seam() -> None:
    # Configurable multi-domain (future setting) — bare or @-prefixed both work.
    assert _id.sender_scope("ops@acme.io", "me@acme.com", {"acme.io"}) == "internal"
    assert _id.sender_scope("ops@acme.io", "me@acme.com", {"@acme.io"}) == "internal"


def test_sender_scope_fails_safe_to_external() -> None:
    # Empty / garbage / no-self must never suppress a real receive-category.
    assert _id.sender_scope("", "me@acme.com") == "external"
    assert _id.sender_scope("garbage", "me@acme.com") == "external"
    assert _id.sender_scope("x@acme.com", "") == "external"


def test_is_own_mail() -> None:
    assert _id.is_own_mail("sales@acme.com", "me@acme.com") is True
    assert _id.is_own_mail("me@acme.com", "me@acme.com") is True
    assert _id.is_own_mail("ext@other.com", "me@acme.com") is False


# ── email_dict_from_row carries sender_scope ─────────────────────────────────

def _row(from_email: str) -> SimpleNamespace:
    return SimpleNamespace(
        from_address={"email": from_email, "name": "X"}, subject="Invoice #5",
        body_text="Please find the invoice attached.", to_addresses=[],
        cc_addresses=[], received_at=None, thread_id="t1")


def test_email_dict_includes_sender_scope() -> None:
    assert _eng.email_dict_from_row(_row("sales@acme.com"), "me@acme.com")[
        "sender_scope"] == "internal"
    assert _eng.email_dict_from_row(_row("cust@other.com"), "me@acme.com")[
        "sender_scope"] == "external"
    assert _eng.email_dict_from_row(_row("me@acme.com"), "me@acme.com")[
        "sender_scope"] == "self"
    # No self_email known → fail safe to external (legacy behaviour preserved).
    assert _eng.email_dict_from_row(_row("sales@acme.com"))[
        "sender_scope"] == "external"


# ── _email_block renders provenance only for own/org mail ────────────────────

def test_email_block_marks_outbound_and_internal() -> None:
    internal = _eng._email_block(
        {"from": "sales@acme.com", "sender_scope": "internal",
         "subject": "Invoice", "body": "x"})
    assert "INTERNAL/OUTBOUND" in internal

    own = _eng._email_block(
        {"from": "me@acme.com", "sender_scope": "self",
         "subject": "s", "body": "x"})
    assert "OUTBOUND" in own

    external = _eng._email_block(
        {"from": "cust@other.com", "sender_scope": "external",
         "subject": "s", "body": "y"})
    assert "Provenance:" not in external


def test_classifier_guidelines_mention_direction() -> None:
    # The directive that stops outbound mail matching a Receipt-style rule.
    assert "DIRECTION MATTERS" in _eng._CLASSIFIER_GUIDELINES
    assert "Receipt" in _eng._CLASSIFIER_GUIDELINES
