"""Unit tests — graceful handling of a Copilot run that ends with no text.

Regression for the "The agent produced no text output" dead-end (2026-07-16).

A tool-heavy Copilot-SDK run (e.g. deepseek-v4-pro authoring many files via
bash) can exhaust its output-token budget part-way through the turn — the
final tool call's JSON is truncated ("Unterminated string in JSON ...") and
the model never writes its closing answer. The stream ends with
``text_started == False``.

Previously the executor surfaced a hard ``RUN_ERROR`` and returned, which
(a) recorded the run as ``error`` and (b) wiped all the folded tool work from
the UI even though real work had happened. ``_copilot_no_text_end`` now
distinguishes the two cases:

* tool work happened → synthesised closing message + fall through to
  RUN_FINISHED (records ``completed``, keeps the work).
* no tool work at all → genuine empty response → RUN_ERROR (hard stop).
"""
from __future__ import annotations

import orchestrator.executor as ex


def test_tool_activity_soft_finishes_without_run_error() -> None:
    events, finish = ex._copilot_no_text_end(run_id="r1", tool_activity=True)

    # The caller must fall through to its shared RUN_FINISHED.
    assert finish is True

    types = [e["type"] for e in events]
    # A real assistant text segment so the message persists / folds, and the
    # turn does not read as an empty bubble.
    assert types == [
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
    ]
    # Crucially: no RUN_ERROR — that is what previously marked the run failed
    # and discarded the work.
    assert not any(e["type"] == "RUN_ERROR" for e in events)

    # One coherent message id across the segment.
    ids = {e["messageId"] for e in events}
    assert len(ids) == 1
    assert events[1]["delta"].strip(), "fallback message must carry content"


def test_no_tool_activity_is_a_hard_error() -> None:
    events, finish = ex._copilot_no_text_end(run_id="r2", tool_activity=False)

    # No work happened — stop hard, do not reach RUN_FINISHED.
    assert finish is False
    assert len(events) == 1
    err = events[0]
    assert err["type"] == "RUN_ERROR"
    assert err["runId"] == "r2"
    assert err["code"] == "NO_OUTPUT"


def test_message_ids_are_unique_per_call() -> None:
    # Distinct runs must not collide on a reused id (AG-UI dedups by id).
    a, _ = ex._copilot_no_text_end(run_id="r", tool_activity=True)
    b, _ = ex._copilot_no_text_end(run_id="r", tool_activity=True)
    assert a[0]["messageId"] != b[0]["messageId"]
