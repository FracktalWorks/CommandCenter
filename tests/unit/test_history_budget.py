"""Regression: history must be budgeted to the model's REAL context window.

Before this (2026-07-17), the string-prompt path used model-BLIND caps: the last
16 messages, each clipped to 600 chars. That is ~9.6 KB ≈ 2,400 tokens — under
2% of a 128k window — so a large-context model was fed almost none of the
conversation no matter how much it could hold. Worse, the 600-char slice hit the
*immediately preceding* turn too, so a user who pasted a document, diff, or
error log had it shredded on the very next message.

The budget now scales with `context_window_for(model)`: oldest turns drop first,
and a single oversized turn is trimmed rather than allowed to eat everything.
"""
from __future__ import annotations

import orchestrator.executor as ex


def _set_window(monkeypatch, tokens: int) -> None:
    """Pin the resolved context window so a budget test states one thing.

    Patches the resolver itself rather than a model id, so these assertions
    can't drift when a vendor changes a number.
    """
    import acb_llm.model_limits as ml

    monkeypatch.setattr(
        ml, "get_limits",
        lambda _m: ml.ModelLimits(tokens, 8192, "test", "test"),
    )


def _hist(n: int, size: int = 400) -> list[dict[str, str]]:
    """n alternating turns of `size` chars each, oldest first."""
    return [
        {
            "role": "user" if i % 2 == 0 else "assistant",
            "content": f"m{i}-" + ("x" * size),
        }
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# The budget itself
# ---------------------------------------------------------------------------

def test_budget_scales_with_the_model_window() -> None:
    """A big-window model must get a far bigger history budget than the floor."""
    big = ex._history_char_budget("tier-powerful")   # real window via litellm
    assert big > ex._HISTORY_MIN_CHARS
    # The old flat cap was ~9.6 KB (16 x 600). A large-context model must now be
    # allowed vastly more than that.
    assert big > 50_000, f"large-window budget still tiny: {big} chars"


def test_unknown_model_falls_open_to_the_floor() -> None:
    """An unresolvable model must not collapse to zero history."""
    assert ex._history_char_budget("") >= ex._HISTORY_MIN_CHARS
    assert ex._history_char_budget("no/such-model-xyz") >= ex._HISTORY_MIN_CHARS


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def test_recent_turn_is_not_shredded_to_600_chars() -> None:
    """The old 600-char cap truncated even the immediately-preceding message."""
    pasted = "y" * 5_000  # e.g. a pasted diff / log / document
    history = [{"role": "user", "content": pasted}]
    out = ex._render_history_block(history, current_msg="what is this?",
                                   model="tier-powerful")
    assert len(out) > 4_000, (
        "regression: the preceding turn is being clipped to the old flat cap"
    )
    assert pasted[:1000] in out


def test_far_more_than_16_messages_survive_on_a_big_model() -> None:
    """The old code hard-capped at 16 messages regardless of window."""
    history = _hist(60)
    out = ex._render_history_block(history, current_msg="next",
                                   model="tier-powerful")
    kept = sum(1 for i in range(60) if f"m{i}-" in out)
    assert kept > 16, f"still capped near the old 16-message limit (kept={kept})"


def test_chronological_order_is_preserved() -> None:
    history = _hist(6, size=50)
    out = ex._render_history_block(history, current_msg="next",
                                   model="tier-powerful")
    positions = [out.index(f"m{i}-") for i in range(6) if f"m{i}-" in out]
    assert positions == sorted(positions), "history must read oldest → newest"


def test_oldest_turns_drop_first_when_over_budget(monkeypatch) -> None:
    """Eviction mirrors assemble_run_context: whole oldest turns go first."""
    monkeypatch.setattr(ex, "_history_char_budget", lambda _m: 2_000)
    history = _hist(20, size=300)
    out = ex._render_history_block(history, current_msg="next", model="m")
    # The newest turns survive; the oldest are evicted.
    assert "m19-" in out and "m18-" in out
    assert "m0-" not in out and "m1-" not in out


def test_current_turn_is_not_duplicated() -> None:
    history = [{"role": "user", "content": "hello there"}]
    out = ex._render_history_block(history, current_msg="hello there",
                                   model="tier-powerful")
    assert out == "", "the current turn must not be echoed back as history"


def test_one_giant_turn_cannot_eat_the_whole_budget(monkeypatch) -> None:
    monkeypatch.setattr(ex, "_history_char_budget", lambda _m: 20_000)
    history = [
        {"role": "user", "content": "z" * 500_000},   # pathological single turn
        {"role": "assistant", "content": "recent answer"},
    ]
    out = ex._render_history_block(history, current_msg="next", model="m")
    # The recent turn still survives despite the giant one preceding it.
    assert "recent answer" in out


def test_empty_history_renders_nothing() -> None:
    assert ex._render_history_block([], "hi", "tier-powerful") == ""
    assert ex._render_history_block(
        [{"role": "user", "content": "   "}], "hi", "tier-powerful",
    ) == ""


# ---------------------------------------------------------------------------
# The absolute ceiling: a fraction of a HUGE window is a cost bug
# ---------------------------------------------------------------------------

def test_million_token_window_is_capped(monkeypatch) -> None:
    """50% of deepseek-v4-pro's 1M window is 500K tokens of prior conversation
    resent and re-billed on EVERY turn. Past ~100K it's nearly all stale turns
    the model doesn't need."""
    _set_window(monkeypatch, 1_000_000)
    budget = ex._history_char_budget("any-model")
    assert budget == ex._HISTORY_MAX_TOKENS * 4
    assert budget < (1_000_000 * 0.5) * 4, "the fraction alone must not stand"


def test_ceiling_does_not_bind_on_current_tiers(monkeypatch) -> None:
    """The ceiling must only catch the absurd cases — it must not quietly claw
    back the context this budgeting was written to give agents."""
    _set_window(monkeypatch, 131_072)
    assert ex._history_char_budget("any-model") == int(131_072 * 0.5) * 4


def test_ceiling_is_env_tunable(monkeypatch) -> None:
    _set_window(monkeypatch, 1_000_000)
    monkeypatch.setattr(ex, "_HISTORY_MAX_TOKENS", 10_000)
    assert ex._history_char_budget("any-model") == 40_000


# ---------------------------------------------------------------------------
# Reserving room for the model's own reply
# ---------------------------------------------------------------------------

def test_reserves_what_the_gateway_will_actually_send() -> None:
    """assemble_run_context defaulted to reserving 1024 tokens while the gateway
    lets the model emit up to 32000 — so the prompt filled the window minus 1K,
    the model tried to write 32K into what was left, and the provider rejected
    the request outright."""
    assert ex._reserved_output_tokens("deepseek/deepseek-v4-pro") == 32_000


def test_reservation_shrinks_to_a_vouched_for_cap() -> None:
    """gpt-4o can only emit 16384, so holding back 32000 wastes 16K of window."""
    assert ex._reserved_output_tokens("openai/gpt-4o") == 16_384


def test_reservation_ignores_a_stale_registry_cap() -> None:
    """Same rule as the gateway clamp: litellm claims v4-pro caps at 8192 while
    it provably emits 10940. Under-reserving is how output got truncated."""
    assert ex._reserved_output_tokens("deepseek/deepseek-v4-pro") > 8_192


def test_reservation_survives_a_resolver_failure(monkeypatch) -> None:
    import acb_llm.model_limits as ml

    def boom(_m):
        raise RuntimeError("nope")

    monkeypatch.setattr(ml, "get_limits", boom)
    assert ex._reserved_output_tokens("anything") == ex._RESERVED_OUTPUT_TOKENS
