"""Phase 0.2/0.3 regression tests (multi_agent_orchestration.md).

0.2 — the injected-tools addendum was scope-blind by construction: a scoped
agent's prompt described ~30 tools (including ``call_agent`` and the agent
registry) while its actual toolset had 11 — the model was misinformed, not
confused. The addendum now takes the agent's RESOLVED effective scope and
omits sections for tools the agent does not have.

0.3 — a ``tool_scope`` entry matching no injectable platform tool silently
no-oped (the live ``"ask_user"`` typo — the native SDK tool's name, not an
injected tool). Each unknown entry now logs a warning.
"""
from __future__ import annotations

from typing import Any

import orchestrator._tool_injection as ti
from orchestrator._tool_injection import (
    _build_injected_tools_addendum,
    _resolve_injected_scope,
)


def _scoped(*extra: str) -> str:
    resolved = _resolve_injected_scope(list(extra) or ["web_search"])
    assert resolved is not None
    return _build_injected_tools_addendum(effective_scope=frozenset(resolved))


def test_scoped_addendum_omits_absent_tool_sections():
    text = _scoped("web_search")
    # Floor tools stay documented…
    for present in ("### Web access", "### Workspace", "write_artifact",
                    "### Human-in-the-Loop"):
        assert present in text
    # …while non-floor, non-scoped sections are gone.
    for absent in ("### Conversation history", "### GitHub code search",
                   "### Runtime dependencies"):
        assert absent not in text, f"{absent} described but not injected"


def test_scoped_addendum_includes_added_specialist_sections():
    text = _scoped("query_history", "github_search")
    assert "### Conversation history" in text
    assert "### GitHub code search" in text
    assert "### Runtime dependencies" not in text


def test_delegation_rides_the_floor_into_every_scoped_addendum():
    # The email-hand-off regression: a specialist scope must still yield a
    # prompt that documents delegation AND the registry of delegatable agents.
    text = _scoped("web_search")
    assert "### Inter-agent delegation" in text
    assert "call_agent(" in text
    assert "Registered agents" in text


def test_no_delegation_scope_omits_delegation_and_registry():
    # Defensive: if the floor ever changes, an effective scope without the
    # delegation family must not describe it (that was the original lie).
    no_delegation = frozenset({
        "web_search", "fetch_page", "write_artifact", "share_artifact",
        "manage_todo_list", "ask_questions", "run_diagnostics", "get_errors",
        "save_note", "recall_notes",
    })
    text = _build_injected_tools_addendum(effective_scope=no_delegation)
    assert "### Inter-agent delegation" not in text
    assert "Registered agents" not in text
    compact = _build_injected_tools_addendum(
        is_sub_agent=True, effective_scope=no_delegation,
    )
    assert "call_agent(" not in compact


def test_unscoped_addendum_unchanged_and_complete():
    text = _build_injected_tools_addendum()
    for section in ("### Inter-agent delegation", "### Web access",
                    "### Conversation history", "### GitHub code search",
                    "### Runtime dependencies", "### Workspace"):
        assert section in text


class _RecLog:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def warning(self, event: str, **kw: Any) -> None:
        self.events.append((event, kw))

    def __getattr__(self, _name: str) -> Any:  # info/debug/error no-ops
        return lambda *a, **k: None


def test_unknown_scope_entry_warns(monkeypatch):
    rec = _RecLog()
    monkeypatch.setattr(ti, "_log", rec)
    ti._inject_agent_tools([], tool_scope=["ask_user", "web_search"])
    unknown = [kw for ev, kw in rec.events
               if ev == "executor.tool_scope_unknown_entry"]
    assert unknown and unknown[0].get("entry") == "ask_user", (
        "a scope entry matching no injectable tool must warn (it no-ops)"
    )


def test_known_scope_entries_do_not_warn(monkeypatch):
    rec = _RecLog()
    monkeypatch.setattr(ti, "_log", rec)
    ti._inject_agent_tools([], tool_scope=["web_search", "query_history"])
    assert not [ev for ev, _ in rec.events
                if ev == "executor.tool_scope_unknown_entry"]
