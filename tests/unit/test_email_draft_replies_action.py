"""The "Auto draft replies" toggle ↔ the To Reply rule's DRAFT_EMAIL action.

inbox-zero parity: enabling auto-draft adds a DRAFT_EMAIL action to the "To
Reply" rule (so to-reply mail is drafted during the normal rule run, gated by
draft_confidence); disabling removes it. Mirrors inbox-zero's
``enableDraftRepliesAction``.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from gateway.routes import email as m

rules = m.automation.rules


def _to_reply(actions, *, name="To Reply", system_type=None):
    return {"id": "r1", "name": name, "system_type": system_type,
            "actions": actions}


async def _run(enabled, rules_list):
    db = AsyncMock()
    replace = AsyncMock()
    with patch.object(rules, "_load_rules", AsyncMock(return_value=rules_list)), \
            patch.object(rules, "_replace_actions", replace):
        changed = await rules.sync_draft_reply_action(db, "acc-1", enabled)
    return changed, replace


async def test_enable_adds_draft_action() -> None:
    changed, replace = await _run(
        True, [_to_reply([{"type": "LABEL", "label": "To Reply"}])])
    assert changed is True
    replace.assert_awaited_once()
    rid, actions = replace.await_args.args[1], replace.await_args.args[2]
    assert rid == "r1"
    types = [a.type for a in actions]
    assert "DRAFT_EMAIL" in types and "LABEL" in types  # keeps the label action


async def test_disable_removes_draft_action() -> None:
    changed, replace = await _run(
        False, [_to_reply([{"type": "LABEL"}, {"type": "DRAFT_EMAIL"}])])
    assert changed is True
    actions = replace.await_args.args[2]
    types = [a.type for a in actions]
    assert "DRAFT_EMAIL" not in types and "LABEL" in types


async def test_enable_noop_when_already_present() -> None:
    changed, replace = await _run(
        True, [_to_reply([{"type": "DRAFT_EMAIL"}])])
    assert changed is False
    replace.assert_not_awaited()  # already in desired state → no rewrite


async def test_disable_noop_when_already_absent() -> None:
    changed, replace = await _run(False, [_to_reply([{"type": "LABEL"}])])
    assert changed is False
    replace.assert_not_awaited()


async def test_noop_when_no_to_reply_rule() -> None:
    other = {"id": "r2", "name": "Newsletter", "system_type": None,
             "actions": [{"type": "LABEL"}]}
    changed, replace = await _run(True, [other])
    assert changed is False
    replace.assert_not_awaited()


async def test_matches_by_system_type() -> None:
    # A rule named differently but flagged TO_REPLY still gets the action.
    changed, replace = await _run(
        True, [_to_reply([{"type": "LABEL"}], name="Respond",
                         system_type="TO_REPLY")])
    assert changed is True
    types = [a.type for a in replace.await_args.args[2]]
    assert "DRAFT_EMAIL" in types
