"""Unit tests for E2 observability: correlated logging + durable run trace.

Phase 1 — bind_run_context threads run_id/thread_id/agent/user into structlog
contextvars so every log line for a run is filterable, and JSON output is
machine-parseable. Phase 2 — build_run_trace_row derives the durable agent_run
row (metadata+status for all runs; full trace only for errored/flagged).
"""
from __future__ import annotations

import structlog
from acb_common import (
    bind_run_context,
    clear_run_context,
    get_run_context,
)
from gateway.run_trace import _derive_status, build_run_trace_row

# ── Phase 1: correlated logging ─────────────────────────────────────────────
#
# We assert on the CONTEXTVARS bind/clear manage — that IS the mechanism that
# puts the fields on every line: the configured processor chain includes
# structlog.contextvars.merge_contextvars, so anything in the contextvars at
# emit time lands on the rendered line. (An end-to-end JSON render is verified
# manually; structlog's cache_logger_on_first_use makes cross-test handler
# capture unreliable, so we test the contextvar state directly here.)


def test_merge_contextvars_is_in_the_configured_chain():
    # The whole scheme relies on this processor being present.
    from acb_common import configure_logging
    configure_logging("INFO", json_logs=True)
    names = [
        getattr(p, "__name__", getattr(type(p), "__name__", ""))
        for p in structlog.get_config()["processors"]
    ]
    assert any("merge_contextvars" in n for n in names)


def test_bound_context_visible_to_any_emitter_on_the_task():
    # After bind, ANY code on this task (e.g. the LLM usage emitter that passes
    # no ids) sees the run fields via the contextvars merge processor.
    bind_run_context(run_id="r1", thread_id="t1", agent="sales", user="u@x")
    try:
        merged = structlog.contextvars.get_contextvars()
        assert merged["run_id"] == "r1"
        assert merged["thread_id"] == "t1"
        assert merged["agent"] == "sales"
        assert merged["user"] == "u@x"
    finally:
        clear_run_context()


def test_clear_removes_context_no_leak():
    bind_run_context(run_id="r1", agent="a")
    clear_run_context()
    merged = structlog.contextvars.get_contextvars()
    assert "run_id" not in merged
    assert "agent" not in merged


def test_get_run_context_reflects_bound_fields():
    bind_run_context(run_id="rX", agent="emailer")
    try:
        ctx = get_run_context()
        assert ctx == {"run_id": "rX", "agent": "emailer"}
    finally:
        clear_run_context()
    assert get_run_context() == {}


def test_bind_ignores_empty_values():
    bind_run_context(run_id="r", thread_id="", agent=None, user="")
    try:
        assert get_run_context() == {"run_id": "r"}
    finally:
        clear_run_context()


# ── Phase 2: durable run-trace row ──────────────────────────────────────────

_TOOL_EVENTS = [
    {"name": "search", "status": "done", "result": "hits"},
    {"name": "draft", "status": "done", "result": "a draft body"},
]


def _folded(**over):
    base = {
        "content": "Here is your answer.",
        "tool_events": _TOOL_EVENTS,
        "reasoning": '["thinking..."]',
        "custom_events": [],
        "timestamp": 1000,
    }
    base.update(over)
    return base


def test_successful_run_stores_metadata_no_trace_body():
    events = [{"type": "RUN_FINISHED"}]
    row = build_run_trace_row(
        run_id="r1", thread_id="t1", agent_name="sales", user_id="u",
        model="tier3", events=events, folded=_folded(),
        started_ms=200, ended_ms=1000,
    )
    assert row["status"] == "completed"
    assert row["tool_count"] == 2
    assert row["tool_summary"] == [
        {"name": "search", "status": "done"},
        {"name": "draft", "status": "done"},
    ]
    assert row["duration_ms"] == 800
    # Full trace (content / results) is NOT retained for a successful run.
    assert row["trace"] is None
    assert row["error_message"] is None


def test_errored_run_keeps_full_trace_and_error():
    events = [
        {"type": "TOOL_CALL_START"},
        {"type": "RUN_ERROR", "message": "boom: provider 500"},
    ]
    row = build_run_trace_row(
        run_id="r2", thread_id="t2", agent_name="emailer", user_id="u",
        model="tier2", events=events, folded=_folded(),
    )
    assert row["status"] == "error"
    assert row["error_message"] == "boom: provider 500"
    # Full trace IS retained for an errored run (content + tool results).
    assert row["trace"] is not None
    assert row["trace"]["content"] == "Here is your answer."
    assert row["trace"]["tool_events"] == _TOOL_EVENTS


