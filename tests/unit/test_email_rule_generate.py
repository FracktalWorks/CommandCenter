"""Unit tests for the NL → rules normalizer (inbox-zero plain-text rule flow).

`_normalize_generated_rules` sanitizes the LLM's JSON into safe rule specs.
Pure function — no LLM/network touched.
"""
from __future__ import annotations

from gateway.routes import email as m


def test_single_rule_normalized() -> None:
    out = m._normalize_generated_rules([
        {"name": "Receipts", "instructions": "purchase receipts and invoices",
         "actions": [{"type": "label", "label": "Receipt"}]},
    ])
    assert len(out) == 1
    r = out[0]
    assert r["name"] == "Receipts"
    assert r["instructions"] == "purchase receipts and invoices"
    assert r["conditional_operator"] == "AND"
    assert r["actions"] == [{
        "type": "LABEL", "label": "Receipt", "to_address": None,
        "subject": None, "content": None, "url": None,
    }]


def test_bare_dict_is_wrapped() -> None:
    out = m._normalize_generated_rules(
        {"name": "X", "actions": [{"type": "ARCHIVE"}]})
    assert len(out) == 1 and out[0]["name"] == "X"


def test_multiple_rules() -> None:
    out = m._normalize_generated_rules([
        {"name": "A", "actions": [{"type": "ARCHIVE"}]},
        {"name": "B", "actions": [{"type": "STAR"}]},
    ])
    assert [r["name"] for r in out] == ["A", "B"]


def test_drops_unknown_action_types() -> None:
    out = m._normalize_generated_rules([
        {"name": "A", "actions": [{"type": "NUKE_INBOX"}]},  # invalid → no actions
        {"name": "B", "actions": [{"type": "ARCHIVE"}, {"type": "BOGUS"}]},
    ])
    # "A" dropped (no valid action); "B" keeps only ARCHIVE.
    assert [r["name"] for r in out] == ["B"]
    assert [a["type"] for a in out[0]["actions"]] == ["ARCHIVE"]


def test_drops_specs_without_name() -> None:
    out = m._normalize_generated_rules([
        {"name": "", "actions": [{"type": "ARCHIVE"}]},
        {"actions": [{"type": "ARCHIVE"}]},
    ])
    assert out == []


def test_operator_normalized_to_or() -> None:
    out = m._normalize_generated_rules([
        {"name": "A", "conditional_operator": "or",
         "actions": [{"type": "ARCHIVE"}]},
    ])
    assert out[0]["conditional_operator"] == "OR"


def test_non_list_non_dict_returns_empty() -> None:
    assert m._normalize_generated_rules("nope") == []
    assert m._normalize_generated_rules(None) == []


def test_name_clamped_to_60_chars() -> None:
    out = m._normalize_generated_rules([
        {"name": "x" * 200, "actions": [{"type": "ARCHIVE"}]},
    ])
    assert len(out[0]["name"]) == 60
