"""Persistent broker handlers execute a QUEUED task write on approval (BO-1/A2).

The enqueue → approve → execute loop end-to-end: a queued ClickUp write is
approved via ``action_broker.approve``, which dispatches to the registered
handler, which re-resolves the provider (mocked here) and runs the raw write.
"""
from __future__ import annotations

import ast
import asyncio
import pathlib
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

    async def _raw_delete_task(self, provider_task_id):
        self.calls.append(("delete_task", provider_task_id))
        # The real writer returns None — a delete has nothing to report back.
        return None

    async def _raw_archive_task(self, provider_task_id, archived):
        self.calls.append(("archive_task", provider_task_id, archived))
        return None

    async def _raw_create_project(self, name, space_id, folder_id):
        self.calls.append(("create_project", name, space_id, folder_id))
        return {"id": "L1"}

    async def _raw_create_folder(self, name, space_id):
        self.calls.append(("create_folder", name, space_id))
        return {"id": "F1"}


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


def test_handler_dispatches_create_folder(monkeypatch):
    fake = _FakeProvider()
    _patch_resolve(monkeypatch, fake)
    res = asyncio.run(bh._handle_task_write(_prop(
        "clickup.create_folder",
        {"account_id": "a", "args": {"name": "F", "space_id": "s1"}},
    )))
    assert res == {"id": "F1"}
    assert fake.calls == [("create_folder", "F", "s1")]


def test_register_wires_every_writer_action():
    """Registration is derived from ``_WRITERS`` — every entry gets a handler and
    nothing else does. Says nothing about which actions `providers.py` gates;
    that is the fence below."""
    import action_broker
    from action_broker.broker import _HANDLERS
    action_broker.clear_action_handlers()
    bh.register_task_broker_handlers()
    assert set(_HANDLERS) == set(bh._WRITERS)
    assert _HANDLERS, "registration wired nothing — the fence would be vacuous"
    action_broker.clear_action_handlers()


# ── the derived fence (BO-1a): a gated action with no handler fails HERE ──────

_PROVIDERS_PY = (
    pathlib.Path(bh.__file__).resolve().parent / "providers.py"
)


def _gated_action_names() -> set[str]:
    """Every literal action name passed to a ``…._broker_gate(...)`` call in
    ``providers.py``, collected from its AST (never executed, never imported)."""
    tree = ast.parse(_PROVIDERS_PY.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "_broker_gate"):
            continue
        if not node.args:
            continue
        first = node.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            names.add(first.value)
    return names


def test_every_gated_provider_action_has_a_writer():
    """Every literal action name at a ``_broker_gate`` call site in
    ``routes/tasks/providers.py`` has a ``_WRITERS`` entry — so a queued write
    can actually execute on approval instead of landing in
    ``broker.execute()``'s no-handler branch and marking the row ``failed``.

    What this proves and what it does NOT (state the limits, or the fence gets
    trusted for more than it checks):

    * It is **blind to reachability**. A gated call site that no code path can
      reach still counts, and a handler for a dead action still satisfies it.
    * It is **blind to a non-literal action name** — a variable, an f-string or
      a name built at runtime is silently skipped, so it cannot see a gate whose
      action is computed.
    * It is **scoped to `providers.py` only**. `routes/crm/broker_handlers.py`
      has its own `broker_gate`, and `routes/apps/tools.py` derives action names
      through `_broker_action_name`; neither surface is covered here.
    """
    gated = _gated_action_names()
    # Non-emptiness is the fence's own fence: an AST walk that stops matching
    # (a renamed gate, a changed call shape) would otherwise pass vacuously.
    assert gated, "no _broker_gate call sites found — the AST walk went blind"
    missing = gated - set(bh._WRITERS)
    assert not missing, (
        f"gated in providers.py with no _WRITERS entry: {sorted(missing)}"
    )


def test_the_gated_payload_carries_every_arg_its_writer_reads(monkeypatch):
    """The other half of BO-1a #1: a handler reads `args[k] for k in keys`, so
    the gate's `audit_payload` at that call site must already carry those keys.
    `clickup.archive_task`'s second arg (`archived`) is the one the four-entry
    map never carried — assert the payload shape rather than assuming it."""
    from gateway.routes.tasks.providers import ClickUpProvider

    seen: dict[str, dict] = {}

    async def _capture(self, action, target, audit_payload, do_write):
        seen[action] = audit_payload
        return {}

    monkeypatch.setattr(ClickUpProvider, "_broker_gate", _capture)
    prov = ClickUpProvider(token="tok", workspace_id="ws1", account_id="acc-1")

    asyncio.run(prov.delete_task("T1"))
    asyncio.run(prov.archive_task("T1", True))

    for action, payload in seen.items():
        keys = bh._WRITERS[action][1]
        assert set(payload["args"]) == set(keys), action
        assert payload["account_id"] == "acc-1"
    assert seen["clickup.archive_task"]["args"] == {
        "provider_task_id": "T1", "archived": True,
    }
    assert seen["clickup.delete_task"]["args"] == {"provider_task_id": "T1"}


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


def _approve_queued(monkeypatch, provider, action, args):
    """Run one enqueue→approve→execute cycle over a queued ``pending_actions``
    row (shape as ``_load_proposal`` reads it) and return approve's result."""
    import acb_graph
    import action_broker

    _patch_resolve(monkeypatch, provider)
    row = {
        "id": "22222222-2222-2222-2222-222222222222",
        "actor": "tasks:clickup:ws:9",
        "action": action,
        "target": "task:T1",
        "payload": {"account_id": "acc-1", "args": args},
        "authority": "suggest+apply",
        "destructive": True,
        "disposition": "needs_approval",
        "status": "pending",
    }
    session = _FakeSession([row])
    monkeypatch.setattr(acb_graph, "get_session", lambda: session)

    action_broker.clear_action_handlers()
    bh.register_task_broker_handlers()
    try:
        return asyncio.run(action_broker.approve(str(row["id"]), "user:vijay")), session
    finally:
        action_broker.clear_action_handlers()


def test_approving_a_queued_delete_ends_applied_not_failed(monkeypatch):
    """BO-1a's actual bug: before the `_WRITERS` entry existed this approval fell
    into `broker.execute()`'s no-handler branch and the row was marked `failed`.
    A `_raw_delete_task` returning None must still count as applied."""
    fake_provider = _FakeProvider()
    res, session = _approve_queued(
        monkeypatch, fake_provider, "clickup.delete_task",
        {"provider_task_id": "T1"},
    )

    assert res["ok"] is True and res["status"] == "applied"
    assert fake_provider.calls == [("delete_task", "T1")]
    assert any(u and u.get("status") == "applied" for u in session.updates)
    assert not any(u and u.get("status") == "failed" for u in session.updates)


def test_approving_a_queued_archive_carries_the_archived_flag(monkeypatch):
    """The archive twin — `archived` is the arg the four-entry map never carried,
    so assert it reaches the provider rather than only that the row applied."""
    fake_provider = _FakeProvider()
    res, session = _approve_queued(
        monkeypatch, fake_provider, "clickup.archive_task",
        {"provider_task_id": "T1", "archived": True},
    )

    assert res["ok"] is True and res["status"] == "applied"
    assert fake_provider.calls == [("archive_task", "T1", True)]
    assert not any(u and u.get("status") == "failed" for u in session.updates)
