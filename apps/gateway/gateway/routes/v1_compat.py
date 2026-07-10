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

    Also handles camelCase ``toolCalls`` (some SDK variants), empty/whitespace
    content, and malformed tool-call items that lack a ``function`` key.

    Rules applied:
    1. Assistant messages with *neither* valid content nor valid tool_calls
       → dropped.
    2. Assistant messages with tool_calls but null/empty content → content
       set to "" (all providers — null content violates the OpenAI spec).
    3. Tool messages with null/empty content → content set to "[tool result]".
    4. Malformed tool-call items (missing ``function`` / ``name``) → stripped.
    """
    if not messages:
        return messages

    cleaned: list[dict[str, Any]] = []
    for m in messages:
        role = m.get("role", "")
        content = m.get("content")
        # Accept both snake_case and camelCase tool calls.
        tool_calls = m.get("tool_calls") or m.get("toolCalls")

        if role == "assistant":
            # ── Normalise tool_calls ──────────────────────────────
            _valid_tool_calls: list[dict[str, Any]] = []
            if isinstance(tool_calls, list):
                for tc in tool_calls:
                    if isinstance(tc, dict):
                        fn = tc.get("function") or {}
                        if isinstance(fn, dict) and fn.get("name"):
                            _valid_tool_calls.append(tc)
                            continue
                        # Some SDKs put name/arguments at top level.
                        if tc.get("name"):
                            _valid_tool_calls.append(tc)
                            continue
                if _valid_tool_calls:
                    m = dict(m)
                    m["tool_calls"] = _valid_tool_calls
                    tool_calls = _valid_tool_calls
                else:
                    tool_calls = None

            # ── Assess content ───────────────────────────────────
            has_content = bool(
                content is not None
                and str(content).strip()
            )

            # ── Assess tool_calls ────────────────────────────────
            has_tool_calls = bool(
                isinstance(tool_calls, list) and len(tool_calls) > 0
            )

            # ── Drop if neither is present ───────────────────────
            if not has_content and not has_tool_calls:
                _log.debug(
                    "v1.sanitize_dropped_assistant",
                    reason="no content or tool_calls",
                )
                continue

            # ── Always fix null/empty content when tool_calls set ─
            # The OpenAI spec says content SHOULD be null when
            # tool_calls is present, but many providers (DeepSeek,
            # Groq, Together) reject null content outright.
            if has_tool_calls and (
                content is None or str(content).strip() == ""
            ):
                if not isinstance(m, dict):
                    m = dict(m)
                m["content"] = ""

        elif role == "tool":
            # Tool messages must have non-empty string content.
            if content is None or str(content).strip() == "":
                m = dict(m)
                m["content"] = "[tool result]"

        cleaned.append(m)

    return cleaned


async def _handle_chat_completions(request: Request) -> StreamingResponse | dict[str, Any]:
    """OpenAI-compatible chat completions. Supports streaming and tools."""
    await _ensure_keys_loaded()

    # Observability attribution (E2): the agent runtime stamps its identity on the
    # request via default_headers so we can tie this model call + cost back to the
    # specific agent (otherwise it's a bare request with no run context). Fail-soft
    # — absent headers just fall back to source="chat", no agent.
    _obs_agent = request.headers.get("x-cc-agent") or None
    _obs_source = request.headers.get("x-cc-source") or "chat"

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

    # Provider-aware prompt caching (specs/llm_caching_memory.md Phase 2/3).
    # This is THE choke point every agent runtime (native-MAF
    # OpenAIChatCompletionClient, Copilot SDK) POSTs through, so marking the
    # cache breakpoints here covers all agent traffic in one place:
    #   • Anthropic tiers → cache_control on the stable system block (split at
    #     the CACHE BREAK sentinel the executor injects) + the last tool schema.
    #   • OpenAI tiers → prompt_cache_key routing (agent name if present).
    #   • DeepSeek/others → sentinel stripped (automatic/no-op caching).
    # The sentinel never reaches the model in any case.
    from acb_llm.prompt_cache import apply_prompt_caching

    _cache_key = body.get("prompt_cache_key") or body.get("user") or None
    messages, tools, _cache_extra = apply_prompt_caching(
        model=model, messages=messages, tools=tools,
        cache_key=_cache_key, extra={},
    )

    common: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": tool_choice if tools else None,
        "temperature": temperature,
        "max_tokens": max_tokens,
        **_cache_extra,
    }
    if api_base:
        common["api_base"] = api_base
    if api_key:
        common["api_key"] = api_key

    if stream:
        async def event_generator():
            # Keep the raw chunks so we can rebuild the full response (with usage)
            # AFTER the stream, WITHOUT changing the provider request — this is
            # THE choke point every agent runtime streams through, so it must stay
            # byte-identical for the client. Observability is derived, never
            # intrusive.
            _chunks: list[Any] = []
            try:
                response = await acompletion(**common, stream=True)
                async for chunk in response:
                    _chunks.append(chunk)
                    # litellm returns Pydantic ModelResponseStream — convert to dict
                    data = chunk.model_dump() if hasattr(chunk, "model_dump") else dict(chunk)
                    yield f"data: {json.dumps(data)}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as exc:
                _log.exception("v1.stream_error")
                yield f"data: {json.dumps({'error': str(exc)})}\n\n"
            finally:
                # Observability (E2): rebuild usage from the streamed chunks
                # (litellm's own stream aggregator) → emit the model activation +
                # cost. This is what makes chat-agent model calls observable.
                # Best-effort; source="chat" (interactive agent traffic).
                if _chunks:
                    try:
                        from litellm import stream_chunk_builder  # noqa: PLC0415
                        rebuilt = stream_chunk_builder(_chunks, messages=messages)
                        if rebuilt is not None:
                            from acb_llm.client import _emit_usage  # noqa: PLC0415
                            _emit_usage(model, "", rebuilt,
                                        source=_obs_source, agent=_obs_agent)
                    except Exception:  # noqa: BLE001
                        pass

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
        # Observability (E2): emit the model activation + cost for this agent
        # completion. Best-effort; never affects the response.
        try:
            from acb_llm.client import _emit_usage  # noqa: PLC0415
            _emit_usage(model, "", response, source=_obs_source, agent=_obs_agent)
        except Exception:  # noqa: BLE001
            pass
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
