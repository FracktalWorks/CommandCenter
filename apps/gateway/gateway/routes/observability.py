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
from acb_common import active_runs, get_logger, read_activity_since, recent_activity
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
