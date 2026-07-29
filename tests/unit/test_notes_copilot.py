"""Tests for the copilot orchestrator's lifecycle and event bus.

Two properties matter most and are easy to get wrong:
  1. Turning the copilot OFF must actually stop spend — the task has to be
     cancelled, not just flagged, or the toggle is a lie.
  2. The copilot is a consumer of the transcript, never in the capture path, so
     nothing here may raise into the meeting.
"""
from __future__ import annotations

import asyncio

from gateway.routes.notes import copilot


def test_emit_publishes_and_keeps_history() -> None:
    mid = "cop-emit"
    copilot._BUSES.pop(mid, None)
    copilot.emit(mid, "suggestion", "Ask about the renewal date")
    copilot.emit(mid, "status", "Copilot is listening.")
    ring = list(copilot._bus(mid).ring)
    assert [e["kind"] for e in ring] == ["suggestion", "status"]
    assert ring[0]["text"] == "Ask about the renewal date"


def test_subscriber_receives_events_live() -> None:
    bus = copilot._Bus()
    q = bus.subscribe()
    bus.publish({"kind": "suggestion", "text": "x"})
    assert q.get_nowait()["text"] == "x"


def test_backlog_is_bounded_so_a_slow_console_cant_wedge_it() -> None:
    bus = copilot._Bus()
    q = bus.subscribe()
    for i in range(copilot._QUEUE_MAX + 25):
        bus.publish({"kind": "status", "text": str(i)})
    assert q.qsize() == copilot._QUEUE_MAX


def test_start_is_idempotent_and_stop_cancels_the_task() -> None:
    """Off must mean cancelled — that's what unsubscribes from the transcript
    bus and makes spend stop immediately."""
    async def scenario() -> tuple[bool, bool, bool, bool]:
        mid = "cop-lifecycle"
        copilot._BUSES.pop(mid, None)
        first = copilot.start(mid)
        second = copilot.start(mid)        # already running → no second task
        running = copilot.is_running(mid)
        stopped = copilot.stop(mid)
        await asyncio.sleep(0)             # let the cancellation land
        return first, second, running, stopped

    first, second, running, stopped = asyncio.run(scenario())
    assert first is True
    assert second is False
    assert running is True
    assert stopped is True


def test_stopping_something_not_running_is_harmless() -> None:
    assert copilot.stop("cop-never-started") is False


def test_stop_announces_itself_on_the_bus() -> None:
    """The console should show the copilot went quiet deliberately, rather than
    the user wondering whether it broke."""
    async def scenario() -> list[str]:
        mid = "cop-announce"
        copilot._BUSES.pop(mid, None)
        copilot.start(mid)
        copilot.stop(mid)
        await asyncio.sleep(0)
        return [e["text"] for e in copilot._bus(mid).ring]

    assert "Copilot is off." in asyncio.run(scenario())


def test_budget_is_configurable_with_a_sane_default(monkeypatch) -> None:
    monkeypatch.delenv("NOTES_COPILOT_TOKEN_BUDGET", raising=False)
    assert copilot._budget_tokens() == 60000
    monkeypatch.setenv("NOTES_COPILOT_TOKEN_BUDGET", "1234")
    assert copilot._budget_tokens() == 1234
    monkeypatch.setenv("NOTES_COPILOT_TOKEN_BUDGET", "not-a-number")
    assert copilot._budget_tokens() == 60000   # never crashes on bad config
