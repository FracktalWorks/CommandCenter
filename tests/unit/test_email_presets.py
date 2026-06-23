"""Unit tests for the default-rule preset installer (used by the UI's
'Add defaults' and the AI assistant's install_default_rules tool)."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes import email as m

_actions_for_preset = m.automation.rules._actions_for_preset


def test_preset_set_matches_inbox_zero_system_rules() -> None:
    names = [p["name"] for p in m._PRESET_RULES]
    assert names == [
        "To Reply", "Awaiting Reply", "Actioned", "FYI", "Newsletter",
        "Marketing", "Calendar", "Receipt", "Notification", "Cold Email",
    ]
    # To Reply drafts a reply; FYI/To Reply run on threads.
    to_reply = next(p for p in m._PRESET_RULES if p["name"] == "To Reply")
    assert to_reply["run_on_threads"] is True
    actions = _actions_for_preset(to_reply, "gmail")
    assert any(a["type"] == "DRAFT_EMAIL" for a in actions)


# Names that become FOLDER moves on Outlook (inbox-zero parity) vs stay as
# category LABELs.
_MS_FOLDER_NAMES = {"Newsletter", "Marketing", "Receipt", "Notification", "Cold Email"}
# Marketing & Cold Email label_archive on Gmail; on Outlook the folder move files
# them (no archive — archiving would re-file them out of their folder).
_GMAIL_ARCHIVE_NAMES = {"Marketing", "Cold Email"}


def test_actions_for_preset_outlook_labels_and_files_cleanup_categories() -> None:
    for p in m._PRESET_RULES:
        types = [a["type"] for a in _actions_for_preset(p, "microsoft")]
        if p["name"] in _MS_FOLDER_NAMES:
            # Outlook tags the category (LABEL) AND files it into the folder.
            assert types[0] == "LABEL", p["name"]
            assert "MOVE_FOLDER" in types, p["name"]
            # The folder move files the mail; never pair it with ARCHIVE (that
            # would move it straight back out into the Archive folder).
            assert "ARCHIVE" not in types, p["name"]
        else:
            assert types[0] == "LABEL", p["name"]
            assert "MOVE_FOLDER" not in types, p["name"]


def test_actions_for_preset_gmail_is_label_only() -> None:
    for p in m._PRESET_RULES:
        types = [a["type"] for a in _actions_for_preset(p, "gmail")]
        assert "MOVE_FOLDER" not in types, p["name"]
        assert types[0] == "LABEL", p["name"]
    # Marketing & Cold Email still archive on Gmail.
    for name in _GMAIL_ARCHIVE_NAMES:
        p = next(x for x in m._PRESET_RULES if x["name"] == name)
        assert "ARCHIVE" in [a["type"] for a in _actions_for_preset(p, "gmail")]


async def test_install_presets_uses_folder_actions_for_outlook() -> None:
    db = AsyncMock()
    db.execute.return_value = MagicMock(
        fetchone=MagicMock(return_value=SimpleNamespace(provider="microsoft"))
    )
    user = SimpleNamespace(email="u@example.com")
    captured: list = []
    with patch.object(m.automation.rules, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m.automation.rules, "_assert_account_owner", AsyncMock()), \
            patch.object(m.automation.rules, "_load_rules", AsyncMock(return_value=[])), \
            patch.object(m.automation.rules, "_replace_actions",
                         AsyncMock(side_effect=lambda _db, _rid, acts: captured.append(acts))):
        await m.install_preset_rules(account_id="acc-1", user=user)
    all_types = {a.type for acts in captured for a in acts}
    assert "MOVE_FOLDER" in all_types  # Outlook files promo mail into folders


def _db_with_provider(provider: str = "gmail") -> AsyncMock:
    """AsyncMock db whose provider-lookup SELECT returns ``provider``."""
    db = AsyncMock()
    db.execute.return_value = MagicMock(
        fetchone=MagicMock(return_value=SimpleNamespace(provider=provider))
    )
    return db


async def test_install_presets_creates_only_missing() -> None:
    db = _db_with_provider()
    user = SimpleNamespace(email="u@example.com")
    with patch.object(m.automation.rules, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m.automation.rules, "_assert_account_owner", AsyncMock()), \
            patch.object(m.automation.rules, "_load_rules",
                         AsyncMock(return_value=[{"name": "To Reply"}])), \
            patch.object(m.automation.rules, "_replace_actions", AsyncMock()):
        res = await m.install_preset_rules(account_id="acc-1", user=user)
    assert "To Reply" not in res["installed"]   # already present → skipped
    assert "FYI" in res["installed"]
    assert len(res["installed"]) == 9
    assert res["total_presets"] == 10
    db.commit.assert_awaited()


async def test_install_presets_idempotent_when_all_present() -> None:
    db = _db_with_provider()
    user = SimpleNamespace(email="u@example.com")
    all_rules = [{"name": p["name"]} for p in m._PRESET_RULES]
    with patch.object(m.automation.rules, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m.automation.rules, "_assert_account_owner", AsyncMock()), \
            patch.object(m.automation.rules, "_load_rules", AsyncMock(return_value=all_rules)), \
            patch.object(m.automation.rules, "_replace_actions", AsyncMock()):
        res = await m.install_preset_rules(account_id="acc-1", user=user)
    assert res["installed"] == []


async def test_reset_rules_deletes_then_reinstalls_every_preset() -> None:
    """Reset wipes existing rules and reseeds the full preset set regardless of
    what was there before (unlike install-presets, which is additive)."""
    db = _db_with_provider("microsoft")
    user = SimpleNamespace(email="u@example.com")
    existing = [{"name": p["name"]} for p in m._PRESET_RULES]  # all present…
    with patch.object(m.automation.rules, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m.automation.rules, "_assert_account_owner", AsyncMock()), \
            patch.object(m.automation.rules, "_load_rules", AsyncMock(return_value=existing)), \
            patch.object(m.automation.rules, "_replace_actions", AsyncMock()):
        res = await m.reset_rules(account_id="acc-1", user=user)
    # …yet every preset is reinstalled, and the response flags the reset.
    assert len(res["installed"]) == len(m._PRESET_RULES)
    assert res["total_presets"] == len(m._PRESET_RULES)
    assert res["reset"] is True
    # A DELETE of the account's rules ran before reseeding.
    sql = " ".join(str(c.args[0]) for c in db.execute.call_args_list if c.args)
    assert "DELETE FROM email_rules" in sql
    db.commit.assert_awaited()
