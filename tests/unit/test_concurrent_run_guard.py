"""A second person cannot destroy a first person's in-flight run.

Spec: ``docs/multiplayer/README.md`` §3.3 (the finding) and §5.2 (the fix).

Starting a run on an already-active thread cancels the previous one *and*
deletes its Redis event log (``run_detached`` → ``mark_active(reset=True)``).
That is correct when you supersede your own run — steer, retry, Quick action —
and destructive the moment two people share a thread: the first person's work
disappears with no error, because the cancel path deliberately suppresses
``RUN_ERROR`` (it treats cancellation as a supersede, not a failure).

The guard therefore keys on *who owns the live run*, not merely on one existing:

* same actor  → allowed (every existing supersede path is untouched)
* other actor → 409
* unknown     → allowed (fail open, matching ``_thread_owner_ok``)
"""
from __future__ import annotations

import pytest

stream_relay = pytest.importorskip(
    "orchestrator.stream_relay", reason="orchestrator not installed",
)


class _FakeRedis:
    """Minimal async stand-in for the keys the relay touches."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def set(self, key, value, ex=None, xx=False, **_kw):
        if xx and key not in self.store:
            return None
        self.store[key] = value
        return True

    async def get(self, key):
        return self.store.get(key)

    async def delete(self, *keys):
        for k in keys:
            self.store.pop(k, None)
        return True

    async def expire(self, *_a, **_kw):
        return True

    async def exists(self, key):
        return 1 if key in self.store else 0


@pytest.fixture
def fake_redis(monkeypatch):
    r = _FakeRedis()

    async def _get_client():
        return r

    monkeypatch.setattr(stream_relay, "_get_client", _get_client)
    return r


# ---------------------------------------------------------------------------
# Actor recording
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_mark_active_records_the_actor(fake_redis) -> None:
    await stream_relay.mark_active("t1", actor="vijay@fracktal.in")
    assert await stream_relay.get_run_actor("t1") == "vijay@fracktal.in"
    assert await stream_relay.is_active("t1") is True


@pytest.mark.asyncio
async def test_mark_active_without_an_actor_records_none(fake_redis) -> None:
    await stream_relay.mark_active("t1")
    assert await stream_relay.get_run_actor("t1") is None


@pytest.mark.asyncio
async def test_an_actorless_run_does_not_inherit_the_previous_actor(fake_redis) -> None:
    """Otherwise an anonymous or internal run would look like it belongs to
    whoever ran last, and a third party could be refused on their behalf."""
    await stream_relay.mark_active("t1", actor="vijay@fracktal.in")
    await stream_relay.mark_active("t1", actor=None)
    assert await stream_relay.get_run_actor("t1") is None


@pytest.mark.asyncio
async def test_finishing_a_run_clears_its_actor(fake_redis) -> None:
    """A finished run has no owner — the next caller must not be refused
    against a stale one."""
    await stream_relay.mark_active("t1", actor="vijay@fracktal.in")
    await stream_relay.mark_inactive("t1")
    assert await stream_relay.get_run_actor("t1") is None
    assert await stream_relay.is_active("t1") is False


@pytest.mark.asyncio
async def test_get_run_actor_fails_open_when_redis_is_down(monkeypatch) -> None:
    async def _boom():
        raise RuntimeError("redis down")

    monkeypatch.setattr(stream_relay, "_get_client", _boom)
    assert await stream_relay.get_run_actor("t1") is None


@pytest.mark.asyncio
async def test_actor_is_isolated_per_thread(fake_redis) -> None:
    await stream_relay.mark_active("t1", actor="vijay@fracktal.in")
    await stream_relay.mark_active("t2", actor="sanjay@fracktal.in")
    assert await stream_relay.get_run_actor("t1") == "vijay@fracktal.in"
    assert await stream_relay.get_run_actor("t2") == "sanjay@fracktal.in"


@pytest.mark.asyncio
async def test_reset_wipes_the_event_log(fake_redis) -> None:
    """The behaviour the guard exists to protect: reset=True DELETES the
    previous run's transcript. Asserting it here so the destructiveness stays
    visible if anyone re-reads this in isolation."""
    fake_redis.store[stream_relay._stream_key("t1")] = "previous events"
    await stream_relay.mark_active("t1", reset=True, actor="sanjay@fracktal.in")
    assert stream_relay._stream_key("t1") not in fake_redis.store


# ---------------------------------------------------------------------------
# The refusal decision — exercising the REAL guard
# ---------------------------------------------------------------------------

routes_agent = pytest.importorskip(
    "gateway.routes.agent", reason="gateway not installed",
)


async def _would_refuse(thread_id: str, actor: str) -> bool:
    """True when the real route guard would 409.

    Calls ``_refuse_if_another_run_is_active`` rather than reimplementing its
    logic, so these tests fail if the guard changes rather than drifting from it.
    """
    from fastapi import HTTPException

    try:
        await routes_agent._refuse_if_another_run_is_active(thread_id, actor)
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail["error"] == "run_in_progress"
        assert exc.detail["threadId"] == thread_id
        return True
    return False


@pytest.mark.asyncio
async def test_a_different_person_is_refused(fake_redis) -> None:
    """The bug: Sanjay's message would cancel Vijay's run and erase it."""
    await stream_relay.mark_active("t1", actor="vijay@fracktal.in")
    assert await _would_refuse("t1", "sanjay@fracktal.in") is True


@pytest.mark.asyncio
async def test_the_same_person_may_supersede_their_own_run(fake_redis) -> None:
    """Steer, retry and Quick action all land here — none may break."""
    await stream_relay.mark_active("t1", actor="vijay@fracktal.in")
    assert await _would_refuse("t1", "vijay@fracktal.in") is False


@pytest.mark.asyncio
async def test_an_idle_thread_is_never_refused(fake_redis) -> None:
    assert await _would_refuse("t1", "sanjay@fracktal.in") is False


@pytest.mark.asyncio
async def test_a_finished_run_is_never_refused(fake_redis) -> None:
    await stream_relay.mark_active("t1", actor="vijay@fracktal.in")
    await stream_relay.mark_inactive("t1")
    assert await _would_refuse("t1", "sanjay@fracktal.in") is False


@pytest.mark.asyncio
async def test_an_unattributable_run_fails_open(fake_redis) -> None:
    """A legacy run started before actors were recorded must not block a
    legitimate retry — a false refusal blocks real work, a false allow only
    restores today's behaviour."""
    await stream_relay.mark_active("t1")  # active, no actor
    assert await _would_refuse("t1", "sanjay@fracktal.in") is False


