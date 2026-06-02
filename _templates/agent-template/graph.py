"""{{ agent_name }} — LangGraph StateGraph definition.

Every agent repo MUST export a zero-argument ``build_graph()`` function that
returns a ``StateGraph`` (not yet compiled).  The Core executor compiles it
with a ``PostgresSaver`` checkpointer so do not call ``.compile()`` here.

Quickstart
----------
1. Replace the placeholder nodes with your real logic.
2. Add any ``skill_repos`` your nodes depend on to ``config.json``.
3. Keep ``build_graph()`` free of side-effects (it may be called multiple
   times during a single execution in retry scenarios).
"""
from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph


# ---------------------------------------------------------------------------
# State definition
# ---------------------------------------------------------------------------

class AgentState(TypedDict):
    """Shared mutable state threaded through every node."""
    agent_name: str
    run_id: str
    event_payload: dict[str, Any]
    mutation_attempts: int
    error: str | None
    result: Any | None


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------

async def process_node(state: AgentState) -> dict[str, Any]:
    """Main processing node — replace with real business logic."""
    payload = state["event_payload"]

    # TODO: implement agent logic here
    result = {"message": "Agent ran successfully", "echo": payload}

    return {"result": result}


# ---------------------------------------------------------------------------
# Graph factory
# ---------------------------------------------------------------------------

def build_graph() -> StateGraph:
    """Build and return the agent's StateGraph.

    Called by the Core executor at event time.  Do NOT call .compile() here.
    """
    g = StateGraph(AgentState)

    g.add_node("process", process_node)

    g.add_edge(START, "process")
    g.add_edge("process", END)

    return g
