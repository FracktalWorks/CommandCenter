"""Golden trajectories: sub-agent delegation guards (review P0-7).

Locks the cycle/depth refusal behaviour end-to-end through ``call_agent``:
a refused delegation returns an explanatory string to the calling agent
(never raises, never spawns) so the parent can answer from what it has.
"""
from __future__ import annotations

from acb_skills import agent_tools
from acb_skills.agent_tools import _delegation_chain, _delegation_refusal, call_agent


async def test_cycle_is_refused_end_to_end():
    token = _delegation_chain.set(("agent-sales", "task-manager"))
    try:
        result = await call_agent("agent-sales", "loop back please")
    finally:
        _delegation_chain.reset(token)
    assert "cycle detected" in result
    assert "agent-sales" in result


async def test_depth_limit_is_refused_end_to_end(monkeypatch):
    monkeypatch.setattr(agent_tools, "_MAX_DELEGATION_DEPTH", 2)
    token = _delegation_chain.set(("a", "b"))
    try:
        result = await call_agent("c", "one level too deep")
    finally:
        _delegation_chain.reset(token)
    assert "max delegation depth" in result


def test_fresh_delegation_is_allowed():
    token = _delegation_chain.set(("root-agent",))
    try:
        assert _delegation_refusal("task-manager") is None
    finally:
        _delegation_chain.reset(token)
