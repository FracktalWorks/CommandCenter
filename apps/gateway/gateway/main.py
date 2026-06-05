"""FastAPI entry point. Run with: uv run uvicorn gateway.main:app --reload"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from acb_auth import UserContext, UserRole, get_current_user, require_role
from acb_common import configure_logging, get_logger, get_settings
from fastapi import Depends, FastAPI
from pydantic import BaseModel

_log = get_logger("gateway")

# ── Pre-import heavy modules before event loop starts ──────────────────────
# SQLAlchemy / psycopg deadlocks when imported for the first time inside a
# running asyncio event loop.  Importing here (module level, before uvicorn
# starts the loop) avoids the deadlock entirely.
try:
    from agent_framework.ag_ui import \
        add_agent_framework_fastapi_endpoint as _add_ag_ui_endpoint
    from orchestrator.agents import \
        build_orchestrator_agent as _build_orchestrator_agent
    _HAS_MAF = True
except ImportError:
    _HAS_MAF = False
    _add_ag_ui_endpoint = None
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

    yield
    _log.info("gateway.shutdown")


app = FastAPI(
    title="AI Company Brain — Gateway",
    version="0.0.1",
    description="Pull queries, push notifications, approvals. See ai-company-brain/system_architecture.md §3.",
    lifespan=lifespan,
)

# ── Wire AG-UI endpoint (module level so imports happen before event loop) ──
if _HAS_MAF:
    try:
        _maf_agent = _build_orchestrator_agent(with_history=False)
        _add_ag_ui_endpoint(
            app,
            _maf_agent,
            "/copilot/chat",
            dependencies=[Depends(get_current_user)],
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
    from gateway.routes.settings import router as _settings_router

    app.include_router(_settings_router)
except Exception:  # pragma: no cover
    pass

# ---------- Health ----------

class Health(BaseModel):
    status: str
    env: str


@app.get("/health", response_model=Health, tags=["meta"])
async def health() -> Health:
    return Health(status="ok", env=get_settings().acb_env)


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
            import httpx  # noqa: PLC0415
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
                                {"id": m["id"], "label": m.get("name", m["id"])}
                                for m in chat_models
                            ],
                            "source": "live",
                        }
        except Exception:  # noqa: BLE001
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
    import uuid

    from acb_llm.guardrails import \
        CITATION_RE  # local import to avoid cold-start cost

    trace_id = uuid.uuid4().hex
    _log.info("pull.received", query=req.query, user=req.user_email, trace_id=trace_id)
    try:
        from orchestrator.agents import \
            build_orchestrator_agent  # noqa: PLC0415
        agent = build_orchestrator_agent(with_history=False)
        async with agent:
            response = await agent.run(req.query)
        text = response.text or ""
    except Exception as exc:
        _log.exception("pull.failed", trace_id=trace_id)
        return PullResponse(
            answer=f"[agent error] {type(exc).__name__}: {exc}", citations=[], trace_id=trace_id
        )
    citations = sorted({m.group(0) for m in CITATION_RE.finditer(text)})
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
        from orchestrator.agents import \
            build_orchestrator_agent  # noqa: PLC0415
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
