"""Regression tests — final answer leaking into the consciousness stream.

Root causes (2026-07-02):
  1. copilot_agent ASSISTANT_MESSAGE dedup was TURN-global (`not
     _accumulated_text`): in a narrate → tool → answer turn, a final message
     whose deltas never streamed was dropped entirely — the visible output
     held only pre-tool narration and the real answer survived nowhere but
     the folded thinking timeline. Dedup is now PER message_id
     (_streamed_message_ids), mirroring _streamed_reasoning_ids.
  2. chatStream.ts reset the trailing-answer un-fold cursor on ANY delta —
     including the stray whitespace deltas models emit around tool
     boundaries — stranding the folded answer at run end. (Covered
     functionally via tsx against the real reducer; source-guarded here.)
  3. useAgentChat's "done was missing" fallback cleared streaming flags
     without running the un-fold. It now applies the shared done reducer.
"""
from __future__ import annotations

import inspect
from pathlib import Path

from orchestrator import copilot_agent

REPO = Path(__file__).resolve().parents[2]


def test_assistant_message_dedup_is_per_message_id():
    src = inspect.getsource(copilot_agent)
    assert "_streamed_message_ids" in src, "per-message dedup set missing"
    # The old turn-global guard must be gone.
    assert "if content and not _accumulated_text:" not in src, (
        "turn-global ASSISTANT_MESSAGE guard is back — later full messages "
        "without deltas (the post-tool final answer) would be dropped again"
    )


def test_frontend_fold_reset_requires_real_text():
    reducer = (REPO / "workbench/control_plane/src/lib/chatStream.ts").read_text()
    assert "if (deltaText.trim()) fold.foldedAnswerIdx = -1;" in reducer, (
        "whitespace deltas must not cancel the trailing-answer un-fold"
    )
    translator = (
        REPO / "workbench/control_plane/src/app/api/agent/chat/route.ts"
    ).read_text()
    assert "if (delta.trim()) foldedAnswerIdx = -1;" in translator, (
        "server persistence translator must mirror the whitespace guard"
    )


def test_live_loop_missing_done_fallback_unfolds():
    hook = (
        REPO / "workbench/control_plane/src/hooks/useAgentChat.ts"
    ).read_text()
    assert 'applyStreamEvent(m, { type: "done" }, fold)' in hook, (
        "the no-done fallback must run the shared done reducer (un-fold)"
    )
