"""FastAPI entry point. Run with: uv run uvicorn gateway.main:app --reload"""
from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from acb_auth import UserContext, UserRole, get_current_user, require_role
from acb_common import configure_logging, get_logger, get_settings
from fastapi import BackgroundTasks, Depends, FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

_log = get_logger("gateway")

# ── Pre-import heavy modules before event loop starts ──────────────────────
# SQLAlchemy / psycopg deadlocks when imported for the first time inside a
# running asyncio event loop.  Importing here (module level, before uvicorn
# starts the loop) avoids the deadlock entirely.
try:
    from orchestrator.agents import build_orchestrator_agent as _build_orchestrator_agent
    _HAS_MAF = True
except ImportError:
    _HAS_MAF = False
    _build_orchestrator_agent = None


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # Force UTF-8 for all child processes spawned by the gateway (scripts, git, etc.).
    # On Windows the default is cp1252 which breaks any script that prints emoji or
    # non-ASCII characters (e.g. zoho_crm.py's pipeline summary headers).
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

    settings = get_settings()
    configure_logging(settings.log_level)
    _log.info("gateway.startup", env=settings.acb_env)

    if _HAS_MAF:
        _log.info("gateway.ag_ui_registered", path="/copilot/chat")

    # Tier 1.5 runtime self-check (M2.6). Surfaces a broken github-copilot
    # sandbox at startup instead of failing silently on the first agent run.
    try:
        checks = _runtime_checks()
        ok = all(c["ok"] for c in checks.values())
        _log.info("gateway.runtime_check", ok=ok, **{k: v["ok"] for k, v in checks.items()})
        for name, c in checks.items():
            if not c["ok"]:
                _log.warning("gateway.runtime_degraded", check=name, detail=c["detail"])
    except Exception as exc:  # pragma: no cover
        _log.warning("gateway.runtime_check_failed", error=str(exc))

    yield
    _log.info("gateway.shutdown")


app = FastAPI(
    title="AI Company Brain — Gateway",
    version="0.0.1",
    description="Pull queries, push notifications, approvals. See ai-company-brain/system_architecture.md §3.",
    lifespan=lifespan,
)

