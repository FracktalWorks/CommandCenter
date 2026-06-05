"""MAF-based orchestrator agent (WBS 0.7 — replaces LangGraph graph.py harness).

Architecture:
    A single MAF ``Agent`` backed by an OpenAI-compatible client pointed at our
    LiteLLM proxy.  Two retrieval tools are registered so the LLM can ground its
    answers in the entity graph (Postgres + pgvector) before responding.

    RedisHistoryProvider is attached on the *operator chat* path only (interactive
    sessions through the Control Plane AG-UI endpoint).  Background event-driven
    runs (webhook → executor) use in-memory AgentSession only.

Exports:
    build_orchestrator_agent(*, with_history: bool = True) -> Agent
    build_agents() -> list[Agent]   ← Dynamic Agent Loader entry point
"""
from __future__ import annotations

import asyncio
from typing import Any

from agent_framework import Agent
from agent_framework.openai import OpenAIChatCompletionClient

from acb_common import get_logger, get_settings
from acb_graph import get_session
from orchestrator.retrieval import format_context, retrieve
from orchestrator.sales_views import sales_context as _sales_context_fn

_log = get_logger("orchestrator.agents")

# ---------------------------------------------------------------------------
# System instructions
# ---------------------------------------------------------------------------

_PULL_INSTRUCTIONS = """\
You are the AI Company Brain Pull agent for Fracktal Works.
Your job is to answer questions about internal company data: projects, tasks, deals, and people.

Rules:
1. Call retrieve_entity_context to search for relevant context BEFORE answering general questions.
2. For sales-domain questions (deal pipeline, customer health, quiet deals, last activity),
   call retrieve_sales_context instead.
3. Every factual claim must end with one or more citation tokens of the form [entity:uuid]
   COPIED EXACTLY from the context returned by the retrieval tools.
   UUIDs are 36 characters including 4 hyphens. Do NOT shorten, abbreviate, or regenerate them.
4. If the context does not contain the answer, say so explicitly and cite the most relevant
   entity you did find.
5. If retrieval returns "(no matching entities found)", answer from general knowledge and say so.
6. Keep answers concise. Use bullet points for lists of items.
7. Never expose raw SQL, internal UUIDs outside of citations, or stack traces to the user.
"""

# ---------------------------------------------------------------------------
# Retrieval tools (sync Postgres calls wrapped in asyncio.to_thread)
# ---------------------------------------------------------------------------

async def retrieve_entity_context(query: str) -> str:
    """Search the entity graph for projects, tasks, deals, and people relevant to the query."""
    def _sync() -> str:
        with get_session() as s:
            hits = retrieve(s, query)
        return format_context(hits) if hits else "(no matching entities found)"
    return await asyncio.to_thread(_sync)


async def retrieve_sales_context(query: str) -> str:
    """Search the sales entity graph for customer 360 summaries and deal pipeline data."""
    def _sync() -> str:
        with get_session() as s:
            hits = _sales_context_fn(s, query)
        return format_context(hits) if hits else "(no matching sales data found)"
    return await asyncio.to_thread(_sync)


# ---------------------------------------------------------------------------
# Agent factory
# ---------------------------------------------------------------------------

def _make_openai_client() -> OpenAIChatCompletionClient:
    """Build an OpenAIChatCompletionClient pointing at our LiteLLM proxy (tier-2 alias)."""
    settings = get_settings()
    return OpenAIChatCompletionClient(
        base_url=f"{settings.litellm_base_url}/v1",
        api_key=settings.litellm_master_key,
        model="tier2-sonnet",
    )


def build_orchestrator_agent(*, with_history: bool = True) -> Agent:
    """Build the core pull Q&A MAF agent.

    Args:
        with_history: Attach ``RedisHistoryProvider`` for multi-turn conversation
                      persistence.  Set ``True`` on the operator chat path (AG-UI
                      endpoint); ``False`` for background event-driven runs where
                      each invocation is a fresh, stateless AgentSession.
    """
    settings = get_settings()

    context_providers = []
    if with_history:
        from agent_framework.redis import RedisHistoryProvider  # noqa: PLC0415
        context_providers.append(
            RedisHistoryProvider(
                source_id="chat_history",
                redis_url=settings.redis_url,
                max_messages=100,
            )
        )

    return Agent(
        client=_make_openai_client(),
        name="orchestrator",
        instructions=_PULL_INSTRUCTIONS,
        tools=[retrieve_entity_context, retrieve_sales_context],
        context_providers=context_providers or None,
    )


def build_agents() -> list[Agent]:
    """Dynamic Agent Loader entry point.  Returns list of MAF agents for this repo."""
    # Background / event-driven path: no Redis history (stateless runs).
    return [build_orchestrator_agent(with_history=False)]


__all__ = ["build_agents", "build_orchestrator_agent", "retrieve_entity_context", "retrieve_sales_context"]
