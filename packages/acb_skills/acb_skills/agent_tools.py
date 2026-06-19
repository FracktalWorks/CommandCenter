"""Agent delegation tools — auto-injected into every loaded agent.

Any MAF agent or GitHub Copilot SDK agent running through CommandCenter can
call another registered agent as a sub-task without any changes to the agent
repo itself. The tools are injected by the executor at load time.

Agent repos can also import them explicitly if they want to declare them in
their build_agents() signature for type-checking or documentation:

    from acb_skills.agent_tools import call_agent, call_agents_parallel, call_agent_background

Tools
-----
call_agent(agent_name, message) -> str
    Delegate a sub-task to another agent; awaits the full response (sequential).
    Use this when you need the result before continuing.

call_agents_parallel(tasks) -> str
    Run multiple agents concurrently and return all results (parallel fan-out).
    All sub-agents stream live into the parent ThinkingContainer simultaneously.
    tasks is a JSON array of {"agent": "name", "message": "..."} objects.

call_agent_background(agent_name, message) -> str
    Fire-and-forget delegation; returns immediately with the run_id.
    Use this when you want to trigger parallel work without blocking.
"""
from __future__ import annotations

import asyncio
import json as _json
import uuid as _uuid


async def call_agent(agent_name: str, message: str) -> str:
    """Delegate a sub-task to another CommandCenter agent and return its response.

    Runs the target agent synchronously and awaits the full result. Use this
    when your current task depends on the sub-agent's output before continuing.

    When an active parent SSE stream exists (i.e. called from within a tool
    dispatch during run_agent_stream), the sub-agent's tokens, tool calls, and
    tool results are forwarded to the parent stream as SUB_AGENT_* events so
    the UI shows the sub-agent working in real time.

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

    # If there is an active parent SSE queue (set by run_agent_stream via ContextVar),
    # stream sub-agent events through it so the UI shows progress in real time.
    event_queue = None
    try:
        from orchestrator.executor import _active_run_queue  # noqa: PLC0415
        event_queue = _active_run_queue.get(None)
    except (ImportError, Exception):  # noqa: BLE001
        pass

    if event_queue is not None:
        try:
            from orchestrator.executor import _run_sub_agent_streaming  # noqa: PLC0415
            return await _run_sub_agent_streaming(agent_name, message, run_id, event_queue)
        except Exception as exc:  # noqa: BLE001
            return f"Sub-task to {agent_name!r} failed: {exc}"

    # No active queue — try Redis relay (Tier 1 / Tier 1.5 / Copilot SDK).
    # Push SUB_AGENT_* events directly to the Redis stream so the frontend
    # subscriber receives them in real time (same pattern as ask_questions Path C).
    try:
        from orchestrator.executor import (  # noqa: PLC0415
            _stream_relay_thread_id,
            _run_sub_agent_streaming,
        )
        _relay_tid = _stream_relay_thread_id.get(None)
        if _relay_tid:
            return await _run_sub_agent_streaming(agent_name, message, run_id, None)
    except (ImportError, Exception):  # noqa: BLE001
        pass

    # Fallback: no active stream — batch path (background runs, webhooks, etc.)
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


async def call_agents_parallel(tasks: str) -> str:
    """Run multiple agents concurrently and return all results once every agent finishes.

    All sub-agents start at the same time (true fan-out). Each agent streams its tokens
    and tool calls live into the parent ThinkingContainer simultaneously — you will see
    multiple sub-agent panels updating in parallel.

    Use this when you need results from several independent agents before you can
    synthesise a final answer. For example:
      - Fetch deal pipeline from sales agent + overdue tasks from task agent at the same time
      - Gather customer health, reconciliation status, and billing simultaneously

    Args:
        tasks: JSON array of objects, each with "agent" and "message" keys.
               Example:
               [
                 {"agent": "agent-sales-assistant", "message": "Find all deals in Awaiting PO"},
                 {"agent": "task-manager", "message": "List overdue tasks this sprint"}
               ]

    Returns:
        A combined result block with each agent's name and response:
            [agent-sales-assistant]
            <response>

            [task-manager]
            <response>

    Notes:
        - Each agent runs in its own async task; they don't share state.
        - If one agent fails, its error is included in the output and the others continue.
        - Maximum 5 agents per call to avoid overloading the system.
    """
    try:
        task_list = _json.loads(tasks) if isinstance(tasks, str) else tasks
    except Exception:  # noqa: BLE001
        return "Error: tasks must be a JSON array like [{\"agent\": \"name\", \"message\": \"...\"}]"

    if not isinstance(task_list, list) or len(task_list) == 0:
        return "Error: tasks must be a non-empty JSON array"

    task_list = task_list[:5]  # hard cap

    event_queue = None
    _run_sub_agent_streaming = None
    try:
        from orchestrator.executor import _active_run_queue, _run_sub_agent_streaming as _rss  # noqa: PLC0415
        event_queue = _active_run_queue.get(None)
        _run_sub_agent_streaming = _rss
    except (ImportError, Exception):  # noqa: BLE001
        pass

    # Redis relay fallback (Tier 1 / Tier 1.5) when no queue is available.
    _relay_tid = None
    if event_queue is None:
        try:
            from orchestrator.executor import (  # noqa: PLC0415
                _stream_relay_thread_id,
                _run_sub_agent_streaming as _rss_relay,
            )
            _relay_tid = _stream_relay_thread_id.get(None)
            if _relay_tid:
                _run_sub_agent_streaming = _rss_relay
        except (ImportError, Exception):  # noqa: BLE001
            pass

    async def _run_one(agent_name: str, message: str) -> tuple[str, str]:
        run_id = str(_uuid.uuid4())
        # Use streaming path if we have either a queue (Tier 2) or
        # Redis relay (Tier 1 / Tier 1.5).  Pass event_queue=None
        # for the relay path — _run_sub_agent_streaming will push
        # events directly to Redis.
        if _run_sub_agent_streaming is not None:
            try:
                _q = event_queue if event_queue is not None else None
                result = await _run_sub_agent_streaming(
                    agent_name, message, run_id, _q)
                return agent_name, result
            except Exception as exc:  # noqa: BLE001
                return agent_name, f"Sub-task failed: {exc}"
        # Fallback: no parent stream
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
            return agent_name, str(text) if text else f"({agent_name!r} returned empty)"
        except Exception as exc:  # noqa: BLE001
            return agent_name, f"Sub-task failed: {exc}"

    coros = [
        _run_one(str(t.get("agent", "")), str(t.get("message", "")))
        for t in task_list
        if t.get("agent") and t.get("message")
    ]
    if not coros:
        return "Error: each task must have 'agent' and 'message' fields"

    results = await asyncio.gather(*coros, return_exceptions=False)

    parts = []
    for agent_name, response in results:
        parts.append(f"[{agent_name}]\n{response}")
    return "\n\n".join(parts)


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
