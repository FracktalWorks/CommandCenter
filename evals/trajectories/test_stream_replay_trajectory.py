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

import asyncio

import pytest

from orchestrator import stream_relay


class _FakePubSub:
    """Minimal async pub/sub stand-in — one Redis-side channel queue per
    subscription, fed by :meth:`FakeRedis.publish`."""

    def __init__(self, hub: "FakeRedis") -> None:
        self._hub = hub
        self._queues: dict[str, asyncio.Queue] = {}

    async def subscribe(self, channel: str) -> None:
        q: asyncio.Queue = asyncio.Queue()
        self._queues[channel] = q
        self._hub._subs.setdefault(channel, []).append(q)

    async def unsubscribe(self, channel: str) -> None:
        q = self._queues.pop(channel, None)
        subs = self._hub._subs.get(channel)
        if subs and q in subs:
            subs.remove(q)

    async def listen(self):
        # Merge all subscribed channel queues; yield redis-shaped messages.
        while True:
            getters = [asyncio.ensure_future(q.get()) for q in self._queues.values()]
            if not getters:
                await asyncio.sleep(0.005)
                continue
            done, pending = await asyncio.wait(
                getters, return_when=asyncio.FIRST_COMPLETED,
            )
            for p in pending:
                p.cancel()
            for d in done:
                yield d.result()

    async def aclose(self) -> None:
        for ch in list(self._queues):
            await self.unsubscribe(ch)


class FakeRedis:
    """Minimal async stand-in for the redis.asyncio client surface used by
    stream_relay (xadd/xread/get/set/delete/expire/exists/publish/pubsub)."""

    def __init__(self) -> None:
        self.streams: dict[str, list[tuple[str, dict]]] = {}
        self.kv: dict[str, str] = {}
        self._subs: dict[str, list[asyncio.Queue]] = {}
        self._seq = 0

    async def publish(self, channel: str, data: str) -> int:
        subs = self._subs.get(channel, [])
        for q in subs:
            q.put_nowait({"type": "message", "channel": channel, "data": data})
        return len(subs)

    def pubsub(self) -> "_FakePubSub":
        return _FakePubSub(self)

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


# ── Cross-worker control bus (P1-2) ─────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_control_state():
    """Isolate the module-global control registries between tests."""
    stream_relay._LOCAL_CONTROL_HANDLERS.clear()
    stream_relay._CONTROL_LISTENERS.clear()
    yield
    stream_relay._LOCAL_CONTROL_HANDLERS.clear()
    for t in stream_relay._CONTROL_LISTENERS.values():
        t.cancel()
    stream_relay._CONTROL_LISTENERS.clear()


async def test_dispatch_control_applies_locally_without_publishing(fake_redis):
    """Owning worker: dispatch_control resolves via the local handler inline
    (no Redis publish needed)."""
    tid = "traj-ctl-local"
    seen: list[dict] = []
    stream_relay.register_control_command(
        tid, "cancel", lambda cmd: (seen.append(cmd), True)[-1],
    )
    ok = await stream_relay.dispatch_control(tid, {"cmd": "cancel"})
    assert ok is True
    assert seen == [{"cmd": "cancel"}]


async def test_dispatch_control_relays_to_owning_worker(fake_redis):
    """Cross-worker: a command with NO local handler is published, and a
    worker whose control listener is subscribed applies it.  This is the P1-2
    fix — a Stop/answer issued on a different worker still reaches the run."""
    tid = "traj-ctl-relay"
    applied: list[dict] = []
    # "Owning worker": register the local applier + subscribe its listener.
    stream_relay.register_control_command(
        tid, "respond_input", lambda cmd: (applied.append(cmd), True)[-1],
    )
    stream_relay._start_control_listener(tid)
    await asyncio.sleep(0.02)  # let the subscribe land

    # "Other worker" now publishes (simulated: same process, but the command
    # travels through Redis pub/sub, not the in-proc handler call).
    delivered = await stream_relay.publish_control(
        tid, {"cmd": "respond_input", "request_id": "r1", "answer": "yes"},
    )
    assert delivered == 1  # the owning worker's listener received it

    # The listener applies it asynchronously.
    for _ in range(50):
        if applied:
            break
        await asyncio.sleep(0.01)
    assert applied == [
        {"cmd": "respond_input", "request_id": "r1", "answer": "yes"},
    ]

    stream_relay._stop_control_listener(tid)


async def test_dispatch_control_false_when_no_run_anywhere(fake_redis):
    """No local handler AND no subscriber AND not active → not delivered."""
    ok = await stream_relay.dispatch_control("traj-ctl-dead", {"cmd": "cancel"})
    assert ok is False


async def test_cancel_run_relays_over_bus_when_task_not_local(fake_redis):
    """cancel_run on a worker that doesn't own the task relays a 'cancel' over
    the bus (the owning worker's listener stops the run) and still emits the
    idempotent terminal teardown."""
    tid = "traj-cancel-remote"
    await stream_relay.mark_active(tid, reset=True)
    cancelled: list[dict] = []
    # Stand in for the owning worker: local cancel applier + live listener.
    stream_relay.register_control_command(
        tid, "cancel", lambda cmd: (cancelled.append(cmd), True)[-1],
    )
    stream_relay._start_control_listener(tid)
    await asyncio.sleep(0.02)

    # No _DETACHED_TASKS entry on "this" worker → cancel_run must relay.
    found = await stream_relay.cancel_run(tid)
    assert found is True  # relayed to a live subscriber

    for _ in range(50):
        if cancelled:
            break
        await asyncio.sleep(0.01)
    assert cancelled == [{"cmd": "cancel"}]

    # Terminal teardown still ran (idempotent): thread marked inactive + a
    # cancelled RUN_FINISHED pushed for subscribers.
    assert await stream_relay.is_active(tid) is False
    events = await stream_relay.replay_events(tid, since_id="0-0")
    assert any(
        e["type"] == "RUN_FINISHED" and e.get("cancelled") for e in events
    )

    stream_relay._stop_control_listener(tid)
