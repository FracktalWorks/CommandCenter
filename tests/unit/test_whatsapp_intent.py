"""Unit tests for the deterministic WhatsApp intent classifier."""

from __future__ import annotations

import pytest
from gateway.routes.whatsapp.automation.intent import classify_intent


@pytest.mark.parametrize("body,expected", [
    # payment
    ("Sir, invoice FW-2291 is still pending", "payment"),
    ("kab tak payment ho jayega", "payment"),
    ("Please share the proforma invoice", "payment"),
    # order status
    ("Where is my order? kab milega", "order_status"),
    ("Has it been dispatched yet?", "order_status"),
    ("Can you share the AWB tracking number", "order_status"),
    # quote
    ("Please send a quotation for 2 Falcons", "quote_request"),
    ("kitna hoga for the edu bundle?", "quote_request"),
    ("Can I get the price list?", "quote_request"),
    # service
    ("The nozzle is jammed, printer not working", "service_issue"),
    ("machine kharab hai, need service", "service_issue"),
    # scheduling
    ("Can we schedule a demo call?", "scheduling"),
    ("kab free ho for a visit", "scheduling"),
    # social
    ("Hi", "social"),
    ("Good morning 🙏", "social"),
    ("thank you!", "social"),
    # spam
    ("Congratulations you have won a lucky draw", "spam"),
])
def test_intent_matches(body, expected) -> None:
    assert classify_intent(body) == expected


def test_unmatched_returns_none() -> None:
    assert classify_intent("The blue widget is on the third shelf") is None
    assert classify_intent("") is None
    assert classify_intent(None) is None
    assert classify_intent("   ") is None


def test_specificity_payment_beats_greeting_prefix() -> None:
    # A message that opens with a greeting but is really about an overdue invoice
    # must classify as payment, not social (payment pattern is checked first and
    # the social pattern only matches a *pure* greeting).
    assert classify_intent("Hi sir, the invoice is overdue") == "payment"


def test_pure_greeting_is_social_not_payment() -> None:
    assert classify_intent("Hello 👍") == "social"
