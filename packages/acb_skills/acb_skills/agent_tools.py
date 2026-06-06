"""Agent delegation tools — auto-injected into every loaded agent.

Any MAF agent or GitHub Copilot SDK agent running through CommandCenter can
call another registered agent as a sub-task without any changes to the agent
repo itself. The tools are injected by the executor at load time.

Agent repos can also import them explicitly if they want to declare them in
their build_agents() signature for type-checking or documentation:

    from acb_skills.agent_tools import call_agent, call_agent_background

Tools
-----
call_agent(agent_name, message) -> str
    Delegate a sub-task to another agent; awaits the full response (sequential).
    Use this when you need the result before continuing.

call_agent_background(agent_name, message) -> str
    Fire-and-forget delegation; returns immediately with the run_id.
    Use this when you want to trigger parallel work without blocking.
"""
from __future__ import annotations

import asyncio
import uuid as _uuid


async def call_agent(agent_name: str, message: str) -> str:
    """Delegate a sub-task to another CommandCenter agent and return its response.

    Runs the target agent synchronously and awaits the full result. Use this
    when your current task depends on the sub-agent's output before continuing.

    Available agents are registered in CommandCenter via the /agents UI page.
    Common agents: "task-manager", "agent-sales-assistant", "agent-triage",
    "agent-reconciler", "agent-delivery", or any custom agent you have added.

    Args:
        agent_name: Exact registered name of the target agent.
                    Examples: "task-manager", "agent-sales-assistant"
        message:    The full request to send to the agent, written as a
                    self-contained task. Include all context needed — the
                    sub-agent does not share your conversation history.

    Returns:
        The agent's response text.
        Returns an error description (not raises) if the agent fails, so
        you can handle partial failures gracefully.

    Example:
        tasks = await call_agent(
            "task-manager",
            "List all overdue tasks assigned to the engineering team this sprint"
        )
        deals = await call_agent(
            "agent-sales-assistant",
            "Find all deals in the Awaiting PO stage and summarise the blockers"
        )
    """
    run_id = str(_uuid.uuid4())
    try:
        from orchestrator.executor import run_agent  # noqa: PLC0415
        result = await run_agent(
            agent_name,
            {"message": message, "mode": "sub_task"},
            run_id=run_id,
        )
        text = result.get("result") or result.get("answer") or ""
        if isinstance(text, dict):
            text = text.get("content", str(text))
        return str(text) if text else f"({agent_name!r} returned an empty response)"
    except Exception as exc:  # noqa: BLE001
        return f"Sub-task to {agent_name!r} failed: {exc}"


async def call_agent_background(agent_name: str, message: str) -> str:
    """Dispatch a sub-task to another agent without waiting for the result.

    Returns immediately. The target agent runs concurrently as a background
    asyncio task. Use this when you want to trigger parallel work — for
    example kicking off a reconciliation run while you continue drafting a
    report. Use call_agent() instead when you need the result.

    Args:
        agent_name: Exact registered name of the target agent.
        message:    Self-contained task description for the target agent.

    Returns:
        Confirmation message with the background run_id so you can reference
        the run later (e.g. in the /inbox HITL queue).

    Example:
        await call_agent_background(
            "agent-reconciler",
            "Run the nightly diff for the engineering team and escalate any blockers"
        )
    """
    run_id = str(_uuid.uuid4())
    try:
        from orchestrator.executor import run_agent  # noqa: PLC0415
        asyncio.create_task(
            run_agent(
                agent_name,
                {"message": message, "mode": "background_sub_task"},
                run_id=run_id,
            )
        )
        return (
            f"Dispatched sub-task to {agent_name!r} in the background "
            f"(run_id: {run_id}). It is running independently — check "
            f"/inbox for the result."
        )
    except Exception as exc:  # noqa: BLE001
        return f"Failed to dispatch sub-task to {agent_name!r}: {exc}"
