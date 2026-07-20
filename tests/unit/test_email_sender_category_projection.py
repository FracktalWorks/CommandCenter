"""Unit tests for the sender-category convergence: `_rule_category` projects a
sender's category from the rule engine's per-message labels (dominant cleanup
category, or Personal for a reply-active sender), deferring to None (cold-start
LLM fallback) when the rules haven't labelled enough of the sender's mail."""
from __future__ import annotations

from gateway.routes.email.automation.senders import _MIN_RULE_MESSAGES, _rule_category


def test_dominant_cleanup_category_is_projected() -> None:
    counts = {"marketing": 5, "newsletter": 1}
    assert _rule_category(counts) == "Marketing"


def test_below_threshold_defers_to_fallback() -> None:
    # Two Marketing labels is under the coverage bar → no rule projection yet.
    assert _MIN_RULE_MESSAGES == 3
    assert _rule_category({"marketing": 2}) is None


def test_reply_active_sender_projects_conversation() -> None:
    # No cleanup labels, but the rules put this thread through Reply Zero, so
    # there is an exchange here. Note a Cold Email is also a human writing
    # one-to-one — what separates them is that a reply came back.
    counts = {"reply": 2, "awaiting reply": 1}
    assert _rule_category(counts) == "Conversation"


def test_cleanup_wins_over_conversation_when_dominant() -> None:
    # A vendor you also reply to: a strong cleanup signal takes precedence.
    counts = {"receipt": 4, "reply": 5}
    assert _rule_category(counts) == "Receipt"


def test_no_signal_defers_to_fallback() -> None:
    assert _rule_category({}) is None
    # Conversation labels below the bar also defer.
    assert _rule_category({"fyi": 1}) is None


def test_conversation_only_projects_personal_only_without_cleanup() -> None:
    # A single cleanup label present (top_n != 0) blocks the Personal shortcut,
    # so a sender with mixed-but-thin signal defers rather than guessing Personal.
    counts = {"reply": 3, "marketing": 1}
    assert _rule_category(counts) is None
