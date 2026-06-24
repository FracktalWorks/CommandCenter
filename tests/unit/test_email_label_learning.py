"""Unit tests for learning classification patterns from manual label changes
made in the user's email client (inbox-zero LABEL_ADDED / LABEL_REMOVED)."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from gateway.routes import email as m

_sync = m.transport.sync


async def test_label_added_and_removed_teach_include_and_exclude() -> None:
    db = AsyncMock()
    msg = SimpleNamespace(
        from_address=SimpleNamespace(email="alice@acme.com"), thread_id="t1")
    label_map = {"newsletter": "rule-news", "to reply": "rule-reply"}
    captured: list[tuple] = []

    async def _fake_upsert(db, account_id, rule_id, value, exclude, source,
                           *a, **k):
        captured.append((rule_id, value, exclude, source))

    with patch.object(m.automation.rules, "_upsert_rule_pattern", _fake_upsert):
        await _sync._learn_from_label_changes(
            db, "acc-1", msg,
            old_categories=["To Reply"], new_categories=["Newsletter"],
            label_rule_map=label_map)

    assert ("rule-news", "alice@acme.com", False, "LABEL_ADDED") in captured
    assert ("rule-reply", "alice@acme.com", True, "LABEL_REMOVED") in captured


async def test_no_learning_without_a_sender() -> None:
    db = AsyncMock()
    msg = SimpleNamespace(from_address=None, thread_id=None)
    called: list[int] = []

    async def _fake(*a, **k):
        called.append(1)

    with patch.object(m.automation.rules, "_upsert_rule_pattern", _fake):
        await _sync._learn_from_label_changes(
            db, "acc-1", msg, ["x"], ["y"], {"x": "r1", "y": "r2"})
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
            db, "acc-1", msg, [], ["Random"], {"newsletter": "r"})
    assert not called
