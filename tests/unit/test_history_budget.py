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
