"""Unit tests for learning classification patterns from manual label changes
made in the user's email client (inbox-zero LABEL_ADDED / LABEL_REMOVED).

Conversation-status rules (Reply / Awaiting / FYI / Done) are NEVER
sender-pinned — a manually-added reply label routes to a direct thread-status
correction instead, and a removed one is ignored. Only sender-stable cleanup
rules (Newsletter/Receipt/…) learn FROM patterns."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from gateway.routes import email as m

_sync = m.transport.sync


async def test_cleanup_label_change_teaches_include_and_exclude() -> None:
    db = AsyncMock()
    msg = SimpleNamespace(
        from_address=SimpleNamespace(email="alice@acme.com"), thread_id="t1")
    label_map = {"newsletter": "rule-news", "receipts": "rule-rcpt"}
    captured: list[tuple] = []
    status_corrections: dict[str, str] = {}

    async def _fake_upsert(db, account_id, rule_id, value, exclude, source,
                           *a, **k):
        captured.append((rule_id, value, exclude, source))

    with patch.object(m.automation.rules, "_upsert_rule_pattern", _fake_upsert):
        await _sync._learn_from_label_changes(
            db, "acc-1", msg,
            old_categories=["Receipts"], new_categories=["Newsletter"],
            label_rule_map=label_map, conv_rule_keys={},
            status_corrections=status_corrections)

    # Cleanup rules are sender-stable → a manual label add/remove learns a pattern.
    assert ("rule-news", "alice@acme.com", False, "LABEL_ADDED") in captured
    assert ("rule-rcpt", "alice@acme.com", True, "LABEL_REMOVED") in captured
    assert status_corrections == {}


async def test_conversation_label_is_never_sender_pinned() -> None:
    db = AsyncMock()
    msg = SimpleNamespace(
        from_address=SimpleNamespace(email="alice@acme.com"), thread_id="t1")
    label_map = {"reply": "rule-reply"}
    conv_keys = {"rule-reply": "REPLY"}
    captured: list[tuple] = []
    status_corrections: dict[str, str] = {}

    async def _fake_upsert(*a, **k):
        captured.append(a)

    with patch.object(m.automation.rules, "_upsert_rule_pattern", _fake_upsert):
        # User manually ADDS "Reply" in their client.
        await _sync._learn_from_label_changes(
            db, "acc-1", msg, old_categories=[], new_categories=["Reply"],
            label_rule_map=label_map, conv_rule_keys=conv_keys,
            status_corrections=status_corrections)

    # No sender pattern is ever learned for a conversation rule; instead the
    # thread status is queued for a direct correction (the only thing that sticks).
    assert not captured
    assert status_corrections == {"t1": "REPLY"}


async def test_removed_conversation_label_is_ignored() -> None:
    db = AsyncMock()
    msg = SimpleNamespace(
        from_address=SimpleNamespace(email="alice@acme.com"), thread_id="t1")
    label_map = {"reply": "rule-reply"}
    conv_keys = {"rule-reply": "REPLY"}
    captured: list[tuple] = []
    status_corrections: dict[str, str] = {}

    async def _fake_upsert(*a, **k):
        captured.append(a)

    with patch.object(m.automation.rules, "_upsert_rule_pattern", _fake_upsert):
        # Removing a conversation label carries no unambiguous target status.
        await _sync._learn_from_label_changes(
            db, "acc-1", msg, old_categories=["Reply"], new_categories=[],
            label_rule_map=label_map, conv_rule_keys=conv_keys,
            status_corrections=status_corrections)

    assert not captured           # never pinned
    assert status_corrections == {}  # never guessed


async def test_conversation_add_records_status_even_without_sender() -> None:
    db = AsyncMock()
    msg = SimpleNamespace(from_address=None, thread_id="t9")
    status_corrections: dict[str, str] = {}

    async def _fake(*a, **k):
        raise AssertionError("no pattern should be learned")

    with patch.object(m.automation.rules, "_upsert_rule_pattern", _fake):
        await _sync._learn_from_label_changes(
            db, "acc-1", msg, [], ["Awaiting Reply"],
            label_rule_map={"awaiting reply": "rule-await"},
            conv_rule_keys={"rule-await": "AWAITING_REPLY"},
            status_corrections=status_corrections)

    # Status correction doesn't depend on a sender being present.
    assert status_corrections == {"t9": "AWAITING_REPLY"}


async def test_no_pattern_learning_without_a_sender() -> None:
    db = AsyncMock()
    msg = SimpleNamespace(from_address=None, thread_id=None)
    called: list[int] = []

    async def _fake(*a, **k):
        called.append(1)

    with patch.object(m.automation.rules, "_upsert_rule_pattern", _fake):
        # Cleanup rules need a sender to pin — no sender → nothing learned.
        await _sync._learn_from_label_changes(
            db, "acc-1", msg, ["x"], ["y"], {"x": "r1", "y": "r2"},
            conv_rule_keys={}, status_corrections={})
    assert not called


async def test_unmapped_categories_are_ignored() -> None:
    db = AsyncMock()
    msg = SimpleNamespace(
        from_address=SimpleNamespace(email="bob@x.com"), thread_id=None)
    called: list[int] = []

    async def _fake(*a, **k):
        called.append(1)

    with patch.object(m.automation.rules, "_upsert_rule_pattern", _fake):
        # "Random" isn't in the label→rule map → nothing learned.
        await _sync._learn_from_label_changes(
            db, "acc-1", msg, [], ["Random"], {"newsletter": "r"},
            conv_rule_keys={}, status_corrections={})
    assert not called
