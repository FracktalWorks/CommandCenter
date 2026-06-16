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
    from orchestrator.agents import \
        build_orchestrator_agent as _build_orchestrator_agent
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

    # Pre-warm the Copilot model list cache so /api/models/all returns instantly.
    async def _warmup_copilot_models() -> None:
        try:
            _gh = getattr(settings, "github_token", "") or os.environ.get("GITHUB_TOKEN", "")
            if not _gh:
                return
            os.environ.setdefault("GITHUB_TOKEN", _gh)
            import time as _t  # noqa: PLC0415

            from copilot import CopilotClient as _CC  # noqa: PLC0415
            _c = _CC(options={"github_token": _gh}); await _c.start()
            try:
                _m = await _c.list_models()
            finally:
                await _c.stop()
            if _m:
                _copilot_models_cache["data"] = {
                    "models": [{"id": x.id, "label": x.name, "model_picker_enabled": True}
                               for x in _m if not x.policy or x.policy.state == "enabled"],
                    "source": "live",
                }
                _copilot_models_cache["ts"] = _t.monotonic()
                _log.info("gateway.copilot_models_cache_warmed", count=len(_m))
        except Exception as _e:  # noqa: BLE001
            _log.warning("gateway.copilot_models_warmup_failed", error=str(_e))

    import asyncio as _asyncio
    _asyncio.ensure_future(_warmup_copilot_models())

    # Load provider API keys from encrypted Postgres store into litellm SDK.
    try:
        from acb_llm.key_store import get_key_store
        store = get_key_store()
        existing = await store.get_all()
        if not existing:
            _env_to_provider = {
                "GEMINI_API_KEY": "gemini", "OPENAI_API_KEY": "openai",
                "ANTHROPIC_API_KEY": "anthropic", "DEEPSEEK_API_KEY": "deepseek",
                "OPENROUTER_API_KEY": "openrouter", "GROQ_API_KEY": "groq",
                "MISTRAL_API_KEY": "mistral", "TOGETHER_API_KEY": "together",
            }
            for env_var, provider in _env_to_provider.items():
                val = os.environ.get(env_var, "")
                if val and val.strip():
                    await store.put(provider, val.strip())
        await store.configure_litellm()
        await store.configure_integrations()
        _log.info("gateway.keys_loaded_from_store")
    except Exception as exc:
        _log.warning("gateway.key_store_skipped", error=str(exc))

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

def _apply_thinking_mode(opts: dict, think_mode: str) -> None:
    """Apply thinking/reasoning mode to agent options.

    Maps our three thinking modes to model-specific parameters:
    - "thinking": enable chain-of-thought with moderate budget
    - "max":      enable chain-of-thought with maximum budget
    - "auto":     no override (model decides)

    For Copilot SDK models, this adds a 'thinking' block.
    For LiteLLM models, this adds 'reasoning_effort' or 'thinking'.
    """
    if think_mode == "thinking":
        # Moderate reasoning depth
        opts["model_params"] = opts.get("model_params", {})
        opts["model_params"]["reasoning_effort"] = "medium"
        opts["thinking"] = {"type": "enabled", "budget_tokens": 4000}
    elif think_mode == "max":
        # Maximum reasoning depth
        opts["model_params"] = opts.get("model_params", {})
        opts["model_params"]["reasoning_effort"] = "high"
        opts["thinking"] = {"type": "enabled", "budget_tokens": 16000}

