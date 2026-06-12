"""Per-thread Redis Stream relay for durable agent event buffering.

Enables fire-and-forget agent runs with live reconnection: every SSE event
the agent emits is pushed to a Redis Stream keyed by ``thread_id``.  When a
client reconnects after a disconnect it can replay missed events from its
last-known event ID and then subscribe to new events live.

Stream naming
-------------
    cc:stream:{thread_id}     — ordered event log (MAXLEN ~10 000)
    cc:active:{thread_id}     — "1" while running, deleted on finish

Event IDs
---------
Each event pushed gets a Redis auto-generated ID (``<ms>-<seq>``).
The frontend tracks the last ID it received and passes it to the reconnect
endpoint so only events *after* that ID are replayed.

TTL
---
Streams expire after 1 hour (configurable via ``STREAM_TTL_SECONDS``).
If a client reconnects after the stream expired, it falls back to the
existing Postgres polling recovery path.

Usage::

    from orchestrator.stream_relay import (
        push_event, replay_events, subscribe_events,
        mark_active, mark_inactive,
    )

    await mark_active(thread_id)
    async for sse_line in run_agent_stream(...):
        await push_event(thread_id, sse_line)
        yield sse_line
    await mark_inactive(thread_id)
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

import redis.asyncio as aioredis

from acb_common import get_logger, get_settings

_log = get_logger("orchestrator.stream_relay")

STREAM_PREFIX = "cc:stream"
ACTIVE_PREFIX = "cc:active"
STREAM_MAXLEN = 10_000
STREAM_TTL_SECONDS = 3600  # 1 hour


def _stream_key(thread_id: str) -> str:
    return f"{STREAM_PREFIX}:{thread_id}"


def _active_key(thread_id: str) -> str:
    return f"{ACTIVE_PREFIX}:{thread_id}"


async def _get_client() -> aioredis.Redis:
    """Return a fresh async Redis client.  Callers should close it."""
    settings = get_settings()
    return aioredis.from_url(settings.redis_url, decode_responses=True)


async def push_event(thread_id: str, event: dict[str, Any]) -> str:
    """Append a single event to the per-thread stream.

    Args:
        thread_id: Conversation thread ID.
        event:     Dict with at least ``"type"``; serialised as JSON.

    Returns:
        The Redis entry ID (e.g. ``"1719123456789-0"``).
    """
    r = await _get_client()
    try:
        eid = await r.xadd(
            _stream_key(thread_id),
            {"event": json.dumps(event, default=str)},
            maxlen=STREAM_MAXLEN,
            approximate=True,
        )
        # Refresh TTL on every write so an active stream doesn't expire.
        await r.expire(_stream_key(thread_id), STREAM_TTL_SECONDS)
        return eid
    finally:
        await r.aclose()


async def replay_events(
    thread_id: str,
    since_id: str = "0-0",
    count: int = 500,
) -> list[dict[str, Any]]:
    """Read events from *since_id* (exclusive) to the current stream tail.

    Args:
        thread_id: Conversation thread ID.
        since_id:  Redis stream ID to start AFTER (use ``"0-0"`` for all).
        count:     Max events to return in one batch.

    Returns:
        List of parsed event dicts, oldest first.
    """
    r = await _get_client()
    try:
        raw = await r.xread(
            {_stream_key(thread_id): since_id},
            count=count,
            block=0,  # don't block — return immediately if no new events
        )
        if not raw:
            return []

        events: list[dict[str, Any]] = []
        for _stream_name, entries in raw:
            for eid, fields in entries:
                try:
                    evt = json.loads(fields.get("event", "{}"))
                    # Attach Redis stream ID for cursor tracking.
                    evt["_stream_id"] = eid
                    events.append(evt)
                except (json.JSONDecodeError, TypeError):
                    _log.warning(
                        "stream_relay.bad_event",
                        thread_id=thread_id[:12],
                        eid=eid[:20],
                    )
        return events
    except aioredis.ResponseError:
        # Stream doesn't exist (expired or never created).
        return []
    finally:
        await r.aclose()


async def subscribe_events(
    thread_id: str,
    since_id: str = "$",
    block_ms: int = 30_000,
) -> AsyncIterator[dict[str, Any]]:
    """Subscribe to new events on the per-thread stream, blocking for up to
    *block_ms* between events.  Yields parsed event dicts as they arrive.

    Exits when the stream is marked inactive AND no new events arrive within
    *block_ms*, when a terminal event (RUN_FINISHED / RUN_ERROR) is yielded,
    or when the stream expires.

    Args:
        thread_id: Conversation thread ID.
        since_id:  Stream ID (``"$"`` = new only, ``"0"`` = all).
        block_ms:  Max milliseconds to block waiting for a new event.

    Yields:
        Parsed event dicts with ``_stream_id`` attached.
    """
    r = await _get_client()
    try:
        cursor = since_id
        while True:
            # Check if the agent is still active before blocking.
            active = await r.get(_active_key(thread_id))
            if active != "1":
                # Agent finished — drain any remaining events, then exit.
                try:
                    raw = await r.xread(
                        {_stream_key(thread_id): cursor},
                        count=100,
                        block=1000,  # short block to drain tail
                    )
                    if raw:
                        for _sn, entries in raw:
                            for eid, fields in entries:
                                try:
                                    evt = json.loads(fields.get("event", "{}"))
                                    evt["_stream_id"] = eid
                                    yield evt
                                    cursor = eid
                                except (json.JSONDecodeError, TypeError):
                                    pass
                except aioredis.ResponseError:
                    pass
                return  # stream finished

            # Block for new events.
            try:
                raw = await r.xread(
                    {_stream_key(thread_id): cursor},
                    count=100,
                    block=block_ms,
                )
                if raw:
                    for _sn, entries in raw:
                        for eid, fields in entries:
                            try:
                                evt = json.loads(fields.get("event", "{}"))
                                evt["_stream_id"] = eid
                                yield evt
                                cursor = eid
                                # Terminal event: the run is over — close
                                # the subscription NOW instead of blocking
                                # another XREAD cycle (the HTTP response
                                # would otherwise linger ~30s, leaving the
                                # UI "loading" and queueing new messages).
                                if evt.get("type") in (
                                    "RUN_FINISHED", "RUN_ERROR",
                                ):
                                    return
                            except (json.JSONDecodeError, TypeError):
                                pass
                else:
                    # Timeout — re-check active status next loop.
                    # If stream expired, xread returns empty; exit.
                    exists = await r.exists(_stream_key(thread_id))
                    if not exists:
                        return
            except aioredis.ResponseError:
                # Stream disappeared.
                return
    finally:
        await r.aclose()


async def mark_active(thread_id: str, *, reset: bool = False) -> None:
    """Mark a thread's agent as currently running.

    Args:
        thread_id: Conversation thread ID.
        reset:     When True, delete any existing event stream first so the
                   stream contains ONLY the current run's events.  This
                   makes ``replay_events(since_id="0-0")`` always correct
                   for the run in progress (previous turns live in
                   Postgres, not Redis).
    """
    r = await _get_client()
    try:
        if reset:
            await r.delete(_stream_key(thread_id))
        await r.set(_active_key(thread_id), "1", ex=STREAM_TTL_SECONDS)
    finally:
        await r.aclose()


async def mark_inactive(thread_id: str) -> None:
    """Mark a thread's agent as finished."""
    r = await _get_client()
    try:
        await r.delete(_active_key(thread_id))
        # Also refresh the stream TTL so late reconnectors can still replay.
        await r.expire(_stream_key(thread_id), STREAM_TTL_SECONDS)
    finally:
        await r.aclose()


