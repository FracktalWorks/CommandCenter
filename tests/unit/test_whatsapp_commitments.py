"""Unit tests for the WhatsApp commitment extractor (both directions)."""

from __future__ import annotations

import pytest
from gateway.routes.whatsapp.automation.commitments import extract_commitment


@pytest.mark.parametrize("body,expect_due", [
    ("I'll send the revised quote by Friday", "by friday"),
    ("we'll ship the units tomorrow", "tomorrow"),
    ("Sure, will share the AWB number by tomorrow", "by tomorrow"),
    ("I will get back to you with the numbers", None),
    ("sending you the invoice today", "today"),
    ("Let me check with accounts and revert", None),
    ("we'll deliver within two weeks", "within two weeks"),
])
def test_promises_are_extracted_with_due_hint(body, expect_due) -> None:
    result = extract_commitment(body)
    assert result is not None
    text_val, due = result
    assert text_val == body.strip()[:200]
    assert due == expect_due


@pytest.mark.parametrize("body", [
    "The meeting is by Friday",          # deadline but no promise verb
    "How much for 2 units?",             # a question, not a promise
    "Thanks, received the payment",       # acknowledgement
    "Where is my order?",                 # an ask, not a commitment
    "",
    None,
])
def test_non_commitments_return_none(body) -> None:
    assert extract_commitment(body) is None


def test_text_is_bounded() -> None:
    body = "I'll send " + ("x" * 500)
    result = extract_commitment(body)
    assert result is not None
    assert len(result[0]) <= 200


def test_commitment_route_registered() -> None:
    from gateway.routes.whatsapp import router
    paths = {r.path for r in router.routes}
    assert "/whatsapp/commitments" in paths
