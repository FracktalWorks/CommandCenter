"""Unit tests for learned classification-pattern matching (inbox-zero parity:
bidirectional FROM, number-generalised SUBJECT)."""
from __future__ import annotations

from gateway.routes import email as m

_eng = m.automation.engine


def test_generalize_subject_strips_numbers_parens_and_ids() -> None:
    assert _eng._generalize_subject("Invoice (#1234) - Order 5678") == "Invoice - Order"


def test_subject_pattern_matches_across_different_numbers() -> None:
    # A learned "Invoice …" pattern should still match a differently-numbered one.
    assert _eng._pattern_hit(("SUBJECT", "Invoice 0001"),
                             {"subject": "Invoice 9999 is due"})


def test_subject_pattern_plain_substring_still_matches() -> None:
    assert _eng._pattern_hit(("SUBJECT", "newsletter"),
                             {"subject": "Weekly newsletter"})


def test_from_pattern_is_bidirectional() -> None:
    # Stored value broader than the from, and vice-versa, both match.
    assert _eng._pattern_hit(("FROM", "Alice <alice@acme.com>"),
                             {"from": "alice@acme.com"})
    assert _eng._pattern_hit(("FROM", "@acme.com"), {"from": "bob@acme.com"})


def test_from_pattern_empty_from_never_matches() -> None:
    assert not _eng._pattern_hit(("FROM", "alice@acme.com"), {"from": ""})
