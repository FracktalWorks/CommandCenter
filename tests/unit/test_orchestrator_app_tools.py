"""Custom Apps → orchestrator tools (Phase 3b, RFC §4.7).

Locks ``orchestrator.app_tools``: dynamic per-action tool functions built
from a granted app's manifest, wired into ``_inject_agent_tools()``'s SAFE
pipeline (never the unsafe ``_load_specialist_agents_as_tools()`` path).
"""
from __future__ import annotations

import inspect

import pytest

from orchestrator import app_tools


def _action(**over):
    base = {"name": "log_usage", "kind": "storage.set", "table": "spools",
            "description": "Log filament usage",
            "params": {"key": {"type": "string"}, "value": {"type": "object"}}}
    base.update(over)
    return base


# ── _make_action_tool: naming, signature, docstring ─────────────────────────

def test_tool_name_is_namespaced_by_slug_and_action():
    fn = app_tools._make_action_tool("filament-tracker", _action(), "inv-bot")
    assert fn.__name__ == "app_filament_tracker_log_usage"


def test_signature_reflects_declared_params_not_kwargs_impl():
    fn = app_tools._make_action_tool("filament-tracker", _action(), "inv-bot")
    sig = inspect.signature(fn)
    assert list(sig.parameters) == ["key", "value"]
    assert sig.parameters["key"].annotation is str
    assert sig.parameters["value"].annotation is dict
    assert inspect.iscoroutinefunction(fn)


def test_no_params_action_gets_empty_signature():
    fn = app_tools._make_action_tool(
        "filament-tracker",
        _action(name="get_low_stock", kind="storage.list", params={}),
        "inv-bot",
    )
    assert list(inspect.signature(fn).parameters) == []


def test_docstring_carries_app_and_action_description():
    fn = app_tools._make_action_tool("filament-tracker", _action(), "inv-bot")
    assert "filament-tracker" in fn.__doc__
    assert "Log filament usage" in fn.__doc__


# ── Loop-closure-per-iteration correctness ──────────────────────────────────

def test_factory_avoids_loop_closure_bug():
    """Building N tools via _make_action_tool in a loop must NOT have every
    tool capture the LAST iteration's slug/action — the classic Python
    closure-in-loop bug this factory pattern exists to avoid."""
    actions = [_action(name="a"), _action(name="b"), _action(name="c")]
    fns = [app_tools._make_action_tool("s", a, "bot") for a in actions]
    assert [f.__name__ for f in fns] == [
        "app_s_a", "app_s_b", "app_s_c",
    ]


# ── _action_risk: derived, never manifest-trusted ───────────────────────────

def test_storage_list_get_are_readonly():
    for kind in ("storage.list", "storage.get"):
        risk = app_tools._action_risk("s", _action(kind=kind))
        assert risk["read_only"] is True
        assert risk["open_world"] is False


def test_storage_set_is_write_but_not_open_world():
    risk = app_tools._action_risk("s", _action(kind="storage.set"))
    assert risk["read_only"] is False
    assert risk["destructive"] is False
    assert risk["open_world"] is False


def test_tool_call_derives_from_real_tool_registry(monkeypatch):
    from dataclasses import dataclass

    @dataclass(frozen=True)
    class _Spec:
        integration: str
        read_only: bool
        destructive: bool
        open_world: bool
        handler: object = None

    fake_registry = {"clickup.create_task": _Spec("clickup", False, True, True)}
    monkeypatch.setattr(
        "gateway.routes.apps.tools._TOOL_REGISTRY", fake_registry,
    )
    risk = app_tools._action_risk(
        "s", _action(kind="tool.call", tool="clickup.create_task"),
    )
    assert risk == {
        "read_only": False, "destructive": True,
        "idempotent": False, "open_world": True,
    }


def test_tool_call_unknown_tool_is_conservative():
    risk = app_tools._action_risk(
        "s", _action(kind="tool.call", tool="not.a.real.tool"),
    )
    assert risk["destructive"] is True
    assert risk["open_world"] is True


# ── load_app_action_tools: filtering + skip-malformed ───────────────────────

def test_load_skips_malformed_and_unknown_kind_actions(monkeypatch):
    monkeypatch.setattr(
        app_tools, "_granted_live_apps",
        lambda agent_name: [
            ("s", {"actions": [
                _action(name="ok"),
                _action(name="BadName!"),           # fails ACTION_NAME_RE
                _action(name="bad_kind", kind="storage.query"),  # not in ACTION_KINDS
                "not-a-dict",                        # malformed entry
            ]}),
        ],
    )
    tools = app_tools.load_app_action_tools("inv-bot")
    assert [t.__name__ for t in tools] == ["app_s_ok"]


def test_load_returns_empty_when_no_grants(monkeypatch):
    monkeypatch.setattr(app_tools, "_granted_live_apps", lambda agent_name: [])
    assert app_tools.load_app_action_tools("inv-bot") == []


def test_load_skips_apps_with_no_actions_array(monkeypatch):
    monkeypatch.setattr(
        app_tools, "_granted_live_apps",
        lambda agent_name: [("s", {"name": "S"})],
    )
    assert app_tools.load_app_action_tools("inv-bot") == []


# ── _run: agent identity, queued vs. immediate result, error handling ───────

@pytest.mark.asyncio
async def test_run_passes_bare_agent_name_not_prefixed(monkeypatch):
    """can_view() reconstructs f"agent:{email}" itself to match a stored
    agent:<name> grant — email must be the BARE agent name, never
    pre-prefixed, or every grant check double-prefixes and silently fails."""
    captured = {}

    async def _fake_execute(slug, action_name, args, user):
        captured["email"] = user.email
        captured["role"] = user.role
        return {"result": "ok"}

    monkeypatch.setattr(
        "gateway.routes.apps.actions.execute_app_action", _fake_execute,
    )
    fn = app_tools._make_action_tool(
        "filament-tracker",
        _action(name="get_low_stock", kind="storage.list", params={}),
        "inventory-bot",
    )
    result = await fn()
    from acb_auth import UserRole
    assert captured["email"] == "inventory-bot"
    assert captured["role"] is UserRole.AGENT
    assert result == "ok"


@pytest.mark.asyncio
async def test_run_reports_queued_result_as_text(monkeypatch):
    async def _fake_execute(slug, action_name, args, user):
        return {"queued": True, "action_id": "abc123"}

    monkeypatch.setattr(
        "gateway.routes.apps.actions.execute_app_action", _fake_execute,
    )
    fn = app_tools._make_action_tool(
        "s", _action(kind="tool.call", tool="clickup.create_task", params={}),
        "bot",
    )
    result = await fn()
    assert "abc123" in result
    assert "review" in result.lower()


@pytest.mark.asyncio
async def test_run_never_raises_reports_failure_as_text(monkeypatch):
    async def _fake_execute(slug, action_name, args, user):
        raise RuntimeError("app has no live version")

    monkeypatch.setattr(
        "gateway.routes.apps.actions.execute_app_action", _fake_execute,
    )
    fn = app_tools._make_action_tool(
        "s", _action(name="get_low_stock", kind="storage.list", params={}), "bot",
    )
    result = await fn()
    assert "failed" in result.lower()
    assert "app_s_get_low_stock" in result


# ── _granted_live_apps: best-effort, never raises ───────────────────────────

def test_granted_live_apps_swallows_db_errors(monkeypatch):
    def _boom():
        raise RuntimeError("no db in unit tests")

    monkeypatch.setattr("acb_graph.get_session", _boom)
    assert app_tools._granted_live_apps("inv-bot") == []
