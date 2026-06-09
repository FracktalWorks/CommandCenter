"""Thin OpenAI-compatible chat completions endpoint.

Replaces the LiteLLM proxy container for MAF agent-framework compatibility.
The MAF OpenAIChatCompletionClient and Copilot SDK speak OpenAI API — this
route translates requests to our acb_llm module (which uses litellm SDK directly).

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
_TIER_NAME_TO_ID: dict[str, str] = {
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

    from litellm import acompletion  # type: ignore[import-untyped]

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
