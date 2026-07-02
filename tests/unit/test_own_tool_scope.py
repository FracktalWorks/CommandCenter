"""Unit tests for own_tool_scope filtering of agent-baked tools (HH-5).

``tool_scope`` filters which PLATFORM tools the executor injects;
``own_tool_scope`` (config.json) is its counterpart for tools the agent repo
ships itself — previously an agent baking 60+ tools (email-assistant) could
not be narrowed per deployment.
"""
from __future__ import annotations

from types import SimpleNamespace

from orchestrator.executor import _apply_own_tool_scope, _tool_name


def _fn(name: str):
    def tool():  # pragma: no cover - never called
        return None
    tool.__name__ = name
    return tool


def test_filters_maf_agent_tools_in_place():
    agent = SimpleNamespace(name="email-assistant",
                            tools=[_fn("read_email"), _fn("send_email"),
                                   _fn("get_digest")])
    _apply_own_tool_scope([agent], ["read_email", "get_digest"])
    assert [_tool_name(t) for t in agent.tools] == ["read_email", "get_digest"]


def test_filters_copilot_private_tools_list():
    agent = SimpleNamespace(name="x", _tools=[_fn("a"), _fn("b")], tools=[])
    _apply_own_tool_scope([agent], ["b"])
    assert [_tool_name(t) for t in agent._tools] == ["b"]


def test_no_match_keeps_all_tools():
    tools = [_fn("a"), _fn("b")]
    agent = SimpleNamespace(name="x", tools=list(tools))
    _apply_own_tool_scope([agent], ["nonexistent"])
    assert len(agent.tools) == 2  # fail open, mirrors tool_scope semantics


def test_none_scope_is_a_no_op():
    agent = SimpleNamespace(name="x", tools=[_fn("a")])
    _apply_own_tool_scope([agent], None)
    assert len(agent.tools) == 1


def test_tool_name_handles_wrappers_and_dicts():
    assert _tool_name(_fn("plain")) == "plain"
    assert _tool_name(SimpleNamespace(name="ai_function")) == "ai_function"
    assert _tool_name({"function": {"name": "dict_spec"}}) == "dict_spec"
    assert _tool_name({"name": "flat_dict"}) == "flat_dict"
    assert _tool_name(object()) == ""
