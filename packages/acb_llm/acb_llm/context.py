"""Context-window management + automatic model fallback (ADR-008 follow-up).

Most email-assistant inbox work runs on a cheap "assistant" tier model (e.g.
DeepSeek chat). Two failure modes have to be handled before a request reaches
the provider:

1. **Context overflow.** A prompt (long thread + knowledge base + every rule
   instruction) can exceed the assistant model's input window, so the provider
   rejects the call. We resolve the *underlying* model behind a tier alias, look
   up its real context window, and truncate/compress the input to fit *before*
   the call.

2. **The cheap model can't do the job.** Even within budget, a small model may
   mis-classify or hard-fail. The caller supplies a more powerful *fallback*
   model; on a context-length error (or any hard failure) we retry once on the
   fallback, re-fitting the input to that model's (usually larger) window.

This keeps the common path cheap while still getting an answer out of the hard
emails. The fitting + fallback logic lives here so every in-gateway LLM call
(rule classification, drafting, …) can share one implementation.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from acb_common import get_logger

_log = get_logger("acb_llm.context")

# Conservative input-token budgets for the gateway tier aliases. Mirrors
# gateway.routes.settings._TIER_CONTEXT_WINDOWS so behaviour is identical
# whether the budget comes from litellm's registry or this tier table.
_TIER_CONTEXT_WINDOWS: dict[str, int] = {
    "tier-fast": 32_768,
    "tier-balanced": 128_000,
    "tier-powerful": 200_000,
}

# Substrings litellm / providers use when the prompt is too long for the model.
_CONTEXT_OVERFLOW_MARKERS = (
    "context length", "context_length", "context window", "maximum context",
    "context_length_exceeded", "too many tokens", "reduce the length",
    "input is too long", "prompt is too long", "string too long",
    "please reduce", "exceeds the maximum",
)

# Fallback when no real number is available anywhere.
_DEFAULT_CONTEXT_WINDOW = 32_768
# Chars per token for the heuristic estimator (English prose ≈ 4).
_CHARS_PER_TOKEN = 4
# Trimmed-message marker so a truncated prompt reads as deliberately shortened.
_TRUNCATION_MARKER = "\n\n[… content truncated to fit the model context window …]\n\n"


def resolve_underlying_model(model: str) -> str:
    """Resolve a gateway tier alias (``tier-fast`` / ``-balanced`` / ``-powerful``)
    to the concrete litellm model string it currently routes to; pass an explicit
    ``provider/model`` (or any unknown value) through unchanged.

    Reads ``acb_llm.client._TIER_MODEL`` at call time so runtime tier changes
    (Settings UI) take effect immediately."""
    m = (model or "").strip()
    if not m:
        return m
    try:
        from acb_llm.client import _TIER_ALIAS_MAP, _TIER_MODEL
        tier_id = _TIER_ALIAS_MAP.get(m)
        if tier_id:
            return _TIER_MODEL.get(tier_id, m)
    except Exception:
        pass
    return m


def context_window_for(model: str) -> int:
    """Best-effort *input*-token budget for ``model`` (a tier alias or a concrete
    litellm id). Order: curated tier table → litellm's registry for the resolved
    model → a conservative default. Always returns a positive number."""
    m = (model or "").strip()
    if not m:
        return _DEFAULT_CONTEXT_WINDOW
    # Tier alias → use the curated tier budget directly (the backing model may
    # not carry a max_input_tokens entry in litellm's registry).
    if m in _TIER_CONTEXT_WINDOWS:
        return _TIER_CONTEXT_WINDOWS[m]
    resolved = resolve_underlying_model(m)
    if resolved in _TIER_CONTEXT_WINDOWS:
        return _TIER_CONTEXT_WINDOWS[resolved]
    try:
        from litellm import model_cost
        info = (model_cost.get(resolved)
                or model_cost.get(resolved.split("/")[-1]))
        if info:
            win = int(info.get("max_input_tokens")
                      or info.get("max_tokens") or 0)
            if win > 0:
                return win
    except Exception:
        pass
    return _DEFAULT_CONTEXT_WINDOW


def count_message_tokens(messages: list[dict[str, Any]], model: str = "") -> int:
    """Estimate the prompt token count of a chat ``messages`` list. Uses
    litellm's tokenizer for the resolved model when available, else a chars/4
    heuristic plus a small per-message envelope allowance."""
    resolved = resolve_underlying_model(model) if model else ""
    if resolved:
        try:
            from litellm import token_counter
            n = token_counter(model=resolved, messages=messages)
            if n:
                return int(n)
        except Exception:
            pass
    total = 0
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, str):
            total += len(content)
    # +~8 tokens/message for role + delimiters (OpenAI chat-format overhead).
    return max(1, total // _CHARS_PER_TOKEN) + 8 * max(1, len(messages))


def fit_messages_to_context(
    messages: list[dict[str, Any]],
    model: str,
    *,
    max_output_tokens: int = 1024,
    safety_margin: int = 512,
) -> tuple[list[dict[str, Any]], bool]:
    """Shrink ``messages`` so they fit ``model``'s input window, reserving room
    for the completion (``max_output_tokens``) and a small ``safety_margin``.

    Returns ``(messages, truncated)``. When already within budget the original
    list is returned untouched. Otherwise the longest string ``content`` is
    repeatedly trimmed (keeping a head + tail around a marker) until the prompt
    fits — system messages are usually short, so this falls on the big user
    payload (thread / body) rather than the instructions."""
    budget = context_window_for(model) - max_output_tokens - safety_margin
    if budget < 1024:
        # Pathologically small window (or huge max_tokens) — keep something usable.
        budget = max(1024, (context_window_for(model) * 3) // 4)

    if count_message_tokens(messages, model) <= budget:
        return messages, False

    out: list[dict[str, Any]] = [dict(m) for m in messages]
    truncated = False
    # Bounded passes; each pass removes ~30% of the longest message, so the
    # prompt converges on the budget quickly without an unbounded loop.
    for _ in range(24):
        if count_message_tokens(out, model) <= budget:
            break
        idx, longest = -1, 0
        for i, msg in enumerate(out):
            content = msg.get("content")
            if isinstance(content, str) and len(content) > longest:
                idx, longest = i, len(content)
        if idx < 0 or longest <= len(_TRUNCATION_MARKER) + 200:
            break  # nothing meaningful left to trim
        content = out[idx]["content"]
        body_len = len(content) - (len(_TRUNCATION_MARKER) if _TRUNCATION_MARKER in content else 0)
        keep = max(200, int(body_len * 0.7))
        head = (keep * 3) // 4
        tail = keep - head
        out[idx]["content"] = (
            content[:head] + _TRUNCATION_MARKER + (content[-tail:] if tail else "")
        )
        truncated = True

    if truncated:
        _log.info(
            "acb_llm.context_fitted",
            model=model,
            budget=budget,
            final_tokens=count_message_tokens(out, model),
        )
    return out, truncated


def is_context_overflow_error(exc: BaseException) -> bool:
    """True when ``exc`` looks like a provider rejecting an over-long prompt."""
    s = str(exc).lower()
    return any(mark in s for mark in _CONTEXT_OVERFLOW_MARKERS)


async def acompletion_with_fallback(
    *,
    model: str,
    fallback_model: str = "",
    messages: list[dict[str, Any]],
    max_tokens: int = 1024,
    temperature: float = 0.2,
    **extra: Any,
) -> tuple[Any, str]:
    """Run a chat completion on ``model``, fitting the input to its context
    window first; on a context-overflow error (or any hard failure) retry once
    on ``fallback_model`` with the input re-fit to that model's window.

    The fallback is skipped when it is empty or resolves to the same underlying
    model as the primary. Returns ``(response, used_model)`` where
    ``used_model`` is the concrete litellm id that produced the answer. Raises
    the last error if every attempt fails.
    """
    import litellm as _litellm
    from litellm import acompletion

    from acb_llm.client import (
        _ensure_keys_loaded,
        ensure_model_registered,
    )

    _litellm.drop_params = True
    _litellm.suppress_debug_info = True
    await _ensure_keys_loaded()

    attempts: list[tuple[str, bool]] = [(model, False)]
    fb = (fallback_model or "").strip()
    if fb and resolve_underlying_model(fb) != resolve_underlying_model(model):
        attempts.append((fb, True))

    last_exc: BaseException | None = None
    for attempt_model, is_fallback in attempts:
        resolved = resolve_underlying_model(attempt_model)
        ensure_model_registered(resolved)
        fitted, was_truncated = fit_messages_to_context(
            messages, attempt_model, max_output_tokens=max_tokens,
        )
        try:
            resp = await acompletion(
                model=resolved, messages=fitted,
                temperature=temperature, max_tokens=max_tokens, **extra,
            )
            if is_fallback:
                _log.info("acb_llm.fallback_succeeded",
                          model=resolved, truncated=was_truncated)
            return resp, resolved
        except Exception as exc:
            last_exc = exc
            _log.warning(
                "acb_llm.completion_failed",
                model=resolved,
                is_fallback=is_fallback,
                overflow=is_context_overflow_error(exc),
                will_fallback=(not is_fallback and len(attempts) > 1),
                error=str(exc)[:200],
            )
            continue

    raise last_exc or RuntimeError("LLM completion failed (no attempts made)")


# ── Server-side run-context assembler (C2) ──────────────────────────────────
# The single INPUT-side context builder. Before this, each orchestrator path
# re-sliced the client-sent history with its own COUNT cap (12/16/20/50 msgs)
# and char-truncation, none token-aware, and non-chat callers (API/webhook) got
# no history at all because nothing rebuilt it server-side. This routes them all
# through one token-budgeted assembler. See specs/context_assembly_c2.md.


def _dedupe_current_turn(
    history: list[dict[str, Any]], current_message: str,
) -> list[dict[str, Any]]:
    """Drop a trailing history entry equal to the current user turn.

    Server-side equivalent of route.ts's ``withoutCurrentTurn`` — so the model
    never sees the prompt twice, regardless of whether the caller already
    excluded it. Only strips a *trailing* user turn (the just-sent one).
    """
    if not history or not current_message.strip():
        return history
    last = history[-1]
    if (
        str(last.get("role")) == "user"
        and str(last.get("content") or "").strip() == current_message.strip()
    ):
        return history[:-1]
    return history


def assemble_run_context(
    *,
    system_context: str = "",
    history: list[dict[str, Any]] | None = None,
    current_message: str = "",
    model: str = "",
    max_output_tokens: int = 1024,
    history_loader: Callable[[], list[dict[str, Any]]] | None = None,
    max_turns: int = 50,
) -> list[dict[str, Any]]:
    """Assemble a token-budgeted OpenAI-format ``messages`` list for a run.

    One server-side assembler for every chat / agent-run path, replacing the
    six divergent client-history slicers in the executor (C2). Steps:

    1. **Source of history.** Use ``history`` when it has content. When empty
       AND ``history_loader`` is supplied (the server holds a ``thread_id``),
       rebuild it from the store via the loader — this is what gives non-chat
       callers (API/webhook/external) the SAME history as the browser client,
       which previously got none.
    2. **Dedupe the current turn** (server-side ``withoutCurrentTurn``).
    3. **Assemble** ``[system?] + history[-max_turns:] + current`` in OpenAI
       shape; only ``user``/``assistant``/``system`` roles with content survive.
    4. **Token-budget fit** via :func:`fit_messages_to_context` — token-aware
       fitting REPLACES the old blind count caps (``max_turns`` remains only as
       a cheap upper bound applied before the token pass).

    Pure function: DB access is injected via ``history_loader`` so ``acb_llm``
    keeps no dependency on the gateway. Never raises for empty inputs — returns
    at least the current user turn (and system, if any).
    """
    src = list(history or [])
    if not src and history_loader is not None:
        try:
            loaded = history_loader() or []
            if isinstance(loaded, list):
                src = loaded
        except Exception as exc:
            _log.warning("acb_llm.history_loader_failed", error=str(exc))

    src = _dedupe_current_turn(src, current_message)

    messages: list[dict[str, Any]] = []
    if system_context.strip():
        messages.append({"role": "system", "content": system_context.strip()})

    hist_turns: list[dict[str, Any]] = []
    for m in src[-max_turns:]:
        role = str(m.get("role") or "user")
        content = str(m.get("content") or "").strip()
        if content and role in ("user", "assistant", "system"):
            hist_turns.append({"role": role, "content": content})

    current_turn = (
        {"role": "user", "content": current_message.strip()}
        if current_message.strip() else None
    )

    if not model:
        # No window to fit to — return the full assembly (count cap only).
        out = messages + hist_turns
        if current_turn:
            out.append(current_turn)
        return out

    # Token-budget windowing. Two-stage, because fit_messages_to_context only
    # TRIMS the single longest message per pass — great for the email shape
    # (one huge body) but it can't converge on a many-medium-turn chat
    # transcript. So first DROP whole oldest history turns until the assembly
    # fits, THEN let fit_messages_to_context handle any remaining oversized
    # single message (e.g. one giant pasted block). System context + the
    # current turn are never dropped — only historical turns.
    budget = context_window_for(model) - max_output_tokens - 512
    budget = max(1024, budget)
    dropped = 0
    while hist_turns:
        trial = messages + hist_turns + ([current_turn] if current_turn else [])
        if count_message_tokens(trial, model) <= budget:
            break
        hist_turns.pop(0)  # drop the oldest historical turn
        dropped += 1

    assembled = messages + hist_turns + ([current_turn] if current_turn else [])
    fitted, truncated = fit_messages_to_context(
        assembled, model, max_output_tokens=max_output_tokens,
    )
    if truncated or dropped:
        _log.info(
            "acb_llm.run_context_fitted",
            model=model,
            turns=len(assembled),
            dropped_turns=dropped,
            char_truncated=truncated,
            from_loader=(not history and history_loader is not None),
        )
    return fitted