async def is_active(thread_id: str) -> bool:
    """Check whether an agent is still running for *thread_id*."""
    r = await _get_client()
    try:
        val = await r.get(_active_key(thread_id))
        return val == "1"
    finally:
        await r.aclose()


async def stream_exists(thread_id: str) -> bool:
    """Check whether the event stream still exists (not expired)."""
    r = await _get_client()
    try:
        return bool(await r.exists(_stream_key(thread_id)))
    finally:
        await r.aclose()


async def push_sse_event(thread_id: str, sse_line: str) -> str:
    """Parse an SSE frame and push the JSON payload to the per-thread stream.

    Handles both bare ``data: {...}\\n\\n`` frames (executor format) and
    multi-line frames such as ``event: X\\ndata: {...}\\n\\n`` (AG-UI
    ``EventEncoder`` format).

    Returns the Redis entry ID, or ``""`` if the frame couldn't be parsed.
    """
    raw = ""
    for part in sse_line.split("\n"):
        part = part.strip()
        if part.startswith("data:"):
            raw = part[5:].strip()
            break
    if not raw:
        return ""
    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        return ""
    return await push_event(thread_id, event)


# ---------------------------------------------------------------------------
# Detached execution — decouple agent runs from the HTTP response lifecycle
# ---------------------------------------------------------------------------

