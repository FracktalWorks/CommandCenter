"""Workflow Copilot + semantic catalog search unit tests.

Pure parts (scoring, module-name resolution, module validation problems) run
directly; the copilot's persist/validate round (``_apply_round``) runs against
a fake DB session so the create-missing-modules flow is covered without
Postgres or an LLM.
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from gateway.routes.workflows import copilot as copilot_mod
from gateway.routes.workflows import search as search_mod
from gateway.routes.workflows.copilot import (
    _apply_round,
    _module_problems,
    resolve_module_nodes,
)
from gateway.routes.workflows.search import (
    CatalogEntry,
    cosine,
    keyword_score,
    merge_scores,
)

# ── Scoring ─────────────────────────────────────────────────────────────────


def test_keyword_score_ranks_label_over_description() -> None:
    label_hit = keyword_score("dedupe", "dedupe contacts", "cleans rows")
    desc_hit = keyword_score("dedupe", "clean_contact_rows", "dedupe by email")
    miss = keyword_score("dedupe", "send email", "smtp delivery")
    assert label_hit > desc_hit > miss == 0.0


def test_keyword_score_exact_label_beats_substring() -> None:
    exact = keyword_score("triage", "triage", "email triage agent")
    partial = keyword_score("triage", "triage-helper", "assists")
    assert exact > partial > 0


def test_merge_scores_semantic_contributes() -> None:
    assert merge_scores(2.0, 0.8) == pytest.approx(6.0)
    assert merge_scores(2.0, None) == pytest.approx(2.0)
    assert merge_scores(0.0, -0.3) == pytest.approx(0.0)


def test_cosine_bounds() -> None:
    assert cosine([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert cosine([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert cosine([], [1.0]) == 0.0


def test_catalog_entry_hash_tracks_content() -> None:
    a = CatalogEntry(kind="tool", key="x", label="A", description="d")
    b = CatalogEntry(kind="tool", key="x", label="A", description="d2")
    assert a.content_hash != b.content_hash


def test_search_degrades_to_keyword_only_without_index(monkeypatch) -> None:
    async def _no_db() -> Any:
        raise RuntimeError("no database in unit tests")

    monkeypatch.setattr(search_mod, "_get_db", _no_db)
    monkeypatch.setattr(search_mod, "_embedding_model", lambda: None)
    monkeypatch.setattr(search_mod, "_last_sync", 0.0)
    monkeypatch.setattr(
        search_mod,
        "collect_catalog_entries",
        lambda: [
            CatalogEntry(
                kind="tool",
                key="clickup.create_task",
                label="ClickUp: create task",
                description="write task",
            ),
            CatalogEntry(
                kind="agent", key="triage", label="triage", description="classify inbound email"
            ),
        ],
    )
    out = asyncio.run(search_mod.search_catalog("classify email"))
    assert out["semantic"] is False
    assert out["results"] and out["results"][0]["key"] == "triage"


# ── Module resolution + validation problems ─────────────────────────────────


def _module_node(config: dict) -> dict:
    return {
        "id": "m1",
        "type": "module",
        "position": {"x": 0, "y": 0},
        "data": {"label": "m1", "config": config},
    }


def test_resolve_module_nodes_rewrites_names() -> None:
    graph = {"nodes": [_module_node({"module_name": "clean_rows", "inputs": {}})], "edges": []}
    unresolved = resolve_module_nodes(graph, {"clean_rows": "id-123"})
    config = graph["nodes"][0]["data"]["config"]
    assert unresolved == []
    assert config["module_id"] == "id-123" and "module_name" not in config


def test_resolve_module_nodes_reports_unknown() -> None:
    graph = {"nodes": [_module_node({"module_name": "ghost"})], "edges": []}
    assert resolve_module_nodes(graph, {}) == ["ghost"]


def test_module_problems_flags_bad_code_and_duplicates() -> None:
    bad = {"name": "x", "code": "import os\ndef run(inputs):\n    return {}\n"}
    dupe_a = {"name": "same", "code": "def run(inputs):\n    return {}\n"}
    dupe_b = {"name": "same", "code": "def run(inputs):\n    return {}\n"}
    problems = _module_problems([bad, dupe_a, dupe_b])
    assert any("Import" in p for p in problems)
    assert any("duplicate" in p for p in problems)
    assert _module_problems([dupe_a]) == []


# ── The apply round, on a fake DB ───────────────────────────────────────────


class _FakeResult:
    def __init__(self, one: Any = None, many: list[Any] | None = None):
        self._one, self._many = one, many or []

    def fetchone(self) -> Any:
        return self._one

    def fetchall(self) -> list[Any]:
        return self._many


class _FakeSession:
    """Serves exactly the three module queries _apply_round issues."""

    def __init__(self, store: dict[str, SimpleNamespace]):
        self.store = store

    async def execute(self, clause: Any, params: dict | None = None) -> _FakeResult:
        sql = str(clause)
        params = params or {}
        if "INSERT INTO workflow_modules" in sql:
            module_id = str(uuid.uuid4())
            self.store[params["name"]] = SimpleNamespace(
                id=module_id,
                name=params["name"],
                code=params["code"],
            )
            return _FakeResult(one=SimpleNamespace(id=module_id))
        if "SELECT id, code FROM workflow_modules" in sql:
            row = self.store.get(params["name"])
            return _FakeResult(one=row)
        if "SELECT id, name FROM workflow_modules" in sql:
            return _FakeResult(many=list(self.store.values()))
        raise AssertionError(f"unexpected SQL in fake session: {sql[:80]}")

    async def commit(self) -> None:
        pass

    async def close(self) -> None:
        pass


@pytest.fixture
def fake_db(monkeypatch):
    store: dict[str, SimpleNamespace] = {}

    async def _get_db() -> _FakeSession:
        return _FakeSession(store)

    monkeypatch.setattr(copilot_mod, "_get_db", _get_db)
    # Deterministic agent registry for validation.
    import gateway.routes.workflows.catalog as catalog_mod

    monkeypatch.setattr(catalog_mod, "known_agent_names", lambda: {"triage"})
    return store


def _copilot_graph(module_ref: dict) -> dict:
    return {
        "nodes": [
            {
                "id": "start",
                "type": "trigger",
                "position": {"x": 0, "y": 0},
                "data": {"label": "t", "config": {"kind": "manual"}},
            },
            {
                "id": "clean",
                "type": "module",
                "position": {"x": 0, "y": 120},
                "data": {"label": "clean", "config": module_ref},
            },
            {
                "id": "done",
                "type": "output",
                "position": {"x": 0, "y": 240},
                "data": {"label": "out", "config": {"value": "{{clean.rows}}"}},
            },
        ],
        "edges": [
            {"id": "e1", "source": "start", "target": "clean"},
            {"id": "e2", "source": "clean", "target": "done"},
        ],
    }


def test_apply_round_creates_missing_module_and_validates(fake_db) -> None:
    result = {
        "reply": "Added a cleaning step.",
        "graph": _copilot_graph({"module_name": "clean_rows", "inputs": {}}),
        "new_modules": [
            {
                "name": "clean_rows",
                "description": "drop rows without email",
                "code": "def run(inputs):\n    rows = [r for r in inputs.get('rows', [])"
                " if r.get('email')]\n    return {'rows': rows}\n",
                "input_schema": {"rows": "array"},
                "output_schema": {"rows": "array"},
            }
        ],
        "_model": "stub-model",
    }
    out, created = asyncio.run(
        _apply_round(result, "wf-1", "clean the rows", "maker@fracktal.works"),
    )
    assert out["_problems"] == []
    assert "clean_rows" in created and "clean_rows" in fake_db
    config = out["graph"]["nodes"][1]["data"]["config"]
    assert config["module_id"] == created["clean_rows"]


def test_apply_round_reuses_existing_module_by_name(fake_db) -> None:
    fake_db["clean_rows"] = SimpleNamespace(
        id="existing-id",
        name="clean_rows",
        code="def run(inputs):\n    return {}\n",
    )
    result = {
        "reply": "wired it",
        "graph": _copilot_graph({"module_name": "clean_rows"}),
        "new_modules": [],
        "_model": "stub",
    }
    out, created = asyncio.run(
        _apply_round(result, "wf-1", "reuse", "maker@fracktal.works"),
    )
    assert out["_problems"] == []
    assert created == {}
    assert out["graph"]["nodes"][1]["data"]["config"]["module_id"] == "existing-id"


def test_apply_round_reports_invalid_module_and_saves_nothing(fake_db) -> None:
    result = {
        "reply": "trying",
        "graph": _copilot_graph({"module_name": "sneaky"}),
        "new_modules": [{"name": "sneaky", "code": "import os\ndef run(inputs):\n    return {}\n"}],
        "_model": "stub",
    }
    out, created = asyncio.run(
        _apply_round(result, "wf-1", "sneak", "maker@fracktal.works"),
    )
    assert any("Import" in p for p in out["_problems"])
    assert created == {} and fake_db == {}


def test_apply_round_flags_unknown_agent_and_graph_issues(fake_db) -> None:
    graph = _copilot_graph({"module_name": "clean_rows"})
    graph["nodes"][1] = {
        "id": "clean",
        "type": "agent",
        "position": {"x": 0, "y": 120},
        "data": {"label": "a", "config": {"agent": "made-up-agent", "message": "hi"}},
    }
    result = {"reply": "…", "graph": graph, "new_modules": [], "_model": "stub"}
    out, _created = asyncio.run(
        _apply_round(result, "wf-1", "x", "maker@fracktal.works"),
    )
    assert any("unknown_agent" in p for p in out["_problems"])
    assert any(i["code"] == "unknown_agent" for i in out["_issues"])
