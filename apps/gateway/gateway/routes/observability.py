"""Live observability API — the operator-facing face of the activity bus (E2).

Where ``/debug`` (routes/debug.py) is the *post-hoc* view over the durable
``agent_run`` trace store, this is the *live* view: a real-time feed of every
agent run and model call as it happens, across chat AND every app, plus a
"running right now" snapshot. Backed by the global ``cc:activity`` Redis stream
(``acb_common.activity``), not Postgres — this is the ephemeral signal layer.

    GET /observability/activity/recent?limit=   → recent activations (backfill)
    GET /observability/activity/stream          → SSE live feed (new events)
    GET /observability/active                    → agent runs in flight now
    GET /observability/roster                    → all agents + working/idle
    GET /observability/cost?days=                → daily LLM cost rollup
    GET /observability/runs?agent=&status=       → DURABLE history (agent_run)

Open to any AUTHENTICATED caller (this is the operator's own dashboard). It
returns operational *metadata* — agent/model/tier/user/duration/tokens/cost and
error messages — but NEVER the full message-content trace, which stays
EXECUTIVE-gated behind ``/debug/runs/{id}``. The Redis feed (recent/stream) is
ephemeral (~2000 events, latest-first); ``/runs`` is the durable timeline.
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

# Any AUTHENTICATED caller may read the live views. These expose operational
# METADATA (agent/model/tokens/cost/status/duration) — NOT message content — so
# unlike /debug (full traces, EXECUTIVE-only) this is the operator's own
# dashboard and must not silently 403 for a non-"executive" logged-in operator.
# EMPLOYEE is the default role the SSO proxy sends; AGENT is internal tooling.
_VIEWER = require_role(UserRole.EXECUTIVE, UserRole.AGENT, UserRole.EMPLOYEE)

router = APIRouter(prefix="/observability", tags=["observability"])


@router.get("/activity/recent")
async def activity_recent(
    limit: int = 100,
    _viewer: UserContext = _VIEWER,
) -> dict[str, Any]:
    """Recent activations, oldest-first — used to backfill the feed on load.

    ``limit`` is clamped to [1, 500].
    """
    events = await recent_activity(limit=limit)
    return {"events": events, "count": len(events)}


@router.get("/active")
async def active(
    _viewer: UserContext = _VIEWER,
) -> dict[str, Any]:
    """Agent runs currently in flight (the "running right now" panel).

    Self-healing: a run whose end event was lost ages out of the presence set
    after ``acb_common.activity.LIVE_TTL_SECONDS``.
    """
    runs = await active_runs()
    return {"runs": runs, "count": len(runs)}


@router.get("/roster")
async def roster(
    _viewer: UserContext = _VIEWER,
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

    # The orchestrator is the default-chat agent but isn't a registered
    # specialist — seed it so it's always on stage (idle between chats, working
    # during them).
    registry = [{
        "name": "orchestrator",
        "description": "Core orchestrator — routes chat to the right specialist",
        "agent_runtime": "maf",
    }] + registry

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

    # Include agents that are LIVE but not in the registry — most importantly the
    # "orchestrator" (the default-chat agent, which isn't a registered specialist)
    # and any ad-hoc sub-agent. Without this the primary agent never shows in the
    # office even while it's clearly working.
    for name, live in live_by_agent.items():
        if not name or name in seen:
            continue
        seen.add(name)
        agents.append({
            "name": name,
            "description": "Core orchestrator" if name == "orchestrator" else "",
            "runtime": "maf",
            "status": "working",
            "active_runs": len(live),
            "last_ts": live[0].get("ts") if live else None,
            "source": live[0].get("source") if live else None,
        })

    agents.sort(key=lambda e: (e["status"] != "working", e["name"]))
    return {"agents": agents, "count": len(agents)}


@router.get("/cost")
async def cost(
    days: int = 7,
    _viewer: UserContext = _VIEWER,
) -> dict[str, Any]:
    """Daily LLM cost rollup (USD) for the last *days* days.

    Per-day totals + by-model + by-source breakdowns, from the always-on Redis
    rollup (best-effort litellm pricing). ``days`` is clamped to [1, 90].
    """
    return await cost_summary(days=days)


_RUN_STATUSES = frozenset({"running", "completed", "error", "cancelled"})


@router.get("/runs")
async def runs(
    agent: str | None = None,
    status: str | None = None,
    since_hours: int | None = None,
    limit: int = 50,
    _viewer: UserContext = _VIEWER,
) -> dict[str, Any]:
    """DURABLE activity history from the ``agent_run`` trace store.

    Unlike the ephemeral Redis feed (recent/stream, ~2000 events lost on a Redis
    flush), this reads the persisted per-run rows — so it survives restarts and
    goes back as far as retention keeps them. Lean rows only: metadata + error
    message, NEVER the full trace blob (that stays EXECUTIVE-gated at
    ``/debug/runs/{id}``). Powers the History tab + the per-agent drawer.
    Newest-first; ``limit`` clamped to [1, 200].
    """
    limit = max(1, min(limit, 200))
    where: list[str] = []
    params: dict[str, Any] = {"limit": limit}
    if agent:
        where.append("agent_name = :agent")
        params["agent"] = agent
    if status in _RUN_STATUSES:
        where.append("status = :status")
        params["status"] = status
    if since_hours:
        where.append("started_at > now() - make_interval(hours => :sh)")
        params["sh"] = int(since_hours)
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        with get_session() as s:
            rows = s.execute(
                text(
                    "SELECT run_id, thread_id, agent_name, user_id, model, "
                    "status, started_at, ended_at, duration_ms, total_tokens, "
                    "tool_count, error_type, error_message FROM agent_run"
                    + clause + " ORDER BY started_at DESC LIMIT :limit"
                ),
                params,
            ).fetchall()
    except Exception as exc:  # noqa: BLE001 — degrade to empty, never 500 the UI
        _log.warning("observability.runs_failed", error=str(exc))
        return {"runs": [], "count": 0}

    out = [{
        "run_id": r.run_id,
        "thread_id": r.thread_id,
        "agent": r.agent_name,
        "user": r.user_id,
        "model": r.model,
        "status": r.status,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "ended_at": r.ended_at.isoformat() if r.ended_at else None,
        "duration_ms": r.duration_ms,
        "total_tokens": r.total_tokens,
        "tool_count": r.tool_count,
        "error_type": r.error_type,
        "error_message": r.error_message,
    } for r in rows]
    return {"runs": out, "count": len(out)}


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
    _viewer: UserContext = _VIEWER,
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
