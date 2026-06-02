"""LangGraph state machine harness (WBS 0.5, Phase 0 skeleton).

Three-node pipeline mirroring `pull_agent.answer()` for now:

    start -> retrieve -> generate -> guard -> END

Future phases plug Deep Agents sub-agents and HITL nodes into the same graph.
"""
from __future__ import annotations

from typing import TypedDict

from langgraph.graph import END, StateGraph

from acb_audit import AuditEvent, record
from acb_graph import get_session
from acb_llm import LLMTier, complete
from acb_llm.guardrails import CitationError, repair_citations, require_citations

from orchestrator.retrieval import ContextHit, format_context, retrieve


class BrainState(TypedDict, total=False):
    user_query: str
    user_email: str
    hits: list[ContextHit]
    context_block: str
    raw_answer: str
    answer: str
    citations: list[str]
    blocked: bool


_SYSTEM_GROUNDED = (
    "You are the AI Company Brain Pull agent. Answer using ONLY the supplied "
    "Context. Every factual claim must end with one or more citation tokens of "
    "the form [entity:uuid] COPIED EXACTLY from the Context list \u2014 UUIDs are "
    "36 characters including 4 hyphens; do NOT shorten or regenerate them. "
)
_SYSTEM_UNGROUNDED = (
    "You are the AI Company Brain Pull agent. No private context matched this "
    "query; answer from general knowledge and say so. Keep it concise."
)


# ----- node implementations ------------------------------------------------

def _retrieve_node(state: BrainState) -> BrainState:
    with get_session() as s:
        hits = retrieve(s, state["user_query"])
    return {"hits": hits, "context_block": format_context(hits)}


async def _generate_node(state: BrainState) -> BrainState:
    hits = state.get("hits") or []
    if hits:
        system = _SYSTEM_GROUNDED
        user_content = f"Context:\n{state['context_block']}\n\nQuestion: {state['user_query']}"
    else:
        system = _SYSTEM_UNGROUNDED
        user_content = state["user_query"]

    raw = await complete(
        tier=LLMTier.TIER_2,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
    )
    return {"raw_answer": raw}


def _guard_node(state: BrainState) -> BrainState:
    from acb_llm.guardrails import CITATION_RE

    raw = state.get("raw_answer", "")
    hits = state.get("hits") or []
    if not hits:
        return {"answer": raw, "citations": [], "blocked": False}
    repaired = repair_citations(raw, [(h.kind, str(h.id)) for h in hits])
    try:
        validated = require_citations(repaired)
    except CitationError as exc:
        record(
            AuditEvent(
                actor="agent:pull",
                action="guardrail_block",
                target="agent:pull",
                payload={"reason": str(exc), "raw": raw},
            )
        )
        return {
            "answer": "I drafted an answer but it failed the citation guardrail; refusing to surface.",
            "citations": [],
            "blocked": True,
        }
    cites = sorted({m.group(0) for m in CITATION_RE.finditer(validated)})
    return {"answer": validated, "citations": cites, "blocked": False}


# ----- graph builder -------------------------------------------------------

def build_graph() -> object:
    """Compile and return the Phase-0 Pull StateGraph."""
    g: StateGraph = StateGraph(BrainState)
    g.add_node("retrieve", _retrieve_node)
    g.add_node("generate", _generate_node)
    g.add_node("guard", _guard_node)
    g.set_entry_point("retrieve")
    g.add_edge("retrieve", "generate")
    g.add_edge("generate", "guard")
    g.add_edge("guard", END)
    return g.compile()


__all__ = ["BrainState", "build_graph"]