"""Tests for {{ agent_name }} graph.

Run with:
    pytest tests/test_graph.py -v
"""
from __future__ import annotations

import pytest

from graph import AgentState, build_graph


@pytest.fixture
def sample_state() -> AgentState:
    return AgentState(
        agent_name="{{ agent_name }}",
        run_id="test-run-001",
        event_payload={"test_key": "test_value"},
        mutation_attempts=0,
        error=None,
        result=None,
    )


@pytest.mark.asyncio
async def test_build_graph_returns_state_graph() -> None:
    """build_graph() must return a StateGraph (not compiled)."""
    from langgraph.graph import StateGraph

    g = build_graph()
    assert isinstance(g, StateGraph)


@pytest.mark.asyncio
async def test_graph_compiles_without_checkpointer() -> None:
    """Graph must compile without a checkpointer (for unit tests)."""
    g = build_graph()
    compiled = g.compile()
    assert compiled is not None


@pytest.mark.asyncio
async def test_graph_produces_result(sample_state: AgentState) -> None:
    """Full graph invocation should populate state['result']."""
    g = build_graph()
    compiled = g.compile()
    final = await compiled.ainvoke(dict(sample_state))
    assert final["result"] is not None
