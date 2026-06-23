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
from pathlib import Path
from typing import Any

from acb_common import get_logger, get_settings
from litellm import acompletion  # type: ignore[import-untyped]

_log = get_logger("acb_llm")

# Error substrings that indicate a transient failure worth retrying.
_TRANSIENT_ERRORS = (
    "rate limit", "ratelimit", "429", "503", "overload",
    "timeout", "connection", "retry", "service unavailable",
)

# ── Tier → model mapping ──────────────────────────────────────────────────
# Populated from config.yaml + tier_overrides.yaml at import time so the
# runtime always matches the configured tiers.  Falls back to these hardcoded
# defaults if the config files can't be read.
_TIER_DEFAULTS: dict[str, str] = {
    "tier1": "groq/llama-3.3-70b-versatile",     # fast & cheap (Groq)
    "tier2": "deepseek/deepseek-chat",            # balanced (DeepSeek)
    "tier3": "deepseek/deepseek-reasoner",        # powerful reasoning
}
_TIER_MODEL: dict[str, str] = dict(_TIER_DEFAULTS)

# Tier alias → tier ID (must stay in sync with v1_compat.py._TIER_NAME_TO_ID).
_TIER_ALIAS_MAP: dict[str, str] = {
    "tier-fast": "tier1",
    "tier-balanced": "tier2",
    "tier-powerful": "tier3",
}

# Track whether keys have been loaded from the store.
_keys_loaded = False
_tier_models_initialised = False


# ── Tier model initialisation from config ─────────────────────────────────

