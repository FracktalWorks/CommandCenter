"""Thin wrapper around LiteLLM that enforces tiered routing.

Tiers (per system_architecture.md §10):
    TIER_1  Local Qwen3-8B via vLLM         — classify / triage / cheap extraction
    TIER_2  Sonnet-class / GPT-4o-class     — structured extraction, action drafting
    TIER_3  Opus-class / GPT-5-class        — multi-hop reasoning, strategy
"""
from __future__ import annotations

import asyncio
from enum import StrEnum
from typing import Any

from litellm import acompletion  # type: ignore[import-untyped]

from acb_common import get_settings

# Error substrings that indicate a transient failure worth retrying.
_TRANSIENT_ERRORS = (
    "rate limit", "ratelimit", "429", "503", "overload",
    "timeout", "connection", "retry", "service unavailable",
)

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

    last_exc: Exception | None = None
    for attempt in range(3):
        if attempt > 0:
            await asyncio.sleep(2 ** attempt)  # 2 s, then 4 s
        try:
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
            # content can be None for thinking models (e.g. gemini-2.5-pro returns
            # reasoning tokens separately; the text content field is null until done).
            choices = response.get("choices") or []
            if not choices:
                last_exc = RuntimeError(
                    f"LLM returned no choices (model={model}). "
                    f"Response: {dict(response)}"
                )
                continue  # retry
            content = choices[0]["message"]["content"]
            return content or ""  # type: ignore[no-any-return,index]
        except Exception as exc:
            if any(token in str(exc).lower() for token in _TRANSIENT_ERRORS):
                last_exc = exc
                continue  # retry on transient errors
            raise  # re-raise non-transient errors immediately

    raise last_exc or RuntimeError(f"LLM completion failed after 3 attempts (model={model})")


async def complete_with_tools(
    *,
    tier: LLMTier,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    tool_choice: str = "auto",
    temperature: float = 0.2,
    max_tokens: int = 4096,
    **extra: Any,
) -> dict[str, Any]:
    """Like complete() but with tool-calling support.

    Returns the full assistant message dict, which may include ``tool_calls``.
    Feed the returned dict directly back into ``messages`` for the next turn.

    The returned dict is always JSON-serializable (plain Python dicts/lists, no
    Pydantic objects) so it can be stored in LangGraph state without issue.
    """
    settings = get_settings()
    model = _TIER_MODEL[tier.value]

    last_exc: Exception | None = None
    for attempt in range(3):
        if attempt > 0:
            await asyncio.sleep(2 ** attempt)
        try:
            response = await acompletion(
                model=f"litellm_proxy/{model}",
                messages=messages,
                tools=tools,
                tool_choice=tool_choice,
                temperature=temperature,
                max_tokens=max_tokens,
                api_base=settings.litellm_base_url,
                api_key=settings.litellm_master_key,
                **extra,
            )
            choices = response.get("choices") or []
            if not choices:
                last_exc = RuntimeError(
                    f"LLM returned no choices (model={model}). Response: {dict(response)}"
                )
                continue

            msg = choices[0]["message"]

            # Normalise to a plain serialisable dict — LiteLLM may return
            # Pydantic model objects that LangGraph can't pickle.
            result: dict[str, Any] = {
                "role": (msg.get("role") if hasattr(msg, "get") else getattr(msg, "role", "assistant")) or "assistant",
            }
            content = msg.get("content") if hasattr(msg, "get") else getattr(msg, "content", None)
            tool_calls_raw = msg.get("tool_calls") if hasattr(msg, "get") else getattr(msg, "tool_calls", None)

            if content is not None:
                result["content"] = content

            if tool_calls_raw:
                normalised_calls: list[dict[str, Any]] = []
                for tc in tool_calls_raw:
                    if hasattr(tc, "function"):
                        fn = tc.function
                        fn_name = fn.name if hasattr(fn, "name") else fn.get("name", "")
                        fn_args = fn.arguments if hasattr(fn, "arguments") else fn.get("arguments", "{}")
                        tc_id = tc.id if hasattr(tc, "id") else tc.get("id", "")
                    else:
                        fn = tc.get("function") or {}
                        fn_name = fn.get("name", "")
                        fn_args = fn.get("arguments", "{}")
                        tc_id = tc.get("id", "")
                    normalised_calls.append({
                        "id": tc_id,
                        "type": "function",
                        "function": {"name": fn_name, "arguments": fn_args},
                    })
                result["tool_calls"] = normalised_calls

            return result

        except Exception as exc:
            if any(token in str(exc).lower() for token in _TRANSIENT_ERRORS):
                last_exc = exc
                continue
            raise

    raise last_exc or RuntimeError(f"LLM tool-call completion failed after 3 attempts (model={model})")
