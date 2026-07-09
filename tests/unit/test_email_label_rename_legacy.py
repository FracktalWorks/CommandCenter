"""Backward-compat regression for the "To Reply"→"Reply" / "Actioned"→"Done"
conversation-status rename (migration 63).

The user-facing labels and the internal enum keys were renamed, but old tokens
can still reach the code from three places that migration 63 does NOT rewrite in
lock-step: the LLM status determiner's output, a stale provider label delta, and
(briefly) an un-migrated rule row. These tests lock the legacy aliases that keep
those cases working — remove them only when legacy data can no longer exist."""
from __future__ import annotations

from types import SimpleNamespace

from gateway.routes import email as m

_eng = m.automation.engine
_rz = m.automation.replyzero
_rules = m.automation.rules


def test_canon_status_key_folds_legacy_tokens() -> None:
    assert _rz._canon_status_key("TO_REPLY") == "REPLY"
    assert _rz._canon_status_key("actioned") == "DONE"      # case-insensitive
    assert _rz._canon_status_key("REPLY") == "REPLY"        # new tokens pass through
    assert _rz._canon_status_key("AWAITING_REPLY") == "AWAITING_REPLY"
    assert _rz._canon_status_key("") == ""


def test_thread_status_map_resolves_via_legacy_key() -> None:
    # A determiner (or provider delta) that still emits the old token maps to the
    # same (derived status, new label) pair as the current token.
    legacy = _rz._THREAD_STATUS_MAP[_rz._canon_status_key("ACTIONED")]
    assert legacy == ("DONE", "Done")
    legacy_reply = _rz._THREAD_STATUS_MAP[_rz._canon_status_key("TO_REPLY")]
    assert legacy_reply == ("NEEDS_REPLY", "Reply")


def test_legacy_named_rule_still_recognised_as_conversation_rule() -> None:
    # An un-migrated rule named "To Reply" (system_type NULL) is still gated out
    # of no-reply mail and still treated as a conversation rule everywhere.
    assert _eng._conversation_rule_key(
        {"name": "To Reply", "system_type": None}) == "TO_REPLY"
    assert _eng._is_conversation_status_rule(
        {"name": "Actioned", "system_type": None}) is True
    rules = [{"id": "1", "name": "To Reply", "system_type": None},
             {"id": "2", "name": "Newsletter", "system_type": None}]
    kept = {r["name"] for r in _eng._gate_conversation_rules(rules, allowed=False)}
    assert "To Reply" not in kept and "Newsletter" in kept


def test_match_conversation_key_folds_legacy_name_and_system_type() -> None:
    # replyzero's rule-key resolver folds a legacy system_type or name to the
    # current key so the runner projects the right Reply Zero status.
    assert _rz._match_conversation_key(
        {"rule": {"system_type": "TO_REPLY"}}) == "REPLY"
    assert _rz._match_conversation_key(
        {"rule": {"name": "Actioned"}}) == "DONE"


async def test_upsert_guard_blocks_legacy_named_conversation_rule() -> None:
    # The sender-pin backstop must still refuse a legacy-named conversation rule
    # (the "vjvarada@… → To Reply" anti-pattern predates the rename).
    from tests.unit.test_email_rule_pattern_guards import _FakeDB

    db = _FakeDB(SimpleNamespace(name="To Reply", system_type=None),
                 SimpleNamespace(email_address="me@fracktal.in"))
    await _rules._upsert_rule_pattern(
        db, "acc-1", "rule-reply", "souradeep@iisc.ac.in", False,
        "LABEL_ADDED", "why", None, None, pattern_type="FROM")
    assert db.inserted is False
