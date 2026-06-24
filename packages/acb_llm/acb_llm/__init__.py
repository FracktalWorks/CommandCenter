"""LiteLLM-backed LLM client with tiered routing (ADR-005, ADR-008).

All app code MUST go through this module — never call provider SDKs directly.
"""
from acb_llm.client import LLMTier, complete, complete_with_tools
from acb_llm.context import (
    acompletion_with_fallback,
    context_window_for,
    fit_messages_to_context,
    resolve_underlying_model,
)

__all__ = [
    "LLMTier",
    "acompletion_with_fallback",
    "complete",
    "complete_with_tools",
    "context_window_for",
    "fit_messages_to_context",
    "resolve_underlying_model",
]
