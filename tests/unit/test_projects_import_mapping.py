"""Projects · the ClickUp importer and its Space→Center mapping plan.

Spec: ``project-docs/specs/project_management_app.md`` §7.1 · **D-PM-10** ·
ticket WS-27b done-whens 1-8.

Hermetic: no Postgres, no ClickUp, no LLM. The provider is a fake returning the
shapes ``ClickUpProvider.get_schema`` / ``list_tasks`` actually return, so the
flattening is exercised against the real contract rather than an invented one.

The load-bearing claims here are the owner's rule (D-PM-10): **an agent may
propose a mapping and must never apply one**, and an **unmapped Space still
imports in full**. Both are asserted directly.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException
from gateway.routes.projects import core as pm_core
from gateway.routes.projects import import_clickup as pm_import
from gateway.routes.projects import mapping as pm_mapping
from gateway.routes.projects import tree as pm_tree

from tests.unit._projects_fakes import (
    FakeProjectsDB,
    bind_db,
    member_user,
    projects_user,
    silence_events,
)

MODULES = (pm_core, pm_tree, pm_import)
OWNER = projects_user()
COLLEAGUE = member_user("colleague@fracktal.in")


class FakeClickUp:
    """The two provider calls the importer makes, in their real shapes."""

    provider = "clickup"

    def __init__(self, hierarchy: list[dict], tasks: list[dict]) -> None:
        self._workspace_id = "ws-1"
        self._hierarchy = hierarchy
        self._tasks = tasks
        self.schema_calls = 0
        self.task_calls = 0

    async def get_schema(self, workspace_id: str) -> dict[str, Any]:
        self.schema_calls += 1
        return {"hierarchy": self._hierarchy, "members": [], "statuses": []}

    async def list_tasks(
        self, workspace_id: str, *, updated_since_ms: int | None = None,
    ) -> list[dict[str, Any]]:
        self.task_calls += 1
        return list(self._tasks)


def _space(space_id: str, name: str, *, lists=(), folders=()) -> dict:
    return {
        "id": space_id, "name": name,
        "lists": [{"id": i, "name": n} for i, n in lists],
        "folders": [
            {"id": fid, "name": fname,
             "lists": [{"id": i, "name": n} for i, n in flists]}
            for fid, fname, flists in folders
        ],
    }


def _task(
    task_id: str, title: str, list_ref: str, *,
    status: str = "Open", status_type: str = "open", assignees=(),
) -> dict:
    return {
        "provider_task_id": task_id, "title": title, "project_ref": list_ref,
        "status": status, "status_type": status_type,
        "assignees": [{"email": e, "name": e} for e in assignees],
        "due_at_ms": None, "closed_at_ms": None, "description": None,
    }


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> FakeProjectsDB:
    fake = FakeProjectsDB()
    bind_db(monkeypatch, fake, MODULES)
    silence_events(monkeypatch, MODULES)
    return fake


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> FakeClickUp:
    """A workspace with two Spaces, a folder, and tasks in both."""
    fake = FakeClickUp(
        hierarchy=[
            _space("s-sales", "Sales", lists=[("l-1", "Pipeline")]),
            _space(
                "s-rnd", "R&D",
                lists=[("l-2", "Backlog")],
                folders=[("f-1", "Printers", [("l-3", "Firmware")])],
            ),
        ],
        tasks=[
            _task("t-1", "Follow up with lead", "l-1",
                  assignees=["seller@fracktal.in"]),
            _task("t-2", "Ship v2", "l-2", status="In progress",
                  status_type="custom", assignees=["maker@fracktal.in"]),
            _task("t-3", "Fix extruder", "l-3", status="Closed",
                  status_type="closed"),
        ],
    )

    async def _resolve(account_id: str) -> FakeClickUp:
        return fake

    monkeypatch.setattr(pm_import, "_resolve_provider", _resolve)
    return fake


def _no_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Silence the classifier. Its own degradation is tested separately."""
    async def _none(space_name, titles, centers):
        return {}, None

    monkeypatch.setattr(pm_mapping, "score_by_content", _none)