if _HAS_MAF:
    try:
        from ag_ui.core.events import RunErrorEvent as _RunErrorEvent
        from ag_ui.encoder import EventEncoder as _EventEncoder
        from agent_framework.ag_ui import \
            AgentFrameworkAgent as _AgentFrameworkAgent
        from agent_framework_ag_ui import AGUIRequest as _AGUIRequest

        @app.post("/copilot/chat", tags=["AG-UI"], response_model=None)
        async def copilot_chat(
            request_body: _AGUIRequest,
            background_tasks: BackgroundTasks,
            user: UserContext = Depends(get_current_user),
        ) -> StreamingResponse:
            """MAF orchestrator: per-request agent with Mem0+Graphiti memory injection."""
            from orchestrator.agents import (build_orchestrator_agent,
                                             enrich_instructions_with_memory)

            user_id: str = getattr(user, "email", "") or "anonymous"
            input_data = request_body.model_dump(exclude_none=True)

            # ── Set user context for memory tools (remember / save_memory / etc.) ──
            try:
                from acb_skills.memory_tools import \
                    _set_memory_user_id  # noqa: PLC0415
                _set_memory_user_id(user_id)
            except ImportError:
                pass

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

            # Apply thinking mode to agent options
            think_mode = input_data.get("think_mode", "auto")
            if think_mode and think_mode != "auto":
                opts = agent.default_options
                if isinstance(opts, dict):
                    _apply_thinking_mode(opts, think_mode)

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

            # ── Detached execution + Redis relay (spec_stream_reconnection) ──
            # The orchestrator run executes in a background task that tees every
            # AG-UI frame to the per-thread Redis stream.  This response is a
            # Redis subscriber: client disconnects don't kill the run, and the
            # reconnect endpoint can replay missed events.  thread_id comes from
            # the AG-UI request body (the control plane always sends it).
            _thread_id: str = (
                input_data.get("thread_id") or input_data.get("threadId") or ""
            )

            async def relayed_generator():
                import json as _json  # noqa: PLC0415

                from orchestrator.stream_relay import (  # noqa: PLC0415
                    get_detached_task, run_detached)
                try:
                    async for evt in run_detached(
                        _thread_id, event_generator(), tee=True
                    ):
                        yield f"data: {_json.dumps(evt)}\n\n"
                except Exception:  # noqa: BLE001
                    if get_detached_task(_thread_id) is not None:
                        _log.warning("copilot_chat.stream_subscribe_lost")
                        return
                    # Redis unavailable — degrade to direct streaming.
                    _log.warning("copilot_chat.stream_relay_unavailable")
                    async for line in event_generator():
                        yield line

            # Post-run memory extraction (fires after response stream closes)
            try:
                from acb_memory import (add_episode,  # noqa: PLC0415
                                        add_memories_background)
                if last_user_msg and messages:
                    conv = [
                        {"role": m.get("role", "user"), "content": m.get("content", "")}
                        for m in messages if m.get("content")
                    ]
                    background_tasks.add_task(add_memories_background, user_id, conv)
                    # Also populate the bi-temporal knowledge graph (Graphiti)
                    background_tasks.add_task(add_episode,
                        name=f"chat:{user_id[:20]}",
                        content=last_user_msg[:500],
                        source_description="copilot_chat",
                        group_id=user_id,
                    )
            except ImportError:
                pass

            return StreamingResponse(
                relayed_generator() if _thread_id else event_generator(),
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
    from gateway.routes.v1_compat import routers as _v1_routers

    for _r in _v1_routers:
        app.include_router(_r)
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


# ── OpenAI-compatible /v1/chat/completions (for Mem0 + other OpenAI clients) ──
# Mem0's OpenAI client needs a standard /v1/chat/completions endpoint.
# We expose our LiteLLM tier models through this endpoint so Mem0 can use
# tier-fast (DeepSeek) without needing an OPENAI_API_KEY.

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    model: str = "tier-fast"
    messages: list[ChatMessage]
    max_tokens: int = 2000
    temperature: float = 0.1

@app.post("/v1/chat/completions", tags=["openai"])
async def chat_completions(
    req: ChatCompletionRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """OpenAI-compatible chat completions via LiteLLM tier models."""
    try:
        import litellm  # noqa: PLC0415

        settings = get_settings()
        litellm.drop_params = True
        litellm.suppress_debug_info = True

        msgs = [{"role": m.role, "content": m.content} for m in req.messages]
        response = await litellm.acompletion(
            model=req.model,
            messages=msgs,
            max_tokens=req.max_tokens,
            temperature=req.temperature,
            api_base=settings.litellm_base_url,
            api_key=settings.litellm_master_key,
        )
        choice = response.choices[0]
        return {
            "id": response.id,
            "object": "chat.completion",
            "created": getattr(response, "created", 0),
            "model": response.model or req.model,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": choice.message.content or "",
                },
                "finish_reason": choice.finish_reason or "stop",
            }],
            "usage": {
                "prompt_tokens": getattr(response.usage, "prompt_tokens", 0),
                "completion_tokens": getattr(response.usage, "completion_tokens", 0),
                "total_tokens": getattr(response.usage, "total_tokens", 0),
            },
        }
    except Exception as exc:
        _log.exception("v1.chat_completions_error")
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(exc), "type": "server_error"}},
        )


class EmbeddingRequest(BaseModel):
    model: str = "text-embedding-3-small"
    input: str | list[str]

