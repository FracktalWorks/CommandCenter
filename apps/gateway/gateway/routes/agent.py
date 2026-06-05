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

import json
import re
import uuid
from pathlib import Path
from typing import Any

from acb_auth import UserContext, get_current_user
from acb_common import get_logger, get_settings
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

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

# Human-readable metadata for the Control Plane agent picker.
# Keys match the bare agent names in _KNOWN_AGENTS.
_AGENT_REGISTRY: list[dict] = [
    {
        "name": "task-manager",
        "description": "ClickUp task management — status, progress, and workload questions with citations.",
        "tags": ["tasks", "clickup", "project-management"],
        "status": "live",
        # Local monorepo agent — MAF runner (uses GitHubCopilotAgent internally, but
        # is NOT registered from an external GitHub repo, so agent_runtime = "maf").
        "agent_runtime": "maf",
        "local_path": "apps/agent-task-manager",
        "integrations": ["clickup"],
        "optional_integrations": [],
        "webhook_routes": [
            {"source": "clickup", "event_type": "taskCreated"},
            {"source": "clickup", "event_type": "taskUpdated"},
            {"source": "clickup", "event_type": "taskDeleted"},
        ],
    },
    {
        "name": "sales",
        "description": "Zoho CRM sales pipeline + deal follow-ups",
        "tags": ["sales", "zoho"],
        "status": "live",
        "agent_runtime": "maf",
        "integrations": ["zoho-crm"],
        "optional_integrations": ["gmail-send"],
    },
    {
        "name": "delivery",
        "description": "Project delivery monitoring + push notifications",
        "tags": ["delivery"],
        "status": "live",
        "agent_runtime": "maf",
        "integrations": ["clickup"],
        "optional_integrations": [],
    },
    {
        "name": "triage",
        "description": "Email / WhatsApp / meeting triage + routing",
        "tags": ["triage", "email"],
        "status": "live",
        "agent_runtime": "maf",
        "integrations": ["gmail", "zoho-crm"],
        "optional_integrations": ["clickup"],
    },
    {
        "name": "reconciler",
        "description": "Nightly source-of-truth diff + escalation",
        "tags": ["ops"],
        "status": "live",
        "agent_runtime": "maf",
        "integrations": ["clickup", "zoho-crm"],
        "optional_integrations": [],
    },
    {
        "name": "billing",
        "description": "Billing & invoice workflows",
        "tags": ["billing"],
        "status": "live",
        "agent_runtime": "maf",
        "integrations": ["zoho-crm"],
        "optional_integrations": ["smtp"],
    },
    {
        "name": "strategy",
        "description": "Weekly digest + planning synthesis",
        "tags": ["strategy"],
        "status": "live",
        "agent_runtime": "maf",
        "integrations": [],
        "optional_integrations": [],
    },
]


# ---------------------------------------------------------------------------
# Dynamic (user-registered) agent persistence
# ---------------------------------------------------------------------------

def _get_agents_file() -> Path:
    """Locate agents.json at the project root (alongside .env and pyproject.toml)."""
    candidate = Path(__file__).resolve()
    for _ in range(8):
        candidate = candidate.parent
        if (candidate / "pyproject.toml").exists():
            return candidate / "agents.json"
    return Path.cwd() / "agents.json"


def _load_dynamic_agents() -> list[dict]:
    """Return the list of user-registered agents from agents.json."""
    path = _get_agents_file()
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []


def _save_dynamic_agents(agents: list[dict]) -> None:
    """Write the dynamic agent list back to agents.json."""
    path = _get_agents_file()
    path.write_text(json.dumps(agents, indent=2, ensure_ascii=False), encoding="utf-8")


def _validate_agent_name(name: str) -> str:
    """Reject agent names not in the static or dynamic allowlist."""
    safe = name.lower().strip()
    if safe not in _KNOWN_AGENTS:
        # Also accept dynamically registered agents
        dynamic_names = {a["name"] for a in _load_dynamic_agents()}
        if safe not in dynamic_names:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Unknown agent {name!r}. "
                    f"Static allowed: {sorted(_KNOWN_AGENTS)}"
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
# Request model for registering a new agent
# ---------------------------------------------------------------------------

