"""§5.2 — a second party cannot delete a transcript they do not own.

``docs/multiplayer/README.md`` §3.3 is the bug: starting a run on an already
active thread cancels the previous run AND deletes its Redis event log
(``run_detached`` → ``mark_active(reset=True)``), silently, because that path
deliberately suppresses ``RUN_ERROR`` — it was written for "supersede my own
run". Two people on one thread turns it into 40 minutes of somebody else's work
vanishing with no error.

These tests pin the INNER layer of the fix: the destructive statement is
unreachable except by the run's own actor, regardless of which call site reaches
``run_detached``. The route's 409 is policy and can be forgotten by a new
caller; this is an invariant and cannot.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from orchestrator import stream_relay
from orchestrator.stream_relay import SupersedeRefused


@pytest.fixture
def relay_world(monkeypatch):
    """A fake thread world: who owns the run, and what got destroyed."""
    state: dict[str, Any] = {
        "owner": None,
        "active": False,
        "resets": [],      # every mark_active(reset=True) that actually happened
        "marked": [],
    }

    async def _get_run_actor(_tid: str) -> str | None:
        return state["owner"]

    async def _is_active(_tid: str) -> bool:
        return bool(state["active"])

    async def _mark_active(tid: str, **kw: Any) -> None:
        if kw.get("reset"):
            state["resets"].append(tid)
        state["marked"].append(kw)

    async def _mark_inactive(_tid: str) -> None:
        return None

    async def _subscribe(_tid: str, since_id: str = "0"):
        yield {"type": "RUN_FINISHED"}

    monkeypatch.setattr(stream_relay, "get_run_actor", _get_run_actor)
    monkeypatch.setattr(stream_relay, "is_active", _is_active)
    monkeypatch.setattr(stream_relay, "mark_active", _mark_active)
    monkeypatch.setattr(stream_relay, "mark_inactive", _mark_inactive)
    monkeypatch.setattr(stream_relay, "subscribe_events", _subscribe)
    monkeypatch.setattr(stream_relay, "_start_control_listener", lambda _t: None)
    stream_relay._DETACHED_TASKS.clear()
    stream_relay._LOCAL_CONTROL_HANDLERS.clear()
    yield state
    stream_relay._DETACHED_TASKS.clear()
    stream_relay._LOCAL_CONTROL_HANDLERS.clear()


async def _empty_gen():
    if False:  # pragma: no cover - a generator that yields nothing
        yield ""


def _run(thread_id: str, actor: str | None, **kw: Any) -> list[Any]:
    async def _go() -> list[Any]:
        out = []
        async for evt in stream_relay.run_detached(
            thread_id, _empty_gen(), actor=actor, **kw,
        ):
            out.append(evt)
        return out

    return asyncio.run(_go())


# ---------------------------------------------------------------------------
# The destruction guard
# ---------------------------------------------------------------------------

def test_a_second_party_cannot_delete_a_transcript_they_dont_own(relay_world):
    """THE test. Bob must not be able to erase Alice's 40-minute run."""
    relay_world["owner"] = "alice@x.io"
    relay_world["active"] = True

    with pytest.raises(SupersedeRefused) as exc:
        _run("t-shared", "bob@x.io")

    assert relay_world["resets"] == [], (
        "the destructive mark_active(reset=True) must never have run"
    )
    assert exc.value.owner == "alice@x.io"
    assert exc.value.actor == "bob@x.io"


def test_the_refusal_names_who_would_have_been_destroyed(relay_world):
    """A silent supersede is the bug; an anonymous refusal is a smaller one."""
    relay_world["owner"] = "alice@x.io"
    relay_world["active"] = True

    with pytest.raises(SupersedeRefused) as exc:
        _run("t-shared", "bob@x.io")
    assert "alice@x.io" in str(exc.value)


def test_the_owner_may_still_supersede_their_own_run(relay_world):
    """Steer / retry / Quick action must keep working byte-for-byte."""
    relay_world["owner"] = "alice@x.io"
    relay_world["active"] = True

    _run("t-solo", "alice@x.io")
    assert relay_world["resets"] == ["t-solo"]


