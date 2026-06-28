"""Regression tests for streamed tool-call id de-duplication.

OpenAI sends a tool call's id only on its FIRST streaming chunk; the
argument-streaming chunks that follow carry ``call_id=""``.  The native-MAF
streaming path used to mint a fresh synthetic id per empty-id chunk, so one
tool call rendered as several rows in the consciousness timeline (the reported
"most tool calls appear multiple times" bug).  These tests lock the fix: one
streamed call → one TOOL_CALL_START, with its args accumulated to one id.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from orchestrator.executor import _FcStreamState, _native_fc_events


def _fc(call_id: str = "", name: str = "", arguments: str = "") -> SimpleNamespace:
    """A stand-in for agent-framework's streamed FunctionCallContent."""
    return SimpleNamespace(call_id=call_id, name=name, arguments=arguments)


def _drive(state: _FcStreamState, contents: list[Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for c in contents:
        out.extend(_native_fc_events(c, state))
    return out


def test_streamed_call_emits_single_start_and_accumulates_args() -> None:
    state = _FcStreamState("run1")
    events = _drive(state, [
        _fc(call_id="call_abc", name="query_inbox", arguments=""),
        _fc(call_id="", arguments='{"account_id": "'),
        _fc(call_id="", arguments='123"}'),
    ])
    starts = [e for e in events if e["type"] == "TOOL_CALL_START"]
    args = [e for e in events if e["type"] == "TOOL_CALL_ARGS"]
    assert len(starts) == 1
    assert starts[0]["toolCallId"] == "call_abc"
    assert starts[0]["toolCallName"] == "query_inbox"
    # All arg deltas attribute to the one call and concatenate to the full JSON.
    assert {a["toolCallId"] for a in args} == {"call_abc"}
    assert "".join(a["delta"] for a in args) == '{"account_id": "123"}'


def test_two_distinct_calls_emit_two_starts() -> None:
    state = _FcStreamState("run1")
    events = _drive(state, [
        _fc(call_id="call_a", name="tool_a", arguments=""),
        _fc(call_id="", arguments='{"x":1}'),
        _fc(call_id="call_b", name="tool_b", arguments=""),
        _fc(call_id="", arguments='{"y":2}'),
    ])
    starts = [e["toolCallId"] for e in events if e["type"] == "TOOL_CALL_START"]
    assert starts == ["call_a", "call_b"]
    a_args = "".join(
        e["delta"] for e in events
        if e["type"] == "TOOL_CALL_ARGS" and e["toolCallId"] == "call_a"
    )
    b_args = "".join(
        e["delta"] for e in events
        if e["type"] == "TOOL_CALL_ARGS" and e["toolCallId"] == "call_b"
    )
    assert a_args == '{"x":1}'
    assert b_args == '{"y":2}'


def test_resent_id_does_not_duplicate_row() -> None:
    state = _FcStreamState("run1")
    events = _drive(state, [
        _fc(call_id="call_a", name="tool_a", arguments='{"x":1}'),
        _fc(call_id="call_a", name="tool_a", arguments='{"x":1}'),  # full re-send
    ])
    starts = [e for e in events if e["type"] == "TOOL_CALL_START"]
    assert len(starts) == 1


def test_leading_continuation_falls_back_to_synthetic_id() -> None:
    # Defensive: a continuation chunk before any call started still yields one
    # row under a synthetic id (rather than being dropped).
    state = _FcStreamState("run1")
    events = _drive(state, [_fc(call_id="", arguments='{"x":1}')])
    starts = [e for e in events if e["type"] == "TOOL_CALL_START"]
    assert len(starts) == 1
    assert starts[0]["toolCallId"] == "run1:fc:1"
