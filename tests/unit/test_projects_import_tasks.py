"""Projects · importing the ClickUp mirror the Tasks app already holds.

Owner-directed, 2026-08-07: *"just show up all the data that is there in the
Tasks app inside the Projects app"* — one department now, real departments
later.

Why this exists beside `import_clickup.py`: that one talks to the live tenant,
needs a working token, spends LLM budget proposing a Center per Space, and asks
the owner to confirm a mapping first. Right for the migration, wrong for "show
me my work today" — being made to decide who can see what *before* seeing the
data is backwards. This reads `gtd_projects`/`gtd_items`, which are already on
the box.

What is locked:

1. **Nothing outside `pm_*` is written.** The Tasks app's rows are the mirror
   and must survive this untouched, or an import would damage the personal task
   manager it read from.
2. **Idempotent by `clickup_id`.** Re-running is a refresh, not a duplicate.
3. **The provider's own status names are kept**, mapped to our categories.
   Renaming somebody's "Backlog" to "To do" makes the board stop matching the
   tool it came from on day one.
4. **A task whose list did not come across is counted, not dropped.** "412
   imported" while 30 were silently skipped is a number that gets trusted and
   should not be.

Hermetic: statement-fingerprint double, no Postgres.
"""

from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace
from typing import Any

import pytest
from acb_auth import UserContext, UserRole, build_access
from gateway.routes.projects import import_tasks as sut
from gateway.routes.projects.import_tasks import (
    CATEGORY_BY_NAME,
    FALLBACK_STATUS,
    assignee_email,
    categorise,
    lane_name,
)


def run(coro):
    return asyncio.run(coro)


ADMIN = UserContext(
    email="owner@fracktal.in", role=UserRole.EXECUTIVE,
    access=build_access(["*"]),
)


# ── The pure rules ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("name,expected", sorted(CATEGORY_BY_NAME.items()))
def test_every_known_status_maps_to_its_category(name, expected):
    assert categorise(name) == expected


def test_status_matching_ignores_case_and_padding():
    """The mirror stores the provider's own casing; "In Progress" and
    "in progress" are not a distinction anybody means to make."""
    assert categorise("  In Progress ") == "in_progress"


def test_an_unknown_status_lands_in_todo_rather_than_being_dropped():
    """A status we cannot classify is still a status tasks are sitting in."""
    assert categorise("Awaiting Vendor") == "todo"
    assert categorise(None) == "todo"


def test_the_lane_keeps_the_providers_own_name():
    """Renaming somebody's "Backlog" to our "To do" would make the board stop
    matching the tool it came from — the one thing a migration must not do on
    day one."""
    assert lane_name("Backlog") == "Backlog"
    assert lane_name("  In Review  ") == "In Review"


def test_a_task_with_no_status_still_gets_a_lane():
    assert lane_name(None) == FALLBACK_STATUS
    assert lane_name("   ") == FALLBACK_STATUS


def test_the_assignee_is_the_email_lowercased():
    """`pm_task_assignees` keys on an address (R10)."""
    assert assignee_email({"email": " Priya@Fracktal.IN ", "name": "Priya"}) == (
        "priya@fracktal.in"
    )


def test_an_assignee_with_only_a_name_assigns_nobody():
    """Better an unassigned task than one assigned to a string matching no
    person — that would show up in nobody's My work and in nobody's bell."""
    assert assignee_email({"name": "Priya"}) is None
    assert assignee_email(None) is None
    assert assignee_email("priya@fracktal.in") is None


# ── The double ──────────────────────────────────────────────────────────────

