"""Unit tests for canonical rule ordering and history undo."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from gateway.routes import email as m


def test_rules_sort_canonically_not_by_user_order() -> None:
    """Rules sort in the fixed inbox-zero system order (no user 'priority'):
    enabled first, then system-type order, then name. system_type may be absent
    on seeded presets, so the rule name is used as a fallback rank."""
    rules = [
        {"name": "Cold Email", "enabled": True, "system_type": "COLD_EMAIL"},
        {"name": "To Reply", "enabled": True, "system_type": "TO_REPLY"},
        {"name": "FYI", "enabled": True, "system_type": "FYI"},
        # system_type missing → ranked by name ("Newsletter" → NEWSLETTER).
        {"name": "Newsletter", "enabled": True, "system_type": None},
        {"name": "Zeta custom", "enabled": True, "system_type": None},
        {"name": "Alpha custom", "enabled": True, "system_type": None},
        # disabled rules sort last regardless of system order.
        {"name": "Awaiting Reply", "enabled": False, "system_type": "AWAITING_REPLY"},
    ]
    out = [r["name"] for r in m.automation.rules._sort_rules_canonical(rules)]
    assert out == [
        "To Reply", "FYI", "Newsletter", "Cold Email",
        "Alpha custom", "Zeta custom",
        "Awaiting Reply",
    ]


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
