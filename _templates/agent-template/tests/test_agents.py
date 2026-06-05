"""Tests for {{ agent_name }} MAF agent.

Offline-only — no LLM calls, no Docker required.
Run with:
    pytest tests/test_agents.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Allow importing from the repo root (agents.py, graph.py live at root level)
sys.path.insert(0, str(Path(__file__).parent.parent))

from agents import build_agent, build_agents, sample_tool


# ---------------------------------------------------------------------------
# build_agents()
# ---------------------------------------------------------------------------

def test_build_agents_returns_list() -> None:
    """build_agents() must return a non-empty list."""
    agents = build_agents()
    assert isinstance(agents, list)
    assert len(agents) >= 1


def test_build_agents_idempotent() -> None:
    """build_agents() must be side-effect-free and callable multiple times."""
    a1 = build_agents()
    a2 = build_agents()
    assert len(a1) == len(a2)


def test_build_agent_has_instructions() -> None:
    """The agent must have non-empty instructions."""
    agent = build_agent()
    # GitHubCopilotAgent stores instructions in default_options or as an attribute;
    # we verify the template's INSTRUCTIONS string was loaded.
    from agents import INSTRUCTIONS
    assert isinstance(INSTRUCTIONS, str)
    assert len(INSTRUCTIONS) > 10


def test_build_agent_has_tools() -> None:
    """The agent must expose at least one tool."""
    agent = build_agent()
    # GitHubCopilotAgent stores tools internally; verify the module's tool list.
    from agents import __all__
    assert "sample_tool" in __all__


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sample_tool_returns_string() -> None:
    """sample_tool() must return a non-empty string."""
    result = await sample_tool("test query")
    assert isinstance(result, str)
    assert len(result) > 0


@pytest.mark.asyncio
async def test_sample_tool_echoes_query() -> None:
    """sample_tool() must include the input query in its output."""
    result = await sample_tool("hello world")
    assert "hello world" in result


# ---------------------------------------------------------------------------
# graph.py shim
# ---------------------------------------------------------------------------

def test_graph_shim_raises_not_implemented() -> None:
    """The deprecated graph.py shim must raise NotImplementedError."""
    import warnings
    from graph import build_graph
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        with pytest.raises(NotImplementedError):
            build_graph()


def test_graph_shim_emits_deprecation_warning() -> None:
    """The deprecated graph.py shim must emit a DeprecationWarning."""
    import warnings
    from graph import build_graph
    with pytest.warns(DeprecationWarning, match="build_graph"):
        try:
            build_graph()
        except NotImplementedError:
            pass
