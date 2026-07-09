"""Live observability API — the operator-facing face of the activity bus (E2).

Where ``/debug`` (routes/debug.py) is the *post-hoc* view over the durable
``agent_run`` trace store, this is the *live* view: a real-time feed of every
agent run and model call as it happens, across chat AND every app, plus a
"running right now" snapshot. Backed by the global ``cc:activity`` Redis stream
(``acb_common.activity``), not Postgres — this is the ephemeral signal layer.

    GET /observability/activity/recent?limit=   → recent activations (backfill)
    GET /observability/activity/stream          → SSE live feed (new events)
    GET /observability/active                    → agent runs in flight now

Gated to EXECUTIVE (humans) + AGENT (internal tooling): activation *metadata*
(agent / model / tier / user / duration / tokens) is far less sensitive than a
full trace, but it still names users and internal agents, so it stays behind
the same role wall as ``/debug``.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

from acb_auth import UserContext, UserRole, require_role
from acb_common import (
    active_runs,
    cost_summary,
    get_logger,
    read_activity_since,
    recent_activity,
)
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

_log = get_logger("gateway.observability")

# EXECUTIVE (humans) + AGENT (internal service calls / CI harness) may read.
_ADMIN = require_role(UserRole.EXECUTIVE, UserRole.AGENT)

router = APIRouter(prefix="/observability", tags=["observability"])


@router.get("/activity/recent")
async def activity_recent(
    limit: int = 100,
    _admin: UserContext = _ADMIN,
) -> dict[str, Any]:
    """Recent activations, oldest-first — used to backfill the feed on load.

    ``limit`` is clamped to [1, 500].
    """
    events = await recent_activity(limit=limit)
    return {"events": events, "count": len(events)}


@router.get("/active")
async def active(
    _admin: UserContext = _ADMIN,
) -> dict[str, Any]:
    """Agent runs currently in flight (the "running right now" panel).

    Self-healing: a run whose end event was lost ages out of the presence set
    after ``acb_common.activity.LIVE_TTL_SECONDS``.
    """
    runs = await active_runs()
    return {"runs": runs, "count": len(runs)}


@router.get("/roster")
async def roster(
    _admin: UserContext = _ADMIN,
) -> dict[str, Any]:
    """Every registered agent + its live status — the office view's cast list.

    Merges the static + dynamically-registered agent registry with the live
    presence set so each agent reports ``working`` (an active run) or ``idle``.
    Deep per-agent history/errors come from ``/debug/runs?agent=`` on demand.
    """
    try:
        from gateway.routes.agent import (  # noqa: PLC0415
            _AGENT_REGISTRY,
            _load_dynamic_agents,
        )
        registry = list(_load_dynamic_agents()) + list(_AGENT_REGISTRY)
    except Exception as exc:  # noqa: BLE001
        _log.warning("observability.roster_registry_failed", error=str(exc))
        registry = []

    runs = await active_runs()
    live_by_agent: dict[str, list[dict[str, Any]]] = {}
    for r in runs:
        live_by_agent.setdefault(str(r.get("agent") or ""), []).append(r)

    seen: set[str] = set()
    agents: list[dict[str, Any]] = []
    for a in registry:
        name = str(a.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        live = live_by_agent.get(name, [])
        agents.append({
            "name": name,
            "description": str(a.get("description") or ""),
            "runtime": a.get("agent_runtime") or a.get("runtime") or "maf",
            "status": "working" if live else "idle",
            "active_runs": len(live),
            "last_ts": live[0].get("ts") if live else None,
            "source": live[0].get("source") if live else None,
        })
    agents.sort(key=lambda e: (e["status"] != "working", e["name"]))
    return {"agents": agents, "count": len(agents)}


@router.get("/cost")
async def cost(
    days: int = 7,
    _admin: UserContext = _ADMIN,
) -> dict[str, Any]:
    """Daily LLM cost rollup (USD) for the last *days* days.

    Per-day totals + by-model + by-source breakdowns, from the always-on Redis
    rollup (best-effort litellm pricing). ``days`` is clamped to [1, 90].
    """
    return await cost_summary(days=days)


async def _sse_activity() -> AsyncIterator[bytes]:
    """Yield SSE frames for each new activation; heartbeat on idle.

    Starts from ``$`` (new events only) — the client backfills history via
    ``/activity/recent`` first, then opens this for the live tail. A heartbeat
    comment on each idle cycle keeps proxies from closing the connection.
    """
    cursor = "$"
    # Prime the client so EventSource fires ``onopen`` promptly.
    yield b": connected\n\n"
    while True:
        try:
            events, cursor = await read_activity_since(
                cursor, block_ms=15_000, count=200,
            )
        except asyncio.CancelledError:  # client disconnected
            raise
        except Exception as exc:  # noqa: BLE001 — degrade, keep the stream open
            _log.warning("observability.stream_read_failed", error=str(exc))
            await asyncio.sleep(1.0)
            yield b": error\n\n"
            continue
        if not events:
            yield b": ping\n\n"  # heartbeat
            continue
        for evt in events:
            frame = f"data: {json.dumps(evt, default=str)}\n\n"
            yield frame.encode("utf-8")


@router.get("/activity/stream")
async def activity_stream(
    _admin: UserContext = _ADMIN,
) -> StreamingResponse:
    """Server-Sent Events stream of live activations (agent + model)."""
    return StreamingResponse(
        _sse_activity(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable nginx proxy buffering
        },
    )
