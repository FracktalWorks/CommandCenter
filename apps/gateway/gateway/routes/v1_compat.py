"""Thin OpenAI-compatible chat completions endpoint.

Routes /v1/chat/completions through the litellm SDK directly (no proxy).
The MAF OpenAIChatCompletionClient and Copilot SDK speak OpenAI API — this
route translates requests to our acb_llm module.

Serves both /v1/chat/completions (OpenAI standard) and /chat/completions (some SDKs).
"""
from __future__ import annotations

import json
from typing import Any

from acb_common import get_logger
from acb_llm.client import _ensure_keys_loaded
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

_log = get_logger("v1")

# Mount at /v1 (OpenAI standard) and also at root for SDKs that omit the prefix.
router_v1 = APIRouter(prefix="/v1", tags=["openai-compat"])
router_root = APIRouter(tags=["openai-compat"])

# Tier name → tier id mapping (constant; the model per tier id is dynamic).
# IMPORTANT: must stay in sync with acb_llm.client._TIER_MODEL.
# The orchestrator (agents.py, executor.py) passes these alias names as the
# "model" field — if an alias is missing here, litellm rejects it with
# "BadRequestError: LLM Provider NOT provided".
_TIER_NAME_TO_ID: dict[str, str] = {
    # Model-agnostic tier names (used by settings UI, orchestrator, and agents)
    "tier-fast": "tier1",
    "tier-balanced": "tier2",
    "tier-powerful": "tier3",
}


def _resolve_model(requested: str) -> str:
    """Map tier aliases to current model strings; pass unknown models through.

    Reads from acb_llm.client._TIER_MODEL at call time so runtime tier
    changes (via POST /settings/llm/tier) take effect immediately.
    """
    tier_id = _TIER_NAME_TO_ID.get(requested)
    if tier_id:
        from acb_llm.client import _TIER_MODEL as _live_tiers
        return _live_tiers.get(tier_id, requested)
    return requested


def _sanitize_messages_for_provider(
    messages: list[dict[str, Any]],
    provider: str,
) -> list[dict[str, Any]]:
    """Normalize messages so they pass provider-specific validation.

    DeepSeek (and some other providers) reject assistant messages where both
    ``content`` and ``tool_calls`` are null/missing.  The Copilot SDK may
    emit such messages when it serialises conversation history that includes
    tool-call-only assistant turns (content=null, tool_calls=[...]) or
    thinking-only turns that have neither field.

    Rules applied:
    1. Assistant messages with *neither* content nor tool_calls → dropped.
    2. Assistant messages with tool_calls but null content → content set to "".
    3. Tool messages with null/empty content → content set to "[tool result]".
    """
    if not messages:
        return messages

    # Providers that require content to be a string (not null) even when
    # tool_calls are present.  OpenAI accepts null content with tool_calls;
    # DeepSeek and some others reject it.
    _null_content_providers = {"deepseek"}
    _provider_lower = (provider or "").lower()
    _fix_null_content = any(
        p in _provider_lower for p in _null_content_providers
    )

    cleaned: list[dict[str, Any]] = []
    for m in messages:
        role = m.get("role", "")
        content = m.get("content")
        tool_calls = m.get("tool_calls")

        if role == "assistant":
            # If both content and tool_calls are null/empty/missing, drop.
            # Invalid per the OpenAI spec — rejected by all providers.
            has_content = content is not None and content != ""
            has_tool_calls = tool_calls is not None and len(tool_calls) > 0
            if not has_content and not has_tool_calls:
                _log.debug(
                    "v1.sanitize_dropped_assistant",
                    reason="no content or tool_calls",
                )
                continue
            # Some providers require content to be a string (not null) when
            # tool_calls are present.  Set to empty string for those.
            if has_tool_calls and content is None and _fix_null_content:
                m = dict(m)
                m["content"] = ""

        elif role == "tool":
            # Some providers reject null/empty tool result content.
            if content is None or content == "":
                m = dict(m)
                m["content"] = "[tool result]"

        cleaned.append(m)

    return cleaned


async def _handle_chat_completions(request: Request) -> StreamingResponse | dict[str, Any]:
    """OpenAI-compatible chat completions. Supports streaming and tools."""
    await _ensure_keys_loaded()

    body = await request.json()
    model = _resolve_model(body.get("model", "tier-balanced"))
    messages = body.get("messages", [])
    tools = body.get("tools")
    tool_choice = body.get("tool_choice", "auto")
    temperature = body.get("temperature", 0.2)
    max_tokens = body.get("max_tokens", 4096)
    stream = body.get("stream", False)
    # Passthrough: custom api_base for Ollama / vLLM / self-hosted endpoints.
    api_base = body.get("api_base") or None
    api_key = body.get("api_key") or None

    import litellm as _litellm  # type: ignore[import-untyped]
    from litellm import acompletion  # type: ignore[import-untyped]

    # Drop parameters the provider doesn't support (e.g. Copilot SDK may
    # send fields that DeepSeek / other providers reject).
    _litellm.drop_params = True
    _litellm.suppress_debug_info = True

    # Dynamically register model so new provider models route correctly.
    from acb_llm.client import ensure_model_registered
    provider = ensure_model_registered(model)

    # Sanitize messages for providers with strict validation (e.g. DeepSeek).
    messages = _sanitize_messages_for_provider(messages, provider or model)

    common: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": tool_choice if tools else None,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if api_base:
        common["api_base"] = api_base
    if api_key:
        common["api_key"] = api_key

    if stream:
        async def event_generator():
            try:
                response = await acompletion(**common, stream=True)
                async for chunk in response:
                    # litellm returns Pydantic ModelResponseStream — convert to dict
                    data = chunk.model_dump() if hasattr(chunk, "model_dump") else dict(chunk)
                    yield f"data: {json.dumps(data)}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as exc:
                _log.exception("v1.stream_error")
                yield f"data: {json.dumps({'error': str(exc)})}\n\n"

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    # Non-streaming
    try:
        response = await acompletion(**common)
        return dict(response) if hasattr(response, "items") else response  # type: ignore[return-value]
    except Exception as exc:
        _log.exception("v1.completion_error")
        return {
            "error": {
                "message": str(exc),
                "type": type(exc).__name__,
            }
        }


# Register on both /v1/chat/completions and /chat/completions
# response_model=None because we return either StreamingResponse or dict
router_v1.post("/chat/completions", response_model=None)(_handle_chat_completions)
router_root.post("/chat/completions", response_model=None)(_handle_chat_completions)

# Export both routers — callers include both
routers = [router_v1, router_root]
