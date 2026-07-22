"""Regression tests for the HITL-park ACTIVE-flag heartbeat (audit R3).

The ``cc:active`` flag's TTL is refreshed only by ``push_event`` — and a run
parked on a HITL question pushes nothing for up to the whole ask_user budget
(3600s == the TTL), so the flag lapsed mid-park: live subscribers terminated
and reconnect reported the still-parked run as finished, clearing the
question card. ``wait_user_future`` waits in slices and touches the flag
between them.
"""
from __future__ import annotations

import asyncio

import pytest
from orchestrator import executor, stream_relay


def test_resolved_future_returns_answer():
    async def _run():
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        fut.set_result({"answer": "yes", "wasFreeform": True})
        return await executor.wait_user_future(fut, 5, thread_id="t-hb")

    assert asyncio.run(_run())["answer"] == "yes"


def test_heartbeat_touches_active_flag_between_slices(monkeypatch):
    touched: list[str] = []

    async def _touch(tid: str) -> None:
        touched.append(tid)

    monkeypatch.setattr(stream_relay, "touch_active", _touch)

    async def _run():
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        with pytest.raises(asyncio.TimeoutError):
            await executor.wait_user_future(
                fut, 0.2, thread_id="t-hb", slice_seconds=0.03,
            )

    asyncio.run(_run())
    assert touched, "the park must heartbeat the relay ACTIVE flag"
    assert set(touched) == {"t-hb"}


def test_answer_arriving_mid_slice_resolves(monkeypatch):
    async def _touch(_tid: str) -> None:
        pass

    monkeypatch.setattr(stream_relay, "touch_active", _touch)

    async def _run():
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        loop.call_later(0.08, fut.set_result, {"answer": "b", "wasFreeform": False})
        return await executor.wait_user_future(
            fut, 5, thread_id="t-hb", slice_seconds=0.02,
        )

    assert asyncio.run(_run())["answer"] == "b"


def test_slice_timeout_does_not_cancel_the_future(monkeypatch):
    """A slice expiry must not cancel the shared future — the next slice (or a
    late resolve_user_input) still needs it pending."""

    async def _touch(_tid: str) -> None:
        pass

    monkeypatch.setattr(stream_relay, "touch_active", _touch)

    async def _run():
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        with pytest.raises(asyncio.TimeoutError):
            await executor.wait_user_future(
                fut, 0.1, thread_id="t-hb", slice_seconds=0.02,
            )
        return fut

    fut = asyncio.run(_run())
    assert not fut.cancelled(), "shield must protect the future from slice timeouts"