class RegisterAgentRequest(BaseModel):
    name: str
    """Unique slug, e.g. ``"my-agent"``."""
    description: str = ""
    repo_url: str = ""
    """GitHub repo as ``owner/repo`` or full ``https://github.com/owner/repo`` URL."""
    local_path: str | None = None
    """Absolute path to a local agent directory (dev mode).  Takes priority over repo_url."""
    tags: list[str] = []
    integrations: list[str] = []
    optional_integrations: list[str] = []


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/config", summary="Fetch config.json from a GitHub agent repo or local path")
async def get_agent_config(
    repo: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Fetch and return the agent's config.json.

    ``repo`` may be:
    - ``owner/repo`` or ``https://github.com/owner/repo`` — fetched from GitHub
    - An absolute local path (``/path/to/dir`` or ``C:\\path\\to\\dir``) — read from disk

    Returns the parsed config dict, or raises 404 if not found.
    """
    import httpx  # noqa: PLC0415

    raw = repo.strip().rstrip("/")

    # ── Local path ─────────────────────────────────────────────────────────
    local = Path(raw)
    if local.is_absolute():
        # Resolve to prevent traversal tricks
        resolved = local.resolve()
        config_file = resolved / "config.json"
        if not resolved.is_dir():
            raise HTTPException(status_code=404, detail=f"Directory not found: {raw}")
        if not config_file.exists():
            raise HTTPException(status_code=404, detail="config.json not found in that directory.")
        try:
            return json.loads(config_file.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=422, detail="config.json is not valid JSON.")

    # ── GitHub ──────────────────────────────────────────────────────────────
    slug = raw.removeprefix("https://github.com/").removeprefix("http://github.com/")

    settings = get_settings()
    headers: dict[str, str] = {"Accept": "application/vnd.github.raw+json"}
    token: str = getattr(settings, "github_token", "") or ""
    if token:
        headers["Authorization"] = f"token {token}"

    async with httpx.AsyncClient(timeout=8) as client:
        for branch in ("main", "master", "HEAD"):
            url = f"https://raw.githubusercontent.com/{slug}/{branch}/config.json"
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                try:
                    return resp.json()
                except Exception:  # noqa: BLE001
                    raise HTTPException(status_code=422, detail="config.json is not valid JSON.")

    raise HTTPException(
        status_code=404,
        detail=f"config.json not found in {slug!r} (tried main, master, HEAD).",
    )


@router.get("", summary="List all registered agents")
async def list_agents(
    user: UserContext = Depends(get_current_user),
) -> list[dict]:
    """Return the merged static + dynamic agent registry."""
    dynamic = _load_dynamic_agents()
    dynamic_names = {a["name"] for a in dynamic}
    # Static agents not overridden by dynamic entries come first
    static = [a for a in _AGENT_REGISTRY if a["name"] not in dynamic_names]
    # Back-fill agent_runtime for legacy dynamic entries that predate the field.
    # Rule: only entries registered FROM a GitHub repo URL are "github-copilot";
    # everything else (local path, unknown) is plain MAF.
    for a in dynamic:
        if "agent_runtime" not in a:
            a["agent_runtime"] = (
                "github-copilot"
                if (a.get("repo_name") or a.get("repo_url")) and not a.get("local_path")
                else "maf"
            )
    return static + dynamic


@router.post("", status_code=status.HTTP_201_CREATED, summary="Register an agent from a GitHub repo")
async def register_agent(
    req: RegisterAgentRequest,
    background_tasks: BackgroundTasks,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Add a new agent to the dynamic registry and persist it to agents.json.

    Accepts either a GitHub URL (``repo_url``) or an absolute local directory
    path (``local_path``).  In both cases, if metadata fields are empty the
    endpoint reads ``config.json`` to fill them.  For GitHub repos a background
    git clone is also triggered so the agent is warm before its first run.
    """
    import httpx  # noqa: PLC0415

    # Validate name format
    if not re.match(r"^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$", req.name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Agent name must be 2-50 lowercase letters, digits, or hyphens (no leading/trailing hyphens).",
        )

    dynamic = _load_dynamic_agents()
    all_names = {a["name"] for a in _AGENT_REGISTRY} | {a["name"] for a in dynamic}
    if req.name in all_names:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Agent {req.name!r} is already registered.",
        )

    description = req.description or ""
    tags = req.tags or []
    integrations = req.integrations or []
    optional_integrations = req.optional_integrations or []

    # ── Determine source: local path or GitHub ──────────────────────────────
    local_path: str | None = None
    repo_url: str = (req.repo_url or "").strip().rstrip("/")
    repo_name: str = ""

    # Detect local path: req.local_path set, or repo_url is an absolute path
    raw_input = req.local_path or (repo_url if Path(repo_url).is_absolute() else None)
    if raw_input:
        resolved = Path(raw_input).resolve()
        if not resolved.is_dir():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Local path does not exist: {raw_input}",
            )
        local_path = str(resolved)
        # Auto-read config.json from disk if metadata is missing
        if not description or not integrations:
            config_file = resolved / "config.json"
            if config_file.exists():
                try:
                    cfg: dict = json.loads(config_file.read_text(encoding="utf-8"))
                    description = description or cfg.get("description", "")
                    tags = tags or cfg.get("tags", [])
                    integrations = integrations or cfg.get("integrations", [])
                    optional_integrations = optional_integrations or cfg.get("optional_integrations", [])
                    _log.info("agent.config_read_local", name=req.name, path=local_path)
                except Exception as exc:  # noqa: BLE001
                    _log.warning("agent.config_parse_failed", name=req.name, error=str(exc))
    else:
        # GitHub URL
        repo_name = repo_url.removeprefix("https://github.com/").removeprefix("http://github.com/")
        if not description or not integrations:
            settings = get_settings()
            gh_token: str = getattr(settings, "github_token", "") or ""
            headers: dict[str, str] = {"Accept": "application/vnd.github.raw+json"}
            if gh_token:
                headers["Authorization"] = f"token {gh_token}"
            try:
                async with httpx.AsyncClient(timeout=8) as client:
                    cfg = {}
                    for branch in ("main", "master", "HEAD"):
                        url = f"https://raw.githubusercontent.com/{repo_name}/{branch}/config.json"
                        resp = await client.get(url, headers=headers)
                        if resp.status_code == 200:
                            try:
                                cfg = resp.json()
                            except Exception:  # noqa: BLE001
                                cfg = {}
                            break
                    if cfg:
                        description = description or cfg.get("description", "")
                        tags = tags or cfg.get("tags", [])
                        integrations = integrations or cfg.get("integrations", [])
                        optional_integrations = optional_integrations or cfg.get("optional_integrations", [])
                        _log.info("agent.config_fetched", name=req.name, repo=repo_name)
            except Exception as exc:  # noqa: BLE001
                _log.warning("agent.config_fetch_failed", name=req.name, error=str(exc))

    # agent_runtime: only agents registered FROM a GitHub repo URL run via the
    # GitHub Copilot SDK (GitHubCopilotAgent). Local-path agents are plain MAF.
    agent_runtime = "github-copilot" if (repo_name and not local_path) else "maf"

    entry: dict = {
        "name": req.name,
        "description": description,
        "tags": tags,
        "status": "live",
        "agent_runtime": agent_runtime,
        "repo_url": repo_url or None,
        "repo_name": repo_name or None,
        "local_path": local_path,
        "integrations": integrations,
        "optional_integrations": optional_integrations,
        "dynamic": True,
    }
    dynamic.append(entry)
    _save_dynamic_agents(dynamic)
    _log.info("agent.registered", name=req.name, actor=user.email, source="local" if local_path else "github")

    # Eager background clone — only for GitHub repos (local paths need no cloning)
    if not local_path and repo_name:
        def _eager_clone(agent_name: str, repo_slug: str) -> None:
            try:
                from acb_skills.loader import load_agent  # noqa: PLC0415
                repo_portion = repo_slug.split("/")[-1] if "/" in repo_slug else repo_slug
                with load_agent(agent_name, repo_name=repo_portion):
                    pass
                _log.info("agent.eager_clone_done", name=agent_name)
            except Exception as exc:  # noqa: BLE001
                _log.warning("agent.eager_clone_failed", name=agent_name, error=str(exc))

        background_tasks.add_task(_eager_clone, req.name, repo_name)

    return entry


