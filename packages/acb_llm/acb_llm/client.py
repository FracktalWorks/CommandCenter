"""LiteLLM SDK client with tiered routing (ADR-005, ADR-008).

Connects to providers directly via the litellm Python SDK — no proxy needed.
Provider API keys are loaded from the encrypted Postgres key store at startup.

Tiers (per system_architecture.md §10):
    TIER_1  Cheap/fast models                — classify / triage / cheap extraction
    TIER_2  Sonnet-class / GPT-4o-class      — structured extraction, action drafting
    TIER_3  Opus-class / GPT-5-class         — multi-hop reasoning, strategy
"""
from __future__ import annotations

import asyncio
import os
from enum import StrEnum
from typing import Any

from acb_common import get_logger, get_settings
from litellm import acompletion  # type: ignore[import-untyped]

_log = get_logger("acb_llm")

# Error substrings that indicate a transient failure worth retrying.
_TRANSIENT_ERRORS = (
    "rate limit", "ratelimit", "429", "503", "overload",
    "timeout", "connection", "retry", "service unavailable",
)

# Tier → litellm model string.  These use native litellm provider prefixes
# so acompletion() routes directly (no proxy needed).
# IMPORTANT: the tier ALIASES (tier-fast, tier-balanced, tier-powerful) are defined in
# v1_compat.py._TIER_NAME_TO_ID — both files must stay in sync when adding tiers.
_TIER_MODEL: dict[str, str] = {
    "tier1": "groq/llama-3.3-70b-versatile",     # fast & cheap (Groq)
    "tier2": "deepseek/deepseek-chat",            # balanced (DeepSeek)
    "tier3": "deepseek/deepseek-reasoner",        # powerful reasoning
}

# Track whether keys have been loaded from the store.
_keys_loaded = False


async def _ensure_keys_loaded() -> None:
    """Load provider keys from the encrypted Postgres store into litellm's config.

    On first run with an empty store, auto-seeds any keys found in env vars.
    Falls back to env vars only if the store is completely unreachable.
    """
    global _keys_loaded
    if _keys_loaded:
        return
    _keys_loaded = True

    try:
        from acb_llm.key_store import get_key_store
        store = get_key_store()

        # Seed from env vars on first boot (one-time migration)
        existing = await store.get_all()
        if not existing:
            _env_to_provider = {
                "GEMINI_API_KEY": "gemini",
                "OPENAI_API_KEY": "openai",
                "ANTHROPIC_API_KEY": "anthropic",
                "DEEPSEEK_API_KEY": "deepseek",
                "OPENROUTER_API_KEY": "openrouter",
                "GROQ_API_KEY": "groq",
                "MISTRAL_API_KEY": "mistral",
                "TOGETHER_API_KEY": "together",
                "OPENROUTER_API_KEY": "openrouter",
            }
            for env_var, provider in _env_to_provider.items():
                val = os.environ.get(env_var, "")
                if val and val.strip():
                    await store.put(provider, val.strip())
                    _log.info("acb_llm.key_seeded_from_env", provider=provider)

        await store.configure_litellm()
        _log.info("acb_llm.keys_loaded_from_store")
    except Exception as exc:
        _log.warning("acb_llm.key_store_unavailable", error=str(exc))
        # Fall back to env vars for bootstrap / first-run
        _load_keys_from_env()


def _load_keys_from_env() -> None:
    """Bootstrap litellm config from environment variables (fallback)."""
    import litellm as _litellm

    env_map = {
        "OPENAI_API_KEY": "api_key",
        "ANTHROPIC_API_KEY": "anthropic_api_key",
        "GEMINI_API_KEY": "gemini_api_key",
        "DEEPSEEK_API_KEY": "deepseek_api_key",
        "GROQ_API_KEY": "groq_api_key",
        "MISTRAL_API_KEY": "mistral_api_key",
        "TOGETHER_API_KEY": "together_api_key",
        "OPENROUTER_API_KEY": "openrouter_api_key",
    }
    for env_var, attr in env_map.items():
        val = os.environ.get(env_var, "")
        if val:
            setattr(_litellm, attr, val)
            _log.debug("acb_llm.key_from_env", provider=attr)


class LLMTier(StrEnum):
    TIER_1 = "tier1"
    TIER_2 = "tier2"
    TIER_3 = "tier3"


def is_known_model(model: str) -> bool:
    """Check whether *model* is recognised by litellm's provider registry.

    Returns True for known provider/model strings (e.g. ``deepseek/deepseek-chat``)
    and False for unrecognised names that would cause litellm to silently fall
    back to unknown routing (often through OpenRouter with unexpected limits).
    """
    # Tier aliases are always known — they resolve via _TIER_MODEL.
    if model.lower().startswith("tier"):
        return True
    # GitHub Copilot models use a github/… prefix handled specially.
    if model.startswith("github/"):
        return True
    try:
        from litellm import model_cost  # noqa: PLC0415
        return model in model_cost
    except ImportError:
        return True  # can't validate — allow through


async def complete(
    *,
    tier: LLMTier,
    messages: list[dict[str, str]],
    temperature: float = 0.2,
    max_tokens: int = 1024,
    **extra: Any,
) -> str:
    """Send a chat completion directly to the provider via litellm SDK.

    Returns the assistant message content as a plain string. Caller is responsible
    for any downstream parsing / guardrail validation (see acb_llm.guardrails).
    """
    await _ensure_keys_loaded()

    model = _TIER_MODEL[tier.value]

    last_exc: Exception | None = None
    for attempt in range(3):
        if attempt > 0:
            await asyncio.sleep(2 ** attempt)  # 2 s, then 4 s
        try:
            response = await acompletion(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
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
    await _ensure_keys_loaded()

    model = _TIER_MODEL[tier.value]

    last_exc: Exception | None = None
    for attempt in range(3):
        if attempt > 0:
            await asyncio.sleep(2 ** attempt)
        try:
            response = await acompletion(
                model=model,
                messages=messages,
                tools=tools,
                tool_choice=tool_choice,
                temperature=temperature,
                max_tokens=max_tokens,
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
