"""Golden trajectory: tool-addendum drift guard (map B2/B3 gap).

The addendum in `_build_injected_tools_addendum` is hand-written prose telling
every Copilot-SDK agent which platform tools exist. The core module map flags it
as "hand-maintained prose (drift risk vs actual tools)" — a tool can be injected
into the agent (`_inject_agent_tools`) but never described, so the agent gets a
capability with zero usage guidance. That is exactly what had happened to
`emit_generative_ui` (injected, undocumented) until this guard was added.

This eval makes drift impossible to ship silently: every platform tool that is
actually injected MUST appear (by name) in both the full and the compact
(sub-agent) addendum. The mandatory HITL tools must be present too.

Not a byte-for-byte lock (the prose is deliberately editable) — a *coverage*
lock. If someone adds a tool to the injection list without documenting it, or
removes a documented tool's description, this fails CI.

See specs/runtime_agent_effectiveness_2026-07.md and core_module_map.md (B2/B3).
"""
from __future__ import annotations

from orchestrator.executor import _build_injected_tools_addendum

# The platform tools _inject_agent_tools appends to every agent (executor.py
# ~928-1026). These are the names an agent will see as callable tools, so each
# MUST be described in the addendum or the agent has no guidance for it.
INJECTED_PLATFORM_TOOLS = {
    "call_agent", "call_agents_parallel", "call_agent_background",
    "web_search", "fetch_page",
    "write_artifact", "share_artifact", "emit_generative_ui",
    "remember", "recall_timeline", "save_memory", "save_episode",
    "manage_todo_list", "ask_questions",
    "get_errors", "run_diagnostics", "install_dependency",
    "save_note", "recall_notes", "query_history",
    "github_search", "github_repo_search",
}


def test_full_addendum_documents_every_injected_tool():
    text = _build_injected_tools_addendum(is_sub_agent=False)
    missing = sorted(t for t in INJECTED_PLATFORM_TOOLS if t not in text)
    assert not missing, f"injected but undocumented in full addendum: {missing}"


def test_compact_addendum_documents_every_injected_tool():
    text = _build_injected_tools_addendum(is_sub_agent=True)
    missing = sorted(t for t in INJECTED_PLATFORM_TOOLS if t not in text)
    assert not missing, f"injected but undocumented in compact addendum: {missing}"


def test_hitl_tools_present_in_full_addendum():
    """ask_user (native blocking) + ask_questions must be documented — they drive
    the ElicitationCard and text alone does nothing."""
    text = _build_injected_tools_addendum(is_sub_agent=False)
    assert "ask_user" in text
    assert "ask_questions" in text


def test_run_diagnostics_action_verb_alias_documented():
    """run_diagnostics exists because models under-call the noun-named get_errors;
    the addendum must name run_diagnostics (the alias that gets called)."""
    text = _build_injected_tools_addendum(is_sub_agent=False)
    assert "run_diagnostics" in text
