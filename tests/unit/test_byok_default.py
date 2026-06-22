"""Tests for the BYOK-by-default model routing policy (executor)."""
from __future__ import annotations

from apps.orchestrator.orchestrator.executor import (
    _byok_default_model,
    _is_gateway_model,
)


class _Settings:
    def __init__(self, byok_default: bool = True, chat_model: str = "tier-balanced"):
        self.copilot_byok_default = byok_default
        self.copilot_chat_model = chat_model


def test_is_gateway_model() -> None:
    assert _is_gateway_model("tier-balanced")
    assert _is_gateway_model("TIER-fast")
    assert _is_gateway_model("anthropic/claude-3")
    assert _is_gateway_model("copilot/gpt-4o")
    assert not _is_gateway_model("claude-sonnet-4-5")
    assert not _is_gateway_model("")


def test_byok_default_keeps_tier_models() -> None:
    model, is_byok = _byok_default_model("tier-fast", _Settings())
    assert model == "tier-fast"
    assert is_byok is True


def test_byok_default_keeps_provider_models() -> None:
    model, is_byok = _byok_default_model("anthropic/claude-3", _Settings())
    assert model == "anthropic/claude-3"
    assert is_byok is True


def test_byok_default_coerces_bare_name_to_default_tier() -> None:
    # A bare GitHub model name (e.g. from .agent.md) -> default tier, BYOK.
    model, is_byok = _byok_default_model("claude-sonnet-4-5", _Settings())
    assert model == "tier-balanced"
    assert is_byok is True


def test_byok_default_coerces_empty_to_default_tier() -> None:
    model, is_byok = _byok_default_model("", _Settings())
    assert model == "tier-balanced"
    assert is_byok is True


def test_byok_default_honors_custom_chat_model() -> None:
    model, is_byok = _byok_default_model(
        "claude-sonnet-4-5", _Settings(chat_model="tier-powerful")
    )
    assert model == "tier-powerful"
    assert is_byok is True


def test_byok_default_bare_chat_model_falls_back_to_tier_balanced() -> None:
    # If copilot_chat_model is itself a bare name (e.g. "gpt-4o"), it is NOT a
    # gateway id, so coercion targets the guaranteed tier-balanced alias.
    s = _Settings(chat_model="gpt-4o")
    model, is_byok = _byok_default_model("claude-sonnet-4-5", s)
    assert model == "tier-balanced"
    assert is_byok is True
    # An already-bare configured model resolves the same way when passed in.
    model2, _ = _byok_default_model("gpt-4o", s)
    assert model2 == "tier-balanced"


def test_byok_disabled_lets_bare_name_route_direct() -> None:
    # Escape hatch: flag off -> bare name stays direct (not BYOK).
    model, is_byok = _byok_default_model(
        "claude-sonnet-4-5", _Settings(byok_default=False)
    )
    assert model == "claude-sonnet-4-5"
    assert is_byok is False


def test_byok_disabled_still_byok_for_tier() -> None:
    model, is_byok = _byok_default_model(
        "tier-balanced", _Settings(byok_default=False)
    )
    assert model == "tier-balanced"
    assert is_byok is True
