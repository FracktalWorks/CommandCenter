"""Regression tests — chat-stack hardening batch 1 (review P0-1/2/4/5, P1-8).

See ai-company-brain/specs/chat_implementation_review_2026-07.md.
"""
from __future__ import annotations

import inspect
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

REPO = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_push_event_refreshes_active_flag_without_resurrecting():
    """P0-2: every push refreshes cc:active TTL — but only when it still
    exists (xx=True), so a cancelled run isn't marked active again."""
    from orchestrator import stream_relay

    r = MagicMock()
    r.xadd = AsyncMock(return_value="1-1")
    r.expire = AsyncMock()
    r.set = AsyncMock()
    with patch.object(stream_relay, "_get_client", AsyncMock(return_value=r)):
        await stream_relay.push_event("t1", {"type": "X"})
    r.set.assert_awaited_once()
    _, kwargs = r.set.await_args
    assert kwargs.get("xx") is True, "active refresh must not resurrect a finished run"
    assert kwargs.get("ex") == stream_relay.STREAM_TTL_SECONDS


def test_reconnect_endpoint_enforces_thread_ownership():
    """P0-1: the replayed stream is the whole conversation — reconnect must
    apply the same owner guard as cancel."""
    from gateway.routes import agent as agent_routes

    src = inspect.getsource(agent_routes.reconnect_agent_stream)
    assert "_thread_owner_ok" in src
    assert "403" in src


def test_session_upsert_attributes_real_user_and_never_downgrades():
    """P1-8: the Copilot session-store upsert uses the acting user (not a
    hardcoded 'system') and only claims system-owned rows."""
    from orchestrator import executor

    src = inspect.getsource(executor._store_session_id)
    assert "_get_memory_user_id" in src
    assert "chat_session.user_id = 'system'" in src
    assert '"uid": "system",' not in src


def test_translator_persists_real_tool_status_and_stable_stream_id():
    """P0-5: failed tools persist as error; P0-4: the fallback persistence id
    is minted once per stream (not per thread, not per checkpoint)."""
    route = (REPO / "workbench/control_plane/src/app/api/agent/chat/route.ts").read_text()
    assert 'status: ev.success !== false ? "done" : "error"' in route
    assert "const persistId =" in route
    # the collapsing per-thread constant must not be the effective fallback
    assert "id: messageId || `assistant-${threadId}`," not in route
