"""Unit tests for per-call LLM usage telemetry (HH-3).

Covers ``_usage_stats`` extraction (token + provider cache counters) and the
fact that a successful ``complete`` emits usage without affecting the result.
"""
from __future__ import annotations

import pytest
from acb_llm import client as llm_client
from acb_llm.client import LLMTier, _compute_cost, _usage_stats, complete
from acb_llm.context import _infer_app_source


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


# ── Cost pricing (E2 live cost) ──────────────────────────────────────────────

def test_compute_cost_prices_a_known_model():
    resp = {"usage": {"prompt_tokens": 1000, "completion_tokens": 500,
                      "total_tokens": 1500}}
    cost = _compute_cost("gpt-4o-mini", resp, resp["usage"])
    assert isinstance(cost, float) and cost > 0


def test_compute_cost_returns_none_for_unknown_model():
    resp = {"usage": {"prompt_tokens": 10, "completion_tokens": 5}}
    # Unknown model → no price in litellm's catalogue → None (UI shows "—",
    # never a misleading $0).
    assert _compute_cost("totally-made-up-model-xyz", resp, resp["usage"]) is None


# ── App-source inference (zero-touch cross-app attribution) ──────────────────

def test_infer_app_source_reads_the_originating_app_module():
    # Real chain in prod: <app handler> -> acompletion_with_fallback ->
    # _infer_app_source. _getframe(2) lands on the app handler, so a module
    # under gateway.routes.<app> attributes to <app> with NO call-site changes.
    def fake_acompletion():  # stands in for acompletion_with_fallback (frame 1)
        return _infer_app_source()

    for modname, expect in [
        ("gateway.routes.email.automation.drafting", "email"),
        ("gateway.routes.tasks.ai", "tasks"),
        ("gateway.routes.newapp.handlers", "newapp"),  # future app, no wiring
        ("orchestrator.executor", None),               # agent run → run context
    ]:
        g = {"__name__": modname, "fake_acompletion": fake_acompletion}
        exec("def handler():\n    return fake_acompletion()", g)  # noqa: S102
        assert g["handler"]() == expect
