"""Custom Apps · actions — manifest-declared dispatch (RFC §4.4/§4.7).

Locks ``execute_app_action`` in ``gateway.routes.apps.actions`` — the single
in-process dispatch function both the HTTP route (``call_app_action``) and a
parallel orchestrator-side tool wrapper call. Mirrors ``test_app_tools.py``'s
conventions: called directly as a plain async function, DB-touching seams
(``_get_db``/``get_app_or_404``/``_load_live_manifest``) and the Action
Broker (``propose``/``submit``) monkeypatched with fakes — no live Postgres.

Covers:
* Unknown action name (or unknown ``kind``) → 404 ``unknown_action``.
* ``storage.list``/``storage.get`` run for a plain viewer, no confirm/broker.
* ``storage.set`` auto-applies for a plain viewer (the app's-own-data design
  decision — actually exercised, not just described).
* ``tool.call``: an editor auto-applies through the broker at
  ``AuthorityTier.AUTONOMOUS`` (verified to resolve to ``AUTO_APPLY`` via the
  real ``decide_disposition``); a non-editor person AND an agent caller both
  always get ``AuthorityTier.SUGGEST`` regardless of ``ACTION_BROKER_ENFORCE``
  — no bypass for either caller type.
* ``readonly`` is derived from ``_TOOL_REGISTRY``, never the manifest's own
  (possibly lying) field — a manifest claiming ``readonly: true`` for an
  actually-destructive tool still goes through the broker, not a free execute.
* Draft-vs-live manifest isolation, using the REAL ``_load_live_manifest``
  (not mocked): an action only visible via the app row's own ``manifest``
  column (never actually published) is not callable.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from acb_auth import UserContext, UserRole
from action_broker import AuthorityTier, Disposition, decide_disposition
from fastapi import HTTPException
from gateway.routes.apps import _common, actions
from gateway.routes.apps.actions import (
    ActionCallRequest,
    call_app_action,
    execute_app_action,
)
from gateway.routes.apps.tools import ToolSpec

OWNER = UserContext(email="owner@fracktal.in", role=UserRole.EMPLOYEE)
VIEWER = UserContext(email="viewer@fracktal.in", role=UserRole.EMPLOYEE)
AGENT = UserContext(email="delivery-agent", role=UserRole.AGENT)


async def _never(_args: dict[str, Any]) -> dict[str, Any]:
    raise AssertionError("handler should not run on this path")


# ── Fakes ────────────────────────────────────────────────────────────────

class _Result:
    def __init__(
        self, one: Any = None, many: list[Any] | None = None, scalar: Any = None,
    ):
        self._one = one
        self._many = many if many is not None else []
        self._scalar = scalar

    def fetchone(self) -> Any:
        return self._one

    def fetchall(self) -> list[Any]:
        return self._many

    def scalar_one(self) -> Any:
        return self._scalar


class _FakeDB:
    """In-memory ``app_data`` stand-in — enough SQL-substring matching for
    storage.list/get/set. Shared by reference across calls within one test
    (like ``test_app_tools.py``'s ``_FakeDB``), so writes are visible to a
    later read in the same test."""

    def __init__(self, data: dict[tuple[str, str], Any] | None = None):
        self.data: dict[tuple[str, str], Any] = data if data is not None else {}
        self.committed = False
        self.closed = False

    async def execute(self, sql: Any, params: dict | None = None) -> _Result:
        s = str(sql)
        params = params or {}
        if "SELECT 1 FROM app_data" in s:
            key = (params["table"], params["key"])
            return _Result(one=(1,) if key in self.data else None)
        if "SELECT COUNT(*) FROM app_data" in s:
            return _Result(scalar=len(self.data))
        if "SELECT key, value FROM app_data" in s and "key = :key" in s:
            key = (params["table"], params["key"])
            if key not in self.data:
                return _Result(one=None)
            return _Result(one=SimpleNamespace(key=params["key"], value=self.data[key]))
        if "SELECT key, value FROM app_data" in s:
            table = params["table"]
            rows = [
                SimpleNamespace(key=k, value=v)
                for (t, k), v in sorted(self.data.items())
                if t == table
            ]
            return _Result(many=rows)
        if "INSERT INTO app_data" in s:
            key = (params["table"], params["key"])
            self.data[key] = params["value"]
            return _Result(one=SimpleNamespace(key=params["key"], value=params["value"]))
        return _Result()

    async def commit(self) -> None:
        self.committed = True

    async def close(self) -> None:
        self.closed = True


def _row(**overrides: Any) -> Any:
    defaults = {
        "id": "app-1", "live_version": 1, "owner_email": OWNER.email,
        "visibility": "org", "status": "live", "manifest": {},
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _patch_common(
    monkeypatch: pytest.MonkeyPatch, *, manifest: dict[str, Any],
    row: Any = None, tool_registry: dict[str, ToolSpec] | None = None,
    db: Any = None,
) -> tuple[Any, _FakeDB]:
    """Wire ``actions.py``'s DB-touching seams to fakes so a dispatch test
    needs neither a live Postgres nor the real Action Broker/Integration
    Registry."""
    row = row or _row()
    fake_db = db if db is not None else _FakeDB()

    async def _get_db() -> _FakeDB:
        return fake_db

    async def _get_app_or_404(_db: Any, _slug: str, _user: UserContext) -> Any:
        return row, []

    async def _load_live_manifest(_db: Any, _row: Any) -> dict[str, Any]:
        return manifest

    async def _common_get_db() -> _FakeDB:
        return _FakeDB()  # keeps record_app_audit best-effort + DB-free

    monkeypatch.setattr(actions, "_get_db", _get_db)
    monkeypatch.setattr(actions, "get_app_or_404", _get_app_or_404)
    monkeypatch.setattr(actions, "_load_live_manifest", _load_live_manifest)
    monkeypatch.setattr(_common, "_get_db", _common_get_db)
    if tool_registry is not None:
        monkeypatch.setattr(actions, "_TOOL_REGISTRY", tool_registry)
    return row, fake_db


def _refuse_broker(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail the test loudly if the dispatch reaches the Action Broker at
    all — used to prove the readonly/storage.set paths never do."""
    def _propose(**_kw: Any) -> None:
        raise AssertionError("must not reach the Action Broker")

    async def _submit(_p: Any) -> None:
        raise AssertionError("must not reach the Action Broker")

    monkeypatch.setattr(actions, "propose", _propose)
    monkeypatch.setattr(actions, "submit", _submit)


# ── Unknown action / kind ───────────────────────────────────────────────

async def test_unknown_action_is_404(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_common(monkeypatch, manifest={"actions": []})
    with pytest.raises(HTTPException) as exc:
        await execute_app_action("myapp", "nope", {}, VIEWER)
    assert exc.value.status_code == 404
    assert exc.value.detail["error"] == "unknown_action"


async def test_missing_actions_array_is_404(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_common(monkeypatch, manifest={"scopes": []})
    with pytest.raises(HTTPException) as exc:
        await execute_app_action("myapp", "get_low_stock", {}, VIEWER)
    assert exc.value.status_code == 404
    assert exc.value.detail["error"] == "unknown_action"


async def test_unknown_kind_is_404(monkeypatch: pytest.MonkeyPatch) -> None:
    manifest = {"actions": [
        {"name": "mystery", "kind": "storage.query", "table": "spools"},
    ]}
    _patch_common(monkeypatch, manifest=manifest)
    with pytest.raises(HTTPException) as exc:
        await execute_app_action("myapp", "mystery", {}, VIEWER)
    assert exc.value.status_code == 404
    assert exc.value.detail["error"] == "unknown_action"


# ── storage.list / storage.get — free execute for any viewer ───────────

async def test_storage_list_executes_for_plain_viewer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = {"actions": [
        {"name": "get_low_stock", "description": "...", "kind": "storage.list",
         "table": "spools", "readonly": True},
    ]}
    seed = {
        ("spools", "s1"): {"remaining_g": 10},
        ("spools", "s2"): {"remaining_g": 90},
    }
    _patch_common(monkeypatch, manifest=manifest, db=_FakeDB(dict(seed)))
    _refuse_broker(monkeypatch)

    resp = await execute_app_action("myapp", "get_low_stock", {}, VIEWER)
    assert resp == {"result": [
        {"key": "s1", "value": {"remaining_g": 10}},
        {"key": "s2", "value": {"remaining_g": 90}},
    ]}


async def test_storage_get_executes_for_plain_viewer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = {"actions": [
        {"name": "get_spool", "kind": "storage.get", "table": "spools",
         "params": {"key": {"type": "string"}}, "readonly": True},
    ]}
    seed = {("spools", "s1"): {"remaining_g": 10}}
    _patch_common(monkeypatch, manifest=manifest, db=_FakeDB(dict(seed)))
    _refuse_broker(monkeypatch)

    resp = await execute_app_action("myapp", "get_spool", {"key": "s1"}, VIEWER)
    assert resp == {"result": {"key": "s1", "value": {"remaining_g": 10}}}


async def test_storage_get_missing_key_is_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = {"actions": [
        {"name": "get_spool", "kind": "storage.get", "table": "spools"},
    ]}
    _patch_common(monkeypatch, manifest=manifest, db=_FakeDB())
    resp = await execute_app_action("myapp", "get_spool", {"key": "missing"}, VIEWER)
    assert resp == {"result": None}


async def test_storage_get_without_key_arg_is_422(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = {"actions": [
        {"name": "get_spool", "kind": "storage.get", "table": "spools"},
    ]}
    _patch_common(monkeypatch, manifest=manifest, db=_FakeDB())
    with pytest.raises(HTTPException) as exc:
        await execute_app_action("myapp", "get_spool", {}, VIEWER)
    assert exc.value.status_code == 422


# ── storage.set — auto-applies for ANY viewer (the app's own data) ─────

async def test_storage_set_auto_applies_for_plain_viewer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = {"actions": [
        {"name": "log_usage", "kind": "storage.set", "table": "spools",
         "params": {"key": {"type": "string"}, "value": {"type": "object"}},
         "readonly": False},
    ]}
    _, db = _patch_common(monkeypatch, manifest=manifest, db=_FakeDB())
    _refuse_broker(monkeypatch)

    resp = await execute_app_action(
        "myapp", "log_usage", {"key": "s1", "value": {"remaining_g": 5}}, VIEWER,
    )
    assert resp == {"result": {"key": "s1", "value": {"remaining_g": 5}}}
    assert db.data[("spools", "s1")] == json.dumps({"remaining_g": 5}, default=str)
    assert db.committed


# ── tool.call — editor auto-applies; everyone else always SUGGEST ──────

def _reorder_manifest() -> dict[str, Any]:
    return {
        "scopes": ["tool:clickup.create_task?list=42"],
        "actions": [
            {"name": "reorder", "description": "...", "kind": "tool.call",
             "tool": "clickup.create_task", "readonly": False},
        ],
    }


async def test_tool_call_editor_auto_applies_via_broker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spec = ToolSpec(integration="clickup", read_only=False, destructive=True,
                     open_world=True, handler=_never)
    _patch_common(
        monkeypatch, manifest=_reorder_manifest(),
        tool_registry={"clickup.create_task": spec},
    )  # default row.owner_email == OWNER.email -> can_edit(row, OWNER, []) is True

    proposed: list[dict[str, Any]] = []

    def _fake_propose(**kw: Any) -> SimpleNamespace:
        proposed.append(kw)
        return SimpleNamespace(**kw)

    async def _fake_submit(_proposal: Any) -> dict[str, Any]:
        return {"status": "applied", "ok": True,
                "result": {"provider_task_id": "T1"}}

    monkeypatch.setattr(actions, "propose", _fake_propose)
    monkeypatch.setattr(actions, "submit", _fake_submit)

    resp = await execute_app_action(
        "myapp", "reorder", {"title": "Reorder PLA"}, OWNER,
    )
    assert resp == {"result": {"provider_task_id": "T1"}}
    assert len(proposed) == 1
    assert proposed[0]["action"] == "app.clickup_create_task"     # namespaced
    assert proposed[0]["payload"] == {
        "args": {"title": "Reorder PLA", "list": "42"},           # constraint merged
    }
    assert proposed[0]["authority"] is AuthorityTier.AUTONOMOUS
    # The authority actually chosen must resolve to auto-apply, not just be
    # named AUTONOMOUS — verify against the real broker policy table.
    assert decide_disposition(
        AuthorityTier.AUTONOMOUS, destructive=True,
    ) is Disposition.AUTO_APPLY


@pytest.mark.parametrize("enforce_env", [None, "0", "1", "all", "app.clickup_create_task"])
@pytest.mark.parametrize("who", ["non_editor_person", "agent"])
async def test_tool_call_non_editor_or_agent_always_suggest(
    monkeypatch: pytest.MonkeyPatch, who: str, enforce_env: str | None,
) -> None:
    """No bypass, ever: a non-editor human OR any agent caller always gets
    ``SUGGEST`` (unconditional ``NEEDS_APPROVAL``), regardless of
    ``ACTION_BROKER_ENFORCE`` — a knob this dispatch surface deliberately
    does not consult (unlike ``cc.tools``'s per-tool enforce gate)."""
    if enforce_env is None:
        monkeypatch.delenv("ACTION_BROKER_ENFORCE", raising=False)
    else:
        monkeypatch.setenv("ACTION_BROKER_ENFORCE", enforce_env)

    spec = ToolSpec(integration="clickup", read_only=False, destructive=True,
                     open_world=True, handler=_never)
    _patch_common(
        monkeypatch, manifest=_reorder_manifest(),
        tool_registry={"clickup.create_task": spec},
    )

    caller = VIEWER if who == "non_editor_person" else AGENT
    proposed: list[dict[str, Any]] = []

    def _fake_propose(**kw: Any) -> SimpleNamespace:
        proposed.append(kw)
        return SimpleNamespace(**kw)

    async def _fake_submit(_proposal: Any) -> dict[str, Any]:
        return {"ok": True, "status": "pending",
                "disposition": "needs_approval", "action_id": "act-1"}

    monkeypatch.setattr(actions, "propose", _fake_propose)
    monkeypatch.setattr(actions, "submit", _fake_submit)

    resp = await execute_app_action("myapp", "reorder", {"title": "x"}, caller)
    assert resp == {"queued": True, "action_id": "act-1"}
    assert proposed[0]["authority"] is AuthorityTier.SUGGEST
    assert decide_disposition(
        AuthorityTier.SUGGEST, destructive=True,
    ) is Disposition.NEEDS_APPROVAL


# ── readonly is derived from _TOOL_REGISTRY, never the manifest's field ─

async def test_tool_call_readonly_manifest_claim_is_not_trusted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The manifest lies (``readonly: true``) for an actually-destructive
    tool (``_TOOL_REGISTRY``'s real ``read_only=False``). If the manifest's
    claim were trusted, dispatch would free-execute ``_never`` directly
    (raising AssertionError) instead of routing through the broker."""
    manifest = {
        "scopes": ["tool:clickup.create_task?list=42"],
        "actions": [
            {"name": "reorder", "kind": "tool.call", "tool": "clickup.create_task",
             "readonly": True},   # <- the lie
        ],
    }
    spec = ToolSpec(integration="clickup", read_only=False, destructive=True,
                     open_world=True, handler=_never)
    _patch_common(
        monkeypatch, manifest=manifest, tool_registry={"clickup.create_task": spec},
    )

    proposed: list[dict[str, Any]] = []

    def _fake_propose(**kw: Any) -> SimpleNamespace:
        proposed.append(kw)
        return SimpleNamespace(**kw)

    async def _fake_submit(_proposal: Any) -> dict[str, Any]:
        return {"ok": True, "status": "pending",
                "disposition": "needs_approval", "action_id": "act-2"}

    monkeypatch.setattr(actions, "propose", _fake_propose)
    monkeypatch.setattr(actions, "submit", _fake_submit)

    resp = await execute_app_action("myapp", "reorder", {"title": "x"}, VIEWER)
    assert resp == {"queued": True, "action_id": "act-2"}
    assert len(proposed) == 1


# ── Draft-vs-live manifest isolation ────────────────────────────────────

async def test_action_only_in_draft_manifest_is_not_callable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Uses the REAL ``_load_live_manifest`` (not mocked) — mirrors
    ``tools.py``'s own "scopes checked against LIVE manifest" precedent: an
    action visible only via the app row's own ``manifest`` column (the
    scaffold/edit-time copy) but absent from the published ``app_versions``
    row for ``live_version`` is not callable."""
    draft_manifest = {"scopes": [], "actions": [
        {"name": "get_low_stock", "kind": "storage.list", "table": "spools"},
    ]}
    live_manifest = {"scopes": [], "actions": []}   # what was actually published
    row = _row(manifest=draft_manifest, live_version=1)

    class _VersionDB:
        async def execute(self, sql: Any, params: dict | None = None) -> Any:
            assert (params or {}).get("version") == 1
            return SimpleNamespace(
                fetchone=lambda: SimpleNamespace(manifest=live_manifest),
            )

        async def commit(self) -> None:
            pass

        async def close(self) -> None:
            pass

    async def _get_db() -> _VersionDB:
        return _VersionDB()

    async def _get_app_or_404(_db: Any, _slug: str, _user: UserContext) -> Any:
        return row, []

    monkeypatch.setattr(actions, "_get_db", _get_db)
    monkeypatch.setattr(actions, "get_app_or_404", _get_app_or_404)
    # `_load_live_manifest` is deliberately left as the REAL tools.py function.

    with pytest.raises(HTTPException) as exc:
        await execute_app_action("myapp", "get_low_stock", {}, VIEWER)
    assert exc.value.status_code == 404
    assert exc.value.detail["error"] == "unknown_action"


# ── The HTTP route is a thin, behavior-identical wrapper ───────────────

async def test_route_delegates_to_execute_app_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manifest = {"actions": [
        {"name": "get_low_stock", "kind": "storage.list", "table": "spools"},
    ]}
    seed = {("spools", "s1"): {"remaining_g": 10}}
    _patch_common(monkeypatch, manifest=manifest, db=_FakeDB(dict(seed)))

    resp = await call_app_action(
        "myapp", "get_low_stock", ActionCallRequest(), user=VIEWER,
    )
    assert resp == {"result": [{"key": "s1", "value": {"remaining_g": 10}}]}
