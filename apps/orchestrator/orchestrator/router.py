"""Tiered LLM router (ADR-005). Phase-0 = rule-based; Phase 3.5 swaps in RouteLLM."""
from __future__ import annotations

from acb_llm import LLMTier


_NEEDS_REASONING = {"why", "compare", "should we", "strategy", "trade-off", "trade off"}
_STRUCTURED = {"summarise", "summarize", "list", "extract", "draft", "status of"}


def pick_tier(prompt: str) -> LLMTier:
    """Cheap heuristic mapping. Replaced by a trained RouteLLM classifier in 3.5."""
    p = prompt.lower()
    if any(token in p for token in _NEEDS_REASONING):
        return LLMTier.TIER_3
    if any(token in p for token in _STRUCTURED):
        return LLMTier.TIER_2
    return LLMTier.TIER_1