@router.delete("/{name}", summary="Remove a user-registered agent")
async def remove_agent(
    name: str,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Delete a dynamic agent from agents.json.  Built-in agents cannot be removed."""
    if name in _KNOWN_AGENTS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Built-in agent {name!r} cannot be removed via the API.",
        )
    dynamic = _load_dynamic_agents()
    new_dynamic = [a for a in dynamic if a["name"] != name]
    if len(new_dynamic) == len(dynamic):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Agent {name!r} not found.")
    _save_dynamic_agents(new_dynamic)
    _log.info("agent.removed", name=name, actor=user.email)
    return {"deleted": name}


class PatchAgentRequest(BaseModel):
    description: str | None = None
    tags: list[str] | None = None
    integrations: list[str] | None = None
    optional_integrations: list[str] | None = None
    status: str | None = None


@router.patch("/{name}", summary="Update metadata for a user-registered agent")
async def patch_agent(
    name: str,
    req: PatchAgentRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """Partially update a dynamic agent's metadata in agents.json."""
    if name in _KNOWN_AGENTS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Built-in agent {name!r} cannot be modified via the API.",
        )
    dynamic = _load_dynamic_agents()
    entry = next((a for a in dynamic if a["name"] == name), None)
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Agent {name!r} not found.")
    if req.description is not None:
        entry["description"] = req.description
    if req.tags is not None:
        entry["tags"] = req.tags
    if req.integrations is not None:
        entry["integrations"] = req.integrations
    if req.optional_integrations is not None:
        entry["optional_integrations"] = req.optional_integrations
    if req.status is not None:
        entry["status"] = req.status
    _save_dynamic_agents(dynamic)
    _log.info("agent.patched", name=name, actor=user.email)
    return entry


