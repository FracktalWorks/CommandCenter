"""Unit tests for learned classification patterns (inbox-zero parity).

Covers the pure matching helpers — `_pattern_hit`, `_patterns_excluded_rules`,
`_patterns_included_rule` — for both FROM (sender) and SUBJECT (keyword)
patterns. No DB or network is touched.
"""
from __future__ import annotations

from gateway.routes import email as m

_EMAIL = {
    "from": "billing@acme.com",
    "subject": "Your invoice #4012 is ready",
    "body": "See attached.",
}


def test_pattern_hit_from_substring_ci() -> None:
    assert m._pattern_hit(("FROM", "acme.com"), _EMAIL) is True
    assert m._pattern_hit(("FROM", "ACME.COM"), _EMAIL) is True
    assert m._pattern_hit(("FROM", "other.com"), _EMAIL) is False


def test_pattern_hit_subject_substring_ci() -> None:
    assert m._pattern_hit(("SUBJECT", "invoice"), _EMAIL) is True
    assert m._pattern_hit(("SUBJECT", "INVOICE"), _EMAIL) is True
    assert m._pattern_hit(("SUBJECT", "receipt"), _EMAIL) is False


def test_pattern_hit_empty_value_never_matches() -> None:
    assert m._pattern_hit(("FROM", ""), _EMAIL) is False
    assert m._pattern_hit(("SUBJECT", "   "), _EMAIL) is False


def test_excluded_rules_by_subject_pattern() -> None:
    patterns = {
        "rule-a": {"include": [], "exclude": [("SUBJECT", "invoice")]},
        "rule-b": {"include": [], "exclude": [("SUBJECT", "newsletter")]},
    }
    excluded = m._patterns_excluded_rules(patterns, _EMAIL)
    assert excluded == {"rule-a"}


def test_included_rule_by_subject_pattern() -> None:
    patterns = {"rule-a": {"include": [("SUBJECT", "invoice")], "exclude": []}}
    assert m._patterns_included_rule({"id": "rule-a"}, patterns, _EMAIL) is True
    assert m._patterns_included_rule({"id": "rule-b"}, patterns, _EMAIL) is False


def test_included_rule_mixed_from_and_subject() -> None:
    # An include with a non-matching FROM but a matching SUBJECT still hits.
    patterns = {
        "rule-a": {
            "include": [("FROM", "nope@other.com"), ("SUBJECT", "invoice")],
            "exclude": [],
        }
    }
    assert m._patterns_included_rule({"id": "rule-a"}, patterns, _EMAIL) is True
