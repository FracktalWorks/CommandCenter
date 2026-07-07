"""Unit tests for acb_llm.context — context-window fitting + model fallback.

These guard the two behaviours the email assistant relies on: (1) a prompt is
shrunk to fit the primary model's input window before the call, and (2) on a
context-overflow / hard failure the call escalates once to the fallback model.
No network or provider keys are touched — litellm.acompletion is mocked.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from acb_llm import context as ctx


def test_resolve_tier_alias_to_underlying_model() -> None:
    # A tier alias resolves to a concrete litellm id; an explicit provider/model
    # and an unknown string pass through unchanged.
    assert "/" in ctx.resolve_underlying_model("tier-balanced")
    assert ctx.resolve_underlying_model("deepseek/deepseek-chat") == (
        "deepseek/deepseek-chat"
    )
    assert ctx.resolve_underlying_model("") == ""


def test_context_window_for_tiers() -> None:
    """Tier aliases resolve through _TIER_MODEL → litellm model_cost.

    We do NOT assert specific token counts because the actual value depends on
    whatever model is configured in config.yaml + tier_overrides.yaml + the DB
    (all of which can change independently).  Instead we assert:
    1. Every tier alias returns a positive, non-trivial window.
    2. The returned window matches context_window_for() called on the
       backing model directly — proving the chain is correct.
    """
    from acb_llm.client import _TIER_ALIAS_MAP, _TIER_MODEL
    for alias in ("tier-fast", "tier-balanced", "tier-powerful"):
        cw = ctx.context_window_for(alias)
        assert cw > 0, f"{alias!r} returned a zero context window"
        # Must match what context_window_for returns for the backing model id.
        tier_id = _TIER_ALIAS_MAP.get(alias)
        backing = _TIER_MODEL.get(tier_id, "") if tier_id else ""
        if backing:
            assert cw == ctx.context_window_for(backing), (
                f"{alias!r} (window={cw}) doesn't match backing "
                f"model {backing!r} (window={ctx.context_window_for(backing)})"
            )
    # Unknown id never returns 0 — always a usable positive budget.
    assert ctx.context_window_for("made-up/model") > 0


def test_context_window_for_tiers_tracks_model_changes(monkeypatch) -> None:
    """Changing _TIER_MODEL (as set_tier_model does) immediately changes what
    context_window_for returns — no hardcoded values, no stale cache."""
    from acb_llm.client import _TIER_MODEL
    # Use two DeepSeek models with different known context sizes.
    monkeypatch.setitem(_TIER_MODEL, "tier2", "deepseek/deepseek-v4-pro")   # 1M
    assert ctx.context_window_for("tier-balanced") == 1_000_000

    monkeypatch.setitem(_TIER_MODEL, "tier2", "deepseek/deepseek-chat")      # 131K
    assert ctx.context_window_for("tier-balanced") == 131_072


def test_is_context_overflow_error_detects_provider_messages() -> None:
    assert ctx.is_context_overflow_error(
        Exception("This model's maximum context length is 32768 tokens"))
    assert ctx.is_context_overflow_error(Exception("context_length_exceeded"))
    assert not ctx.is_context_overflow_error(Exception("invalid api key"))


def test_fit_messages_truncates_oversized_prompt() -> None:
    # Use deepseek/deepseek-chat (131K) directly so the test is independent of
    # tier configuration — a 1M-char (~250K token) message must be trimmed to fit.
    model = "deepseek/deepseek-chat"  # 131K context window, always in litellm
    huge = "word " * 200_000  # ~1M chars, well over the 131K window
    messages = [
        {"role": "system", "content": "Classify this email."},
        {"role": "user", "content": huge},
    ]
    fitted, truncated = ctx.fit_messages_to_context(
        messages, model, max_output_tokens=500)
    assert truncated is True
    # Original list is not mutated.
    assert messages[1]["content"] == huge
    # System instructions preserved verbatim.
    assert fitted[0]["content"] == "Classify this email."
    # Now within budget, and the truncation marker is present.
    budget = ctx.context_window_for(model) - 500 - 512
    assert ctx.count_message_tokens(fitted, model) <= budget
    assert "truncated" in fitted[1]["content"]


def test_fit_messages_leaves_small_prompt_untouched() -> None:
    messages = [
        {"role": "system", "content": "Be brief."},
        {"role": "user", "content": "Hello there."},
    ]
    fitted, truncated = ctx.fit_messages_to_context(messages, "tier-balanced")
    assert truncated is False
    assert fitted is messages  # same object — no copy when it already fits


async def test_acompletion_escalates_to_fallback_on_overflow(monkeypatch) -> None:
    # Primary call raises a context-overflow error; the helper must retry once on
    # the distinct fallback model and return that response + the fallback id.
    monkeypatch.setattr(
        "acb_llm.client._ensure_keys_loaded", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "acb_llm.client.ensure_model_registered", lambda m: "deepseek")

    calls: list[str] = []

    async def fake_acompletion(*, model, messages, **kw):
        calls.append(model)
        if model == "deepseek/deepseek-chat":
            raise Exception("maximum context length is 65536 tokens")
        return {"model": model, "ok": True}

    import litellm
    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)

    resp, used = await ctx.acompletion_with_fallback(
        model="deepseek/deepseek-chat",
        fallback_model="deepseek/deepseek-reasoner",
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=100,
    )
    assert used == "deepseek/deepseek-reasoner"
    assert resp["ok"] is True
    assert calls == ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"]


async def test_acompletion_no_fallback_when_same_model(monkeypatch) -> None:
    # When the fallback resolves to the same underlying model, it is skipped and
    # the primary failure propagates (no pointless second call).
    monkeypatch.setattr(
        "acb_llm.client._ensure_keys_loaded", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "acb_llm.client.ensure_model_registered", lambda m: "deepseek")

    calls: list[str] = []

    async def fake_acompletion(*, model, messages, **kw):
        calls.append(model)
        raise Exception("boom")

    import litellm
    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)

    with pytest.raises(Exception, match="boom"):
        await ctx.acompletion_with_fallback(
            model="deepseek/deepseek-chat",
            fallback_model="deepseek/deepseek-chat",
            messages=[{"role": "user", "content": "hi"}],
        )
    assert calls == ["deepseek/deepseek-chat"]  # only one attempt