# ── Wire AG-UI endpoint — custom per-request endpoint with memory injection ──
# Replaced the singleton _add_ag_ui_endpoint pattern (which pre-built one agent
# at module level, making per-request memory enrichment impossible) with a
# custom FastAPI POST handler that:
#   1. Builds a fresh MAF Agent per-request (cheap — just wires tools, no I/O)
#   2. Enriches its instructions with Mem0 + Graphiti context for this user
#   3. Streams AG-UI SSE events via AgentFrameworkAgent + EventEncoder
#   4. Fires background memory extraction after the run
if _HAS_MAF:
    try:
        from agent_framework_ag_ui import AGUIRequest as _AGUIRequest
        from ag_ui.encoder import EventEncoder as _EventEncoder
        from ag_ui.core.events import RunErrorEvent as _RunErrorEvent
        from agent_framework.ag_ui import AgentFrameworkAgent as _AgentFrameworkAgent

        @app.post("/copilot/chat", tags=["AG-UI"], response_model=None)
        async def copilot_chat(
            request_body: _AGUIRequest,
            background_tasks: BackgroundTasks,
            user: UserContext = Depends(get_current_user),
        ) -> StreamingResponse:
            """MAF orchestrator: per-request agent with Mem0+Graphiti memory injection."""
            from orchestrator.agents import (
                build_orchestrator_agent,
                enrich_instructions_with_memory,
            )

            user_id: str = getattr(user, "email", "") or "anonymous"
            input_data = request_body.model_dump(exclude_none=True)

            # Extract the last user message so memory search is query-focused
            messages = input_data.get("messages", [])
            last_user_msg: str = next(
                (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
                "",
            )

            # Build per-request agent (cheap — tools are closures, no network I/O)
            agent = build_orchestrator_agent(with_history=False)

            # Inject Mem0 + Graphiti context into default_options (no-op if disabled)
            if last_user_msg:
                enriched = await enrich_instructions_with_memory(agent, user_id, last_user_msg)
                opts = agent.default_options
                if isinstance(opts, dict) and enriched:
                    opts["instructions"] = enriched

            protocol_runner = _AgentFrameworkAgent(agent=agent)

            async def event_generator():
                encoder = _EventEncoder()
                try:
                    async for event in protocol_runner.run(input_data):
                        yield encoder.encode(event)
                except Exception as exc:  # noqa: BLE001
                    _log.exception("copilot_chat.stream_error")
                    try:
                        yield encoder.encode(_RunErrorEvent(
                            message="Internal error during agent run",
                            code=type(exc).__name__,
                        ))
                    except Exception:
                        pass

            # Post-run memory extraction (fires after response stream closes)
            try:
                from acb_memory import add_memories_background  # noqa: PLC0415
                if last_user_msg and messages:
                    conv = [
                        {"role": m.get("role", "user"), "content": m.get("content", "")}
                        for m in messages if m.get("content")
                    ]
                    background_tasks.add_task(add_memories_background, user_id, conv)
            except ImportError:
                pass

            return StreamingResponse(
                event_generator(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )
    except Exception as _exc:
        _log.warning("gateway.ag_ui_failed", error=str(_exc))

# Webhook routers (Phase 1 ingestion entry points)
try:
    from ingestion.sources.clickup.webhook import router as _clickup_router

    app.include_router(_clickup_router)
except Exception:  # pragma: no cover - keep gateway bootable even if optional dep missing
    pass

try:
    from ingestion.sources.zoho.webhook import router as _zoho_router

    app.include_router(_zoho_router)
except Exception:  # pragma: no cover
    pass

try:
    from ingestion.sources.gmail.webhook import router as _gmail_router

    app.include_router(_gmail_router)
except Exception:  # pragma: no cover
    pass

try:
    from gateway.routes.agent import router as _agent_router

    app.include_router(_agent_router)
except Exception:  # pragma: no cover - keep gateway bootable if orchestrator not installed
    pass

try:
    from gateway.routes.integrations import router as _integrations_router

    app.include_router(_integrations_router)
except Exception:  # pragma: no cover
    pass

try:
    from gateway.routes.oauth import router as _oauth_router

    app.include_router(_oauth_router)
except Exception:  # pragma: no cover
    pass

try:
    from gateway.routes.settings import router as _settings_router

    app.include_router(_settings_router)
except Exception:  # pragma: no cover
    pass

try:
    from gateway.routes.chat import router as _chat_router

    app.include_router(_chat_router)
except Exception:  # pragma: no cover
    pass

try:
    from gateway.routes.workspace import router as _workspace_router

    app.include_router(_workspace_router)
except Exception:  # pragma: no cover
    pass

try:
    from gateway.routes.memory import router as _memory_router

    app.include_router(_memory_router)
except Exception:  # pragma: no cover
    pass

# ---------- Health ----------

class Health(BaseModel):
    status: str
    env: str


def _runtime_checks() -> dict[str, dict]:
    """Validate the GitHub Copilot SDK (Tier 1.5) sandbox prerequisites.

    Checks (M2.6 cloud-sandbox requirements):
      - copilot SDK importable (bundled copilot.exe present)
      - pwsh on PATH (copilot.exe shell tool backend)
      - GITHUB_TOKEN configured (Copilot auth)

    Returns ``{check_name: {"ok": bool, "detail": str}}``. Never raises.
    """
    import shutil

    settings = get_settings()
    checks: dict[str, dict] = {}

    # copilot SDK importable
    try:
        import copilot  # noqa: F401

        checks["copilot_sdk"] = {"ok": True, "detail": "importable"}
    except Exception as exc:
        checks["copilot_sdk"] = {"ok": False, "detail": f"import failed: {exc}"}

    # pwsh on PATH
    pwsh = shutil.which("pwsh") or shutil.which("powershell")
    checks["pwsh"] = (
        {"ok": True, "detail": pwsh}
        if pwsh
        else {"ok": False, "detail": "pwsh not found on PATH — shell tool will fail on Linux"}
    )

    # GITHUB_TOKEN configured
    token = getattr(settings, "github_token", "") or os.environ.get("GITHUB_TOKEN", "")
    checks["github_token"] = (
        {"ok": True, "detail": "configured"}
        if token
        else {"ok": False, "detail": "GITHUB_TOKEN not set — github-copilot agents will fail"}
    )

    return checks


@app.get("/health", response_model=Health, tags=["meta"])
async def health() -> Health:
    return Health(status="ok", env=get_settings().acb_env)


@app.get("/health/runtime", tags=["meta"])
async def health_runtime() -> dict:
    """Report Tier 1.5 sandbox readiness (copilot SDK, pwsh, GITHUB_TOKEN)."""
    checks = _runtime_checks()
    return {"ok": all(c["ok"] for c in checks.values()), "checks": checks}



# ---------- Copilot models ----------
# Returns the list of models available via the GitHub Copilot SDK.
# The UI at /api/models/all calls this to populate the Copilot SDK model group.
# If GITHUB_TOKEN is not set, returns the static fallback list so the UI still
# works without blocking.

_COPILOT_MODELS_STATIC = [
    {"id": "claude-sonnet-4.5",           "label": "Claude Sonnet 4.5"},
    {"id": "claude-haiku-4.5",            "label": "Claude Haiku 4.5"},
    {"id": "claude-opus-4-5",             "label": "Claude Opus 4.5"},
    {"id": "gpt-4o",                      "label": "GPT-4o"},
    {"id": "gpt-4.1",                     "label": "GPT-4.1"},
    {"id": "o3-mini",                     "label": "o3-mini (reasoning)"},
    {"id": "gemini-2.5-pro",              "label": "Gemini 2.5 Pro"},
    {"id": "gemini-2.5-flash",            "label": "Gemini 2.5 Flash"},
]


@app.get("/copilot/models", tags=["copilot"])
async def copilot_models() -> dict:
    """Return the list of models available through the GitHub Copilot SDK.

    Attempts to query the Copilot SDK for the live model list (requires
    GITHUB_TOKEN to be set and the ``gh`` CLI to be authenticated).  Falls back
    to a curated static list so the UI never fails.
    """
    settings = get_settings()
    github_token: str = getattr(settings, "github_token", "") or os.environ.get("GITHUB_TOKEN", "")

    if github_token:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(
                    "https://api.githubcopilot.com/models",
                    headers={
                        "Authorization": f"Bearer {github_token}",
                        "Copilot-Integration-Id": "vscode-chat",
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    # Copilot API returns {"data": [{"id": "...", "name": "...", ...}]}
                    raw = data.get("data", [])
                    # Filter to chat-capable models only
                    chat_models = [
                        m for m in raw
                        if m.get("capabilities", {}).get("type") in ("chat", None)
                        and not m.get("id", "").startswith("text-embedding")
                    ]
                    if chat_models:
                        return {
                            "models": [
                                {
                                    "id": m["id"],
                                    "label": m.get("name", m["id"]),
                                    "model_picker_enabled": m.get("model_picker_enabled", False),
                                }
                                for m in chat_models
                            ],
                            "source": "live",
                        }
        except Exception:
            pass  # Fall through to static list

    return {"models": _COPILOT_MODELS_STATIC, "source": "static"}


# ---------- Pull mode (Phase 0 stub) ----------

class PullRequest(BaseModel):
    query: str
    user_email: str | None = None


class PullResponse(BaseModel):
    answer: str
    citations: list[str] = []
    trace_id: str | None = None


@app.post("/pull", response_model=PullResponse, tags=["pull"])
async def pull(req: PullRequest, _user: UserContext = Depends(get_current_user)) -> PullResponse:
    """Phase-0 pull Q&A: routes through the MAF orchestrator agent."""
    import asyncio
    import uuid

    from acb_llm.guardrails import CITATION_RE  # local import to avoid cold-start cost

    trace_id = uuid.uuid4().hex
    user_id: str = req.user_email or getattr(_user, "email", "") or "anonymous"
    _log.info("pull.received", query=req.query, user=user_id, trace_id=trace_id)
    try:
        from orchestrator.agents import build_orchestrator_agent, enrich_instructions_with_memory
        agent = build_orchestrator_agent(with_history=False)
        # Inject Mem0 + Graphiti context for this user + query (no-op if disabled)
        enriched = await enrich_instructions_with_memory(agent, user_id, req.query)
        opts = agent.default_options
        if isinstance(opts, dict) and enriched:
            opts["instructions"] = enriched
        async with agent:
            response = await agent.run(req.query)
        text = response.text or ""
    except Exception as exc:
        _log.exception("pull.failed", trace_id=trace_id)
        return PullResponse(
            answer=f"[agent error] {type(exc).__name__}: {exc}", citations=[], trace_id=trace_id
        )
    citations = sorted({m.group(0) for m in CITATION_RE.finditer(text)})
    # Background: extract facts from this exchange into Mem0
    try:
        from acb_memory import add_memories_background, add_episode  # noqa: PLC0415
        messages = [
            {"role": "user", "content": req.query},
            {"role": "assistant", "content": text},
        ]
        asyncio.create_task(add_memories_background(user_id, messages))
        asyncio.create_task(add_episode(
            name=f"pull:{trace_id[:8]}",
            content=f"Q: {req.query}\nA: {text[:500]}",
            source_description="pull_endpoint",
            group_id=user_id,
        ))
    except ImportError:
        pass
    return PullResponse(answer=text, citations=citations, trace_id=trace_id)


# ---------- Sales Pull (WBS 1.5) ----------

@app.post("/pull/sales", response_model=PullResponse, tags=["pull"],
          dependencies=[require_role(UserRole.EXECUTIVE)])
async def pull_sales(req: PullRequest) -> PullResponse:
    """Sales-flavoured pull Q&A: uses customer-360 / quiet-deal context blocks."""
    import uuid

    from acb_llm.guardrails import CITATION_RE

    trace_id = uuid.uuid4().hex
    _log.info("pull.sales.received", query=req.query, user=req.user_email, trace_id=trace_id)
    try:
        from orchestrator.agents import build_orchestrator_agent
        agent = build_orchestrator_agent(with_history=False)
        async with agent:
            response = await agent.run(req.query)
        text = response.text or ""
    except Exception as exc:
        _log.exception("pull.sales.failed", trace_id=trace_id)
        return PullResponse(
            answer=f"[agent error] {type(exc).__name__}: {exc}", citations=[], trace_id=trace_id
        )
    citations = sorted({m.group(0) for m in CITATION_RE.finditer(text)})
    return PullResponse(answer=text, citations=citations, trace_id=trace_id)