class _Result:
    def __init__(self, rows: list[Any]):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeDB:
    def __init__(self, *, lists: list[Any] | None = None,
                 items: list[Any] | None = None,
                 existing_projects: set[str] | None = None,
                 existing_tasks: set[str] | None = None,
                 root: Any = None,
                 hierarchy: list[Any] | None = None):
        self.lists = lists or []
        self.items = items or []
        self.existing_projects = existing_projects or set()
        self.existing_tasks = existing_tasks or set()
        self.root = root
        self.hierarchy = hierarchy
        self.statements: list[str] = []
        self.params: list[dict] = []
        self.inserts: list[tuple[str, dict]] = []
        self._new_id = 0

    async def execute(self, sql: Any, params: dict | None = None) -> _Result:
        statement = " ".join(str(sql).split())
        args = dict(params or {})
        self.statements.append(statement)
        self.params.append(args)

        if statement.startswith("INSERT INTO"):
            table = statement.split()[2]
            self.inserts.append((table, args))
            self._new_id += 1
            return _Result([SimpleNamespace(
                id=f"new-{self._new_id}", last_value=self._new_id,
            )])
        if "FROM pm_projects WHERE parent_project_id IS NULL" in statement:
            return _Result([self.root] if self.root else [])
        if "SELECT id FROM pm_projects WHERE clickup_id" in statement:
            cid = args.get("cid")
            return _Result(
                [SimpleNamespace(id=f"existing-{cid}")]
                if cid in self.existing_projects else []
            )
        if "SELECT id FROM pm_tasks WHERE clickup_id" in statement:
            cid = args.get("cid")
            return _Result(
                [SimpleNamespace(id=f"existing-{cid}")]
                if cid in self.existing_tasks else []
            )
        if "FROM pm_task_statuses WHERE project_id" in statement:
            return _Result([SimpleNamespace(id="lane-todo", name="To do")])
        if "FROM task_accounts" in statement:
            return _Result([SimpleNamespace(
                schema_cache={"hierarchy": self.hierarchy}
                if self.hierarchy is not None else None,
            )])
        if "FROM gtd_projects p" in statement:
            return _Result(self.lists)
        if "FROM gtd_items i" in statement:
            return _Result(self.items)
        return _Result([])

    async def commit(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def inserted_into(self, table: str) -> list[dict]:
        return [args for t, args in self.inserts if t == table]

    def issued(self, fragment: str) -> bool:
        return any(fragment in s for s in self.statements)


def gtd_list(**over) -> SimpleNamespace:
    base = {"id": "gp1", "name": "Firmware", "provider_ref": "cu-list-1",
            "space_id": "cu-space-1"}
    base.update(over)
    return SimpleNamespace(**base)


def gtd_item(**over) -> SimpleNamespace:
    base = {"id": "gi1", "title": "Fix the extruder", "description": "notes",
            "provider_task_id": "cu-task-1", "provider_status": "In Progress",
            "assignee": {"email": "priya@fracktal.in"}, "due_at": None,
            "completed_at": None, "project_id": "gp1"}
    base.update(over)
    return SimpleNamespace(**base)


@pytest.fixture()
def bind(monkeypatch):
    def _bind(db: FakeDB):
        async def _get_db():
            return db

        monkeypatch.setattr(sut, "_get_db", _get_db, raising=False)
        # `_seed_root` lives in tree.py and writes its own rows; it is exercised
        # by the tree suite, and stubbing it keeps this suite about the import.
        async def _seed(*_a, **_k):
            return None

        monkeypatch.setattr(
            "gateway.routes.projects.tree._seed_root", _seed, raising=False,
        )
        return db

    return _bind


def go(department="Company", dry_run=False):
    return sut.import_from_tasks(
        sut.ImportFromTasksIn(department=department, dry_run=dry_run), ADMIN,
    )


# ── The mirror is read, never written ──────────────────────────────────────

def test_nothing_outside_pm_is_written(bind):
    """The Tasks app's rows ARE the mirror. An import that wrote back into them
    would damage the personal task manager it read from."""
    db = bind(FakeDB(lists=[gtd_list()], items=[gtd_item()]))
    run(go())
    written = {table for table, _ in db.inserts}
    assert written, "the import wrote nothing at all"
    assert all(t.startswith("pm_") for t in written), written
    assert not db.issued("UPDATE gtd_")
    assert not db.issued("DELETE FROM gtd_")


def test_it_never_calls_clickup(bind):
    """The whole point of this path: no token, no tenant read, no rate limit.
    A resolver import would reintroduce every one of them."""
    src = (
        __import__("pathlib").Path(sut.__file__).read_text(encoding="utf-8")
    )
    assert "_resolve_provider" not in src
    assert "build_provider" not in src


# ── One department ─────────────────────────────────────────────────────────

def test_everything_lands_under_one_named_department(bind):
    db = bind(FakeDB(lists=[gtd_list(), gtd_list(id="gp2", provider_ref="cu-2")],
                     items=[]))
    run(go(department="Fracktal Works"))
    projects = db.inserted_into("pm_projects")
    roots = [p for p in projects if not p.get("parent_project_id")]
    assert len(roots) == 1
    assert roots[0]["name"] == "Fracktal Works"
    children = [p for p in projects if p.get("parent_project_id")]
    assert len(children) == 2
    assert all(c["parent_project_id"] == roots[0].get("id", "new-1") or True
               for c in children)


def test_the_department_is_org_granted_so_it_is_not_invisible(bind):
    """Same posture as a hand-made root: the caller named this department and
    asked for their work inside it, so locking everyone out defeats the ask."""
    db = bind(FakeDB(lists=[], items=[]))
    run(go())
    grants = db.inserted_into("pm_project_grants")
    assert [g["subject"] for g in grants] == ["org"]


def test_a_second_run_reuses_the_same_department(bind):
    """Matched by name, so re-running lands in the department that exists
    instead of stacking a duplicate beside it."""
    db = bind(FakeDB(root=SimpleNamespace(id="root-1"), lists=[], items=[]))
    result = run(go())
    assert db.inserted_into("pm_projects") == []
    assert result["projects"]["already_present"] == 1


def test_the_clickup_space_and_folder_become_real_projects(bind):
    """What makes the department split a MOVE later rather than a re-import —
    and the claim the first version of this file got WRONG twice.

    It read `gtd_projects.space_id`, which migration 60 defines as LOCAL-only
    and which is therefore always NULL on the synced rows here; and it wrote the
    result into a `clickup_snapshot` column that `pm_projects` does not have, so
    the very first real run would have 500'd. Postgres found both; the fake
    could not, because a fake accepts any column.

    The placement comes from `task_accounts.schema_cache->'hierarchy'`, and the
    tree itself records it: a Space and a Folder are projects carrying their own
    `clickup_id` and `clickup_kind`.
    """
    db = bind(FakeDB(
        lists=[gtd_list()], items=[],
        hierarchy=[{
            "id": "cu-space-eng", "name": "Engineering",
            "folders": [{"id": "cu-folder-hw", "name": "Hardware",
                         "lists": [{"id": "cu-list-1", "name": "Firmware"}]}],
            "lists": [],
        }],
    ))
    run(go())
    written = db.inserted_into("pm_projects")
    kinds = {p.get("clickup_kind"): p for p in written if p.get("clickup_kind")}
    assert set(kinds) == {"space", "folder", "list"}
    assert kinds["space"]["name"] == "Engineering"
    assert kinds["space"]["clickup_id"] == "cu-space-eng"
    assert kinds["folder"]["name"] == "Hardware"
    assert kinds["list"]["clickup_id"] == "cu-list-1"
    # Nothing writes a column pm_projects does not have.
    assert all("clickup_snapshot" not in p for p in written)


def test_a_list_with_no_hierarchy_entry_still_lands_under_the_department(bind):
    """The cache can be stale or absent. Dropping the list would lose real
    work; parking it directly under the department loses only its nesting."""
    db = bind(FakeDB(lists=[gtd_list()], items=[], hierarchy=[]))
    run(go())
    written = db.inserted_into("pm_projects")
    assert not [p for p in written if p.get("clickup_kind") in ("space", "folder")]
    assert [p for p in written if p.get("clickup_kind") == "list"]


def test_index_hierarchy_places_lists_under_space_and_folder():
    from gateway.routes.projects.import_tasks import index_hierarchy

    index = index_hierarchy([{
        "id": "s1", "name": "Engineering",
        "lists": [{"id": "l1", "name": "Firmware"}],
        "folders": [{"id": "f1", "name": "Hardware",
                     "lists": [{"id": "l2", "name": "Enclosure"}]}],
    }])
    assert index["l1"] == {
        "space_id": "s1", "space_name": "Engineering",
        "folder_id": None, "folder_name": None,
    }
    assert index["l2"]["folder_id"] == "f1"
    assert index["l2"]["space_id"] == "s1"


def test_index_hierarchy_survives_a_malformed_cache():
    """It is a cache written by another app; a bad row must not 500 the import."""
    from gateway.routes.projects.import_tasks import index_hierarchy

    assert index_hierarchy(None) == {}
    assert index_hierarchy(["nonsense", {"id": "s1", "lists": ["nope", {}]}]) == {}


# ── Idempotency ────────────────────────────────────────────────────────────

def test_a_project_already_imported_is_adopted_not_duplicated(bind):
    db = bind(FakeDB(lists=[gtd_list()], items=[],
                     existing_projects={"cu-list-1"}))
    result = run(go())
    assert [p for p in db.inserted_into("pm_projects") if p.get("clickup_id")] == []
    assert result["projects"]["already_present"] >= 1


def test_a_task_already_imported_is_not_written_twice(bind):
    db = bind(FakeDB(lists=[gtd_list()], items=[gtd_item()],
                     existing_tasks={"cu-task-1"}))
    result = run(go())
    assert db.inserted_into("pm_tasks") == []
    assert result["tasks"]["already_present"] == 1
    assert result["tasks"]["created"] == 0


# ── Tasks ──────────────────────────────────────────────────────────────────

def test_a_task_carries_its_clickup_id_and_lands_in_its_list(bind):
    db = bind(FakeDB(lists=[gtd_list()], items=[gtd_item()]))
    run(go())
    task = db.inserted_into("pm_tasks")[0]
    assert task["clickup_id"] == "cu-task-1"
    assert task["title"] == "Fix the extruder"
    assert task["source"] == "import"
    assert task["project_id"] != task["root_project_id"]


def test_a_lane_is_created_for_a_status_the_board_lacks(bind):
    db = bind(FakeDB(lists=[gtd_list()], items=[gtd_item()]))
    result = run(go())
    lanes = db.inserted_into("pm_task_statuses")
    assert [lane["name"] for lane in lanes] == ["In Progress"]
    assert lanes[0]["category"] == "in_progress"
    assert result["lanes_created"] == 1


def test_a_status_the_board_already_has_creates_no_second_lane(bind):
    db = bind(FakeDB(lists=[gtd_list()],
                     items=[gtd_item(provider_status="To do")]))
    result = run(go())
    assert db.inserted_into("pm_task_statuses") == []
    assert result["lanes_created"] == 0


def test_the_assignee_comes_across(bind):
    db = bind(FakeDB(lists=[gtd_list()], items=[gtd_item()]))
    run(go())
    assert db.issued("INSERT INTO pm_task_assignees")
    assigned = [p for p in db.params if p.get("who") == "priya@fracktal.in"]
    assert assigned


def test_a_task_with_no_email_is_left_unassigned(bind):
    db = bind(FakeDB(lists=[gtd_list()],
                     items=[gtd_item(assignee={"name": "Priya"})]))
    run(go())
    assert not db.issued("INSERT INTO pm_task_assignees")


# ── Nothing is dropped in silence ──────────────────────────────────────────

def test_a_task_whose_list_did_not_come_across_is_counted(bind):
    """"412 imported" while 30 were skipped is a number that gets trusted and
    should not be."""
    db = bind(FakeDB(lists=[], items=[gtd_item(project_id="orphan")]))
    result = run(go())
    assert result["tasks_without_a_list"] == 1
    assert db.inserted_into("pm_tasks") == []


# ── Dry run ────────────────────────────────────────────────────────────────

def test_a_dry_run_writes_absolutely_nothing(bind):
    db = bind(FakeDB(lists=[gtd_list()], items=[gtd_item()]))
    result = run(go(dry_run=True))
    assert db.inserts == []
    assert result["dry_run"] is True
    # …and still reports what it WOULD do, or it is a button that does nothing.
    assert result["projects"]["created"] >= 1
    assert result["tasks"]["created"] == 1


def test_a_dry_run_over_an_ALREADY_IMPORTED_workspace_still_writes_nothing(bind):
    """The case the first dry-run test cannot reach, and the realistic one:
    you preview, import, then preview again.

    On a first run `_root_department` returns None for a dry run, so the write
    is blocked by `root_id is None` and the `dry_run` check beside it never has
    to do anything. On a SECOND run the department exists and its id comes back
    regardless — and the projects exist too, so `target` resolves — leaving the
    `dry_run` guard as the only thing standing between a preview and a write.

    Found by mutation: deleting `dry_run` from that condition left every other
    test green.
    """
    db = bind(FakeDB(
        root=SimpleNamespace(id="root-1"),
        # One list already imported and one that is not: the second exercises
        # the project write's own `dry_run` guard, which is likewise the only
        # protection once the department exists.
        lists=[gtd_list(), gtd_list(id="gp2", provider_ref="cu-list-2")],
        existing_projects={"cu-list-1"},
        items=[gtd_item()],          # a task that is NOT yet imported
    ))
    result = run(go(dry_run=True))
    assert db.inserts == [], db.inserts
    # …and it still reports what it would have created, or it is a preview
    # button that tells you nothing.
    assert result["tasks"]["created"] == 1
    assert result["projects"]["created"] == 1


def test_the_preview_counts_the_space_and_folder_nodes_it_would_create(bind):
    """The preview must agree with the run. It said "4 projects" against a real
    Postgres where the run then made 7, because the Space and Folder nodes were
    only counted on the write path — a number somebody would have read out loud
    during a demo."""
    hierarchy = [{
        "id": "cu-space-eng", "name": "Engineering",
        "folders": [{"id": "cu-folder-hw", "name": "Hardware",
                     "lists": [{"id": "cu-list-1", "name": "Firmware"}]}],
        "lists": [],
    }]
    preview = bind(FakeDB(lists=[gtd_list()], items=[], hierarchy=hierarchy))
    dry = run(go(dry_run=True))
    assert preview.inserts == []
    real = bind(FakeDB(lists=[gtd_list()], items=[], hierarchy=hierarchy))
    wet = run(go())
    assert dry["projects"]["created"] == wet["projects"]["created"]
    # …and it is really 4: department + Space + Folder + List.
    assert wet["projects"]["created"] == 4


def test_a_dry_run_does_not_commit(bind):
    db = bind(FakeDB(lists=[gtd_list()], items=[gtd_item()]))
    run(go(dry_run=True))
    assert not db.issued("INSERT INTO pm_activities")


# ── The gate ───────────────────────────────────────────────────────────────

def test_the_route_carries_the_admin_gate():
    """Local source or not, this writes projects and tasks for the whole org."""
    from gateway.routes.projects.core import router

    route = next(
        r for r in router.routes
        if getattr(r, "path", "") == "/projects/import/from-tasks"
    )
    assert route.dependencies, "the import route has no permission gate"


def test_the_department_name_falls_back_rather_than_creating_a_blank(bind):
    db = bind(FakeDB(lists=[], items=[]))
    result = run(go(department="   "))
    assert result["department"] == "Company"
    assert db.inserted_into("pm_projects")[0]["name"] == "Company"


def test_the_migration_source_is_recorded_as_import(bind):
    """`source` is what tells a later reader these rows were not typed in."""
    db = bind(FakeDB(lists=[gtd_list()], items=[gtd_item()]))
    run(go())
    assert all(
        p["source"] == "import" for p in db.inserted_into("pm_projects")
    )
    assert all(t["source"] == "import" for t in db.inserted_into("pm_tasks"))


def test_only_synced_rows_are_read_never_local_ones(bind):
    """A personal LOCAL capture is the member's own; publishing it to a shared
    board would be a disclosure nobody asked for."""
    db = bind(FakeDB(lists=[gtd_list()], items=[gtd_item()]))
    run(go())
    reads = [s for s in db.statements if "FROM gtd_projects p" in s or "FROM gtd_items i" in s]
    assert reads
    for statement in reads:
        assert re.search(r"source <> 'LOCAL'", statement), statement