def _groups(monkeypatch: pytest.MonkeyPatch, members: dict[str, set[str]]) -> None:
    """Pin group membership: those tables belong to the access system."""
    async def _load(db):
        return members

    async def _centers(db):
        return pm_mapping.FALLBACK_CENTERS

    monkeypatch.setattr(pm_import, "load_group_members", _load)
    monkeypatch.setattr(pm_import, "load_centers", _centers)


# ── The plan writes nothing ─────────────────────────────────────────────────

async def test_the_plan_writes_nothing(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D-PM-10's central promise, asserted against the session itself rather
    than against the response: a plan that quietly created projects would look
    identical from the outside."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    await pm_import.plan_import(pm_import.PlanIn(account_id="acct-1"), user=OWNER)

    writes = [
        s for s, _ in db.calls
        if s.split(None, 1)[0].upper() in ("INSERT", "UPDATE", "DELETE")
    ]
    assert writes == []
    # H2 note: the session wrapper now commits on every clean exit — including
    # a read-only transaction, exactly as `tenant_session` does against
    # Postgres — so a commit COUNT no longer distinguishes a write from a
    # read. "Writes nothing" is the two assertions around this comment: no
    # write statement was issued, and no row appeared.
    assert db.rows("pm_projects") == []


async def test_the_plan_reports_every_space_with_its_counts(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    result = await pm_import.plan_import(
        pm_import.PlanIn(account_id="acct-1"), user=OWNER,
    )

    by_name = {row["name"]: row for row in result["spaces"]}
    assert set(by_name) == {"Sales", "R&D"}
    assert by_name["Sales"]["task_count"] == 1
    assert by_name["R&D"]["task_count"] == 2
    # The folder's list counts toward the Space it belongs to.
    assert by_name["R&D"]["list_count"] == 2
    assert by_name["R&D"]["folder_count"] == 1


async def test_the_plan_makes_two_provider_calls_regardless_of_space_count(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One schema read and one task read. Per-Space calls would make a large
    workspace's plan cost a multiple of the import it precedes."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    await pm_import.plan_import(pm_import.PlanIn(account_id="acct-1"), user=OWNER)

    assert (provider.schema_calls, provider.task_calls) == (1, 1)


# ── The three signals ───────────────────────────────────────────────────────

async def test_assignee_overlap_drives_the_suggestion(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The strongest signal, and the one that needs no naming luck: who does the
    work is what a department is."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {"operations": {"maker@fracktal.in"}})

    result = await pm_import.plan_import(
        pm_import.PlanIn(account_id="acct-1"), user=OWNER,
    )

    rnd = next(r for r in result["spaces"] if r["name"] == "R&D")
    assert rnd["suggestion"]["center"] == "operations"
    assert any("assignees" in e for e in rnd["suggestion"]["evidence"])


async def test_the_space_name_alone_can_carry_a_suggestion(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    result = await pm_import.plan_import(
        pm_import.PlanIn(account_id="acct-1"), user=OWNER,
    )

    sales = next(r for r in result["spaces"] if r["name"] == "Sales")
    assert sales["suggestion"]["center"] == "sales"
    assert any("name" in e for e in sales["suggestion"]["evidence"])


def test_a_whole_word_beats_a_substring_accident() -> None:
    """"Ops review" should reach `operations`; "Developer options" should not
    reach it as strongly — the second is a substring accident."""
    word = pm_mapping.score_by_name("Ops review", pm_mapping.FALLBACK_CENTERS)
    accident = pm_mapping.score_by_name(
        "Developer options", pm_mapping.FALLBACK_CENTERS,
    )

    assert word["operations"] == 1.0
    assert accident.get("operations", 0) < word["operations"]


def test_a_space_nothing_matches_gets_no_suggestion() -> None:
    """A weak guess presented as a suggestion is worse than a blank: the owner
    would be reviewing our noise instead of deciding."""
    scores = pm_mapping.score_by_name("Zephyr", pm_mapping.FALLBACK_CENTERS)
    assert scores == {}


async def test_a_low_confidence_result_suggests_nothing_but_keeps_its_scores() -> None:
    """Hiding the scores would make a blank suggestion indistinguishable from a
    signal failure."""
    suggestion = await pm_mapping.suggest_center(
        space_name="Misc",
        assignees={"nobody@fracktal.in"},
        titles=[],
        group_members={"finance": {"someone@fracktal.in"}},
        centers=pm_mapping.FALLBACK_CENTERS,
        use_llm=False,
    )

    assert suggestion.center is None
    assert suggestion.confidence < pm_mapping.MIN_CONFIDENCE


async def test_the_classifier_degrading_never_fails_the_plan(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The one signal that depends on a third party being up. An owner cannot
    confirm a mapping that never arrived, so the plan must still be useful with
    the two deterministic signals alone.

    The **model client** is what raises here, not ``score_by_content`` — patching
    the function under test and then calling it would have proved only that the
    fake raises.
    """
    import sys
    from types import ModuleType

    module = ModuleType("acb_llm")

    async def _explode(**kwargs):
        raise RuntimeError("no api key")

    module.complete = _explode
    module.LLMTier = type("LLMTier", (), {"TIER_1": "tier1"})
    monkeypatch.setitem(sys.modules, "acb_llm", module)
    _groups(monkeypatch, {})

    assert await pm_mapping.score_by_content("Sales", ["a title"], ("sales",)) == (
        {}, None,
    )

    # …and the whole plan still comes back, carrying the deterministic signals.
    result = await pm_import.plan_import(
        pm_import.PlanIn(account_id="acct-1"), user=OWNER,
    )
    sales = next(r for r in result["spaces"] if r["name"] == "Sales")
    assert sales["suggestion"]["center"] == "sales"


def test_an_unparseable_model_reply_yields_no_signal() -> None:
    assert pm_mapping._first_json_object("no json here") == "{}"
    assert pm_mapping._first_json_object('```json\n{"department":"sales"}\n```') == (
        '{"department":"sales"}'
    )


# ── The import applies only what was confirmed ──────────────────────────────

async def test_only_the_confirmed_mapping_becomes_a_grant(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D-PM-10. The suggestion is a proposal; the import applies the owner's
    answer, and a Space they left blank gets no group grant even when the
    suggester was confident about it."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    await pm_import.import_clickup(
        pm_import.ImportIn(
            account_id="acct-1",
            mappings=[pm_import.SpaceMapping(space_id="s-rnd", center="operations")],
        ),
        user=OWNER,
    )

    subjects = {
        (str(g["project_id"]), g["subject"]) for g in db.rows("pm_project_grants")
    }
    rnd = next(p for p in db.rows("pm_projects") if p["clickup_id"] == "s-rnd")
    sales = next(p for p in db.rows("pm_projects") if p["clickup_id"] == "s-sales")

    assert (str(rnd["id"]), "group:operations") in subjects
    # Sales was suggested confidently and left unmapped — it gets nothing.
    assert not [s for pid, s in subjects if pid == str(sales["id"])]


async def test_an_unmapped_space_still_imports_in_full(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D-PM-10's other half. Refusing to import an unmapped Space would make the
    mapping a precondition of seeing the data the owner needs to decide it."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    result = await pm_import.import_clickup(
        pm_import.ImportIn(account_id="acct-1", mappings=[]), user=OWNER,
    )

    assert {p["clickup_id"] for p in db.rows("pm_projects")} >= {"s-sales", "s-rnd"}
    assert len(db.rows("pm_tasks")) == 3
    assert sorted(result["unmapped_spaces"]) == ["R&D", "Sales"]


async def test_the_unmapped_spaces_are_named_not_counted(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """"3 Spaces were not mapped" is a number the owner cannot act on."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    result = await pm_import.import_clickup(
        pm_import.ImportIn(account_id="acct-1"), user=OWNER,
    )

    assert isinstance(result["unmapped_spaces"], list)
    assert "Sales" in result["unmapped_spaces"]


async def test_an_unknown_center_is_refused_before_anything_is_written(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A typo'd slug must not import half a workspace and then fail."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    with pytest.raises(HTTPException) as exc:
        await pm_import.import_clickup(
            pm_import.ImportIn(
                account_id="acct-1",
                mappings=[pm_import.SpaceMapping(space_id="s-rnd", center="sails")],
            ),
            user=OWNER,
        )

    assert exc.value.status_code == 422
    assert "sails" in str(exc.value.detail)
    assert db.rows("pm_projects") == []


# ── The flattening ──────────────────────────────────────────────────────────

async def test_the_container_zoo_flattens_onto_the_one_self_fk(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Space → root, Folder → child, List → child of whichever contains it —
    depth in ``pm_projects.parent_project_id``, not a table per level (D-PM-2).
    ``clickup_kind`` remembers which was which, for the sync and retirement."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    await pm_import.import_clickup(
        pm_import.ImportIn(account_id="acct-1"), user=OWNER,
    )

    by_clickup = {p["clickup_id"]: p for p in db.rows("pm_projects")}
    rnd, folder, firmware, backlog = (
        by_clickup["s-rnd"], by_clickup["f-1"],
        by_clickup["l-3"], by_clickup["l-2"],
    )

    assert rnd["parent_project_id"] is None
    assert rnd["clickup_kind"] == "space"
    assert str(folder["parent_project_id"]) == str(rnd["id"])
    assert folder["clickup_kind"] == "folder"
    # A list inside a folder hangs off the FOLDER, not the space.
    assert str(firmware["parent_project_id"]) == str(folder["id"])
    # A folderless list hangs off the space.
    assert str(backlog["parent_project_id"]) == str(rnd["id"])
    assert firmware["clickup_kind"] == backlog["clickup_kind"] == "list"


async def test_every_imported_row_carries_its_provenance(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`source='import'` plus `clickup_id` is what makes the import re-runnable
    and the retirement inventory findable."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    await pm_import.import_clickup(
        pm_import.ImportIn(account_id="acct-1"), user=OWNER,
    )

    assert all(p["source"] == "import" for p in db.rows("pm_projects"))
    assert all(t["source"] == "import" for t in db.rows("pm_tasks"))
    assert all(t["clickup_id"] for t in db.rows("pm_tasks"))


async def test_statuses_come_from_the_workspaces_own_names(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D-CRM-2's argument: the importer must represent the real stage names, and
    the machine-readable category is derived from ClickUp's status TYPE."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    await pm_import.import_clickup(
        pm_import.ImportIn(account_id="acct-1"), user=OWNER,
    )

    rnd = next(p for p in db.rows("pm_projects") if p["clickup_id"] == "s-rnd")
    lanes = {
        s["name"]: s["category"] for s in db.rows("pm_task_statuses")
        if str(s["project_id"]) == str(rnd["id"])
    }
    assert lanes == {"In progress": "in_progress", "Closed": "done"}


async def test_a_space_with_no_tasks_still_gets_a_usable_lane(
    db: FakeProjectsDB, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``pm_tasks.status_id`` is NOT NULL, so a project with no status can never
    receive one."""
    empty = FakeClickUp(hierarchy=[_space("s-x", "Empty", lists=[("l-x", "L")])],
                        tasks=[])

    async def _resolve(account_id: str) -> FakeClickUp:
        return empty

    monkeypatch.setattr(pm_import, "_resolve_provider", _resolve)
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    await pm_import.import_clickup(
        pm_import.ImportIn(account_id="acct-1"), user=OWNER,
    )

    assert [s["name"] for s in db.rows("pm_task_statuses")] == ["To do"]
    assert db.rows("pm_task_statuses")[0]["is_default"] is True


async def test_assignees_are_imported_folded(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    await pm_import.import_clickup(
        pm_import.ImportIn(account_id="acct-1"), user=OWNER,
    )

    assert {a["assignee"] for a in db.rows("pm_task_assignees")} == {
        "seller@fracktal.in", "maker@fracktal.in",
    }


# ── Re-runnability ──────────────────────────────────────────────────────────

async def test_a_second_import_creates_nothing_new(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keyed on ``clickup_id`` — the property that makes the import re-runnable
    during coexistence. Without it a re-import doubles the portfolio."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})
    payload = pm_import.ImportIn(account_id="acct-1")

    first = await pm_import.import_clickup(payload, user=OWNER)
    projects_after_first = len(db.rows("pm_projects"))
    second = await pm_import.import_clickup(payload, user=OWNER)

    assert first["projects"]["created"] > 0
    assert second["projects"]["created"] == 0
    assert second["tasks"]["created"] == 0
    assert second["tasks"]["already_present"] == 3
    assert len(db.rows("pm_projects")) == projects_after_first


async def test_a_re_plan_proposes_the_confirmed_mapping_not_a_fresh_guess(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without this a second import could silently re-map a Space the owner had
    already decided — the exact failure D-PM-10 (b) rejects, arriving by a
    different route."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})
    # Sales is deliberately mapped AGAINST its name, so a fresh guess and the
    # confirmed answer cannot agree by accident.
    await pm_import.import_clickup(
        pm_import.ImportIn(
            account_id="acct-1",
            mappings=[pm_import.SpaceMapping(space_id="s-sales", center="finance")],
        ),
        user=OWNER,
    )

    result = await pm_import.plan_import(
        pm_import.PlanIn(account_id="acct-1"), user=OWNER,
    )

    sales = next(r for r in result["spaces"] if r["name"] == "Sales")
    assert sales["current_mapping"] == "finance"
    assert sales["suggestion"]["center"] == "finance"
    assert "already mapped" in sales["suggestion"]["evidence"][0]


# ── Dry run ─────────────────────────────────────────────────────────────────

async def test_a_dry_run_writes_nothing_and_says_so(
    db: FakeProjectsDB, provider: FakeClickUp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Distinct from the plan: this exercises the whole import path, including
    the flattening, and still commits nothing."""
    _no_llm(monkeypatch)
    _groups(monkeypatch, {})

    result = await pm_import.import_clickup(
        pm_import.ImportIn(account_id="acct-1", dry_run=True), user=OWNER,
    )

    assert result["dry_run"] is True
    assert result["projects"]["created"] > 0
    # H2: commit count no longer distinguishes reads from writes (see the
    # plan-writes-nothing test) — the absence of rows IS the dry-run proof.
    assert db.rows("pm_projects") == []


# ── Gating ──────────────────────────────────────────────────────────────────

def test_every_import_endpoint_requires_the_admin_floor() -> None:
    """`admin:access:manage`, NOT `integrations:use:clickup` — migration 131
    grants `member` `integrations:use:*`, so the integration slug gates nothing.
    That was the WS-26b finding and it applies here unchanged.

    The expected SET is exhaustive on purpose: a third import route (the
    Tasks-app mirror path, 2026-08-07) had to be added here deliberately, which
    is the point. An import that writes projects and tasks for the whole org is
    an administrative act however local its source, and a new one must not
    inherit a pass by being absent from this list."""
    from gateway.routes.projects import router

    guarded = {
        route.path: [
            getattr(d.dependency, "__qualname__", "") for d in route.dependencies
        ]
        for route in router.routes
        if getattr(route, "path", "").startswith("/projects/import/")
    }

    assert set(guarded) == {
        "/projects/import/clickup",
        "/projects/import/clickup/plan",
        "/projects/import/from-tasks",
    }
    for path, names in guarded.items():
        assert any("require_permission" in n for n in names), (
            f"{path} carries no permission floor"
        )


def test_the_import_endpoints_are_mounted() -> None:
    """The ``__init__`` trap: a module left out of the import list mounts
    nothing while every test calling its functions directly still passes."""
    from gateway.routes.projects import router

    paths = {route.path for route in router.routes}
    assert "/projects/import/clickup" in paths
    assert "/projects/import/clickup/plan" in paths
    assert "/projects/import/from-tasks" in paths


async def test_a_non_clickup_account_is_refused(
    db: FakeProjectsDB, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The importer speaks ClickUp's shapes; handed an Asana account it would
    silently import nothing rather than say why."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _fake_session(organization_id=None):
        yield db

    class _Row(dict):
        pass

    class _Mappings:
        def __init__(self, row): self._row = row
        def first(self): return self._row

    class _Res:
        def __init__(self, row): self._row = row
        def mappings(self): return _Mappings(self._row)

    async def _execute(sql, params=None):
        return _Res({"provider": "asana", "workspace_id": "w",
                     "credentials_encrypted": "x"})

    monkeypatch.setattr(db, "execute", _execute)
    monkeypatch.setattr(pm_import, "_tenant_session", _fake_session)

    with pytest.raises(HTTPException) as exc:
        await pm_import._resolve_provider("acct-9")
    assert exc.value.status_code == 422
    assert "asana" in str(exc.value.detail)
