"""FastAPI entry point. Run with: uv run uvicorn gateway.main:app --reload"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from pydantic import BaseModel

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
async def pull(req: PullRequest) -> PullResponse:
    """Phase-0 wire: gateway -> pull_agent -> retrieval+LLM+guardrails."""
    from acb_llm.guardrails import CITATION_RE  # local import to avoid cold-start cost

    _log.info("pull.received", query=req.query, user=req.user_email)
    try:
        text = await pull_answer(req.query, user_email=req.user_email)
    except Exception as exc:  # surface upstream errors as 200 with diagnostic text
        _log.exception("pull.failed")
        return PullResponse(answer=f"[agent error] {type(exc).__name__}: {exc}", citations=[])
    citations = sorted({m.group(0) for m in CITATION_RE.finditer(text)})
    return PullResponse(answer=text, citations=citations)


# ---------- Sales Pull (WBS 1.5) ----------

@app.post("/pull/sales", response_model=PullResponse, tags=["pull"])
async def pull_sales(req: PullRequest) -> PullResponse:
    """Sales-flavoured pull: uses customer-360 / quiet-deal context blocks."""
    from acb_llm.guardrails import CITATION_RE

    _log.info("pull.sales.received", query=req.query, user=req.user_email)
    try:
        text = await sales_pull_answer(req.query, user_email=req.user_email)
    except Exception as exc:
        _log.exception("pull.sales.failed")
        return PullResponse(answer=f"[agent error] {type(exc).__name__}: {exc}", citations=[])
    citations = sorted({m.group(0) for m in CITATION_RE.finditer(text)})
    return PullResponse(answer=text, citations=citations)
