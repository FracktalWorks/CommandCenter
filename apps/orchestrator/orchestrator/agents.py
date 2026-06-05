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
You are the AI Company Brain orchestrator for Fracktal Works.
Your job is to answer questions about internal company data AND to create or improve
capabilities in the system when asked.

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
8. When the user asks to CREATE, BUILD, ADD, IMPROVE, or FIX any skill, script, capability,
   or automation in the system — call spawn_copilot_agent with a precise task description.
   The Copilot SDK agent will write the code, run tests, commit, and push autonomously.
   Tell the user what was started and that the change will be live on the next run.
9. When the user's request is clearly specialist work that a named agent handles better —
   outbound prospecting, proposal writing, lead scraping (sales-assistant),
   ClickUp task management (task-manager), billing/invoicing (billing) —
   call delegate_to_agent to hand off and relay the result.
   Use your own tools for broad company data questions that span multiple domains.
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


async def spawn_copilot_agent(    task: str,
    agent_name: str = "orchestrator",
    agent_dir: str | None = None,
) -> str:
    """Spawn a GitHub Copilot SDK agent to create or modify code, skills, or scripts.

    Use this tool when the user asks to:
    - Create a new skill or script in an agent repo
    - Add a new capability / automation to an existing agent
    - Fix a bug or improve an existing script
    - Write tests, add documentation, or refactor code
    - Self-improve any part of the system

    The Copilot SDK agent runs in an isolated container with full access to the
    agent's repository, executes the task autonomously (write code, run tests,
    commit, push), and returns a summary of what was done.

    Args:
        task: Natural language description of what to build or fix.
              Be specific: include file paths, function names, inputs/outputs.
        agent_name: Which agent repo to work in (default: current agent).
        agent_dir: Absolute path to the local clone (auto-resolved if omitted).

    Returns:
        Summary of actions taken and files changed.
    """
    import uuid as _uuid  # noqa: PLC0415
    from orchestrator.mutation import _build_telemetry, _run_mutation_sandbox  # noqa: PLC0415

    run_id = str(_uuid.uuid4())
    settings = get_settings()

    # Build a "task" telemetry block — reuse the mutation infrastructure
    # but with a custom prompt describing the desired new capability.
    class _FakeError(Exception):
        pass

    telemetry = _build_telemetry(
        agent_name, run_id, run_id[:8],
        f"ProactiveTask: {task}",
        settings,
        agent_dir=agent_dir,
        incompatibility=False,
    )
    # Override the prompt with a creation-oriented instruction
    telemetry["_task_override"] = task

    # Use a creation prompt instead of a fix prompt
    from orchestrator.mutation import _build_mutation_prompt  # noqa: PLC0415
    original_error = telemetry["error"]
    telemetry["error"] = (
        f"PROACTIVE TASK (not an error):\n{task}\n\n"
        f"Create or modify the code as described. Commit and push when done."
    )

    pr_url, container_id = await _run_mutation_sandbox(
        agent_name, run_id, run_id[:8], telemetry, settings
    )

    telemetry["error"] = original_error  # restore for audit

    if container_id:
        return (
            f"Copilot SDK agent started (container {container_id}). "
            f"Task: {task!r}. "
            f"It will commit and push on completion. "
            f"The next agent run will pick up the changes automatically."
        )
    return (
        f"Could not start Copilot SDK container. "
        f"Task was: {task!r}. "
        f"Check that Docker is running and GITHUB_TOKEN is configured."
    )


async def delegate_to_agent(agent_name: str, message: str) -> str:
    """Delegate a task to a specialist agent and return its response.

    Use this tool when the user's request is clearly in the domain of a specialist agent.
    The specialist agent loads its own system prompt, skills, and tools from its GitHub repo
    and handles the request fully — its response is returned here verbatim.

    When to delegate (examples):
    - Outbound prospecting, lead scraping, Apollo/Google Maps search → "agent-sales-assistant"
    - ClickUp task management, sprint status, workload queries → "task-manager"
    - Billing / invoice queries → "billing"
    - Email / WhatsApp triage → "triage"
    - Nightly reconciliation queries → "reconciler"

    Do NOT delegate:
    - Broad company data questions that span multiple agents (use your own retrieval tools)
    - Questions you can already answer from the entity graph

    Args:
        agent_name: Exact registered name, e.g. "agent-sales-assistant", "task-manager".
        message:    The user's full request, reworded if needed to be self-contained.

    Returns:
        The specialist agent's full response text.
    """
    from orchestrator.executor import AgentRunError, run_agent  # noqa: PLC0415
    import uuid as _uuid  # noqa: PLC0415

    run_id = str(_uuid.uuid4())
    try:
        result = await run_agent(
            agent_name,
            {"message": message, "mode": "chat"},
            run_id=run_id,
        )
        text = result.get("result") or result.get("answer") or ""
        if isinstance(text, dict):
            text = text.get("content", str(text))
        return str(text) if text else "(agent returned empty response)"
    except AgentRunError as exc:
        return f"Agent {agent_name!r} failed: {exc.original}"
    except Exception as exc:  # noqa: BLE001
        return f"Could not reach agent {agent_name!r}: {exc}"


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
        tools=[retrieve_entity_context, retrieve_sales_context, spawn_copilot_agent, delegate_to_agent],
        context_providers=context_providers or None,
    )


def build_agents() -> list[Agent]:
    """Dynamic Agent Loader entry point.  Returns list of MAF agents for this repo."""
    # Background / event-driven path: no Redis history (stateless runs).
    return [build_orchestrator_agent(with_history=False)]


__all__ = ["build_agents", "build_orchestrator_agent", "retrieve_entity_context", "retrieve_sales_context", "spawn_copilot_agent", "delegate_to_agent"]
