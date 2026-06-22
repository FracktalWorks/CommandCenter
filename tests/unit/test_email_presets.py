"""Unit tests for the default-rule preset installer (used by the UI's
'Add defaults' and the AI assistant's install_default_rules tool)."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from gateway.routes import email as m


def test_preset_set_matches_inbox_zero_system_rules() -> None:
    names = [p["name"] for p in m._PRESET_RULES]
    assert names == [
        "To Reply", "Awaiting Reply", "Actioned", "FYI", "Newsletter",
        "Marketing", "Calendar", "Receipt", "Notification", "Cold Email",
    ]
    # To Reply drafts a reply; FYI/To Reply run on threads.
    to_reply = next(p for p in m._PRESET_RULES if p["name"] == "To Reply")
    assert to_reply["run_on_threads"] is True
    assert any(a["type"] == "DRAFT_EMAIL" for a in to_reply["actions"])


async def test_install_presets_creates_only_missing() -> None:
    db = AsyncMock()
    user = SimpleNamespace(email="u@example.com")
    with patch.object(m, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m, "_assert_account_owner", AsyncMock()), \
            patch.object(m, "_load_rules",
                         AsyncMock(return_value=[{"name": "To Reply"}])), \
            patch.object(m, "_replace_actions", AsyncMock()):
        res = await m.install_preset_rules(account_id="acc-1", user=user)
    assert "To Reply" not in res["installed"]   # already present → skipped
    assert "FYI" in res["installed"]
    assert len(res["installed"]) == 9
    assert res["total_presets"] == 10
    db.commit.assert_awaited()


async def test_install_presets_idempotent_when_all_present() -> None:
    db = AsyncMock()
    user = SimpleNamespace(email="u@example.com")
    all_rules = [{"name": p["name"]} for p in m._PRESET_RULES]
    with patch.object(m, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m, "_assert_account_owner", AsyncMock()), \
            patch.object(m, "_load_rules", AsyncMock(return_value=all_rules)), \
            patch.object(m, "_replace_actions", AsyncMock()):
        res = await m.install_preset_rules(account_id="acc-1", user=user)
    assert res["installed"] == []
