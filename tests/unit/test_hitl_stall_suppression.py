"""Regression tests for the disappearing HITL question cards.

Root cause (two layers, same 5-minute fuse):
  1. CommandCenterCopilotAgent._stream_updates raised "session stalled" after
     COPILOT_STREAM_STALL_TIMEOUT (300s) of silence — but a blocking
     ask_user/ask_questions parks the run on a Future while the HUMAN answers,
     which is legitimate silence. The killed run emitted RUN_FINISHED and the
     frontend cleared the question card without input.
  2. The Tier-2 batch shim bounded every async tool with
     COPILOT_TOOL_TIMEOUT_SECONDS (300s) — cancelling a parked HITL tool
     mid-question.

Fixes: the stall detector suppresses while executor._pending_user_input is
non-empty (up to HITL_IDLE_TIMEOUT_SECONDS), and the HITL tools joined
call_agent on the per-tool-timeout exemption list.
"""
from __future__ import annotations

import asyncio

import pytest
from orchestrator import copilot_agent, executor


def test_hitl_pending_reflects_executor_registry():
    executor._pending_user_input.clear()
    assert copilot_agent._hitl_pending() is False
    fut: asyncio.Future = asyncio.get_event_loop_policy().new_event_loop().create_future()
    try:
        executor._pending_user_input["req-1"] = fut
        assert copilot_agent._hitl_pending() is True
    finally:
        executor._pending_user_input.clear()


def test_hitl_stall_budget_defaults_to_an_hour():
    # The suppression budget must dwarf the 5-min stall fuse, matching the
    # native-MAF tiered watchdog's HITL budget.
    assert copilot_agent._HITL_STALL_TIMEOUT >= 3600
    assert copilot_agent._HITL_STALL_TIMEOUT > copilot_agent._STREAM_STALL_TIMEOUT


@pytest.mark.asyncio
async def test_tier2_shim_exempts_hitl_tools_from_per_tool_timeout():
    # Source-level guard: the exemption branch must cover the blocking HITL
    # tools, not just call_agent (regression: they were cancelled at 300s).
    import inspect
    src = inspect.getsource(executor)
    for name in ("ask_questions", "ask_user", "request_confirmation"):
        assert f'"{name}"' in src, f"{name} missing from per-tool timeout exemption"
