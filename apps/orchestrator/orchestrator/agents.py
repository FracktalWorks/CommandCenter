"""MAF-based orchestrator agent (WBS 0.7 — replaces LangGraph graph.py harness).

Architecture:
    A single MAF ``Agent`` backed by our LiteLLM proxy.  Specialist agents from
    registered GitHub repos are exposed as native MAF tools via agent.as_tool(),
    making cross-agent routing automatic and based on each agent's description.

    Dynamic capability registry: at orchestrator build time, all registered
    agents are loaded and exposed as tools. The LLM routes to the right one
    based on the description in each agent's config.json.

    WorkflowBuilder is used for explicit multi-step pipelines (fan-out/fan-in).

Exports:
    build_orchestrator_agent(*, with_history: bool = True) -> Agent
    build_agents() -> list[Agent]   ← Dynamic Agent Loader entry point
"""
from __future__ import annotations

import asyncio
from typing import Any

from agent_framework import Agent, WorkflowBuilder
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

You have two categories of tools:

RETRIEVAL TOOLS (use for broad company data questions):
- retrieve_entity_context: search projects, tasks, deals, people
- retrieve_sales_context: Zoho pipeline, customer health, deal stages

SPECIALIST AGENT TOOLS (use when the request is clearly in one agent's domain):
- Each registered agent appears as a tool named after it (e.g. agent_sales_assistant, task_manager).
- Call the specialist tool and relay its full response.
- If a request spans multiple domains, call multiple specialist tools and synthesise.

CREATION / IMPROVEMENT TOOLS:
- spawn_copilot_agent: when the user asks to CREATE, BUILD, or FIX any skill, script, or automation.
- delegate_to_agent: fallback for explicit named delegation when the specialist tool is unavailable.

Rules:
1. For data questions: call retrieve_entity_context or retrieve_sales_context FIRST.
2. For specialist work: call the matching specialist tool directly — the tool description
   tells you exactly what each agent handles. Do not ask the user which agent to use.
3. For multi-domain requests: call multiple specialist tools concurrently (MAF supports this).
4. For creation tasks: call spawn_copilot_agent with a precise description.
5. Every factual claim from retrieval must cite [entity:uuid] tokens exactly as returned.
6. Never expose raw SQL, internal UUIDs outside of citations, or stack traces.
7. Be concise. Bullet points for lists.
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
# Dynamic capability registry — load all registered agents as MAF tools
# ---------------------------------------------------------------------------

def _load_specialist_agents_as_tools(client: OpenAIChatCompletionClient) -> list[Any]:
    """Load every registered agent as a native MAF tool via agent.as_tool().

    This uses the MAF-native pattern from the GitHub Copilot SDK + MAF docs:
        agent.as_tool(name=..., description=...)
    Each specialist agent's description comes from its config.json, so the
    orchestrator LLM routes to the right agent purely from that description.

    Returns a list of FunctionTool objects ready to pass to Agent(tools=[...]).
    Non-loadable agents are skipped with a warning (orchestrator still starts).
    """
    tools: list[Any] = []
    try:
        from gateway.routes.agent import _AGENT_REGISTRY, _load_dynamic_agents  # noqa: PLC0415
        all_agents = _load_dynamic_agents() + _AGENT_REGISTRY
    except ImportError:
        return tools

    settings = get_settings()
    skip_names = {"orchestrator", "strategy"}  # avoid circular delegation

    for entry in all_agents:
        name: str = entry.get("name", "")
        description: str = entry.get("description", "")
        if not name or name in skip_names or not description:
            continue
        try:
            # Build a minimal MAF Agent for this specialist just to get as_tool()
            specialist = Agent(
                client=client,
                name=name,
                instructions=(
                    f"You are the {name} specialist agent. {description} "
                    f"Execute the task given to you fully and return the result."
                ),
                tools=[delegate_to_agent],  # let it call back if needed
            )
            # Enrich the tool description with tags and integrations from config
            # so the orchestrator LLM can route reliably (per SDK best practices:
            # specific descriptions = better intent matching)
            tags = entry.get("tags", [])
            integrations = entry.get("integrations", [])
            extra = ""
            if tags:
                extra += f" Tags: {', '.join(tags)}."
            if integrations:
                extra += f" Requires: {', '.join(integrations)}."
            tool = specialist.as_tool(
                name=name.replace("-", "_"),
                description=(
                    f"{description}{extra} "
                    f"Use this tool for requests clearly in the domain of {name}. "
                    f"Do not use for broad company-data questions that span multiple agents."
                ),
            )
            tools.append(tool)
            _log.info("orchestrator.specialist_tool_registered", agent=name)
        except Exception as exc:  # noqa: BLE001
            _log.warning("orchestrator.specialist_tool_skipped", agent=name, error=str(exc))

    return tools


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
    """Build the core orchestrator MAF agent with dynamic specialist agent tools.

    Loads every registered agent as a native MAF tool via agent.as_tool().
    The orchestrator LLM sees each specialist's description and routes to the
    right one automatically — no hard-coded routing table needed.
    """
    settings = get_settings()
    client = _make_openai_client()

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

    # Core tools always present
    core_tools: list[Any] = [
        retrieve_entity_context,
        retrieve_sales_context,
        spawn_copilot_agent,
        delegate_to_agent,
    ]

    # Dynamic specialist tools via MAF as_tool() — each registered agent becomes
    # a callable tool. The LLM routes to the right one from the description alone.
    specialist_tools = _load_specialist_agents_as_tools(client)
    all_tools = core_tools + specialist_tools

    _log.info(
        "orchestrator.tools_loaded",
        core=len(core_tools),
        specialist=len(specialist_tools),
        total=len(all_tools),
    )

    return Agent(
        client=client,
        name="orchestrator",
        instructions=_PULL_INSTRUCTIONS,
        tools=all_tools,
        context_providers=context_providers or None,
    )


def build_agents() -> list[Agent]:
    """Dynamic Agent Loader entry point.  Returns list of MAF agents for this repo."""
    # Background / event-driven path: no Redis history (stateless runs).
    return [build_orchestrator_agent(with_history=False)]


__all__ = ["build_agents", "build_orchestrator_agent", "retrieve_entity_context", "retrieve_sales_context", "spawn_copilot_agent", "delegate_to_agent"]
