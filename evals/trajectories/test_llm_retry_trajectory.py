"""Golden trajectories: tool-failure recovery in the LLM client (HH-1).

Locks the transient/permanent error split in ``acb_llm.complete``: transient
provider failures are retried with backoff, permanent ones surface
immediately, and empty responses count as retryable.
"""
from __future__ import annotations

import pytest

from acb_llm import client as llm_client
from acb_llm.client import LLMTier, complete


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    async def _no_keys() -> None:
        return None

    async def _no_sleep(_delay) -> None:
        return None

    monkeypatch.setattr(llm_client, "_ensure_keys_loaded", _no_keys)
    monkeypatch.setattr(llm_client.asyncio, "sleep", _no_sleep)


def _response(content: str | None) -> dict:
    return {"choices": [{"message": {"content": content}}]}


async def test_transient_errors_are_retried_then_succeed(monkeypatch):
    calls: list[int] = []

    async def _flaky(**kwargs):
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("429 rate limit exceeded")
        return _response("recovered")

    monkeypatch.setattr(llm_client, "acompletion", _flaky)
    result = await complete(tier=LLMTier.TIER_1, messages=[{"role": "user", "content": "hi"}])
    assert result == "recovered"
    assert len(calls) == 3


async def test_permanent_error_raises_immediately(monkeypatch):
    calls: list[int] = []

    async def _bad_request(**kwargs):
        calls.append(1)
        raise ValueError("invalid request: unknown parameter")

    monkeypatch.setattr(llm_client, "acompletion", _bad_request)
    with pytest.raises(ValueError):
        await complete(tier=LLMTier.TIER_1, messages=[{"role": "user", "content": "hi"}])
    assert len(calls) == 1


async def test_persistent_transient_error_raises_after_three_attempts(monkeypatch):
    calls: list[int] = []

    async def _always_down(**kwargs):
        calls.append(1)
        raise RuntimeError("503 service unavailable")

    monkeypatch.setattr(llm_client, "acompletion", _always_down)
    with pytest.raises(RuntimeError, match="503"):
        await complete(tier=LLMTier.TIER_1, messages=[{"role": "user", "content": "hi"}])
    assert len(calls) == 3


async def test_empty_choices_counts_as_retryable(monkeypatch):
    calls: list[int] = []

    async def _empty_then_ok(**kwargs):
        calls.append(1)
        if len(calls) == 1:
            return {"choices": []}
        return _response("second try")

    monkeypatch.setattr(llm_client, "acompletion", _empty_then_ok)
    result = await complete(tier=LLMTier.TIER_1, messages=[{"role": "user", "content": "hi"}])
    assert result == "second try"
    assert len(calls) == 2
