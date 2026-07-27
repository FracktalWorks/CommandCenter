"""Tests for the server-side live-transcript bus (streaming architecture).

The bus is the linchpin that lets live captions AND agents consume an in-progress
meeting's transcript off one pipe. These lock its fan-out semantics without any
network: publish → ring history + live subscribers, with a bounded backlog.
"""
from __future__ import annotations

import asyncio

from gateway.routes.notes import live_transcript as lt


def _seg(text: str) -> dict:
    return {"text": text, "start_s": 0.0, "end_s": 1.0, "is_final": True}


def test_publish_keeps_recent_history() -> None:
    mid = "m-history"
    lt._BUSES.pop(mid, None)
    for i in range(3):
        lt.publish_segment(mid, _seg(f"s{i}"))
    ring = list(lt._bus(mid).ring)
    assert [s["text"] for s in ring] == ["s0", "s1", "s2"]


def test_ring_is_bounded() -> None:
    mid = "m-bound"
    lt._BUSES.pop(mid, None)
    for i in range(lt._RING + 50):
        lt.publish_segment(mid, _seg(f"s{i}"))
    assert len(lt._bus(mid).ring) == lt._RING  # oldest dropped


def test_generator_replays_history() -> None:
    """A subscriber joining mid-meeting first replays the ring (recent context)."""
    async def scenario() -> list[str]:
        mid = "m-replay"
        lt._BUSES.pop(mid, None)
        lt.publish_segment(mid, _seg("past-1"))
        lt.publish_segment(mid, _seg("past-2"))
        agen = lt.subscribe(mid)
        seen = [(await agen.__anext__())["text"], (await agen.__anext__())["text"]]
        await agen.aclose()
        return seen

    assert asyncio.run(scenario()) == ["past-1", "past-2"]


def test_bus_fans_out_live_to_subscribers() -> None:
    """A registered subscriber receives segments published after it joined."""
    bus = lt._Bus()
    q = bus.subscribe()
    bus.publish(_seg("live-1"))
    assert q.get_nowait()["text"] == "live-1"


def test_bus_backlog_is_bounded_and_drops_oldest() -> None:
    bus = lt._Bus()
    q = bus.subscribe()
    for i in range(lt._QUEUE_MAX + 10):
        bus.publish(_seg(f"s{i}"))
    assert q.qsize() == lt._QUEUE_MAX  # slow consumer can't wedge the bus


def test_unsubscribe_removes_subscriber() -> None:
    bus = lt._Bus()
    q = bus.subscribe()
    assert q in bus.subs
    bus.unsubscribe(q)
    assert q not in bus.subs