@app.post("/v1/embeddings", tags=["openai"])
async def embeddings(
    req: EmbeddingRequest,
    user: UserContext = Depends(get_current_user),
) -> dict:
    """OpenAI-compatible embeddings endpoint.
    
    When OPENAI_API_KEY is available, proxies to the real OpenAI API.
    Otherwise returns a dummy embedding (zero-vector of 1536 dims) so
    Mem0's add() can complete — facts are stored without semantic search.
    """
    oai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if oai_key:
        from openai import OpenAI  # noqa: PLC0415
        client = OpenAI(api_key=oai_key)
        inputs = req.input if isinstance(req.input, list) else [req.input]
        resp = client.embeddings.create(model=req.model, input=inputs)
        return resp.model_dump()
    # Dummy embedding: 1536-dimensional zero vector.
    inputs = req.input if isinstance(req.input, list) else [req.input]
    dummy = [0.0] * 1536
    return {
        "object": "list",
        "model": req.model,
        "data": [
            {
                "object": "embedding",
                "index": i,
                "embedding": dummy,
            }
            for i in range(len(inputs))
        ],
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    }



# ---------- Copilot models ----------
# Returns the list of models available via the GitHub Copilot SDK.
# The UI at /api/models/all calls this to populate the Copilot SDK model group.
# If GITHUB_TOKEN is not set, returns the static fallback list so the UI still
# works without blocking.

_COPILOT_MODELS_STATIC = [
    {"id": "claude-sonnet-4.6",    "label": "Claude Sonnet 4.6"},
    {"id": "claude-sonnet-4.5",    "label": "Claude Sonnet 4.5"},
    {"id": "claude-haiku-4.5",     "label": "Claude Haiku 4.5"},
    {"id": "claude-opus-4.6",      "label": "Claude Opus 4.6"},
    {"id": "claude-opus-4.6-fast", "label": "Claude Opus 4.6 (fast mode)"},
    {"id": "claude-opus-4.5",      "label": "Claude Opus 4.5"},
    {"id": "gpt-5.4",              "label": "GPT-5.4"},
    {"id": "gpt-5-mini",           "label": "GPT-5 mini"},
]

import time as _time

_copilot_models_cache: dict = {"data": None, "ts": 0.0}
_COPILOT_MODELS_CACHE_TTL = 300


@app.get("/copilot/models", tags=["copilot"])
async def copilot_models() -> dict:
    """Return Copilot SDK models with 5-min TTL cache."""
    _now = _time.monotonic()
    if _copilot_models_cache["data"] is not None and (_now - _copilot_models_cache["ts"]) < _COPILOT_MODELS_CACHE_TTL:
        return _copilot_models_cache["data"]
    settings = get_settings()
    github_token: str = (
        os.environ.get("COPILOT_GITHUB_TOKEN", "")
        or getattr(settings, "github_token", "")
        or os.environ.get("GITHUB_TOKEN", "")
    )
    if github_token:
        try:
            os.environ.setdefault("GITHUB_TOKEN", github_token)
            from copilot import CopilotClient  # noqa: PLC0415
            _sdk = CopilotClient(options={"github_token": github_token})
            await _sdk.start()
            try:
                _models = await _sdk.list_models()
            finally:
                await _sdk.stop()
            if _models:
                result = {
                    "models": [{"id": m.id, "label": m.name, "model_picker_enabled": True}
                               for m in _models if not m.policy or m.policy.state == "enabled"],
                    "source": "live",
                }
                _copilot_models_cache["data"] = result
                _copilot_models_cache["ts"] = _now
                return result
        except Exception as _e:  # noqa: BLE001
            _log.warning("gateway.copilot_models_failed", error=str(_e))
    static = {"models": [dict(m, model_picker_enabled=False) for m in _COPILOT_MODELS_STATIC], "source": "static"}
    _copilot_models_cache["data"] = static
    _copilot_models_cache["ts"] = _now - (_COPILOT_MODELS_CACHE_TTL - 30)
    return static


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

    from acb_llm.guardrails import \
        CITATION_RE  # local import to avoid cold-start cost

    trace_id = uuid.uuid4().hex
    user_id: str = req.user_email or getattr(_user, "email", "") or "anonymous"
    _log.info("pull.received", query=req.query, user=user_id, trace_id=trace_id)
    try:
        from orchestrator.agents import (build_orchestrator_agent,
                                         enrich_instructions_with_memory)
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
        from acb_memory import (add_episode,  # noqa: PLC0415
                                add_memories_background)
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
