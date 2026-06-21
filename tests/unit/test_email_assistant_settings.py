"""Unit tests for the email Assistant settings model.

Guards the serialization contract the Settings UI and the `/assistant/settings`
endpoints depend on. See ai-company-brain/specs/email_inbox_zero_parity_plan.md.
"""
from __future__ import annotations

from gateway.routes.email import AssistantSettingsModel


def test_settings_defaults_match_litellm_balanced_tier() -> None:
    s = AssistantSettingsModel(account_id="acc-1")
    assert s.auto_run is False
    assert s.cold_email_blocker == "OFF"
    # Default agent must be the LiteLLM balanced tier (→ DeepSeek), not Copilot.
    assert s.agent_model == "tier-balanced"
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
        agent_model="tier-powerful",
        digest_frequency="DAILY",
    )
    d = s.model_dump()
    assert d["about"] == "I run sales at Constellation."
    assert d["signature"] == "— Vijay"
    assert d["auto_run"] is True
    assert d["cold_email_blocker"] == "ARCHIVE"
    assert d["agent_model"] == "tier-powerful"
    assert d["digest_frequency"] == "DAILY"
