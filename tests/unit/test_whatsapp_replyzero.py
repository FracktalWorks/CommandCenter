"""Unit tests for the WhatsApp Reply Zero chat-status classifier."""

from __future__ import annotations

import pytest
from gateway.routes.whatsapp.automation.replyzero import (
    AWAITING,
    FYI,
    NEEDS_REPLY,
    _account_wa_ids,
    classify_chat_status,
)


def test_we_spoke_last_is_awaiting() -> None:
    status, _ = classify_chat_status("out", is_group=False, mentioned=False)
    assert status == AWAITING


def test_dm_inbound_needs_reply() -> None:
    status, reason = classify_chat_status("in", is_group=False, mentioned=False)
    assert status == NEEDS_REPLY
    assert "await" in reason


def test_group_inbound_without_mention_is_fyi() -> None:
    status, _ = classify_chat_status("in", is_group=True, mentioned=False)
    assert status == FYI


def test_group_inbound_with_mention_needs_reply() -> None:
    status, reason = classify_chat_status("in", is_group=True, mentioned=True)
    assert status == NEEDS_REPLY
    assert "mention" in reason


def test_reaction_last_is_fyi_even_in_dm() -> None:
    # A 👍 reaction is not a message that needs answering.
    status, _ = classify_chat_status(
        "in", is_group=False, mentioned=False, last_kind="reaction")
    assert status == FYI


def test_system_last_is_fyi() -> None:
    status, _ = classify_chat_status(
        "in", is_group=True, mentioned=True, last_kind="system")
    assert status == FYI  # a system event never becomes a reply obligation


def test_no_messages_is_fyi() -> None:
    status, reason = classify_chat_status(None, is_group=False, mentioned=False)
    assert status == FYI
    assert reason == "no messages"


@pytest.mark.parametrize("phone,expected", [
    ("+919990388", {"+919990388", "919990388"}),
    ("919990388", {"919990388"}),
    (None, set()),
    ("", set()),
])
def test_account_wa_ids_normalizes_plus_prefix(phone, expected) -> None:
    assert _account_wa_ids(phone) == expected


def test_mention_membership_uses_normalized_ids() -> None:
    # A group message that @mentions the founder's bare number matches even when
    # the account is stored with a leading '+'.
    ids = _account_wa_ids("+919990388")
    assert "919990388" in ids
