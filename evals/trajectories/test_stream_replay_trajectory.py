"""Golden trajectories: reconnect/replay semantics of the Redis stream relay.

Runs against an in-memory FakeRedis so the invariants the frontend relies on
are locked without the docker stack:

- events replay in exact push order with usable cursors
- replay from a mid-stream cursor returns only the tail
- a subscriber terminates on RUN_FINISHED and on inactive-drain
- mark_active(reset=True) establishes a clean per-run stream boundary
- a late in-flight push never resurrects a finished run's active flag
"""
from __future__ import annotations

import pytest

from orchestrator import stream_relay


class FakeRedis:
    """Minimal async stand-in for the redis.asyncio client surface used
    by stream_relay (xadd/xread/get/set/delete/expire/exists)."""

    def __init__(self) -> None:
        self.streams: dict[str, list[tuple[str, dict]]] = {}
        self.kv: dict[str, str] = {}
        self._seq = 0

    @staticmethod
    def _id_tuple(eid: str) -> tuple[int, int]:
        ms, _, seq = eid.partition("-")
        return int(ms), int(seq or 0)

    async def xadd(self, key, fields, maxlen=None, approximate=None):
        self._seq += 1
        eid = f"{self._seq}-0"
        self.streams.setdefault(key, []).append((eid, dict(fields)))
        return eid

    async def xread(self, streams, count=None, block=None):
        out = []
        for key, since in streams.items():
            entries = self.streams.get(key, [])
            if since in ("$",):
                continue  # new-only: nothing arrives synchronously in tests
            floor = (0, 0) if since in ("0", "0-0") else self._id_tuple(since)
            tail = [(eid, f) for eid, f in entries if self._id_tuple(eid) > floor]
            if count is not None:
                tail = tail[:count]
            if tail:
                out.append((key, tail))
        return out

    async def get(self, key):
        return self.kv.get(key)

    async def set(self, key, value, ex=None, xx=False):
        if xx and key not in self.kv:
            return None
        self.kv[key] = value
        return True

    async def delete(self, key):
        self.kv.pop(key, None)
        self.streams.pop(key, None)
        return 1

    async def expire(self, key, ttl):
        return True

    async def exists(self, key):
        return int(key in self.kv or key in self.streams)


@pytest.fixture()
def fake_redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(stream_relay, "_client", fake)
    return fake


async def test_ordered_replay_with_cursor(fake_redis):
    tid = "traj-replay"
    await stream_relay.mark_active(tid, reset=True)
    for i in range(5):
        await stream_relay.push_event(tid, {"type": "TEXT_MESSAGE_CONTENT", "n": i})

    events = await stream_relay.replay_events(tid, since_id="0-0")
    assert [e["n"] for e in events] == [0, 1, 2, 3, 4]
    assert all("_stream_id" in e for e in events)

    tail = await stream_relay.replay_events(tid, since_id=events[2]["_stream_id"])
    assert [e["n"] for e in tail] == [3, 4]


async def test_subscriber_terminates_on_run_finished(fake_redis):
    tid = "traj-terminal"
    await stream_relay.mark_active(tid, reset=True)
    await stream_relay.push_event(tid, {"type": "TEXT_MESSAGE_CONTENT", "n": 0})
    await stream_relay.push_event(tid, {"type": "RUN_FINISHED"})
    # Anything after the terminal event belongs to no run and must not leak.
    await stream_relay.push_event(tid, {"type": "TEXT_MESSAGE_CONTENT", "n": 99})

    seen = [e async for e in stream_relay.subscribe_events(tid, since_id="0")]
    assert [e["type"] for e in seen] == ["TEXT_MESSAGE_CONTENT", "RUN_FINISHED"]


async def test_subscriber_drains_after_inactive(fake_redis):
    tid = "traj-drain"
    await stream_relay.mark_active(tid, reset=True)
    await stream_relay.push_event(tid, {"type": "TEXT_MESSAGE_CONTENT", "n": 0})
    await stream_relay.push_event(tid, {"type": "TEXT_MESSAGE_CONTENT", "n": 1})
    await stream_relay.mark_inactive(tid)

    seen = [e async for e in stream_relay.subscribe_events(tid, since_id="0")]
    assert [e["n"] for e in seen] == [0, 1]


async def test_reset_establishes_run_boundary(fake_redis):
    tid = "traj-reset"
    await stream_relay.mark_active(tid, reset=True)
    await stream_relay.push_event(tid, {"type": "TEXT_MESSAGE_CONTENT", "run": 1})

    # New run on the same thread: replay-from-0 must see ONLY its events.
    await stream_relay.mark_active(tid, reset=True)
    await stream_relay.push_event(tid, {"type": "TEXT_MESSAGE_CONTENT", "run": 2})

    events = await stream_relay.replay_events(tid, since_id="0-0")
    assert [e["run"] for e in events] == [2]


async def test_late_push_does_not_resurrect_finished_run(fake_redis):
    tid = "traj-xx"
    await stream_relay.mark_active(tid, reset=True)
    await stream_relay.mark_inactive(tid)

    # A late in-flight push after cancel/finish refreshes TTLs with xx=True —
    # it must NOT flip the thread back to active.
    await stream_relay.push_event(tid, {"type": "TEXT_MESSAGE_CONTENT", "late": True})
    assert await stream_relay.is_active(tid) is False


async def test_push_sse_event_parses_both_frame_formats(fake_redis):
    tid = "traj-sse"
    await stream_relay.mark_active(tid, reset=True)

    assert await stream_relay.push_sse_event(
        tid, 'data: {"type": "TEXT_MESSAGE_CONTENT", "delta": "hi"}\n\n',
    ) != ""
    assert await stream_relay.push_sse_event(
        tid, 'event: RUN_FINISHED\ndata: {"type": "RUN_FINISHED"}\n\n',
    ) != ""
    # Unparseable frames are reported as not-pushed, never raised.
    assert await stream_relay.push_sse_event(tid, "data: not-json\n\n") == ""
    assert await stream_relay.push_sse_event(tid, ": keepalive\n\n") == ""

    events = await stream_relay.replay_events(tid, since_id="0-0")
    assert [e["type"] for e in events] == ["TEXT_MESSAGE_CONTENT", "RUN_FINISHED"]
