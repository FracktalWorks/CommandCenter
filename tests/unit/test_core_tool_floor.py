"""Unit tests — every agent keeps a guaranteed standard toolset (2026-07-16).

A per-agent ``config.json: tool_scope`` narrows which PLATFORM tools the
executor injects.  Previously a scope could omit the essentials — e.g. a scope
without ``write_artifact`` left the agent with no clean file-write tool, so it
resorted to fragile shell heredocs (echo/printf/base64), burned its output
budget on shell escaping, and truncated mid-write.

``_resolve_injected_scope`` now UNIONs any scope with the core floor
(``_CORE_STANDARD_TOOL_NAMES``) so the baseline — write a file, todo, web
search, clarify, diagnostics, notes — is present no matter how a scope was
written, while a scope can still ADD specialist tools on top.
"""
from __future__ import annotations

from orchestrator._tool_injection import (
    _CORE_STANDARD_TOOL_NAMES,
    _resolve_injected_scope,
)


def test_no_scope_injects_everything() -> None:
    # None / empty scope → sentinel None ("inject all"), unchanged behaviour.
    assert _resolve_injected_scope(None) is None
    assert _resolve_injected_scope([]) is None


def test_restrictive_scope_still_gets_the_core_floor() -> None:
    # A scope naming only a specialist tool must NOT strip the basics.
    resolved = _resolve_injected_scope(["query_history"])
    assert resolved is not None
    assert "query_history" in resolved  # the specialist survives
    # The whole guaranteed baseline is present too.
    assert _CORE_STANDARD_TOOL_NAMES <= resolved


def test_core_covers_the_tools_a_user_expects() -> None:
    # The essentials the user named — todo, write file, web search — plus the
    # close companions any agent needs.
    for essential in (
        "write_artifact",
        "manage_todo_list",
        "web_search",
        "fetch_page",
        "ask_questions",
        "save_note",
        "recall_notes",
    ):
        assert essential in _CORE_STANDARD_TOOL_NAMES


def test_scope_union_is_additive_not_replacing() -> None:
    resolved = _resolve_injected_scope(["write_artifact"])
    assert resolved is not None
    # Even a scope that only names one core tool yields the FULL core, not just
    # that one — the floor is unconditional.
    assert _CORE_STANDARD_TOOL_NAMES <= resolved
    assert "web_search" in resolved
