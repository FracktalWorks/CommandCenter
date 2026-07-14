"""Archive-instead-of-delete back-propagation to ClickUp.

A delete in the app removes the task locally but ARCHIVES its ClickUp
counterpart (recoverable there) rather than hard-deleting it; an explicit
Archive/Restore mirrors the same archived flag upstream. These tests lock:

  * ClickUpProvider.archive_task routes through the broker gate and PUTs
    {archived: bool}; a 404 is treated as success (already gone);
  * items._delete_upstream archives upstream (does NOT call delete_task);
  * items._archive_upstream mirrors the flag for SYNCED rows only, best-effort
    (a provider error never raises), and reuses one provider per account.
"""
from __future__ import annotations

import asyncio
import types

import pytest

from gateway.routes.tasks.providers import ClickUpProvider


def _provider() -> ClickUpProvider:
    return ClickUpProvider(token="tok", workspace_id="ws1")


class _FakeResp:
    def __init__(self, status_code: int):
        self.status_code = status_code
        self.text = ""


class _FakeHttp:
    """A stand-in async httpx.AsyncClient recording the PUT it receives."""

    def __init__(self, status_code: int, sink: list):
        self._status = status_code
        self._sink = sink

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def put(self, url, headers=None, json=None):
        self._sink.append({"url": url, "json": json})
        return _FakeResp(self._status)


def _patch_http(monkeypatch, status_code: int, sink: list):
    import gateway.routes.tasks.providers as prov

    monkeypatch.setattr(
        prov.httpx, "AsyncClient",
        lambda *a, **k: _FakeHttp(status_code, sink),
    )


def _no_db(monkeypatch):
    """Keep the broker's audit off a real DB (record() catches the error)."""
    import acb_graph

    def _raise():
        raise ConnectionError("no db in test")

    monkeypatch.setattr(acb_graph, "get_session", _raise)


def test_archive_task_puts_archived_true(monkeypatch):
    monkeypatch.delenv("ACTION_BROKER_ENFORCE", raising=False)
    _no_db(monkeypatch)
    sink: list = []
    _patch_http(monkeypatch, 200, sink)

    asyncio.run(_provider().archive_task("T7", True))

    assert len(sink) == 1
    assert sink[0]["url"].endswith("/task/T7")
    assert sink[0]["json"] == {"archived": True}


def test_archive_task_can_unarchive(monkeypatch):
    monkeypatch.delenv("ACTION_BROKER_ENFORCE", raising=False)
    _no_db(monkeypatch)
    sink: list = []
    _patch_http(monkeypatch, 200, sink)

    asyncio.run(_provider().archive_task("T7", False))

    assert sink[0]["json"] == {"archived": False}


def test_archive_task_404_is_success(monkeypatch):
    """A gone task is already 'archived' — 404 must not raise."""
    monkeypatch.delenv("ACTION_BROKER_ENFORCE", raising=False)
    _no_db(monkeypatch)
    sink: list = []
    _patch_http(monkeypatch, 404, sink)

    # Should complete without raising.
    asyncio.run(_provider()._raw_archive_task("gone", True))


def test_archive_task_routes_through_broker(monkeypatch):
    """archive_task is an outward write → it goes through _broker_gate with the
    'clickup.archive_task' action id (so the broker can gate/audit it)."""
    seen: dict = {}

    async def _fake_gate(self, action, ref, payload, do_write):
        seen["action"] = action
        seen["ref"] = ref
        return await do_write()

    monkeypatch.delenv("ACTION_BROKER_ENFORCE", raising=False)
    _no_db(monkeypatch)
    sink: list = []
    _patch_http(monkeypatch, 200, sink)
    monkeypatch.setattr(ClickUpProvider, "_broker_gate", _fake_gate)

    asyncio.run(_provider().archive_task("T9", True))

    assert seen["action"] == "clickup.archive_task"
    assert seen["ref"] == "task:T9"
    assert len(sink) == 1  # the underlying write still happened


# ── items._delete_upstream / _archive_upstream ──────────────────────────────

def _row(**kw):
    base = dict(id="abc123def456", source="SYNCED",
               provider_task_id="T1", account_id="acc1")
    base.update(kw)
    return types.SimpleNamespace(**base)


class _RecordingProvider:
    def __init__(self):
        self.archived: list = []
        self.deleted: list = []

    async def archive_task(self, tid, archived=True):
        self.archived.append((tid, archived))

    async def delete_task(self, tid):
        self.deleted.append(tid)


def _patch_provider_build(monkeypatch, provider):
    """Stub out account lookup + credential decrypt + provider construction so
    _delete_upstream/_archive_upstream reach a recording provider with no DB."""
    import gateway.routes.tasks.items as items

    async def _fake_owner(db, acc_id, uid):
        return types.SimpleNamespace(
            id=acc_id, provider="clickup", workspace_id="ws1",
            credentials_encrypted=b"x")

    monkeypatch.setattr(items, "_assert_account_owner", _fake_owner)
    monkeypatch.setattr(
        items, "_key_store",
        lambda: types.SimpleNamespace(decrypt=lambda _b: '{"token": "t"}'))
    monkeypatch.setattr(items, "build_provider",
                        lambda *a, **k: provider)


def test_delete_upstream_archives_not_deletes(monkeypatch):
    """A purge of a synced task ARCHIVES it upstream — never hard-deletes."""
    import gateway.routes.tasks.items as items

    prov = _RecordingProvider()
    _patch_provider_build(monkeypatch, prov)

    asyncio.run(items._delete_upstream(None, _row(), "u1"))

    assert prov.archived == [("T1", True)]
    assert prov.deleted == []  # the ClickUp DELETE is never used


def test_archive_upstream_skips_local_and_mirrors_synced(monkeypatch):
    import gateway.routes.tasks.items as items

    prov = _RecordingProvider()
    _patch_provider_build(monkeypatch, prov)

    rows = [
        _row(id="local1", source="LOCAL", provider_task_id=None,
             account_id=None),          # skipped (local)
        _row(id="s1", provider_task_id="T1"),
        _row(id="s2", provider_task_id="T2"),
    ]
    asyncio.run(items._archive_upstream(None, rows, "u1", True))

    assert prov.archived == [("T1", True), ("T2", True)]


def test_archive_upstream_is_best_effort(monkeypatch):
    """A provider error on one row is swallowed and doesn't abort the rest."""
    import gateway.routes.tasks.items as items

    class _Flaky(_RecordingProvider):
        async def archive_task(self, tid, archived=True):
            if tid == "T1":
                raise RuntimeError("clickup down")
            await super().archive_task(tid, archived)

    prov = _Flaky()
    _patch_provider_build(monkeypatch, prov)
    rows = [_row(id="s1", provider_task_id="T1"),
            _row(id="s2", provider_task_id="T2")]

    # Must not raise; the healthy row still gets archived.
    asyncio.run(items._archive_upstream(None, rows, "u1", True))
    assert prov.archived == [("T2", True)]
