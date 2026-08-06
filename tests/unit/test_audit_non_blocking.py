"""BO-10 — ``acb_audit.record()`` must not block the event loop.

The DB write is synchronous (``acb_graph.get_session()`` is a sync engine) and
most callers are sync code. But the gateway's route handlers are async and call
``record()`` on the loop, where a blocking psycopg round-trip stalls every other
request in the process — behind a write that is best-effort by contract.

These tests pin the three properties that make the fix safe rather than merely
fast: the loop is not blocked, sync callers keep their old blocking behaviour,
and an in-flight write is not lost at shutdown.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest
from acb_audit import log as audit


def _event() -> audit.AuditEvent:
    return audit.AuditEvent(actor="user:t@x", action="test", target="thing:1")


@pytest.mark.asyncio
async def test_record_does_not_block_the_event_loop(monkeypatch) -> None:
    started = threading.Event()

    def slow_persist(event: audit.AuditEvent) -> None:
        started.set()
        time.sleep(0.5)

    monkeypatch.setattr(audit, "_persist", slow_persist)

    t0 = time.monotonic()
    audit.record(_event())
    elapsed = time.monotonic() - t0

    # The 0.5s write is on a worker thread; the call itself must be immediate.
    assert elapsed < 0.1, f"record() blocked the loop for {elapsed:.3f}s"

    # ...and it really is running, not silently dropped.
    await audit.drain(timeout=2.0)
    assert started.is_set()


@pytest.mark.asyncio
async def test_record_runs_the_write_off_the_loop_thread(monkeypatch) -> None:
    """Not just deferred — actually on another thread.

    A `loop.call_soon` style deferral would also return fast while still
    blocking the loop later, which is the bug wearing a disguise.
    """
    loop_thread = threading.get_ident()
    seen: list[int] = []

    monkeypatch.setattr(
        audit, "_persist", lambda event: seen.append(threading.get_ident())
    )

    audit.record(_event())
    await audit.drain(timeout=2.0)

    assert seen and seen[0] != loop_thread


def test_sync_callers_still_write_inline(monkeypatch) -> None:
    """No event loop → no thread hand-off.

    The orchestrator's agents call `record()` from plain sync code and expect
    the row to exist when it returns. Deferring for them would need a drain
    they have nowhere to call.
    """
    calls: list[audit.AuditEvent] = []
    monkeypatch.setattr(audit, "_persist", calls.append)

    ev = _event()
    audit.record(ev)

    assert calls == [ev]


@pytest.mark.asyncio
async def test_drain_waits_for_in_flight_writes(monkeypatch) -> None:
    """Shutdown must not cancel a write that is still running.

    This is the one real regression risk in making the call non-blocking: the
    old code finished the write before the handler returned.
    """
    finished: list[str] = []

    def slow_persist(event: audit.AuditEvent) -> None:
        time.sleep(0.2)
        finished.append(event.target)

    monkeypatch.setattr(audit, "_persist", slow_persist)

    audit.record(_event())
    assert finished == []          # still in flight
    await audit.drain(timeout=5.0)
    assert finished == ["thing:1"]  # completed, not cancelled


@pytest.mark.asyncio
async def test_drain_is_bounded_by_its_timeout(monkeypatch) -> None:
    """A wedged audit DB must not hold the shutdown open forever."""
    monkeypatch.setattr(audit, "_persist", lambda event: time.sleep(3.0))

    audit.record(_event())
    t0 = time.monotonic()
    await audit.drain(timeout=0.2)
    assert time.monotonic() - t0 < 1.5

    # Leave no thread running into the next test.
    await audit.drain(timeout=5.0)


@pytest.mark.asyncio
async def test_a_failing_write_never_reaches_the_caller(monkeypatch) -> None:
    """Best-effort by contract, on the threaded path too.

    `_persist` swallows its own errors; this guards the wiring around it, where
    an exception would surface as an unretrieved-task warning instead.
    """
    def boom(event: audit.AuditEvent) -> None:
        raise RuntimeError("audit db down")

    monkeypatch.setattr(audit, "_persist", boom)

    audit.record(_event())  # must not raise
    with pytest.raises(RuntimeError):
        # The task itself does surface it — drain() gathers, it does not hide.
        await asyncio.wait_for(next(iter(audit._PENDING)), timeout=2.0)


@pytest.mark.asyncio
async def test_pending_set_does_not_grow_without_bound(monkeypatch) -> None:
    """The strong-reference set is bounded by concurrency, not by uptime."""
    monkeypatch.setattr(audit, "_persist", lambda event: None)
    before = len(audit._PENDING)
    for _ in range(5):
        audit.record(_event())
    await audit.drain(timeout=5.0)
    assert len(audit._PENDING) == before
