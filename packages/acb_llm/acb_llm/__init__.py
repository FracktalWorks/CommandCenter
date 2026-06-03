"""LiteLLM-backed LLM client with tiered routing (ADR-005, ADR-008).

All app code MUST go through this module — never call provider SDKs directly.
"""
from acb_llm.client import LLMTier, complete, complete_with_tools

__all__ = ["LLMTier", "complete", "complete_with_tools"]
