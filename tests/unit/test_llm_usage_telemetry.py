"""Unit tests for per-call LLM usage telemetry (HH-3).

Covers ``_usage_stats`` extraction (token + provider cache counters) and the
fact that a successful ``complete`` emits usage without affecting the result.
"""
from __future__ import annotations

import pytest

from acb_llm import client as llm_client
from acb_llm.client import LLMTier, _usage_stats, complete


def test_usage_stats_extracts_tokens_and_cache_counters():
    response = {
        "usage": {
            "prompt_tokens": 1200,
            "completion_tokens": 80,
            "total_tokens": 1280,
            "cache_read_input_tokens": 900,
            "cache_creation_input_tokens": 300,
            "prompt_tokens_details": {"cached_tokens": 900},
        },
    }
    stats = _usage_stats(response)
    assert stats == {
        "prompt_tokens": 1200,
        "completion_tokens": 80,
        "total_tokens": 1280,
        "cache_read_input_tokens": 900,
        "cache_creation_input_tokens": 300,
        "cached_tokens": 900,
    }


def test_usage_stats_tolerates_missing_or_partial_usage():
    assert _usage_stats({}) == {}
    assert _usage_stats({"usage": None}) == {}
    assert _usage_stats({"usage": {"prompt_tokens": 10}}) == {"prompt_tokens": 10}
    assert _usage_stats(object()) == {}


@pytest.mark.asyncio
async def test_complete_emits_usage_on_success(monkeypatch):
    async def _no_keys() -> None:
        return None

    async def _ok(**kwargs):
        return {
            "choices": [{"message": {"content": "hello"}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2},
        }

    emitted: list[tuple] = []
    monkeypatch.setattr(llm_client, "_ensure_keys_loaded", _no_keys)
    monkeypatch.setattr(llm_client, "acompletion", _ok)
    monkeypatch.setattr(
        llm_client, "_emit_usage",
        lambda model, tier, resp: emitted.append((model, tier)),
    )

    result = await complete(
        tier=LLMTier.TIER_1, messages=[{"role": "user", "content": "hi"}],
    )
    assert result == "hello"
    assert len(emitted) == 1
    assert emitted[0][1] == "tier1"
