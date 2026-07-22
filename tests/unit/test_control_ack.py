"""Regression tests for the control-bus applied-ack (audit R2).

Redis pub/sub is fire-and-forget: an answer or Stop published while no
subscriber was listening (subscribe race, owner restart) was silently lost,
yet ``dispatch_control`` fell back to "the run looks active" and reported
success — the HITL card cleared while the agent stayed parked for an hour,
and Stop showed "stopped" while the detached task kept running. Delivery now
requires the owning worker's applied-ack.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from orchestrator import stream_relay


@pytest.fixture(autouse=True)
def _clean_handlers():
    stream_relay._LOCAL_CONTROL_HANDLERS.clear()
    yield
    stream_relay._LOCAL_CONTROL_HANDLERS.clear()


def test_local_applier_short_circuits(monkeypatch):
    calls: list[dict[str, Any]] = []
    stream_relay.register_control_command("t-local", "respond_input", lambda c: calls.append(c) or True)

    async def _no_publish(*_a: Any, **_k: Any) -> int:
        raise AssertionError("must not publish when applied locally")

    monkeypatch.setattr(stream_relay, "publish_control", _no_publish)
    ok = asyncio.run(stream_relay.dispatch_control("t-local", {"cmd": "respond_input"}))
    assert ok is True
    assert len(calls) == 1


def test_relayed_command_requires_ack(monkeypatch):
    published: list[dict[str, Any]] = []

    async def _publish(_tid: str, command: dict[str, Any]) -> int:
        published.append(dict(command))
        return 1

    async def _ack(_ack_id: str, timeout: float = 0) -> bool:
        return True

    monkeypatch.setattr(stream_relay, "publish_control", _publish)
    monkeypatch.setattr(stream_relay, "wait_control_ack", _ack)
    ok = asyncio.run(stream_relay.dispatch_control("t-remote", {"cmd": "respond_input"}))
    assert ok is True
    assert published and published[0].get("ack_id"), "command must carry an ack_id"


def test_unacked_relay_reports_failure(monkeypatch):
    async def _publish(_tid: str, _command: dict[str, Any]) -> int:
        return 1  # delivered to a subscriber…

    async def _no_ack(_ack_id: str, timeout: float = 0) -> bool:
        return False  # …that never confirmed applying it

    monkeypatch.setattr(stream_relay, "publish_control", _publish)
    monkeypatch.setattr(stream_relay, "wait_control_ack", _no_ack)
    ok = asyncio.run(stream_relay.dispatch_control("t-unacked", {"cmd": "respond_input"}))
    assert ok is False, "an unacked relay must not be reported as delivered"


def test_zero_subscribers_retries_once_then_fails(monkeypatch):
    attempts: list[int] = []

    async def _publish(_tid: str, _command: dict[str, Any]) -> int:
        attempts.append(1)
        return 0

    async def _never(_ack_id: str, timeout: float = 0) -> bool:
        raise AssertionError("must not wait for an ack nobody could write")

    monkeypatch.setattr(stream_relay, "publish_control", _publish)
    monkeypatch.setattr(stream_relay, "wait_control_ack", _never)
    ok = asyncio.run(stream_relay.dispatch_control("t-nobody", {"cmd": "cancel"}))
    assert ok is False
    assert len(attempts) == 2, "zero-subscriber publish rides out the subscribe race with one retry"


def test_cancel_run_remote_unconfirmed_reports_false(monkeypatch):
    """An unreachable owner must not be reported as a successful stop."""
    cleanup: list[str] = []

    async def _dispatch(_tid: str, _cmd: dict[str, Any]) -> bool:
        return False

    async def _active(_tid: str) -> bool:
        return True

    async def _mark_inactive(_tid: str) -> None:
        cleanup.append("mark_inactive")

    async def _push(_tid: str, _evt: dict[str, Any]) -> str:
        cleanup.append(str(_evt.get("type")))
        return "1-0"

    monkeypatch.setattr(stream_relay, "dispatch_control", _dispatch)
    monkeypatch.setattr(stream_relay, "is_active", _active)
    monkeypatch.setattr(stream_relay, "mark_inactive", _mark_inactive)
    monkeypatch.setattr(stream_relay, "push_event", _push)
    stream_relay._DETACHED_TASKS.pop("t-zombie", None)

    found = asyncio.run(stream_relay.cancel_run("t-zombie"))
    assert found is False, "cancel must not claim success without the owner's ack"
    # The stuck-UI teardown still runs (flag cleared + terminal event) so
    # subscribers recover even when the owner is unreachable.
    assert "mark_inactive" in cleanup
    assert "RUN_FINISHED" in cleanup


def test_cancel_run_remote_confirmed_reports_true(monkeypatch):
    async def _dispatch(_tid: str, _cmd: dict[str, Any]) -> bool:
        return True

    async def _mark_inactive(_tid: str) -> None:
        pass

    async def _push(_tid: str, _evt: dict[str, Any]) -> str:
        return "1-0"

    monkeypatch.setattr(stream_relay, "dispatch_control", _dispatch)
    monkeypatch.setattr(stream_relay, "mark_inactive", _mark_inactive)
    monkeypatch.setattr(stream_relay, "push_event", _push)
    stream_relay._DETACHED_TASKS.pop("t-owned-elsewhere", None)

    assert asyncio.run(stream_relay.cancel_run("t-owned-elsewhere")) is True
