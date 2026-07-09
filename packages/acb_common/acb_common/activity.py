"""Global activity bus — live, cross-app agent/model activation feed (E2 live).

A single process-wide Redis stream (``cc:activity``) that EVERY agent run and
model call publishes a small event to, so an operator UI can show a live feed
of "who / what is running right now" across chat AND every app (email, tasks,
…). Because the two publish sites are shared libraries — the orchestrator run
boundary (agent activations) and ``acb_llm`` (model activations) — cross-app
coverage is automatic: anything that runs an agent or calls a model shows up.

Design contract (mirrors the per-thread ``stream_relay``, but ONE global,
low-volume stream instead of one per conversation):

* **Best-effort, never blocks, never raises.** A failed publish drops the
  event; it must never affect the run that emitted it. All Redis IO is
  scheduled off the caller's path.
* **Small, stable event shape.** One JSON object per stream entry under the
  ``event`` field (same convention as ``stream_relay.push_event``).
* **Presence keys** (``cc:activity:live:{run_id}``) track in-flight agent runs
  with a TTL so the "running now" panel survives a crash without leaking.

This is the live signal only — the durable record stays in ``agent_run``
(migration 50) and the correlated logs. Retention here is bounded by
``MAXLEN`` and by the presence-key TTL.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis

from acb_common._log import get_run_context
from acb_common.settings import get_settings

# Deliberately NOT get_logger here to avoid any import cycle surprises during
# early process start; publish failures are silent by contract anyway.

ACTIVITY_STREAM = "cc:activity"
LIVE_PREFIX = "cc:activity:live"
STREAM_MAXLEN = 2_000          # ~ last N activations; bounds memory
LIVE_TTL_SECONDS = 900         # presence key self-heals if an "end" is lost

# Fields copied from the run-correlation context when the caller omits them, so
# a model call inside an agent run inherits that run's agent/user/thread/source.
_INHERIT = ("agent", "user", "thread_id", "run_id", "source")


# ── Shared async client (created lazily on the running loop) ─────────────────
_client: aioredis.Redis | None = None


def _get_client() -> aioredis.Redis:
    """Return the shared pooled async Redis client (created once)."""
    global _client
    if _client is None:
        _client = aioredis.from_url(
            get_settings().redis_url,
            decode_responses=True,
            max_connections=16,
            health_check_interval=30,
        )
    return _client


def _live_key(run_id: str) -> str:
    return f"{LIVE_PREFIX}:{run_id}"


def _build_event(fields: dict[str, Any]) -> dict[str, Any]:
    """Merge run-context defaults and stamp a timestamp. Pure; never raises."""
    ctx = {}
    try:
        ctx = get_run_context()
    except Exception:  # noqa: BLE001
        ctx = {}
    evt: dict[str, Any] = {}
    for k in _INHERIT:
        v = fields.get(k)
        if v is None:
            v = ctx.get(k)
        if v is not None:
            evt[k] = v
    # Non-inherited fields (kind, phase, model, tier, status, tokens, …).
    for k, v in fields.items():
        if k not in _INHERIT and v is not None:
            evt[k] = v
    evt.setdefault("ts", datetime.now(timezone.utc).isoformat())
    return evt


async def _axadd(evt: dict[str, Any]) -> None:
    """Append one event to the global stream + maintain the presence key."""
    r = _get_client()
    await r.xadd(
        ACTIVITY_STREAM,
        {"event": json.dumps(evt, default=str)},
        maxlen=STREAM_MAXLEN,
        approximate=True,
    )
    # Presence: an agent run is "live" between its start and end events.
    run_id = evt.get("run_id")
    if evt.get("kind") == "agent" and run_id:
        if evt.get("phase") == "start":
            await r.set(_live_key(run_id), json.dumps(evt, default=str),
                        ex=LIVE_TTL_SECONDS)
        elif evt.get("phase") == "end":
            await r.delete(_live_key(run_id))


def publish_activity(**fields: Any) -> None:
    """Publish one activation event to the global feed. Best-effort, non-blocking.

    Call from anywhere (sync or async). Common fields:
      ``kind``     — "agent" | "model" (required to be useful)
      ``phase``    — "start" | "end"   (agents; models are single events)
      ``model``, ``tier``              — model activations
      ``status``, ``duration_ms``      — agent "end" events
      ``agent``, ``user``, ``thread_id``, ``run_id``, ``source`` — inherited
      from the current run context when omitted.

    Never raises and never blocks the caller: the Redis write is scheduled onto
    the running event loop (or a throwaway loop if none is running). A drop is
    acceptable — the durable record lives in ``agent_run`` and the logs.
    """
    try:
        evt = _build_event(fields)
    except Exception:  # noqa: BLE001
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        try:
            task = loop.create_task(_axadd(evt))
            # Swallow any exception so it isn't reported as "never retrieved".
            task.add_done_callback(
                lambda t: None if t.cancelled() else t.exception()
            )
        except Exception:  # noqa: BLE001
            pass
    else:
        # No running loop (rare — e.g. a sync worker). Fire a one-shot loop
        # with its own short-lived client so we don't touch the shared one.
        async def _one_shot() -> None:
            r = aioredis.from_url(get_settings().redis_url, decode_responses=True)
            try:
                await r.xadd(
                    ACTIVITY_STREAM,
                    {"event": json.dumps(evt, default=str)},
                    maxlen=STREAM_MAXLEN,
                    approximate=True,
                )
            finally:
                await r.aclose()
        try:
            asyncio.run(_one_shot())
        except Exception:  # noqa: BLE001
            pass


def _parse_entry(eid: str, fields: dict[str, str]) -> dict[str, Any] | None:
    try:
        evt = json.loads(fields.get("event", "{}"))
    except (json.JSONDecodeError, TypeError):
        return None
    evt["_id"] = eid
    return evt


async def recent_activity(limit: int = 100) -> list[dict[str, Any]]:
    """Return the most recent activations, oldest-first (for backfill on load)."""
    r = _get_client()
    try:
        raw = await r.xrevrange(ACTIVITY_STREAM, count=max(1, min(limit, 500)))
    except aioredis.ResponseError:
        return []
    out: list[dict[str, Any]] = []
    for eid, fields in raw:
        evt = _parse_entry(eid, fields)
        if evt is not None:
            out.append(evt)
    out.reverse()  # xrevrange is newest-first; feed wants chronological
    return out


async def read_activity_since(
    since_id: str = "$", *, block_ms: int = 15_000, count: int = 200,
) -> tuple[list[dict[str, Any]], str]:
    """Block up to *block_ms* for new activations after *since_id*.

    Returns ``(events, new_cursor)``. On timeout returns ``([], since_id)`` so
    the caller can emit a heartbeat and loop. Never raises.
    """
    r = _get_client()
    cursor = since_id
    try:
        raw = await r.xread({ACTIVITY_STREAM: cursor}, count=count, block=block_ms)
    except Exception:  # noqa: BLE001 — stream missing / transient
        return [], cursor
    events: list[dict[str, Any]] = []
    for _name, entries in raw or []:
        for eid, fields in entries:
            evt = _parse_entry(eid, fields)
            if evt is not None:
                events.append(evt)
            cursor = eid
    return events, cursor


async def active_runs() -> list[dict[str, Any]]:
    """Return the agent runs currently in flight (presence keys not yet expired).

    Newest-first by start time. Self-healing: a run whose "end" was lost simply
    ages out after ``LIVE_TTL_SECONDS``.
    """
    r = _get_client()
    out: list[dict[str, Any]] = []
    try:
        cursor = 0
        while True:
            cursor, keys = await r.scan(
                cursor, match=f"{LIVE_PREFIX}:*", count=200,
            )
            if keys:
                vals = await r.mget(keys)
                for v in vals:
                    if not v:
                        continue
                    try:
                        out.append(json.loads(v))
                    except (json.JSONDecodeError, TypeError):
                        continue
            if cursor == 0:
                break
    except Exception:  # noqa: BLE001
        return out
    out.sort(key=lambda e: str(e.get("ts", "")), reverse=True)
    return out
