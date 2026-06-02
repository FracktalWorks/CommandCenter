"""FastAPI entry point. Run with: uv run uvicorn gateway.main:app --reload"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import Depends, FastAPI
from pydantic import BaseModel

from acb_auth import UserContext, get_current_user, require_role, UserRole
from acb_common import configure_logging, get_logger, get_settings
from orchestrator.agents.pull_agent import answer as pull_answer
from orchestrator.agents.sales_pull_agent import answer as sales_pull_answer

_log = get_logger("gateway")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)
    _log.info("gateway.startup", env=settings.acb_env)
    yield
    _log.info("gateway.shutdown")


app = FastAPI(
    title="AI Company Brain — Gateway",
    version="0.0.1",
    description="Pull queries, push notifications, approvals. See ai-company-brain/system_architecture.md §3.",
    lifespan=lifespan,
)

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
    from ingestion.sources.outlook.webhook import router as _outlook_router

    app.include_router(_outlook_router)
except Exception:  # pragma: no cover
    pass


# ---------- Health ----------

class Health(BaseModel):
    status: str
    env: str


@app.get("/health", response_model=Health, tags=["meta"])
async def health() -> Health:
    return Health(status="ok", env=get_settings().acb_env)


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
    """Phase-0 wire: gateway -> pull_agent -> retrieval+LLM+guardrails."""
    from acb_llm.guardrails import CITATION_RE  # local import to avoid cold-start cost
    import uuid

    trace_id = uuid.uuid4().hex
    _log.info("pull.received", query=req.query, user=req.user_email, trace_id=trace_id)
    try:
        text = await pull_answer(req.query, user_email=req.user_email, trace_id=trace_id)
    except Exception as exc:  # surface upstream errors as 200 with diagnostic text
        _log.exception("pull.failed", trace_id=trace_id)
        return PullResponse(
            answer=f"[agent error] {type(exc).__name__}: {exc}", citations=[], trace_id=trace_id
        )
    citations = sorted({m.group(0) for m in CITATION_RE.finditer(text)})
    return PullResponse(answer=text, citations=citations, trace_id=trace_id)


# ---------- Act mode (Phase 0.5 — write-back actuators) ---------------------
#
# Every endpoint MUTATES an external system. Auth is mandatory; the actor
# email lands in the audit log. Each handler is a thin adapter — real work
# (HTTP call + audit + graph refresh) lives in `orchestrator.actions.*`.

class ActResponse(BaseModel):
    ok: bool
    summary: str
    target: str
    trace_id: str | None = None


class ClickUpUpdateTaskRequest(BaseModel):
    clickup_task_id: str          # ClickUp's native task id (e.g. "abc1234")
    status: str                   # e.g. "in progress", "complete"
    note: str | None = None       # free-text reason, stored only in audit


class ClickUpAddCommentRequest(BaseModel):
    clickup_task_id: str
    comment_text: str
    notify_all: bool = False


@app.post(
    "/act/clickup/update-task",
    response_model=ActResponse,
    tags=["act"],
)
async def act_clickup_update_task(
    req: ClickUpUpdateTaskRequest,
    user: UserContext = Depends(get_current_user),
) -> ActResponse:
    from orchestrator.actions.clickup import ActionError, update_task_status
    import uuid

    trace_id = uuid.uuid4().hex
    _log.info("act.clickup.update_task", task=req.clickup_task_id, status=req.status,
              actor=user.email, trace_id=trace_id)
    try:
        result = await update_task_status(
            actor_email=user.email,
            clickup_task_id=req.clickup_task_id,
            status=req.status,
            note=req.note,
        )
    except ActionError as exc:
        return ActResponse(ok=False, summary=str(exc),
                           target=f"clickup:task:{req.clickup_task_id}", trace_id=trace_id)
    return ActResponse(ok=result.ok, summary=result.summary,
                       target=result.target, trace_id=trace_id)


@app.post(
    "/act/clickup/add-comment",
    response_model=ActResponse,
    tags=["act"],
)
async def act_clickup_add_comment(
    req: ClickUpAddCommentRequest,
    user: UserContext = Depends(get_current_user),
) -> ActResponse:
    from orchestrator.actions.clickup import ActionError, add_task_comment
    import uuid

    trace_id = uuid.uuid4().hex
    _log.info("act.clickup.add_comment", task=req.clickup_task_id,
              actor=user.email, trace_id=trace_id)
    try:
        result = await add_task_comment(
            actor_email=user.email,
            clickup_task_id=req.clickup_task_id,
            comment_text=req.comment_text,
            notify_all=req.notify_all,
        )
    except ActionError as exc:
        return ActResponse(ok=False, summary=str(exc),
                           target=f"clickup:task:{req.clickup_task_id}", trace_id=trace_id)
    return ActResponse(ok=result.ok, summary=result.summary,
                       target=result.target, trace_id=trace_id)


# ---------- Sales Pull (WBS 1.5) ----------

@app.post("/pull/sales", response_model=PullResponse, tags=["pull"],
          dependencies=[require_role(UserRole.EXECUTIVE)])
async def pull_sales(req: PullRequest) -> PullResponse:
    """Sales-flavoured pull: uses customer-360 / quiet-deal context blocks."""
    from acb_llm.guardrails import CITATION_RE
    import uuid

    trace_id = uuid.uuid4().hex
    _log.info("pull.sales.received", query=req.query, user=req.user_email, trace_id=trace_id)
    try:
        text = await sales_pull_answer(req.query, user_email=req.user_email, trace_id=trace_id)
    except Exception as exc:
        _log.exception("pull.sales.failed", trace_id=trace_id)
        return PullResponse(
            answer=f"[agent error] {type(exc).__name__}: {exc}", citations=[], trace_id=trace_id
        )
    citations = sorted({m.group(0) for m in CITATION_RE.finditer(text)})
    return PullResponse(answer=text, citations=citations, trace_id=trace_id)
