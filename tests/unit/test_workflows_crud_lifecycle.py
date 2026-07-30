"""F1 duplicate + F6 rollback — route handlers over a scripted fake DB.

No Postgres: the fake session replays canned rows per execute() and records
every statement + params, so the tests pin the SQL shape (what gets copied,
what gets regenerated, what stays untouched).
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from gateway.routes.workflows import crud, publish

USER = SimpleNamespace(email="maker@fracktal.works")


class _ScriptedDb:
    """Replays *results* (one per execute) and records statements/params."""

    def __init__(self, results: list[Any]) -> None:
        self._results = list(results)
        self.statements: list[str] = []
        self.params: list[dict] = []
        self.committed = False

    async def execute(self, clause: Any, params: dict | None = None) -> Any:
        self.statements.append(str(clause))
        self.params.append(params or {})
        value = self._results.pop(0) if self._results else None

        class _Result:
            def fetchone(self) -> Any:
                return value

            def fetchall(self) -> list:
                return value or []

        return _Result()

    async def commit(self) -> None:
        self.committed = True

    async def close(self) -> None:
        return None


def _install(monkeypatch, module, db: _ScriptedDb) -> None:
    async def fake_get_db() -> Any:
        return db

    monkeypatch.setattr(module, "_get_db", fake_get_db)


def _wf_row(**over: Any) -> SimpleNamespace:
    base = dict(
        id="w1",
        name="Lead intake",
        description="routes leads",
        owner_email="owner@fracktal.works",
        status="published",
        latest_version=3,
        graph={"nodes": [], "edges": []},
        variables={"team": "sales"},
        hook_token="tok-original",
        created_at=None,
        updated_at=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


# ── Duplicate (spec F1) ─────────────────────────────────────────────────────


def test_duplicate_copies_editables_and_regenerates_the_hook_token(monkeypatch) -> None:
    src = _wf_row()
    trigger = SimpleNamespace(
        id="t1",
        kind="schedule",
        config={"cron": "0 9 * * *"},
        enabled=True,
        last_fired_at=None,
    )
    copy_row = _wf_row(
        id="w2", name="Lead intake (copy)", status="draft", latest_version=None,
        hook_token="tok-fresh",
    )
    # load wf → load triggers → INSERT workflows → INSERT trigger
    db = _ScriptedDb([src, [trigger], copy_row, None])
    _install(monkeypatch, crud, db)
    monkeypatch.setattr(crud, "new_hook_token", lambda: "tok-fresh")

    out = asyncio.run(crud.duplicate_workflow("w1", user=USER))

    assert out["name"] == "Lead intake (copy)"
    assert out["status"] == "draft" and out["latest_version"] is None
    assert out["variables"] == {"team": "sales"}
    # Triggers travel, but the source's identity fields do not.
    assert out["triggers"] == [
        {"kind": "schedule", "config": {"cron": "0 9 * * *"}, "enabled": True}
    ]
    insert_params = db.params[2]
    assert insert_params["token"] == "tok-fresh"  # credential regenerated
    assert insert_params["owner"] == "maker@fracktal.works"
    assert json.loads(insert_params["variables"]) == {"team": "sales"}
    trigger_params = db.params[3]
    assert trigger_params["wid"] == "w2" and trigger_params["kind"] == "schedule"
    assert db.committed


def test_duplicate_404_when_source_missing(monkeypatch) -> None:
    db = _ScriptedDb([None])
    _install(monkeypatch, crud, db)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(crud.duplicate_workflow("ghost", user=USER))
    assert exc.value.status_code == 404


# ── Rollback (spec F6: republish an old version) ────────────────────────────

VALID_GRAPH = {
    "nodes": [
        {
            "id": "start",
            "type": "trigger",
            "position": {"x": 0, "y": 0},
            "data": {"label": "start", "config": {}},
        }
    ],
    "edges": [],
}


def test_rollback_republishes_old_version_as_new_version(monkeypatch) -> None:
    wf = _wf_row(status="published", latest_version=3)
    vrow = SimpleNamespace(serialized={"entry": "start", "blocks": []}, graph=VALID_GRAPH)
    # load wf → load version → INSERT version → UPDATE workflows → ready modules
    db = _ScriptedDb([wf, vrow, None, None, []])
    _install(monkeypatch, publish, db)

    out = asyncio.run(publish.rollback_workflow("w1", 2, user=USER))

    assert out["version"] == 4 and out["rolled_back_to"] == 2
    assert out["status"] == "published"
    assert out["warnings"] == []  # a lone trigger validates clean
    insert_params = db.params[2]
    assert insert_params["v"] == 4
    assert json.loads(insert_params["serialized"]) == {"entry": "start", "blocks": []}
    assert db.params[3]["v"] == 4  # workflows.latest_version bumped
    # The draft edit-model is untouched: no UPDATE touches workflows.graph.
    assert not any("SET graph" in s for s in db.statements)
    assert db.committed


def test_rollback_to_live_version_conflicts(monkeypatch) -> None:
    wf = _wf_row(status="published", latest_version=3)
    vrow = SimpleNamespace(serialized={}, graph={})
    db = _ScriptedDb([wf, vrow])
    _install(monkeypatch, publish, db)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(publish.rollback_workflow("w1", 3, user=USER))
    assert exc.value.status_code == 409


def test_rollback_unknown_version_404s(monkeypatch) -> None:
    wf = _wf_row()
    db = _ScriptedDb([wf, None])
    _install(monkeypatch, publish, db)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(publish.rollback_workflow("w1", 99, user=USER))
    assert exc.value.status_code == 404


def test_rollback_of_disabled_workflow_reenables_at_that_version(monkeypatch) -> None:
    """Disable → rollback re-publishes: the re-enable path of spec R2."""
    wf = _wf_row(status="disabled", latest_version=3)
    vrow = SimpleNamespace(serialized={"entry": "start", "blocks": []}, graph=VALID_GRAPH)
    db = _ScriptedDb([wf, vrow, None, None, []])
    _install(monkeypatch, publish, db)

    out = asyncio.run(publish.rollback_workflow("w1", 3, user=USER))

    assert out["version"] == 4 and out["rolled_back_to"] == 3
    assert out["status"] == "published"
