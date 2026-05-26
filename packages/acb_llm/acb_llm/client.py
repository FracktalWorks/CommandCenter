"""Thin wrapper around LiteLLM that enforces tiered routing.

Tiers (per system_architecture.md §10):
    TIER_1  Local Qwen3-8B via vLLM         — classify / triage / cheap extraction
    TIER_2  Sonnet-class / GPT-4o-class     — structured extraction, action drafting
    TIER_3  Opus-class / GPT-5-class        — multi-hop reasoning, strategy
"""
from __future__ import annotations

from enum import StrEnum
from typing import Any

from litellm import acompletion  # type: ignore[import-untyped]

from acb_common import get_settings

# Model aliases — these must match keys in infra/litellm/config.yaml.
_TIER_MODEL: dict[str, str] = {
    "tier1": "tier1-local-qwen3",
    "tier2": "tier2-sonnet",
    "tier3": "tier3-opus",
}


class LLMTier(StrEnum):
    TIER_1 = "tier1"
    TIER_2 = "tier2"
    TIER_3 = "tier3"


async def complete(
    *,
    tier: LLMTier,
    messages: list[dict[str, str]],
    temperature: float = 0.2,
    max_tokens: int = 1024,
    **extra: Any,
) -> str:
    """Send a chat completion through the LiteLLM proxy at the configured tier.

    Returns the assistant message content as a plain string. Caller is responsible
    for any downstream parsing / guardrail validation (see acb_llm.guardrails).
    """
    settings = get_settings()
    model = _TIER_MODEL[tier.value]

    response = await acompletion(
        # `litellm_proxy/` tells the SDK to hit our LiteLLM proxy (which then
        # owns the real provider routing per infra/litellm/config.yaml).
        model=f"litellm_proxy/{model}",
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        api_base=settings.litellm_base_url,
        api_key=settings.litellm_master_key,
        **extra,
    )
    return response["choices"][0]["message"]["content"]  # type: ignore[no-any-return,index]
