"""Why the notetaker stopped — and why the distinction is the product.

A short or empty recording has several completely different causes: nobody ever
joined, the host removed the bot, the call ended before it arrived, or the audio
stack is broken. Before this, all of them surfaced as "captured no audio — check
PulseAudio", which sends someone into a container to debug a working audio
pipeline when the real answer is "that meeting never happened".

The `.meet` module needs Playwright, so the pure classifiers are loaded by path
with a stub — same trick as the other worker tests.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import types

import pytest

_APP = pathlib.Path(__file__).resolve().parents[2] / "apps/services/meeting_bot/app"


def _load_meet():
    """Load meet.py with a stubbed playwright so the module imports."""
    pw = types.ModuleType("playwright")
    aio = types.ModuleType("playwright.async_api")
    aio.async_playwright = lambda: None
    sys.modules.setdefault("playwright", pw)
    sys.modules.setdefault("playwright.async_api", aio)

    spec = importlib.util.spec_from_file_location("mbmeet", _APP / "meet.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mbmeet"] = mod
    spec.loader.exec_module(mod)
    return mod


meet = _load_meet()


# ── kicked vs ended ──────────────────────────────────────────────────────────

def test_being_removed_by_the_host_is_not_an_ordinary_end() -> None:
    """Meet's removal screen ALSO offers "Return to home screen", so checking
    the generic end markers first would report every ejection as a normal
    finish — and being removed is someone declining to be recorded, which is
    exactly the thing worth surfacing."""
    body = (
        "You've been removed from the meeting Return to home screen "
        "Submit feedback"
    )
    assert meet.classify_call_end(body) == "kicked"


def test_a_normal_end_is_reported_as_ended() -> None:
    assert meet.classify_call_end("You've left the meeting Rejoin") == "ended"
    assert meet.classify_call_end("Call ended Return to home screen") == "ended"


def test_an_ongoing_call_is_neither() -> None:
    body = "Leave call You Priya Turn off microphone Chat with everyone"
    assert meet.classify_call_end(body) is None


def test_classification_is_case_insensitive_and_tolerates_none() -> None:
    assert meet.classify_call_end("YOU WERE REMOVED") == "kicked"
    assert meet.classify_call_end("") is None
    assert meet.classify_call_end(None) is None  # type: ignore[arg-type]


# ── the two alone-timers ─────────────────────────────────────────────────────

class _FakePage:
    """A page whose participant count and body text follow a script."""

    def __init__(self, counts: list[int], body: str = "Leave call") -> None:
        self.counts = counts
        self.body = body
        self.calls = 0

    async def evaluate(self, _script):
        # Hold the final value once the script runs out.
        i = min(self.calls, len(self.counts) - 1)
        self.calls += 1
        return self.counts[i]

    async def inner_text(self, _sel):
        return self.body


@pytest.mark.asyncio
async def test_a_bot_alone_from_the_start_gives_up_on_the_short_timer(
    monkeypatch,
) -> None:
    """A meeting nobody joined is a mistake to abandon quickly. Critically, it
    must NOT hold the worker for the 4-hour cap: only one bot runs at a time, so
    a bot parked in an empty room takes the whole feature down with it."""
    monkeypatch.setattr(meet, "NOONE_JOINED_TIMEOUT_S", 15)
    monkeypatch.setattr(meet, "ALONE_TIMEOUT_S", 600)
    monkeypatch.setattr(meet.asyncio, "sleep", _instant_sleep)
    import asyncio as real_asyncio

    reason = await meet._wait_until_end(_FakePage([1]), real_asyncio.Event())
    assert reason == "noone_joined"


@pytest.mark.asyncio
async def test_everyone_leaving_uses_the_longer_timer(monkeypatch) -> None:
    """Once others HAVE been seen, wait longer — people reconnect."""
    monkeypatch.setattr(meet, "NOONE_JOINED_TIMEOUT_S", 15)
    monkeypatch.setattr(meet, "ALONE_TIMEOUT_S", 30)
    monkeypatch.setattr(meet.asyncio, "sleep", _instant_sleep)
    import asyncio as real_asyncio

    # Two others present, then alone forever.
    page = _FakePage([3, 3, 1])
    reason = await meet._wait_until_end(page, real_asyncio.Event())
    assert reason == "everyone_left"


@pytest.mark.asyncio
async def test_an_unreadable_count_never_counts_as_alone(monkeypatch) -> None:
    """The participant selectors are the least stable thing we read. When they
    rot, the bot must keep recording — leaving a live meeting loses the call,
    while lingering only wastes a few minutes."""
    monkeypatch.setattr(meet, "NOONE_JOINED_TIMEOUT_S", 10)
    monkeypatch.setattr(meet, "ALONE_TIMEOUT_S", 10)
    monkeypatch.setattr(meet, "MAX_DURATION_S", 30)
    monkeypatch.setattr(meet.asyncio, "sleep", _instant_sleep)
    import asyncio as real_asyncio

    reason = await meet._wait_until_end(_FakePage([-1]), real_asyncio.Event())
    assert reason == "max_duration", "unknown count must not trigger an early leave"


@pytest.mark.asyncio
async def test_being_asked_to_leave_wins_immediately(monkeypatch) -> None:
    monkeypatch.setattr(meet.asyncio, "sleep", _instant_sleep)
    import asyncio as real_asyncio

    ev = real_asyncio.Event()
    ev.set()
    assert await meet._wait_until_end(_FakePage([3]), ev) == "asked"


@pytest.mark.asyncio
async def test_a_kick_mid_call_is_reported_as_kicked(monkeypatch) -> None:
    monkeypatch.setattr(meet.asyncio, "sleep", _instant_sleep)
    import asyncio as real_asyncio

    page = _FakePage([3], body="You were removed from the meeting")
    assert await meet._wait_until_end(page, real_asyncio.Event()) == "kicked"


async def _instant_sleep(_seconds):
    """Run the loop without real time passing."""
    return None


# ── participant count ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_participant_count_returns_minus_one_when_the_page_fails() -> None:
    class _Broken:
        async def evaluate(self, _s):
            raise RuntimeError("detached frame")

    assert await meet._participant_count(_Broken()) == -1


@pytest.mark.asyncio
async def test_participant_count_coerces_whatever_the_page_returns() -> None:
    class _Stringy:
        async def evaluate(self, _s):
            return "4"

    assert await meet._participant_count(_Stringy()) == 4
