"""Unit tests for the agent_framework telemetry kill switch.

Fixes the chat "<Token ...> was created in a different Context" error: MAF's
streaming-telemetry cleanup hook resets a ContextVar in a different async
context than it set it, raising ValueError at end-of-stream and turning a
successful run into a RUN_ERROR. The instrumentation exports nowhere here, so we
disable it process-wide before the first agent run (unless the operator opts
back in via ENABLE_INSTRUMENTATION).
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import orchestrator.executor as ex


def _reset_flag() -> None:
    ex._telemetry_disabled = False


def test_disables_instrumentation_when_not_opted_in(monkeypatch) -> None:
    _reset_flag()
    monkeypatch.delenv("ENABLE_INSTRUMENTATION", raising=False)
    fake = MagicMock()
    with patch("agent_framework.observability.disable_instrumentation", fake):
        ex._disable_agent_telemetry_once()
        ex._disable_agent_telemetry_once()  # idempotent — second call is a no-op
    fake.assert_called_once()


def test_respects_operator_opt_in(monkeypatch) -> None:
    # ENABLE_INSTRUMENTATION truthy → leave tracing on (for when a real OTel
    # backend is wired up). The kill switch must not fight that.
    for val in ("1", "true", "TRUE", "yes", "on"):
        _reset_flag()
        monkeypatch.setenv("ENABLE_INSTRUMENTATION", val)
        fake = MagicMock()
        with patch("agent_framework.observability.disable_instrumentation", fake):
            ex._disable_agent_telemetry_once()
        fake.assert_not_called()


def test_disable_failure_is_swallowed(monkeypatch) -> None:
    # A broken/older agent_framework that can't be disabled must not crash the
    # run — the executor's end-of-stream ValueError guard still covers it.
    _reset_flag()
    monkeypatch.delenv("ENABLE_INSTRUMENTATION", raising=False)
    boom = MagicMock(side_effect=RuntimeError("nope"))
    with patch("agent_framework.observability.disable_instrumentation", boom):
        ex._disable_agent_telemetry_once()  # must not raise
    boom.assert_called_once()


def test_benign_teardown_error_is_recognized() -> None:
    # The executor treats this specific end-of-stream ValueError as a clean
    # end (break) rather than a RUN_ERROR; guard on the message substring.
    err = ValueError(
        "<Token var=<ContextVar name='inner_response_telemetry_captured_fields'"
        "> at 0x1> was created in a different Context")
    assert "different Context" in str(err)
    # An unrelated ValueError must NOT be swallowed.
    assert "different Context" not in str(ValueError("bad json"))
