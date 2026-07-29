"""Tests for live agenda coverage.

`coverage()` always knew which items had been discussed, but it ran inside the
copilot's loop — so it fed a prompt, was invisible in the UI, and vanished
entirely when the copilot was off. Moving it onto the transcript bus makes it
available either way. These lock the two properties that make it trustworthy:
it latches, and it stays bounded.
"""
from __future__ import annotations

import pytest
from gateway.routes.notes import agenda_progress as ap

AGENDA = [
    {"title": "Volume pricing tiers", "notes": ""},
    {"title": "Maintenance window", "notes": ""},
    {"title": "Pilot sign-off", "notes": ""},
]


@pytest.fixture(autouse=True)
def _clean():
    ap.reset("m1")
    yield
    ap.reset("m1")


def test_nothing_said_means_nothing_covered() -> None:
    assert ap.mark("m1", AGENDA) == [False, False, False]


def test_discussing_an_item_marks_it_covered() -> None:
    ap.note("m1", "so on volume pricing the tiers work for us at scale")
    marks = ap.mark("m1", AGENDA)
    assert marks[0] is True
    assert marks[1] is False


def test_coverage_latches_once_found() -> None:
    """The property that makes this worth showing. An item discussed at minute
    five is still covered at minute fifty — recomputing from a rolling window
    alone would let items blink back to uncovered as the window moved past
    them, which is worse than not showing coverage at all."""
    ap.note("m1", "the volume pricing tiers look fine")
    assert ap.mark("m1", AGENDA)[0] is True

    # Bury it under far more than the rolling window holds.
    for _ in range(ap._WINDOW_WORDS):
        ap.note("m1", "unrelated chatter about something else entirely")

    assert ap.mark("m1", AGENDA)[0] is True, "coverage regressed"


def test_the_text_buffer_stays_bounded() -> None:
    """A four-hour meeting must not accumulate a four-hour transcript in RAM."""
    for _ in range(ap._WINDOW_WORDS):
        ap.note("m1", "word word word word word")
    assert len(ap._TEXT["m1"]) <= ap._WINDOW_WORDS


def test_a_passing_mention_is_not_coverage() -> None:
    """Saying one word from an item's title shouldn't tick it off."""
    ap.note("m1", "pricing")
    assert ap.mark("m1", AGENDA)[0] is False


def test_empty_agenda_is_survivable() -> None:
    ap.note("m1", "talking away")
    assert ap.mark("m1", []) == []


def test_empty_text_is_ignored() -> None:
    ap.note("m1", "")
    ap.note("m1", "   ")
    assert ap.mark("m1", AGENDA) == [False, False, False]


def test_reset_clears_everything_for_that_meeting_only() -> None:
    ap.note("m1", "the volume pricing tiers look fine")
    ap.note("m2", "the volume pricing tiers look fine")
    assert ap.mark("m1", AGENDA)[0] is True
    ap.reset("m1")
    try:
        assert ap.mark("m1", AGENDA)[0] is False
        assert ap.mark("m2", AGENDA)[0] is True, "reset leaked across meetings"
    finally:
        ap.reset("m2")


def test_elapsed_starts_at_the_first_word_not_at_import() -> None:
    assert ap.elapsed_s("m1") == 0.0
    ap.note("m1", "first thing said")
    assert ap.elapsed_s("m1") >= 0.0
    assert ap.elapsed_s("never-seen") == 0.0
