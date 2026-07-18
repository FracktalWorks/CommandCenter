"""Thin OpenAI-compatible chat completions endpoint.

Routes /v1/chat/completions through the litellm SDK directly (no proxy).
The MAF OpenAIChatCompletionClient and Copilot SDK speak OpenAI API — this
route translates requests to our acb_llm module.

Serves both /v1/chat/completions (OpenAI standard) and /chat/completions (some SDKs).
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from acb_auth import require_internal_auth
from acb_common import get_logger
from acb_llm.client import _ensure_keys_loaded
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse

_log = get_logger("v1")

# Whether to honour a caller-supplied ``api_base``/``api_key`` in the request
# body (for Ollama / vLLM / self-hosted endpoints). OFF by default: an
# untrusted body could point the server at an arbitrary URL (SSRF/relay). No
# internal caller sends these in the body today — they configure the provider
# on their own client — so default-off is safe. Opt in per deployment.
_ALLOW_CALLER_ENDPOINT_OVERRIDE = os.environ.get(
    "V1_ALLOW_CALLER_ENDPOINT_OVERRIDE", "0"
).strip().lower() in ("1", "true", "yes", "on")

# ── Default output ceiling ────────────────────────────────────────────────
# This route is THE choke point every agent runtime POSTs through, so this
# default IS the real output cap for the whole platform whenever the caller
# omits max_tokens — and the Copilot SDK ALWAYS omits it: its wire protocol
# has no max_tokens field, so `COPILOT_MAX_OUTPUT_TOKENS` / the SessionConfig
# `max_tokens` never reach us. The old default of 4096 was therefore the
# effective ceiling for every Copilot agent, which truncated long tool-call
# arguments mid-JSON (the model emits a big file's content as a tool argument,
# gets cut at 4096, and the resulting malformed JSON fails the tool call).
#
# Measured on the live gateway (deepseek-v4-pro, 2026-07-17):
#   no max_tokens  → completion_tokens=4096,  finish_reason="length"  (cut off)
#   max_tokens=32k → completion_tokens=10940, finish_reason="stop"    (finished)
#
# Since max_tokens is a CEILING (the model stops when it's done, as the "stop"
# above shows), a generous default costs nothing and only removes an artificial
# cut. Verified accepted by the whole active fleet (deepseek-v4-pro /
# tier-powerful / tier-fast / auto all return 200 at 32000).
_DEFAULT_MAX_OUTPUT_TOKENS: int = int(
    os.environ.get("GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS", "32000")
)


def _clamp_max_tokens(requested: int, model: str) -> int:
    """Lower ``requested`` to ``model``'s real output cap, when one is known.

    The generous default above is what stops long tool-call arguments being
    truncated mid-JSON, but it cuts the other way too: a provider whose model
    caps below 32000 answers an over-large max_tokens with a 400 — a total
    failure, worse than the truncation this default exists to prevent. Nothing
    in the fleet does that today (all deepseek), which is exactly why the ceiling
    could be raised safely; this keeps that true when a smaller model is added.

    Only a limit we VOUCH for is allowed to lower the ceiling — a curated entry
    or an explicit env override. litellm's registry is excluded on purpose: it
    claims deepseek-v4-pro caps at 8192 while the live model emits 10940, and
    clamping to a stale-low number would re-create the exact truncation bug this
    module's default was raised to fix. Believing a guess is what broke this
    before; an unvetted model keeps the generous ceiling instead.
    """
    try:
        from acb_llm.model_limits import get_limits
        limits = get_limits(model)
    except Exception:
        return requested          # resolver unavailable — never block a call
    if limits.max_output_source not in ("curated", "env"):
        return requested
    if limits.max_output <= 0 or requested <= limits.max_output:
        return requested
    _log.info(
        "v1.max_tokens_clamped",
        model=model,
        requested=requested,
        clamped_to=limits.max_output,
        source=limits.max_output_source,
    )
    return limits.max_output

# Mount at /v1 (OpenAI standard) and also at root for SDKs that omit the prefix.
router_v1 = APIRouter(prefix="/v1", tags=["openai-compat"])
router_root = APIRouter(tags=["openai-compat"])

# Tier name → tier id mapping. Single source of truth is
# acb_llm.client._TIER_ALIAS_MAP (also used by context.py); imported here rather
# than duplicated so the two can never drift. The orchestrator (agents.py,
# executor.py) passes these alias names as the "model" field — if an alias is
# missing, litellm rejects it with "BadRequestError: LLM Provider NOT provided".
from acb_llm.client import _TIER_ALIAS_MAP as _TIER_NAME_TO_ID  # noqa: E402


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


# ── Secret-stripping patterns for upstream error surfacing ─────────────────
# The provider's error string carries the ACTIONABLE reason (rate limit, bad
# key, context-length, invalid model) but may also embed the api_base URL, a
# Bearer token, or an ``sk-…`` key fragment. We surface the reason to the
# operator (it's THEIR CommandCenter) but redact anything secret first.
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"sk-[A-Za-z0-9_\-]{6,}"),          # OpenAI-style keys
    re.compile(r"Bearer\s+[A-Za-z0-9._\-]+", re.I),  # bearer tokens
    re.compile(r"https?://\S+"),                     # endpoint URLs
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),      # GitHub tokens
)


def _sanitize_upstream_error(exc: Exception) -> tuple[int, str]:
    """Return ``(http_status, safe_message)`` for an upstream completion error.

    The status is taken from the litellm exception (``status_code``) when
    present so the caller — and the frontend's ``parseAgentError`` — can
    classify it (429 rate-limit, 401 auth, 400 bad-request, …) instead of
    dead-ending on an opaque "upstream completion error". The message keeps the
    provider's human-readable reason but with keys / tokens / URLs redacted.
    """
    status = getattr(exc, "status_code", None)
    try:
        status = int(status) if status is not None else 502
    except (TypeError, ValueError):
        status = 502
    if not (400 <= status <= 599):
        status = 502

    reason = str(getattr(exc, "message", "") or str(exc) or "").strip()
    for pat in _SECRET_PATTERNS:
        reason = pat.sub("[redacted]", reason)
    # Collapse whitespace and cap length so a giant provider payload can't bloat
    # the response (or the CLI/UI that renders it).
    reason = re.sub(r"\s+", " ", reason)[:300].strip()
    if not reason:
        reason = "upstream completion error"
    return status, f"upstream completion failed ({status}): {reason}"


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
    _requested_model = body.get("model", "tier-balanced")
    model = _resolve_model(_requested_model)
    # Preserve the tier alias (if the caller asked for one) so per-tier cost/
    # usage breakdowns populate — this is the choke point for all agent traffic,
    # so a blank tier here left the whole per-tier view empty (obs gap).
    _tier = _requested_model if _requested_model in _TIER_NAME_TO_ID else ""
    messages = body.get("messages", [])
    tools = body.get("tools")
    tool_choice = body.get("tool_choice", "auto")
    temperature = body.get("temperature", 0.2)
    max_tokens = _clamp_max_tokens(
        body.get("max_tokens") or _DEFAULT_MAX_OUTPUT_TOKENS, model)
    stream = body.get("stream", False)
    # Passthrough: custom api_base/api_key for Ollama / vLLM / self-hosted
    # endpoints — only when explicitly enabled (SSRF guard; see module top).
    if _ALLOW_CALLER_ENDPOINT_OVERRIDE:
        api_base = body.get("api_base") or None
        api_key = body.get("api_key") or None
    else:
        api_base = None
        api_key = None
        if body.get("api_base") or body.get("api_key"):
            _log.warning("v1.caller_endpoint_override_ignored")

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
                    # Never emit a chunk whose ``choices`` is null: the MAF/OpenAI
                    # client does ``len(chunk.choices)`` on every streamed chunk,
                    # so a null here crashes the whole run with an opaque
                    # "'NoneType' object has no len()". A missing/usage-only chunk
                    # must carry an empty list, which the client already skips.
                    if data.get("choices") is None:
                        data["choices"] = []
                    yield f"data: {json.dumps(data)}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as exc:
                # Log the full detail server-side; surface a SANITIZED reason +
                # status to the caller (keys/URLs/tokens stripped) so the
                # provider's real cause — rate limit, bad key, context length —
                # reaches the operator instead of an opaque dead-end. The
                # OpenAI/Copilot client raises this as its error message.
                _log.exception("v1.stream_error")
                _status, _safe = _sanitize_upstream_error(exc)
                yield (
                    "data: "
                    + json.dumps({"error": {
                        "message": _safe,
                        "type": type(exc).__name__,
                        "code": _status,
                    }})
                    + "\n\n"
                )
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
                            _emit_usage(model, _tier, rebuilt,
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
            _emit_usage(model, _tier, response, source=_obs_source, agent=_obs_agent)
        except Exception:  # noqa: BLE001
            pass
        payload = dict(response) if hasattr(response, "items") else response
        # An OpenAI-compatible completion MUST carry a non-empty ``choices``
        # list. Some providers (and litellm on a soft error) return a 200 body
        # that has no ``choices`` — the MAF/OpenAI client then parses it into a
        # ChatCompletion whose ``choices`` is None and blows up iterating it with
        # "'NoneType' object is not iterable", masking the real cause. Surface it
        # as an upstream error (proper status) so the client raises cleanly.
        # ``payload`` may be a dict or a litellm ModelResponse object, so read
        # ``choices`` generically from either shape.
        _choices = (
            payload.get("choices") if isinstance(payload, dict)
            else getattr(payload, "choices", None)
        )
        if not _choices:
            _log.warning("v1.completion_missing_choices", model=model)
            return JSONResponse(
                status_code=502,
                content={
                    "error": {
                        "message": "upstream completion returned no choices",
                        "type": "UpstreamResponseError",
                    }
                },
            )
        return payload  # type: ignore[return-value]
    except Exception as exc:
        # Log full detail server-side; surface a SANITIZED reason + the upstream
        # status (keys/URLs/tokens stripped) so the provider's real cause reaches
        # the operator. Use a non-2xx status (never a 200 error body): a 200 with
        # no ``choices`` makes the MAF/OpenAI client iterate a None ``choices``
        # and fail with "'NoneType' object is not iterable", hiding the real
        # error. A non-2xx makes the client raise a clean APIStatusError carrying
        # this message, and the frontend can classify it by status/keyword.
        _log.exception("v1.completion_error")
        _status, _safe = _sanitize_upstream_error(exc)
        return JSONResponse(
            status_code=_status,
            content={
                "error": {
                    "message": _safe,
                    "type": type(exc).__name__,
                    "code": _status,
                }
            },
        )


# Register on both /v1/chat/completions and /chat/completions
# response_model=None because we return either StreamingResponse or dict.
# require_internal_auth 401s any caller without the internal Bearer token —
# this endpoint bills the server's stored provider keys, so it must not be
# world-reachable. Every internal caller already forwards the token.
_auth = [Depends(require_internal_auth)]
router_v1.post(
    "/chat/completions", response_model=None, dependencies=_auth,
)(_handle_chat_completions)
router_root.post(
    "/chat/completions", response_model=None, dependencies=_auth,
)(_handle_chat_completions)

# Export both routers — callers include both
routers = [router_v1, router_root]