def test_flagged_successful_run_keeps_trace():
    row = build_run_trace_row(
        run_id="r3", thread_id="t3", agent_name="a", user_id="u",
        model="m", events=[{"type": "RUN_FINISHED"}], folded=_folded(),
        flagged=True,
    )
    assert row["status"] == "completed"
    assert row["flagged"] is True
    assert row["trace"] is not None  # flag forces retention


def test_cancelled_run_status():
    events = [{"type": "RUN_FINISHED", "cancelled": True}]
    row = build_run_trace_row(
        run_id="r4", thread_id="t4", agent_name="a", user_id="u",
        model="m", events=events, folded=_folded(),
    )
    assert row["status"] == "cancelled"
    assert row["trace"] is not None  # cancelled keeps the trace too


def test_derive_status_error_wins_over_cancel():
    events = [
        {"type": "RUN_ERROR", "message": "x"},
        {"type": "RUN_FINISHED", "cancelled": True},
    ]
    status, msg, _ = _derive_status(events)
    assert status == "error"
    assert msg == "x"


def test_duration_derived_from_event_stream_ids():
    # Regression: duration_ms was null in prod because started_ms wasn't passed.
    # It now derives from the first/last event's Redis stream-id timestamps.
    events = [
        {"type": "RUN_STARTED", "_stream_id": "1000-0"},
        {"type": "TEXT_MESSAGE_CONTENT", "_stream_id": "2000-0"},
        {"type": "RUN_FINISHED", "_stream_id": "3500-0"},
    ]
    row = build_run_trace_row(
        run_id="rd", thread_id="t", agent_name="a", user_id="u", model="m",
        events=events, folded=_folded(),
    )
    assert row["duration_ms"] == 2500  # 3500 - 1000


def test_explicit_times_win_over_event_derivation():
    events = [{"type": "RUN_FINISHED", "_stream_id": "9999-0"}]
    row = build_run_trace_row(
        run_id="rd2", thread_id="t", agent_name="a", user_id="u", model="m",
        events=events, folded=_folded(), started_ms=100, ended_ms=600,
    )
    assert row["duration_ms"] == 500  # explicit values, not the event ms


def test_no_folded_run_still_produces_a_row():
    # A run that errored before producing any message (folded is None) still
    # yields a trace row — that itself is a debuggable outcome.
    events = [{"type": "RUN_ERROR", "message": "died immediately"}]
    row = build_run_trace_row(
        run_id="r5", thread_id="t5", agent_name="a", user_id="u",
        model="m", events=events, folded=None,
    )
    assert row["status"] == "error"
    assert row["error_message"] == "died immediately"
    assert row["tool_count"] == 0
    assert row["trace"] is None  # nothing to store, but the row exists


# ── Phase 6.8: Avatar customization (Office / Avatar Studio) ─────────────────
#
# The avatar-override endpoints let an operator pin a per-agent look / custom
# Pixel Lab sprite. These test the guards + best-effort contracts that don't
# need a live DB or network (name validation, load-degradation, the generate
# 503 when Pixel Lab isn't configured).

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from gateway.routes import observability as _obs  # noqa: E402


def test_agent_name_regex_accepts_valid_and_rejects_junk():
    ok = ["orchestrator", "email-assistant", "task_manager", "a", "apis.config"]
    bad = ["", "-leading", "UPPER", "has space", "x" * 65, "bad/slash"]
    assert all(_obs._AGENT_NAME_RE.match(n) for n in ok)
    assert not any(_obs._AGENT_NAME_RE.match(n) for n in bad)


def test_load_avatars_degrades_to_empty_when_db_unavailable(monkeypatch):
    # Best-effort contract: a DB failure must NOT raise (it would 500 the whole
    # roster) — it returns {} so the office falls back to derived looks.
    import acb_graph

    def _boom(*_a, **_k):
        raise RuntimeError("no db")

    monkeypatch.setattr(acb_graph, "get_session", _boom)
    assert _obs._load_avatars() == {}


@pytest.mark.asyncio
async def test_generate_avatar_503_without_api_key(monkeypatch):
    monkeypatch.delenv("PIXELLAB_API_KEY", raising=False)
    with pytest.raises(HTTPException) as ei:
        await _obs.generate_avatar(_obs.AvatarGenerate(description="a coder"))
    assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_generate_avatar_400_on_empty_description(monkeypatch):
    monkeypatch.setenv("PIXELLAB_API_KEY", "test-key")
    with pytest.raises(HTTPException) as ei:
        await _obs.generate_avatar(_obs.AvatarGenerate(description="   "))
    assert ei.value.status_code == 400
