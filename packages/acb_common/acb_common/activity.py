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
from datetime import datetime, timedelta, timezone
from typing import Any

import redis.asyncio as aioredis

from acb_common._log import get_run_context
from acb_common.settings import get_settings

# Deliberately NOT get_logger here to avoid any import cycle surprises during
# early process start; publish failures are silent by contract anyway.

ACTIVITY_STREAM = "cc:activity"
LIVE_PREFIX = "cc:activity:live"
COST_PREFIX = "cc:cost"        # per-day rollup hash: cc:cost:{YYYY-MM-DD}
STREAM_MAXLEN = 2_000          # ~ last N activations; bounds memory
LIVE_TTL_SECONDS = 900         # presence key self-heals if an "end" is lost
COST_TTL_SECONDS = 60 * 60 * 24 * 45   # keep ~45 days of daily cost rollups

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


def _cost_key(day: str) -> str:
    return f"{COST_PREFIX}:{day}"


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


async def _record_cost(r: aioredis.Redis, evt: dict[str, Any]) -> None:
    """Fold one priced model call into today's rollup hash. Best-effort.

    One hash per UTC day (``cc:cost:{date}``) with additive fields so a daily
    cost breakdown by model / app / agent is a single HGETALL — no migration,
    no per-call Postgres write (the deliberate default; LLM_USAGE_AUDIT stays
    the opt-in durable path). Fields:
        total|cost|tokens|calls
        model|<m>|cost|tokens|calls
        source|<s>|cost   ·   agent|<a>|cost
    """
    cost = evt.get("cost_usd")
    if not isinstance(cost, (int, float)):
        return
    tokens = int(evt.get("tokens") or 0)
    model = str(evt.get("model") or "unknown")
    source = str(evt.get("source") or "unattributed")
    agent = str(evt.get("agent") or "")
    key = _cost_key(_today())
    pipe = r.pipeline(transaction=False)
    pipe.hincrbyfloat(key, "total|cost", float(cost))
    pipe.hincrby(key, "total|tokens", tokens)
    pipe.hincrby(key, "total|calls", 1)
    pipe.hincrbyfloat(key, f"model|{model}|cost", float(cost))
    pipe.hincrby(key, f"model|{model}|tokens", tokens)
    pipe.hincrby(key, f"model|{model}|calls", 1)
    pipe.hincrbyfloat(key, f"source|{source}|cost", float(cost))
    pipe.hincrby(key, f"source|{source}|calls", 1)
    if agent:
        pipe.hincrbyfloat(key, f"agent|{agent}|cost", float(cost))
        pipe.hincrby(key, f"agent|{agent}|calls", 1)
    pipe.expire(key, COST_TTL_SECONDS)
    await pipe.execute()


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
    # Cost rollup: fold priced model calls into today's daily hash.
    if evt.get("kind") == "model" and evt.get("cost_usd") is not None:
        try:
            await _record_cost(r, evt)
        except Exception:  # noqa: BLE001 — cost rollup is best-effort
            pass


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


def _split_field(field: str) -> tuple[str, str, str]:
    """Parse a rollup hash field ``dim|name|metric`` → (dim, name, metric).

    ``name`` may itself contain ``/`` (provider-prefixed models) but not ``|``,
    so joining the middle segments is safe. ``total|cost`` → ("total","","cost").
    """
    parts = field.split("|")
    if len(parts) < 2:
        return field, "", ""
    return parts[0], "|".join(parts[1:-1]), parts[-1]


async def cost_summary(days: int = 7) -> dict[str, Any]:
    """Aggregate the last *days* daily cost rollups for the /observability cost view.

    Returns per-day totals (chronological), plus by-model and by-source rollups
    and grand totals. Costs are in USD (best-effort litellm pricing). Never
    raises — missing/short history just yields zeroes.
    """
    days = max(1, min(days, 90))
    r = _get_client()
    today = datetime.now(timezone.utc).date()
    out_days: list[dict[str, Any]] = []
    by_model: dict[str, dict[str, float]] = {}
    by_source: dict[str, dict[str, float]] = {}
    by_agent: dict[str, dict[str, float]] = {}
    totals = {"cost": 0.0, "tokens": 0, "calls": 0}

    for i in range(days):
        d = (today - timedelta(days=i)).strftime("%Y-%m-%d")
        try:
            h = await r.hgetall(_cost_key(d))
        except Exception:  # noqa: BLE001
            h = {}
        day_rec: dict[str, Any] = {
            "date": d, "cost": 0.0, "tokens": 0, "calls": 0, "by_model": {},
        }
        for field, raw in (h or {}).items():
            try:
                v = float(raw)
            except (TypeError, ValueError):
                continue
            dim, name, metric = _split_field(field)
            if dim == "total":
                if metric == "cost":
                    day_rec["cost"] = round(v, 6)
                    totals["cost"] += v
                elif metric == "tokens":
                    day_rec["tokens"] = int(v)
                    totals["tokens"] += int(v)
                elif metric == "calls":
                    day_rec["calls"] = int(v)
                    totals["calls"] += int(v)
            elif dim == "model" and name:
                m = by_model.setdefault(name, {"cost": 0.0, "tokens": 0, "calls": 0})
                dm = day_rec["by_model"].setdefault(
                    name, {"cost": 0.0, "tokens": 0, "calls": 0})
                if metric == "cost":
                    m["cost"] += v
                    dm["cost"] = round(v, 6)
                elif metric == "tokens":
                    m["tokens"] += int(v)
                    dm["tokens"] = int(v)
                elif metric == "calls":
                    m["calls"] += int(v)
                    dm["calls"] = int(v)
            elif dim == "source" and name:
                s = by_source.setdefault(name, {"cost": 0.0, "calls": 0})
                if metric == "cost":
                    s["cost"] += v
                elif metric == "calls":
                    s["calls"] += int(v)
            elif dim == "agent" and name:
                a = by_agent.setdefault(name, {"cost": 0.0, "calls": 0})
                if metric == "cost":
                    a["cost"] += v
                elif metric == "calls":
                    a["calls"] += int(v)
        out_days.append(day_rec)

    out_days.reverse()  # oldest → newest for a left-to-right chart
    for m in by_model.values():
        m["cost"] = round(m["cost"], 6)
    for s in by_source.values():
        s["cost"] = round(s["cost"], 6)
    for a in by_agent.values():
        a["cost"] = round(a["cost"], 6)
    totals["cost"] = round(totals["cost"], 6)
    return {
        "days": out_days,
        "by_model": by_model,
        "by_source": by_source,
        "by_agent": by_agent,
        "totals": totals,
        "window_days": days,
    }