# Strong references to in-flight detached run tasks, keyed by thread_id.
# Prevents garbage collection and enforces one run per thread.
_DETACHED_TASKS: dict[str, asyncio.Task[None]] = {}


def get_detached_task(thread_id: str) -> asyncio.Task[None] | None:
    """Return the in-flight detached run task for *thread_id*, if any."""
    task = _DETACHED_TASKS.get(thread_id)
    if task is not None and task.done():
        return None
    return task


async def run_detached(
    thread_id: str,
    gen: AsyncIterator[str],
    *,
    tee: bool = False,
) -> AsyncIterator[dict[str, Any]]:
    """Run *gen* (an SSE-line async generator) in a DETACHED background task
    and yield its events from the Redis stream.

    This decouples agent execution from the HTTP response: if the client
    disconnects, uvicorn cancels THIS generator (the subscriber) but the
    background task keeps draining the agent and pushing events to Redis.
    A reconnecting client replays from its cursor and resumes live.

    Args:
        thread_id: Conversation thread ID (stream key).
        gen:       Async generator yielding SSE-formatted strings.
        tee:       When True, this helper pushes each yielded line to Redis
                   (use for generators that don't self-tee, e.g. AG-UI
                   ``/copilot/chat``).  When False the generator is expected
                   to tee its own events (executor ``_sse`` contextvar path).

    Yields:
        Parsed event dicts with ``_stream_id`` (Redis entry ID) attached.
    """
    # One run per thread: cancel any stale run still attached to this thread.
    prev = _DETACHED_TASKS.get(thread_id)
    if prev is not None and not prev.done():
        prev.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(prev), timeout=2)
        except BaseException:  # noqa: BLE001
            pass

    # Fresh run boundary: clear previous events so replay-from-0 is exact.
    await mark_active(thread_id, reset=True)

    async def _drain() -> None:
        try:
            async for line in gen:
                if tee:
                    try:
                        await push_sse_event(thread_id, line)
                    except Exception:  # noqa: BLE001
                        pass  # never let Redis issues kill the agent run
        except asyncio.CancelledError:
            try:
                await push_event(thread_id, {
                    "type": "RUN_ERROR",
                    "message": "Run cancelled (superseded)",
                    "code": "Cancelled",
                })
            except Exception:  # noqa: BLE001
                pass
            raise
        except Exception as exc:  # noqa: BLE001
            _log.exception(
                "stream_relay.detached_run_error",
                thread_id=thread_id[:12],
            )
            try:
                await push_event(thread_id, {
                    "type": "RUN_ERROR",
                    "message": str(exc),
                    "code": type(exc).__name__,
                })
            except Exception:  # noqa: BLE001
                pass
        finally:
            try:
                await mark_inactive(thread_id)
            except Exception:  # noqa: BLE001
                pass
            if _DETACHED_TASKS.get(thread_id) is task:
                _DETACHED_TASKS.pop(thread_id, None)

    task = asyncio.create_task(_drain(), name=f"cc-run-{thread_id[:24]}")
    _DETACHED_TASKS[thread_id] = task

    # Serve events from Redis — the SAME path a reconnecting client uses.
    async for evt in subscribe_events(thread_id, since_id="0"):
        yield evt
