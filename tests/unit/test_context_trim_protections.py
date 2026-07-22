"""Regression tests for the char-trim protections (audit CX3/CX5).

CX5: ``fit_messages_to_context`` picked the LONGEST message regardless of
role, so under pressure the system prompt (persona/instructions) was silently
truncated while ordinary user payloads survived. Non-system content must be
trimmed first; the system block only as a last resort.

CX3: the small-window rescue branch budgeted the prompt to ``window * 3 // 4``
without accounting for the ``max_tokens`` the caller would still send —
producing a request that was over-window by construction. The rescue now
budgets against a floor-sized completion (the /v1 choke point clamps the real
``max_tokens`` to the remaining room).
"""
from __future__ import annotations

from typing import Any

import acb_llm.context as ctx
import pytest

WINDOW = 8000


def _count(msgs: list[dict[str, Any]], _model: str = "") -> int:
    return sum(len(str(m.get("content") or "")) // 4 + 8 for m in msgs)


@pytest.fixture(autouse=True)
def _small_window(monkeypatch):
    monkeypatch.setattr(ctx, "context_window_for", lambda _m: WINDOW)
    monkeypatch.setattr(ctx, "count_message_tokens", _count)


def test_system_prompt_is_protected_from_char_trim():
    system = "PERSONA " * 3000   # 24000 chars — the longest message
    user = "payload " * 2500     # 20000 chars
    msgs = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    out, truncated = ctx.fit_messages_to_context(msgs, "m", max_output_tokens=1024)
    assert truncated is True
    assert out[0]["content"] == system, "system block must not be trimmed while user content is available"
    assert len(out[1]["content"]) < len(user)


def test_system_prompt_trimmed_only_as_last_resort():
    system = "PERSONA " * 8000   # 64000 chars — alone over any budget
    msgs = [
        {"role": "system", "content": system},
        {"role": "user", "content": "hi"},
    ]
    out, truncated = ctx.fit_messages_to_context(msgs, "m", max_output_tokens=1024)
    assert truncated is True
    assert len(out[0]["content"]) < len(system), (
        "with no other trimmable content, the system block must still shrink "
        "rather than shipping an over-budget prompt"
    )
    budget = WINDOW - 1024 - 512
    assert _count(out) <= budget


def test_small_window_rescue_budget_is_satisfiable():
    # max_output (32000) dwarfs the 8000 window → the old rescue budgeted the
    # prompt to 6000 tokens while the caller still sent max_tokens=32000.
    msgs = [{"role": "user", "content": "x" * 60000}]
    out, truncated = ctx.fit_messages_to_context(msgs, "m", max_output_tokens=32000)
    assert truncated is True
    # The fitted prompt must leave room for at least the floor completion.
    assert _count(out) <= WINDOW - 1024 - 512
