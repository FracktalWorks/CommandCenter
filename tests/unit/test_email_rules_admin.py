"""Unit tests for rule reordering and history undo (Chunk D)."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from gateway.routes import email as m


async def test_reorder_rules_writes_sort_order_per_rule() -> None:
    db = AsyncMock()
    user = SimpleNamespace(email="u@example.com")
    req = m.RuleReorderRequest(account_id="acc-1", rule_ids=["r1", "r2", "r3"])
    with patch.object(m.automation.rules, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m.automation.rules, "_assert_account_owner", AsyncMock()):
        res = await m.reorder_rules(req, user=user)
    assert res["reordered"] == 3
    assert db.execute.await_count == 3   # one UPDATE per rule
    db.commit.assert_awaited()


async def test_undo_not_found_raises_404() -> None:
    result = MagicMock()
    result.fetchone.return_value = None
    db = AsyncMock()
    db.execute.return_value = result
    user = SimpleNamespace(email="u@example.com")
    with patch.object(m.automation.runner, "_get_db", AsyncMock(return_value=db)):
        with pytest.raises(HTTPException) as ei:
            await m.undo_execution("e1", user=user)
    assert ei.value.status_code == 404


async def test_undo_rejects_non_applied_execution() -> None:
    row = SimpleNamespace(
        status="PENDING", rule_id=None, message_id=None,
        provider_message_id=None, actions_taken=[], provider="microsoft",
        credentials_encrypted="x")
    result = MagicMock()
    result.fetchone.return_value = row
    db = AsyncMock()
    db.execute.return_value = result
    user = SimpleNamespace(email="u@example.com")
    with patch.object(m.automation.runner, "_get_db", AsyncMock(return_value=db)):
        with pytest.raises(HTTPException) as ei:
            await m.undo_execution("e1", user=user)
    assert ei.value.status_code == 400
