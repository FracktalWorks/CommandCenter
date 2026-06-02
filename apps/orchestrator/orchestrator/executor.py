"""Agent executor — runs a dynamically loaded agent's LangGraph StateGraph.

Flow (ADR-013, ADR-016, ADR-018):

1. Delegate to :func:`load_agent` to clone repos + import ``graph.py``.
2. Call ``loaded.build_graph()`` to get the agent's ``StateGraph``.
3. Compile it with a ``PostgresSaver`` checkpointer (durable state, ADR-001).
4. ``ainvoke`` the compiled graph with the event payload.
5. On any unhandled exception, call :func:`~orchestrator.mutation.attempt_self_mutation`
   (ADR-006, ADR-021) which enforces ``max_mutation_attempts = 1``.
6. Cleanup happens in the :class:`~acb_skills.loader.LoadedAgent` context manager.

Usage::

    from orchestrator.executor import run_agent

    result = await run_agent("task-manager", {"clickup_event": {...}})
"""
from __future__ import annotations

import uuid
from typing import Any

from acb_audit import AuditEvent, record
from acb_common import get_logger, get_settings
from acb_skills.loader import AgentLoadError, load_agent

_log = get_logger("orchestrator.executor")


class AgentRunError(Exception):
    """Raised after an agent run fails (mutation already attempted if applicable)."""

    def __init__(
        self,
        message: str,
        *,
        agent_name: str,
        run_id: str,
        original: Exception,
        mutation_pr: str | None = None,
    ) -> None:
        super().__init__(message)
        self.agent_name = agent_name
        self.run_id = run_id
        self.original = original
        self.mutation_pr = mutation_pr


async def run_agent(
    agent_name: str,
    event_payload: dict[str, Any],
    *,
    run_id: str | None = None,
    thread_id: str | None = None,
) -> dict[str, Any]:
    """Dynamically load and execute a named agent.

    Args:
        agent_name:    Bare agent name, e.g. ``"task-manager"``.
        event_payload: Arbitrary event data injected as the initial state.
        run_id:        Unique execution ID (auto-generated if ``None``).
        thread_id:     LangGraph checkpoint thread ID (defaults to
                       ``"{agent_name}:{run_id}"``).

    Returns:
        The final LangGraph state dict.

    Raises:
        :class:`AgentRunError` on failure (includes mutation PR URL if one was opened).
    """
    settings = get_settings()
    run_id = run_id or str(uuid.uuid4())
    thread_id = thread_id or f"{agent_name}:{run_id}"

    record(
        AuditEvent(
            actor="system:gateway",
            action="agent_run_start",
            target=f"agent:{agent_name}",
            payload={"run_id": run_id, "event_keys": list(event_payload.keys())},
        )
    )

    try:
        _agent_dir: str | None = None
        with load_agent(agent_name, run_id=run_id) as loaded:
            _agent_dir = str(loaded.agent_dir)
            graph = loaded.build_graph()
            final_state = await _execute_graph(
                graph,
                agent_name=agent_name,
                run_id=run_id,
                thread_id=thread_id,
                event_payload=event_payload,
                database_url=settings.database_url,
            )

        record(
            AuditEvent(
                actor=f"agent:{agent_name}",
                action="agent_run_complete",
                target=f"agent:{agent_name}",
                payload={
                    "run_id": run_id,
                    "result_keys": list(final_state.keys()),
                },
            )
        )
        return final_state

    except AgentLoadError as exc:
        _log.error("executor.load_error", agent=agent_name, run_id=run_id, error=str(exc))
        record(
            AuditEvent(
                actor="system:executor",
                action="agent_load_error",
                target=f"agent:{agent_name}",
                payload={"run_id": run_id, "error": str(exc)},
            )
        )
        raise AgentRunError(
            str(exc),
            agent_name=agent_name,
            run_id=run_id,
            original=exc,
        ) from exc

    except Exception as exc:
        _log.error("executor.run_error", agent=agent_name, run_id=run_id, error=str(exc))

        # Attempt self-mutation (max 1 attempt per failure, ADR-021)
        from orchestrator.mutation import attempt_self_mutation  # noqa: PLC0415

        mutation_result = await attempt_self_mutation(
            agent_name=agent_name,
            run_id=run_id,
            error=exc,
            agent_dir=_agent_dir,  # pass persistent clone path for authenticated push
        )
        pr_url = mutation_result.pr_url if mutation_result else None

        record(
            AuditEvent(
                actor=f"agent:{agent_name}",
                action="agent_run_error",
                target=f"agent:{agent_name}",
                payload={
                    "run_id": run_id,
                    "error": str(exc),
                    "mutation_pr": pr_url,
                },
            )
        )
        raise AgentRunError(
            str(exc),
            agent_name=agent_name,
            run_id=run_id,
            original=exc,
            mutation_pr=pr_url,
        ) from exc


# ---------------------------------------------------------------------------
# Internal: compile + run the graph against PostgresSaver
# ---------------------------------------------------------------------------

async def _execute_graph(
    graph: Any,
    *,
    agent_name: str,
    run_id: str,
    thread_id: str,
    event_payload: dict[str, Any],
    database_url: str,
) -> dict[str, Any]:
    """Compile *graph* with a PostgresSaver checkpointer and invoke it."""
    try:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver  # noqa: PLC0415
    except ImportError:
        # Graceful fallback: run without persistence if the package isn't installed.
        # This lets the gateway stay bootable in environments without Postgres.
        _log.warning(
            "executor.no_postgres_saver",
            hint="Install langgraph-checkpoint-postgres for durable state.",
        )
        compiled = graph.compile()
        config = {"configurable": {"thread_id": thread_id}}
        return await compiled.ainvoke(
            _build_initial_state(agent_name, run_id, event_payload),
            config=config,
        )

    async with await AsyncPostgresSaver.from_conn_string(database_url) as checkpointer:
        await checkpointer.setup()  # creates tables if they don't exist
        compiled = graph.compile(checkpointer=checkpointer)
        config = {"configurable": {"thread_id": thread_id}}
        return await compiled.ainvoke(
            _build_initial_state(agent_name, run_id, event_payload),
            config=config,
        )


def _build_initial_state(
    agent_name: str,
    run_id: str,
    event_payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "agent_name": agent_name,
        "run_id": run_id,
        "event_payload": event_payload,
        "mutation_attempts": 0,
        "error": None,
        "result": None,
    }
