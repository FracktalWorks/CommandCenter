"""Unit tests for the email Assistant settings model.

Guards the serialization contract the Settings UI and the `/assistant/settings`
endpoints depend on. See ai-company-brain/specs/email_inbox_zero_parity_plan.md.
"""
from __future__ import annotations

from gateway.routes.email import AssistantSettingsModel


def test_settings_default_model_tiers() -> None:
    s = AssistantSettingsModel(account_id="acc-1")
    # auto_run is the global "run rules automatically" switch; defaults ON so a
    # fresh account auto-runs once it has rules (an explicit OFF stops it).
    assert s.auto_run is True
    assert s.cold_email_blocker == "OFF"
    # Three task-specific models, each defaulting to its recommended tier. Chat
    # defaults to tier-powerful (strong tool-caller) so chat actions are reliable.
    assert s.rule_model == "tier-fast"
    assert s.draft_model == "tier-powerful"
    assert s.chat_model == "tier-powerful"
    assert s.digest_frequency == "OFF"
    assert s.about is None
    assert s.signature is None


def test_settings_roundtrip_preserves_overrides() -> None:
    s = AssistantSettingsModel(
        account_id="acc-1",
        about="I run sales at Constellation.",
        signature="— Vijay",
        auto_run=True,
        cold_email_blocker="ARCHIVE",
        rule_model="tier-balanced",
        draft_model="tier-fast",
        chat_model="tier-powerful",
        digest_frequency="DAILY",
    )
    d = s.model_dump()
    assert d["about"] == "I run sales at Constellation."
    assert d["signature"] == "— Vijay"
    assert d["auto_run"] is True
    assert d["cold_email_blocker"] == "ARCHIVE"
    assert d["rule_model"] == "tier-balanced"
    assert d["draft_model"] == "tier-fast"
    assert d["chat_model"] == "tier-powerful"
    assert d["digest_frequency"] == "DAILY"


def test_inbox_zero_parity_field_defaults() -> None:
    """The migration-29 settings default to inbox-zero's out-of-box behavior."""
    s = AssistantSettingsModel(account_id="acc-1")
    assert s.draft_confidence == "ALL_EMAILS"
    assert s.follow_up_awaiting_days == 0
    assert s.follow_up_needs_reply_days == 0
    assert s.follow_up_auto_draft is True
    assert s.digest_categories == []
    assert s.digest_day_of_week == 1
    assert s.digest_time_of_day == "09:00"
    assert s.digest_send_to_email is True


def test_inbox_zero_parity_fields_roundtrip() -> None:
    s = AssistantSettingsModel(
        account_id="acc-1",
        draft_confidence="HIGH_CONFIDENCE",
        follow_up_awaiting_days=5,
        follow_up_needs_reply_days=3,
        follow_up_auto_draft=False,
        digest_categories=["Newsletter", "Cold Emails"],
        digest_frequency="WEEKLY",
        digest_day_of_week=0,
        digest_time_of_day="07:30",
        digest_send_to_email=False,
    )
    d = s.model_dump()
    assert d["draft_confidence"] == "HIGH_CONFIDENCE"
    assert d["follow_up_awaiting_days"] == 5
    assert d["follow_up_needs_reply_days"] == 3
    assert d["follow_up_auto_draft"] is False
    assert d["digest_categories"] == ["Newsletter", "Cold Emails"]
    assert d["digest_day_of_week"] == 0
    assert d["digest_time_of_day"] == "07:30"
    assert d["digest_send_to_email"] is False