@router.post("/run/stream", summary="Stream a named agent run as AG-UI SSE events")
async def run_agent_stream_endpoint(
    req: AgentRunRequest,
    _request: Request,
    user: UserContext = Depends(get_current_user),
) -> StreamingResponse:
    """Stream a named-agent run as AG-UI Server-Sent Events.

    Returns an ``text/event-stream`` response emitting AG-UI protocol events:
    ``RUN_STARTED``, ``TOOL_CALL_START``, ``TOOL_CALL_ARGS``, ``TOOL_CALL_RESULT``,
    ``TEXT_MESSAGE_CONTENT``, ``RUN_FINISHED`` / ``RUN_ERROR``.

    The Next.js ``/api/agent/chat`` route already knows how to translate this
    stream to the frontend SSE format — it is the same translation layer used
    for the orchestrator's ``/copilot/chat`` endpoint.

    Use this instead of ``POST /agent/run`` whenever the caller wants live
    tool-call visibility (e.g. the control-plane chat UI).
    """
    from orchestrator.executor import run_agent_stream  # noqa: PLC0415

    agent = _validate_agent_name(req.agent)
    run_id = req.run_id or str(uuid.uuid4())

    _log.info("agent.stream_run_start", agent=agent, run_id=run_id, actor=user.email)

    return StreamingResponse(
        run_agent_stream(
            agent,
            req.payload,
            run_id=run_id,
            thread_id=req.thread_id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


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
    ``GET /agent/run/{run_id}/status`` for progress.
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
    """Return the latest recorded status for a given run.

    Queries the audit_event table for agent_run_start / agent_run_complete events
    matching the run_id.  LangGraph PostgresSaver removed in WBS 0.7.
    """
    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        with get_session() as sess:
            result = sess.execute(
                text(
                    "SELECT action, at FROM audit_event "
                    "WHERE payload->>'run_id' = :run_id "
                    "ORDER BY at DESC LIMIT 10"
                ),
                {"run_id": run_id},
            )
            events = [{"action": r.action, "at": str(r.at)} for r in result]

        if not events:
            return {"run_id": run_id, "status": "not_found"}
        actions = {e["action"] for e in events}
        if "agent_run_complete" in actions:
            status_str = "completed"
        elif "agent_run_error" in actions:
            status_str = "failed"
        else:
            status_str = "running"
        return {"run_id": run_id, "status": status_str, "events": events}
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

    Routing logic:
    1. Look up (source, event_type) in ``_WEBHOOK_ROUTES`` for static MAF agents.
    2. If not found there, scan the dynamic agent registry for a route with
       a matching ``webhook_routes`` entry.
    3. Dispatch to the MAF executor (the sole agent execution runtime; the
       Copilot SDK is used only for self-mutation containers).
    """
    agent_name: str | None = _WEBHOOK_ROUTES.get((source, event.event_type))
    agent_runtime = "maf"  # default for static routes — MAF executor (WBS 0.7)

    # If the static table had no match, check dynamic agents for a webhook route
    if not agent_name:
        for dyn in _load_dynamic_agents():
            for route in dyn.get("webhook_routes", []):
                if route.get("source") == source and route.get("event_type") == event.event_type:
                    agent_name = dyn["name"]
                    agent_runtime = dyn.get("agent_runtime", "maf")
                    break
            if agent_name:
                break

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

    # MAF is the sole agent execution runtime (Copilot SDK is mutation-only).
    from orchestrator.executor import run_agent  # noqa: PLC0415

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
    _log.info(
        "webhook.routed",
        source=source,
        event_type=event.event_type,
        agent=agent_name,
        run_id=run_id,
    )

    return {"status": "queued", "run_id": run_id, "agent": agent_name, "runtime": agent_runtime}
