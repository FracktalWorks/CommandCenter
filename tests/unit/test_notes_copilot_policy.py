"""Tests for the copilot's WHEN-to-spend policy.

Stage 1 is what makes the feature affordable: most speech must die here, for
free, before any model is called. It's also what makes the copilot tolerable —
a moderator that interrupts constantly is worse than none. So the gate, the
debounce, the per-meeting cap and the dedup memory are pinned here rather than
left to emerge from prompt behaviour.

All pure — no LLM, no I/O.
"""
from __future__ import annotations

from gateway.routes.notes.copilot_policy import (
    MAX_PER_MEETING,
    MIN_GAP_SECONDS,
    RollingState,
    Window,
    Windower,
    gate,
    is_duplicate,
)

_LONG_AGO = 1e9  # plenty of time since the last interjection


def _w(text: str) -> Window:
    return Window(text=text, speakers=["S1"], start_s=0.0, end_s=5.0)


def _seg(text: str, speaker: str = "S1", start: float = 0.0, end: float = 1.0) -> dict:
    return {"text": text, "speaker_id": speaker, "start_s": start, "end_s": end}


# ── Stage 0: windowing ───────────────────────────────────────────────────────

def test_window_closes_on_speaker_change() -> None:
    """A turn boundary is the natural unit to reason over."""
    w = Windower()
    assert w.push(_seg("I think we should ship it")) is None
    closed = w.push(_seg("I disagree, it's too risky", speaker="S2"))
    assert closed is not None
    assert closed.text == "I think we should ship it"
    assert closed.speakers == ["S1"]


def test_window_closes_on_length_for_a_monologue() -> None:
    """One person talking for a long time must still produce windows."""
    w = Windower()
    closed = None
    for _ in range(12):
        closed = w.push(_seg("word " * 5)) or closed
    assert closed is not None


def test_flush_returns_the_open_window() -> None:
    w = Windower()
    w.push(_seg("trailing thought"))
    assert w.flush().text == "trailing thought"
    assert w.flush() is None


def test_empty_segments_are_ignored() -> None:
    w = Windower()
    assert w.push(_seg("   ")) is None
    assert w.flush() is None


# ── Stage 1: the gate ────────────────────────────────────────────────────────

def test_gate_fires_on_a_question() -> None:
    d = gate(_w("What does the pricing look like for enterprise?"),
             seconds_since_last=_LONG_AGO, interjections_so_far=0)
    assert d.consider is True
    assert "question" in d.reason


def test_gate_fires_on_an_objection() -> None:
    d = gate(_w("Honestly that seems too expensive for what we get"),
             seconds_since_last=_LONG_AGO, interjections_so_far=0)
    assert d.consider is True


def test_gate_fires_on_a_decision_or_number() -> None:
    assert gate(_w("Okay, let's commit to shipping by Friday next week"),
                seconds_since_last=_LONG_AGO, interjections_so_far=0).consider
    assert gate(_w("They quoted us around $40k for the annual contract"),
                seconds_since_last=_LONG_AGO, interjections_so_far=0).consider


def test_gate_stays_quiet_on_ordinary_chatter() -> None:
    """The common case — and it must cost nothing."""
    d = gate(_w("yeah exactly, that makes sense to me as well honestly"),
             seconds_since_last=_LONG_AGO, interjections_so_far=0)
    assert d.consider is False


def test_gate_ignores_fragments_too_short_to_carry_a_thought() -> None:
    assert not gate(_w("what?"), seconds_since_last=_LONG_AGO,
                    interjections_so_far=0).consider


# ── Cost guardrails: these must beat the triggers ────────────────────────────

def test_debounce_wins_over_a_trigger() -> None:
    """Having just spoken, the copilot stays quiet even on a strong trigger —
    otherwise a lively discussion becomes a stream of interruptions."""
    d = gate(_w("But what about the pricing risk here?"),
             seconds_since_last=MIN_GAP_SECONDS - 1, interjections_so_far=0)
    assert d.consider is False
    assert "too soon" in d.reason


def test_per_meeting_cap_wins_over_a_trigger() -> None:
    d = gate(_w("What about the deadline we agreed?"),
             seconds_since_last=_LONG_AGO, interjections_so_far=MAX_PER_MEETING)
    assert d.consider is False
    assert "cap" in d.reason


def test_cap_is_checked_before_anything_else() -> None:
    """Ordering matters: a busy meeting must not be able to run up cost through
    the trigger patterns once the cap is hit."""
    d = gate(_w("What about the pricing?"), seconds_since_last=0.0,
             interjections_so_far=MAX_PER_MEETING + 5)
    assert d.consider is False


# ── Rolling state ────────────────────────────────────────────────────────────

def test_state_stays_compact_however_long_the_meeting_runs() -> None:
    """This is what keeps cost flat — the prompt must not grow with the call."""
    s = RollingState()
    for i in range(200):
        s.note_raised(f"point number {i}")
        s.note_window(Window(text=f"why is thing {i} like that?", speakers=[f"S{i}"]))
    assert len(s.raised) <= RollingState._MAX
    assert len(s.open_questions) <= RollingState._MAX
    assert len(s.as_prompt()) < 2000


def test_state_prompt_tells_the_model_what_not_to_repeat() -> None:
    s = RollingState()
    s.note_raised("Ask about their renewal date")
    assert "do not repeat" in s.as_prompt().lower()
    assert "renewal date" in s.as_prompt()


def test_state_tracks_speakers_seen() -> None:
    s = RollingState()
    s.note_window(Window(text="hello there everyone", speakers=["S1", "S2"]))
    assert s.speakers == ["S1", "S2"]


# ── Dedup ────────────────────────────────────────────────────────────────────

def test_near_duplicate_suggestions_are_suppressed() -> None:
    """Re-raising the same point is the fastest way to become annoying."""
    already = ["Ask whether their current contract renews before December"]
    assert is_duplicate(
        "Ask if the current contract renews before December", already
    )


def test_a_genuinely_new_point_gets_through() -> None:
    already = ["Ask whether their contract renews before December"]
    assert not is_duplicate(
        "Mention the migration support included in onboarding", already
    )


def test_empty_suggestion_counts_as_duplicate() -> None:
    assert is_duplicate("", ["anything"])
