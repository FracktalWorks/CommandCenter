"""Persistent broker handlers execute a QUEUED task write on approval (BO-1/A2).

The enqueue → approve → execute loop end-to-end: a queued ClickUp write is
approved via ``action_broker.approve``, which dispatches to the registered
handler, which re-resolves the provider (mocked here) and runs the raw write.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import gateway.routes.tasks.broker_handlers as bh


class _FakeProvider:
    def __init__(self):
        self.calls: list = []

    async def _raw_create_task(self, project_ref, body):
        self.calls.append(("create_task", project_ref, body))
        return {"provider_task_id": "T9"}

    async def _raw_update_task(self, provider_task_id, body):
        self.calls.append(("update_task", provider_task_id, body))
        return {"provider_task_id": provider_task_id}

    async def _raw_create_project(self, name, space_id, folder_id):
        self.calls.append(("create_project", name, space_id, folder_id))
        return {"id": "L1"}


def _prop(action, payload):
    return SimpleNamespace(action=action, payload=payload)


def _patch_resolve(monkeypatch, provider):
    async def _resolve(account_id):
        provider.resolved_with = account_id
        return provider
    monkeypatch.setattr(bh, "_resolve_provider", _resolve)


def test_handler_dispatches_create_task(monkeypatch):
    fake = _FakeProvider()
    _patch_resolve(monkeypatch, fake)
    res = asyncio.run(bh._handle_task_write(_prop(
        "clickup.create_task",
        {"account_id": "acc-1", "args": {"project_ref": "list-5", "body": {"name": "x"}}},
    )))
    assert res == {"provider_task_id": "T9"}
    assert fake.calls == [("create_task", "list-5", {"name": "x"})]
    assert fake.resolved_with == "acc-1"


def test_handler_dispatches_create_project(monkeypatch):
    fake = _FakeProvider()
    _patch_resolve(monkeypatch, fake)
    res = asyncio.run(bh._handle_task_write(_prop(
        "clickup.create_project",
        {"account_id": "a", "args": {"name": "P", "space_id": "s1", "folder_id": None}},
    )))
    assert res == {"id": "L1"}
    assert fake.calls == [("create_project", "P", "s1", None)]


def test_handler_refuses_without_account_id(monkeypatch):
    fake = _FakeProvider()
    _patch_resolve(monkeypatch, fake)
    try:
        asyncio.run(bh._handle_task_write(_prop(
            "clickup.create_task", {"args": {"project_ref": "l", "body": {}}})))
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "account_id" in str(e)
    assert fake.calls == []  # never resolved / wrote


def test_handler_refuses_unknown_action(monkeypatch):
    fake = _FakeProvider()
    _patch_resolve(monkeypatch, fake)
    try:
        asyncio.run(bh._handle_task_write(_prop("clickup.delete_universe", {"account_id": "a"})))
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "no writer" in str(e)


def test_register_wires_all_three_actions():
    import action_broker
    from action_broker.broker import _HANDLERS
    action_broker.clear_action_handlers()
    bh.register_task_broker_handlers()
    assert set(_HANDLERS) == {
        "clickup.create_task", "clickup.update_task", "clickup.create_project",
    }
    action_broker.clear_action_handlers()


# ── end-to-end: enqueue → approve → handler executes ─────────────────────────

class _Result:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return list(self._rows)


class _FakeSession:
    def __init__(self, rows):
        self.rows = rows
        self.updates: list = []

    def execute(self, stmt, params=None):
        sql = str(stmt)
        if sql.lstrip().upper().startswith("UPDATE"):
            self.updates.append(params)
        if sql.lstrip().upper().startswith("SELECT"):
            return _Result(self.rows)
        return _Result([])

    def add(self, *a, **k):
        pass

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_approve_runs_the_task_handler_end_to_end(monkeypatch):
    import acb_graph
    import action_broker

    fake_provider = _FakeProvider()
    _patch_resolve(monkeypatch, fake_provider)

    row = {
        "id": "11111111-1111-1111-1111-111111111111",
        "actor": "tasks:clickup:ws:9",
        "action": "clickup.create_task",
        "target": "list:5",
        "payload": {"account_id": "acc-1",
                    "args": {"project_ref": "list-5", "body": {"name": "Hi"}}},
        "authority": "suggest+apply",
        "destructive": True,
        "disposition": "needs_approval",
        "status": "pending",
    }
    session = _FakeSession([row])
    monkeypatch.setattr(acb_graph, "get_session", lambda: session)

    action_broker.clear_action_handlers()
    bh.register_task_broker_handlers()

    res = asyncio.run(action_broker.approve(str(row["id"]), "user:vijay"))

    assert res["ok"] is True and res["status"] == "applied"
    # the real write ran via the persistent handler
    assert fake_provider.calls == [("create_task", "list-5", {"name": "Hi"})]
    # and the row was transitioned to applied
    assert any(u and u.get("status") == "applied" for u in session.updates)
    action_broker.clear_action_handlers()
