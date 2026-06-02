"""Agent event routing endpoints (CommandCenter v2 — Core FastAPI router).

Endpoints
---------
POST /agent/run
    Synchronously run a named agent and wait for the result.

POST /agent/run/async
    Fire-and-forget: enqueue the run as a background task, return run_id immediately.

GET  /agent/run/{run_id}/status
    Query the Postgres checkpoint for a run's current state.

POST /agent/webhook/{source}
    Receive an external webhook (ClickUp, Zoho, Gmail, WhatsApp) and route
    it to the correct specialist agent based on the built-in routing table.
    In Phase 2 this table will be driven by each agent's ``config.json``.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel

from acb_auth import UserContext, get_current_user
from acb_common import get_logger

_log = get_logger("gateway.agent")

router = APIRouter(prefix="/agent", tags=["agents"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class AgentRunRequest(BaseModel):
    agent: str
    """Bare agent name, e.g. ``"task-manager"``.  Core prepends ``agent-`` when cloning."""
    payload: dict[str, Any] = {}
    thread_id: str | None = None
    run_id: str | None = None


class AgentRunResponse(BaseModel):
    run_id: str
    agent: str
    status: str  # "completed" | "failed" | "queued"
    result: Any | None = None
    mutation_pr: str | None = None
    error: str | None = None


class WebhookEvent(BaseModel):
    source: str
    event_type: str
    payload: dict[str, Any] = {}


# ---------------------------------------------------------------------------
# Agent name allowlist (security: never clone arbitrary user-supplied names)
# ---------------------------------------------------------------------------

_KNOWN_AGENTS: frozenset[str] = frozenset(
    [
        "task-manager",
        "billing",
        "sales",
        "delivery",
        "triage",
        "reconciler",
        "strategy",
    ]
)


def _validate_agent_name(name: str) -> str:
    """Reject agent names not in the allowlist (prevents path traversal / SSRF)."""
    safe = name.lower().strip()
    if safe not in _KNOWN_AGENTS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Unknown agent {name!r}. "
                f"Allowed: {sorted(_KNOWN_AGENTS)}"
            ),
        )
    return safe


# ---------------------------------------------------------------------------
# Webhook routing table
# Maps (source, event_type) → agent name.
# Phase 2: driven by each agent's config.json; here it is hard-coded for Phase 0.
# ---------------------------------------------------------------------------

_WEBHOOK_ROUTES: dict[tuple[str, str], str] = {
    ("clickup", "taskUpdated"): "task-manager",
    ("clickup", "taskCreated"): "task-manager",
    ("clickup", "taskDeleted"): "task-manager",
    ("zoho", "deal.update"): "sales",
    ("zoho", "contact.create"): "sales",
    ("zoho", "deal.stageChange"): "sales",
    ("gmail", "message.received"): "triage",
    ("whatsapp", "message.received"): "triage",
    ("calendar", "meeting.ended"): "triage",
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/run", response_model=AgentRunResponse)
async def run_agent_sync(
    req: AgentRunRequest,
    user: UserContext = Depends(get_current_user),
) -> AgentRunResponse:
    """Synchronously run a named agent and return the final state.

    Use this for interactive queries where the caller can wait.
    For long-running background tasks prefer ``POST /agent/run/async``.
    """
    from orchestrator.executor import AgentRunError, run_agent  # noqa: PLC0415

    agent = _validate_agent_name(req.agent)
    run_id = req.run_id or str(uuid.uuid4())

    try:
        final_state = await run_agent(
            agent,
            req.payload,
            run_id=run_id,
            thread_id=req.thread_id,
        )
        return AgentRunResponse(
            run_id=run_id,
            agent=agent,
            status="completed",
            result=final_state.get("result"),
        )
    except AgentRunError as exc:
        return AgentRunResponse(
            run_id=run_id,
            agent=agent,
            status="failed",
            error=str(exc.original),
            mutation_pr=exc.mutation_pr,
        )


@router.post("/run/async", status_code=status.HTTP_202_ACCEPTED)
async def run_agent_async(
    req: AgentRunRequest,
    background_tasks: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
) -> dict[str, str]:
    """Enqueue an agent run and return ``run_id`` immediately (202 Accepted).

    The run executes as a FastAPI background task.  Poll
    ``GET /agent/run/{run_id}/status`` or check Langfuse for progress.
    """
    from orchestrator.executor import run_agent  # noqa: PLC0415

    agent = _validate_agent_name(req.agent)
    run_id = req.run_id or str(uuid.uuid4())

    async def _run() -> None:
        try:
            await run_agent(agent, req.payload, run_id=run_id, thread_id=req.thread_id)
        except Exception as exc:  # noqa: BLE001
            _log.error(
                "agent.async_run_error",
                run_id=run_id,
                agent=agent,
                error=str(exc),
            )

    background_tasks.add_task(_run)
    return {"run_id": run_id, "status": "queued", "agent": agent}


@router.get("/run/{run_id}/status")
async def get_run_status(
    run_id: str,
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """Return the latest checkpoint state for a given run.

    Queries the Postgres checkpointer using the run_id as the thread_id prefix.
    Returns a lightweight status envelope; the full state is in Langfuse.
    """
    from acb_common import get_settings  # noqa: PLC0415

    settings = get_settings()

    try:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver  # noqa: PLC0415

        async with await AsyncPostgresSaver.from_conn_string(settings.database_url) as cp:
            # LangGraph stores state keyed by thread_id.
            # We scan for any thread whose ID starts with the run_id prefix.
            thread_id = run_id  # caller may set thread_id == run_id
            state = await cp.aget({"configurable": {"thread_id": thread_id}})
            if state is None:
                return {"run_id": run_id, "status": "not_found"}
            return {
                "run_id": run_id,
                "status": "found",
                "step": state.metadata.get("step"),
                "keys": list(state.values.keys()) if state.values else [],
            }
    except ImportError:
        return {
            "run_id": run_id,
            "status": "unknown",
            "hint": "langgraph-checkpoint-postgres not installed.",
        }
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/webhook/{source}", status_code=status.HTTP_202_ACCEPTED)
async def receive_webhook(
    source: str,
    event: WebhookEvent,
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    """Receive a webhook from an external source and route to the correct agent.

    No authentication required on this endpoint (called by external services).
    Webhook signature verification is handled by the source-specific ingestion
    routers (``ingestion/sources/*/webhook.py``); this endpoint is the v2
    agent-dispatch layer on top.
    """
    from orchestrator.executor import run_agent  # noqa: PLC0415

    agent_name = _WEBHOOK_ROUTES.get((source, event.event_type))
    if not agent_name:
        _log.warning(
            "webhook.no_route",
            source=source,
            event_type=event.event_type,
        )
        return {
            "status": "no_route",
            "source": source,
            "event_type": event.event_type,
            "known_routes": [f"{s}/{et}" for s, et in _WEBHOOK_ROUTES],
        }

    run_id = str(uuid.uuid4())

    async def _run() -> None:
        try:
            await run_agent(
                agent_name,
                {"source": source, "event_type": event.event_type, **event.payload},
                run_id=run_id,
            )
        except Exception as exc:  # noqa: BLE001
            _log.error(
                "webhook.agent_error",
                run_id=run_id,
                agent=agent_name,
                error=str(exc),
            )

    background_tasks.add_task(_run)
    _log.info("webhook.routed", source=source, event_type=event.event_type, agent=agent_name)
    return {"status": "queued", "run_id": run_id, "agent": agent_name}
