"""Integration tests for the detached stream-relay architecture.

Requires a running Redis (acb-redis container).  Verifies the core
guarantees of spec_stream_reconnection.md:

1. ``run_detached`` pushes every event to Redis in emission order.
2. The agent run SURVIVES subscriber disconnect (detached execution).
3. ``RUN_FINISHED`` lands in Redis before the active flag clears.
4. ``replay_events`` returns the full run for a late reconnector.
5. ``mark_active(reset=True)`` gives each run a fresh stream.
"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

import pytest

pytestmark = pytest.mark.asyncio


def _redis_available() -> bool:
    try:
        import redis

        r = redis.from_url("redis://localhost:6379", socket_connect_timeout=1)
        return bool(r.ping())
    except Exception:  # noqa: BLE001
        return False


requires_redis = pytest.mark.skipif(
    not _redis_available(), reason="Redis not running on localhost:6379"
)


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


async def _fake_agent(n: int = 5, delay: float = 0.05) -> AsyncIterator[str]:
    """Simulate an agent SSE stream: RUN_STARTED, deltas, RUN_FINISHED."""
    yield _sse({"type": "RUN_STARTED", "runId": "r1"})
    for i in range(n):
        await asyncio.sleep(delay)
        yield _sse({"type": "TEXT_MESSAGE_CONTENT", "delta": f"word{i} "})
    yield _sse({"type": "RUN_FINISHED", "runId": "r1"})


@requires_redis
async def test_run_detached_pushes_all_events_in_order():
    from orchestrator.stream_relay import replay_events, run_detached

    tid = "test-relay-order"
    got = []
    async for evt in run_detached(tid, _fake_agent(), tee=True):
        got.append(evt["type"])

    assert got[0] == "RUN_STARTED"
    assert got[-1] == "RUN_FINISHED"
    assert got.count("TEXT_MESSAGE_CONTENT") == 5

    # Replay must return the identical sequence.
    replayed = await replay_events(tid, since_id="0-0")
    assert [e["type"] for e in replayed] == got
    # Deltas must be in emission order.
    deltas = [e["delta"] for e in replayed if e["type"] == "TEXT_MESSAGE_CONTENT"]
    assert deltas == [f"word{i} " for i in range(5)]


@requires_redis
async def test_run_survives_subscriber_disconnect():
    from orchestrator.stream_relay import (
        get_detached_task,
        is_active,
        replay_events,
        run_detached,
    )

    tid = "test-relay-detach"
    gen = run_detached(tid, _fake_agent(n=10, delay=0.1), tee=True)

    # Consume only the first 2 events, then DISCONNECT (close the subscriber).
    seen = 0
    async for _evt in gen:
        seen += 1
        if seen >= 2:
            break
    await gen.aclose()  # simulates uvicorn cancelling the response generator

    # The detached task must still be running.
    task = get_detached_task(tid)
    assert task is not None and not task.done(), "run died with the subscriber"

    # Wait for the run to finish on its own.
    await asyncio.wait_for(task, timeout=5)

    # Full run must be in Redis: 1 start + 10 deltas + 1 finish.
    replayed = await replay_events(tid, since_id="0-0")
    types = [e["type"] for e in replayed]
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert types.count("TEXT_MESSAGE_CONTENT") == 10
    assert not await is_active(tid)


@requires_redis
async def test_reconnect_replays_then_follows_live():
    from orchestrator.stream_relay import (
        replay_events,
        run_detached,
        subscribe_events,
    )

    tid = "test-relay-reconnect"
    gen = run_detached(tid, _fake_agent(n=8, delay=0.1), tee=True)

    # Read 3 events then disconnect, remembering the cursor.
    cursor = "0-0"
    seen = 0
    async for evt in gen:
        cursor = evt["_stream_id"]
        seen += 1
        if seen >= 3:
            break
    await gen.aclose()

    # Reconnect: replay from cursor, then subscribe live from replay tail.
    types: list[str] = []
    replayed = await replay_events(tid, since_id=cursor)
    for e in replayed:
        types.append(e["type"])
        cursor = e["_stream_id"]
    async for e in subscribe_events(tid, since_id=cursor):
        types.append(e["type"])

    # Replay + live must cover the remaining 5 events exactly once, ending
    # with RUN_FINISHED (no gap, no duplicates).
    assert types[-1] == "RUN_FINISHED"
    total_deltas = types.count("TEXT_MESSAGE_CONTENT")
    assert total_deltas == 8 - 2  # 2 deltas were consumed before disconnect


@requires_redis
async def test_mark_active_reset_gives_fresh_stream():
    from orchestrator.stream_relay import (
        mark_active,
        mark_inactive,
        push_event,
        replay_events,
    )

    tid = "test-relay-reset"
    await mark_active(tid, reset=True)
    await push_event(tid, {"type": "OLD_EVENT"})
    await mark_inactive(tid)

    # New run resets the stream — old events must be gone.
    await mark_active(tid, reset=True)
    await push_event(tid, {"type": "NEW_EVENT"})
    await mark_inactive(tid)

    replayed = await replay_events(tid, since_id="0-0")
    assert [e["type"] for e in replayed] == ["NEW_EVENT"]


@requires_redis
async def test_push_sse_event_handles_multiline_frames():
    from orchestrator.stream_relay import (
        mark_active,
        mark_inactive,
        push_sse_event,
        replay_events,
    )

    tid = "test-relay-multiline"
    await mark_active(tid, reset=True)
    # AG-UI EventEncoder format: event-type line + data line.
    eid = await push_sse_event(
        tid, 'event: TEXT_MESSAGE_CONTENT\ndata: {"type": "TEXT_MESSAGE_CONTENT", "delta": "hi"}\n\n'
    )
    assert eid
    await mark_inactive(tid)

    replayed = await replay_events(tid, since_id="0-0")
    assert replayed[0]["delta"] == "hi"