def _find_workspace_root() -> Path | None:
    """Walk up from this file to locate the workspace root.

    Looks for pyproject.toml with ``[tool.uv.workspace]`` — the same
    convention used by settings.py's _repo_root().
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        pyproject = parent / "pyproject.toml"
        if pyproject.exists():
            try:
                if "[tool.uv.workspace]" in pyproject.read_text(
                    encoding="utf-8"
                ):
                    return parent
            except OSError:
                pass
    return None


def _init_tier_models() -> None:
    """Populate _TIER_MODEL from config.yaml + tier_overrides.yaml.

    Called once at import time so the in-memory tier mapping always
    reflects the configured models — no gateway restart needed after
    deployments that change config.yaml (tier_overrides.yaml changes
    are handled by set_tier_model() at runtime).
    """
    global _tier_models_initialised
    if _tier_models_initialised:
        return
    _tier_models_initialised = True

    import yaml  # noqa: PLC0415

    root = _find_workspace_root()
    if not root:
        _log.debug("acb_llm.tier_models_no_root")
        return

    config_path = root / "infra" / "litellm" / "config.yaml"
    if not config_path.exists():
        _log.debug(
            "acb_llm.tier_models_no_config", path=str(config_path)
        )
        return

    try:
        with config_path.open() as f:
            cfg: dict[str, Any] = yaml.safe_load(f) or {}
    except Exception as exc:
        _log.warning(
            "acb_llm.tier_models_config_read_failed", error=str(exc)
        )
        return

    # Merge tier overrides on top (Settings UI changes survive deploys).
    # Source of truth is the model_config Postgres table (key 'tier_overrides');
    # fall back to the legacy tier_overrides.yaml file when the DB is empty or
    # unreachable (e.g. very first boot before the gateway has seeded it).
    overrides: dict[str, Any] = {}
    try:
        from acb_llm.model_config import load_blob  # noqa: PLC0415
        blob = load_blob("tier_overrides")
        if isinstance(blob, dict) and "model_list" in blob:
            overrides = blob
    except Exception as exc:  # noqa: BLE001
        _log.warning("acb_llm.tier_models_db_read_failed", error=str(exc))

    if not overrides.get("model_list"):
        overrides_path = root / "infra" / "litellm" / "tier_overrides.yaml"
        if overrides_path.exists():
            try:
                with overrides_path.open() as f:
                    overrides = yaml.safe_load(f) or {}
            except Exception as exc:
                _log.warning(
                    "acb_llm.tier_models_overrides_read_failed",
                    error=str(exc),
                )

    if overrides and "model_list" in overrides:
        override_map = {
            e["model_name"]: e
            for e in overrides["model_list"]
        }
        base_list = cfg.get("model_list", [])
        for i, entry in enumerate(base_list):
            name = entry.get("model_name", "")
            if name in override_map:
                base_list[i] = override_map[name]
        cfg["model_list"] = base_list

    # Extract tier model assignments
    model_list: list[dict] = cfg.get("model_list", [])
    count = 0
    for entry in model_list:
        tier_name = entry.get("model_name", "")
        tier_id = _TIER_ALIAS_MAP.get(tier_name)
        if not tier_id:
            continue
        model = entry.get("litellm_params", {}).get("model", "")
        if model:
            _TIER_MODEL[tier_id] = model
            ensure_model_registered(model)
            count += 1

    if count:
        _log.info(
            "acb_llm.tier_models_initialised",
            models=_TIER_MODEL.copy(),
        )


def set_tier_model(tier_id: str, model: str) -> bool:
    """Update a single tier's model assignment at runtime.

    Called by the Settings UI after a user changes a tier model.
    Updates the in-memory ``_TIER_MODEL`` dict so the Test button
    and all subsequent completions use the new model immediately.

    Args:
        tier_id: One of ``"tier1"``, ``"tier2"``, ``"tier3"``.
        model: LiteLLM model string (e.g. ``"deepseek/deepseek-v4-pro"``).

    Returns:
        ``True`` if the model prefix was recognised and registered.
        ``False`` if the prefix is unknown, but the tier mapping is
        still updated so the caller can try the model anyway.
    """
    if tier_id not in ("tier1", "tier2", "tier3"):
        raise ValueError(f"Unknown tier_id: {tier_id!r}")

    _TIER_MODEL[tier_id] = model

    # Dynamically register so litellm routes through the correct provider
    # even for brand-new models not yet in litellm's built-in registry.
    provider = ensure_model_registered(model)
    _log.info(
        "acb_llm.tier_model_updated",
        tier=tier_id,
        model=model,
        provider=provider,
    )
    return provider is not None


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


def ensure_model_registered(model: str) -> str | None:
    """Ensure *model* can be routed by litellm.

    If the model is already in litellm's registry, returns the provider name.
    If it follows a known provider prefix (``deepseek/``, ``openai/``, etc.)
    but isn't registered yet, adds it dynamically so litellm routes through
    the correct API rather than silently falling back to OpenRouter.

    Returns the provider name on success, or ``None`` if the model prefix
    isn't recognised (caller should warn the user).

    This keeps the model catalogue dynamic — new provider models work
    immediately without waiting for a litellm or CommandCenter release.
    """
    from litellm import model_cost  # noqa: PLC0415

    # Already known — return the provider
    if model in model_cost:
        provider = model_cost[model].get("litellm_provider", "")
        if provider:
            return provider

    # Map known prefixes to litellm providers.
    # When a new model appears (e.g. deepseek/deepseek-v4-turbo), we
    # register it under the correct provider so litellm calls the right
    # API instead of guessing (and potentially falling back to OpenRouter).
    _PREFIX_PROVIDER: dict[str, str] = {
        "deepseek/": "deepseek",
        "openai/": "openai",
        "anthropic/": "anthropic",
        "groq/": "groq",
        "gemini/": "gemini",
        "mistral/": "mistral",
        "together_ai/": "together_ai",
        "openrouter/": "openrouter",
        "cohere/": "cohere",
    }

    for prefix, provider in _PREFIX_PROVIDER.items():
        if model.startswith(prefix):
            # Dynamic registration: add a minimal entry so litellm knows
            # to route through this provider's API.
            model_cost[model] = {
                "litellm_provider": provider,
                "mode": "chat",
                "max_tokens": 32768,
                "max_input_tokens": 262144,
                "max_output_tokens": 32768,
                "input_cost_per_token": 0,
                "output_cost_per_token": 0,
                "supports_function_calling": True,
                "supports_parallel_function_calling": True,
                "supports_native_streaming": True,
                "supports_system_messages": True,
                "supports_tool_choice": True,
                "supports_response_schema": True,
            }
            _log.info(
                "acb_llm.model_registered_dynamic",
                model=model,
                provider=provider,
            )
            return provider

    return None  # unknown prefix — caller should warn


# Initialise from config at import time (best-effort; hardcoded
# defaults above are the fallback if config files are absent).
_init_tier_models()


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

    # Dynamically register model so new provider models work immediately.
    ensure_model_registered(model)

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