@pytest.mark.asyncio
async def test_an_anonymous_caller_is_never_refused(fake_redis) -> None:
    """Internal/cron callers carry no email; refusing them would break
    server-to-server runs."""
    await stream_relay.mark_active("t1", actor="vijay@fracktal.in")
    assert await _would_refuse("t1", "") is False


@pytest.mark.asyncio
async def test_the_refusal_names_the_holder(fake_redis) -> None:
    """The 409 body has to say WHOSE run it is, or the UI can only show a dead
    end instead of "Vijay is running — steer, or wait"."""
    from fastapi import HTTPException

    await stream_relay.mark_active("t1", actor="vijay@fracktal.in")
    with pytest.raises(HTTPException) as caught:
        await routes_agent._refuse_if_another_run_is_active(
            "t1", "sanjay@fracktal.in",
        )
    assert caught.value.detail["holder"] == "vijay@fracktal.in"
    assert "vijay@fracktal.in" in caught.value.detail["message"]


@pytest.mark.asyncio
async def test_a_check_failure_fails_open(monkeypatch, fake_redis) -> None:
    """A broken Redis must not stop people working."""
    await stream_relay.mark_active("t1", actor="vijay@fracktal.in")

    async def _boom(_tid):
        raise RuntimeError("redis down")

    monkeypatch.setattr(stream_relay, "is_active", _boom)
    assert await _would_refuse("t1", "sanjay@fracktal.in") is False
