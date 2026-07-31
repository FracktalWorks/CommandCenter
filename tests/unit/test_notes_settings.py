"""Tests for Note Taker settings, and per-meeting-type copilot instructions.

The interesting part is the layering. Two different questions get answered by
two different sources — "who am I / how do I work" (standing instructions) and
"what matters in THIS kind of meeting" (the meeting type) — so they compose
rather than replace. And shipped defaults must keep reaching anyone who hasn't
customised a type, which is why only overrides are stored.
"""
from __future__ import annotations

from gateway.routes.notes.settings import (
    SENSITIVITY_LEVELS,
    NotesSettings,
    effective_instructions,
    template_catalogue,
)
from gateway.routes.notes.templates import TEMPLATES

# ── per-meeting-type guidance ────────────────────────────────────────────────

def test_every_meeting_type_ships_copilot_guidance() -> None:
    """A type with no guidance would silently give a generic copilot."""
    for key, tpl in TEMPLATES.items():
        assert tpl.copilot.strip(), f"{key} has no copilot guidance"
        assert tpl.agenda_hint.strip(), f"{key} has no agenda hint"


def test_guidance_actually_differs_by_meeting_type() -> None:
    """The whole point: a sales nudge in a 1:1 would be actively wrong."""
    one_on_one = TEMPLATES["one_on_one"].copilot.lower()
    customer = TEMPLATES["customer_call"].copilot.lower()
    assert one_on_one != customer
    assert "objection" in customer          # commercial lens
    assert "trust" in one_on_one            # not a status report


def test_standing_and_type_instructions_compose() -> None:
    """They answer different questions, so one must not replace the other."""
    s = NotesSettings(copilot_instructions="I run a 3D-printing company.")
    out = effective_instructions(s, "customer_call")
    assert "3D-printing" in out
    assert "objection" in out.lower()


def test_a_user_override_replaces_the_shipped_default_for_that_type() -> None:
    s = NotesSettings(
        copilot_instructions="Base.",
        template_instructions={"one_on_one": "Only flag workload risks."},
    )
    out = effective_instructions(s, "one_on_one")
    assert "Base." in out
    assert "Only flag workload risks." in out
    assert "trust conversation" not in out.lower()   # shipped default displaced


def test_overriding_one_type_leaves_the_others_on_defaults() -> None:
    """Improved shipped defaults must keep reaching un-customised types."""
    s = NotesSettings(template_instructions={"one_on_one": "custom"})
    assert "custom" in effective_instructions(s, "one_on_one")
    assert "objection" in effective_instructions(s, "customer_call").lower()


def test_no_template_falls_back_to_standing_instructions_only() -> None:
    s = NotesSettings(copilot_instructions="Base.")
    assert effective_instructions(s, None) == "Base."
    assert effective_instructions(s, "") == "Base."


def test_unknown_template_is_survivable() -> None:
    s = NotesSettings(copilot_instructions="Base.")
    assert effective_instructions(s, "no_such_type") == "Base."


def test_empty_settings_yield_empty_instructions() -> None:
    assert effective_instructions(NotesSettings(), None) == ""


# ── sensitivity ──────────────────────────────────────────────────────────────

def test_sensitivity_levels_are_ordered_sensibly() -> None:
    """Higher sensitivity must mean both a shorter wait AND a higher ceiling —
    otherwise the label lies about what it does."""
    low_gap, low_cap = SENSITIVITY_LEVELS["low"]
    norm_gap, norm_cap = SENSITIVITY_LEVELS["normal"]
    high_gap, high_cap = SENSITIVITY_LEVELS["high"]
    assert low_gap > norm_gap > high_gap
    assert low_cap < norm_cap < high_cap


def test_the_gate_honours_the_configured_thresholds() -> None:
    from gateway.routes.notes.copilot_policy import Window, gate

    w = Window(text="What does the pricing look like for enterprise?", speakers=["S1"])
    # 60s since the last one: quiet on "low" (needs 120s), fine on "normal".
    assert not gate(w, seconds_since_last=60, interjections_so_far=0,
                    min_gap_seconds=SENSITIVITY_LEVELS["low"][0],
                    max_per_meeting=SENSITIVITY_LEVELS["low"][1]).consider
    assert gate(w, seconds_since_last=60, interjections_so_far=0,
                min_gap_seconds=SENSITIVITY_LEVELS["normal"][0],
                max_per_meeting=SENSITIVITY_LEVELS["normal"][1]).consider


# ── catalogue ────────────────────────────────────────────────────────────────

def test_catalogue_exposes_defaults_so_the_ui_can_show_them() -> None:
    """The settings screen shows what a type WOULD do before you override it."""
    cat = {t.key: t for t in template_catalogue()}
    assert set(cat) == set(TEMPLATES)
    assert cat["retro"].copilot_default
    assert cat["retro"].label


# ── paying for streaming ASR only when something reads it ────────────────────

def test_auto_follows_the_copilot() -> None:
    """The saving. Streaming is billed per minute for the whole meeting; with
    the copilot off nothing consumes it in real time, and the recording still
    yields the same transcript afterwards at batch prices."""
    from gateway.routes.notes.settings import wants_live_transcription

    assert wants_live_transcription("auto", copilot_on=True) is True
    assert wants_live_transcription("auto", copilot_on=False) is False


def test_always_and_never_ignore_the_copilot() -> None:
    """`always` buys back live captions on copilot-less meetings; `never` is the
    floor. Neither should be second-guessed by the copilot's state."""
    from gateway.routes.notes.settings import wants_live_transcription

    assert wants_live_transcription("always", copilot_on=False) is True
    assert wants_live_transcription("never", copilot_on=True) is False


def test_an_unknown_mode_fails_closed_on_spend() -> None:
    """Of the two ways to be wrong, silently spending money is the worse one —
    so garbage falls back to `auto`, not to `always`."""
    from gateway.routes.notes.settings import wants_live_transcription

    assert wants_live_transcription("", copilot_on=False) is False
    assert wants_live_transcription("nonsense", copilot_on=False) is False
    assert wants_live_transcription("nonsense", copilot_on=True) is True


def test_default_mode_is_auto() -> None:
    assert NotesSettings().live_transcription == "auto"