def test_an_idle_thread_is_not_protected(relay_world):
    """A stale actor key must not lock a finished thread against everyone."""
    relay_world["owner"] = "alice@x.io"
    relay_world["active"] = False

    _run("t-idle", "bob@x.io")
    assert relay_world["resets"] == ["t-idle"]


def test_an_unattributable_run_fails_open(relay_world):
    """get_run_actor's contract: unknown owner means allow, not refuse.

    A run predating actor tracking, or a Redis hiccup, must not block a
    legitimate retry — a false refusal blocks real work, a false allow only
    restores the behaviour we already had.
    """
    relay_world["owner"] = None
    relay_world["active"] = True

    _run("t-legacy", "bob@x.io")
    assert relay_world["resets"] == ["t-legacy"]


def test_an_anonymous_caller_fails_open(relay_world):
    """Cron / service-to-service callers carry no email and must not be refused."""
    relay_world["owner"] = "alice@x.io"
    relay_world["active"] = True

    _run("t-cron", None)
    assert relay_world["resets"] == ["t-cron"]


def test_a_failing_check_never_blocks_a_run(relay_world, monkeypatch):
    """The guard must not become a new way for Redis to break every run."""
    async def _boom(_tid: str) -> Any:
        raise RuntimeError("redis down")

    monkeypatch.setattr(stream_relay, "get_run_actor", _boom)
    relay_world["owner"] = "alice@x.io"
    relay_world["active"] = True

    _run("t-broken", "bob@x.io")
    assert relay_world["resets"] == ["t-broken"]


# ---------------------------------------------------------------------------
# What the run records about itself, so a steer can be judged later
# ---------------------------------------------------------------------------

def test_a_run_records_its_actor_source_and_floor(relay_world):
    _run(
        "t-room", "alice@x.io",
        source="chat", floor=["alice@x.io", "bob@x.io"],
    )
    marked = relay_world["marked"][-1]
    assert marked["actor"] == "alice@x.io"
    assert marked["source"] == "chat"
    assert marked["floor"] == ["alice@x.io", "bob@x.io"]


def test_a_solo_run_records_no_floor(relay_world):
    """Single-participant sessions stay byte-identical to the solo system."""
    _run("t-alone", "alice@x.io")
    assert relay_world["marked"][-1]["floor"] is None


# ---------------------------------------------------------------------------
# The steer applier is registered by the run that owns it
# ---------------------------------------------------------------------------

def test_the_owning_run_registers_a_steer_applier(relay_world):
    """§4.6: "a new applier, not new infrastructure"."""
    from orchestrator import steer

    steer.clear_guidance("t-appl")

    async def _slow_gen():
        await asyncio.sleep(0)
        yield ""

    async def _go() -> None:
        agen = stream_relay.run_detached(
            "t-appl", _slow_gen(), actor="alice@x.io",
        )
        await agen.__anext__()  # start the run, register handlers
        handlers = stream_relay._LOCAL_CONTROL_HANDLERS.get("t-appl", {})
        assert "steer" in handlers, "steer must ride the existing control bus"
        assert handlers["steer"]({
            "text": "skip staging", "author": "bob@x.io",
        }) is True
        assert steer.has_guidance("t-appl"), (
            "an applied steer must be buffered for the next tool boundary"
        )
        await agen.aclose()

    asyncio.run(_go())
    steer.clear_guidance("t-appl")


def test_an_empty_steer_is_not_applied(relay_world):
    """An applied-ack must mean something landed."""
    async def _slow_gen():
        await asyncio.sleep(0)
        yield ""

    async def _go() -> None:
        agen = stream_relay.run_detached(
            "t-empty", _slow_gen(), actor="alice@x.io",
        )
        await agen.__anext__()
        applier = stream_relay._LOCAL_CONTROL_HANDLERS["t-empty"]["steer"]
        assert applier({"text": "   ", "author": "bob@x.io"}) is False
        await agen.aclose()

    asyncio.run(_go())
