"""The projects migration, read as text — idempotency and the shape §3 specifies.

Spec: ``ai-company-brain/specs/project_management_app.md`` §3 · WS-27a done-when 1.

**Why static.** ``infra/postgres/README.md`` requires every ``02+`` migration to
be idempotent, because ``apply_migrations.sh`` replays the whole ladder on every
deploy. The obvious way to check that is to run it twice — and §10 deliberately
runs no database, so an idempotency claim that holds only "by inspection" is not
a claim at all. Reading the file is what makes it enforceable in CI: a
``CREATE TABLE`` that loses its ``IF NOT EXISTS`` fails here rather than on the
second deploy, which is the deploy nobody watches.

The file is found by CONTENT, not by number: R1 forbids writing an absolute
future migration number anywhere, and a test pinned to ``145_`` would be the
same mistake in a different file. If the migration is renumbered in review, this
still finds it.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[2] / "infra" / "postgres"

#: Every table §3 specifies. Listed here rather than derived from the file, so a
#: table silently dropped from the migration fails instead of shrinking the
#: expectation with it.
EXPECTED_TABLES: tuple[str, ...] = (
    "pm_projects",
    "pm_project_grants",
    "pm_task_statuses",
    "pm_task_types",
    "pm_task_counters",
    "pm_tasks",
    "pm_task_assignees",
    "pm_task_links",
    "pm_activities",
    "pm_views",
    "pm_view_task_positions",
)


def _projects_migration() -> Path:
    """The migration that creates ``pm_projects``, whatever it is numbered."""
    found = [
        path for path in sorted(MIGRATIONS.glob("*.sql"))
        if path.name != "schema.generated.sql"
        and "CREATE TABLE IF NOT EXISTS pm_projects" in path.read_text(
            encoding="utf-8",
        )
    ]
    assert len(found) == 1, (
        f"expected exactly one migration creating pm_projects, found "
        f"{[p.name for p in found]}"
    )
    return found[0]


@pytest.fixture(scope="module")
def sql() -> str:
    return _projects_migration().read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def bare(sql: str) -> str:
    """The statement text with ``--`` comments stripped.

    Every assertion about what the migration DOES runs against this: the header
    and the inline notes talk about tables and constraints by name, and a check
    that its own explanation can satisfy is a check that fails open.
    """
    return "\n".join(re.sub(r"--.*$", "", line) for line in sql.splitlines())


# ── Idempotency ─────────────────────────────────────────────────────────────

def test_every_create_table_is_guarded(bare: str) -> None:
    unguarded = [
        m.group(0) for m in re.finditer(r"CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)\S+",
                                        bare, re.I)
    ]
    assert not unguarded, f"CREATE TABLE without IF NOT EXISTS: {unguarded}"


def test_every_create_index_is_guarded(bare: str) -> None:
    unguarded = [
        m.group(0) for m in re.finditer(r"CREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)\S+",
                                        bare, re.I)
    ]
    assert not unguarded, f"CREATE INDEX without IF NOT EXISTS: {unguarded}"


def test_every_seed_insert_handles_conflict(bare: str) -> None:
    """A redeploy replays this file; an INSERT without ON CONFLICT fails the
    second one and takes the whole deploy with it."""
    inserts = re.findall(r"INSERT\s+INTO\s+(\w+)(.*?);", bare, re.I | re.S)
    for table, body in inserts:
        assert re.search(r"ON\s+CONFLICT", body, re.I), (
            f"INSERT INTO {table} has no ON CONFLICT clause"
        )


def test_the_feature_row_does_not_stomp_is_default(bare: str) -> None:
    """Same rule as migrations 130 and 144: an admin may have retuned the
    default feature set, and a redeploy must not undo it."""
    conflict = re.search(
        r"INSERT\s+INTO\s+feature_catalog(.*?);", bare, re.I | re.S,
    )
    assert conflict is not None
    update = conflict.group(1).split("DO UPDATE", 1)[-1]
    assert "is_default" not in update


# ── The shape §3 specifies ──────────────────────────────────────────────────

@pytest.mark.parametrize("table", EXPECTED_TABLES)
def test_the_table_exists(bare: str, table: str) -> None:
    assert f"CREATE TABLE IF NOT EXISTS {table}" in bare


def test_the_hierarchy_is_two_self_referencing_foreign_keys(bare: str) -> None:
    """D-PM-2, and the single most load-bearing claim in §3.

    Departments → projects → subprojects is one self-FK; tasks → subtasks is the
    other. If either were replaced by per-level tables the whole model changes,
    so this is asserted structurally rather than left to prose.
    """
    assert re.search(
        r"parent_project_id\s+UUID\s+REFERENCES\s+pm_projects\s*\(id\)", bare, re.I,
    )
    assert re.search(
        r"parent_task_id\s+UUID\s+REFERENCES\s+pm_tasks\s*\(id\)", bare, re.I,
    )


def test_there_are_no_per_level_tables(bare: str) -> None:
    """The failure mode D-PM-2 rejects: an `epics`/`stories`/`subtasks` zoo, or
    a `departments` table beside projects."""
    for forbidden in ("pm_epics", "pm_stories", "pm_subtasks", "pm_departments"):
        assert f"CREATE TABLE IF NOT EXISTS {forbidden}" not in bare


def test_tasks_carry_no_rank_column(bare: str) -> None:
    """D-PM-5. Ordering is per view, in pm_view_task_positions — a rank column
    on the task is exactly what would stop the People Center board and a Center
    slice ordering the same task differently."""
    tasks_block = bare.split("CREATE TABLE IF NOT EXISTS pm_tasks", 1)[1].split(");", 1)[0]
    for forbidden in ("position", "rank", "sort_key", "sort_order"):
        assert not re.search(rf"^\s+{forbidden}\s", tasks_block, re.I | re.M), (
            f"pm_tasks declares a '{forbidden}' column; ordering is per-view"
        )


def test_the_view_position_table_carries_a_float_and_a_group(bare: str) -> None:
    """Fractional indexing needs a float; a cross-column drag needs the group
    key, or moving a task between board columns is two writes instead of one."""
    block = bare.split(
        "CREATE TABLE IF NOT EXISTS pm_view_task_positions", 1,
    )[1].split(");", 1)[0]
    assert re.search(r"position\s+DOUBLE\s+PRECISION\s+NOT\s+NULL", block, re.I)
    assert re.search(r"group_key\s+TEXT", block, re.I)
    assert re.search(r"UNIQUE\s*\(\s*view_id\s*,\s*task_id\s*\)", block, re.I)


def test_statuses_are_rows_with_a_semantic_category(bare: str) -> None:
    """D-CRM-2's argument, restated for tasks: the importer must represent
    ClickUp's real status names, so the machine-readable half has to be a
    separate column from the owner-controlled name."""
    block = bare.split(
        "CREATE TABLE IF NOT EXISTS pm_task_statuses", 1,
    )[1].split(");", 1)[0]
    assert re.search(r"category\s+TEXT\s+NOT\s+NULL", block, re.I)
    for category in ("backlog", "todo", "in_progress", "done", "cancelled"):
        assert f"'{category}'" in block


def test_the_grant_subject_is_a_plain_column_not_an_enum(bare: str) -> None:
    """The vocabulary (`email | group:<slug> | org`) is validated in code and
    shared with rooms; a CHECK here could not express the email arm and would
    drift from the shipped validator."""
    block = bare.split(
        "CREATE TABLE IF NOT EXISTS pm_project_grants", 1,
    )[1].split(");", 1)[0]
    assert re.search(r"subject\s+TEXT\s+NOT\s+NULL", block, re.I)
    assert "CHECK" not in block.upper()
    assert re.search(r"UNIQUE\s*\(\s*project_id\s*,\s*subject\s*\)", block, re.I)


def test_assignees_are_strings_so_agents_are_assignable(bare: str) -> None:
    """D-PM-4. A FK onto app_user would exclude `agent:<name>` by construction —
    which is precisely what this app must not do, since assigning an agent IS
    how work is handed to one."""
    block = bare.split(
        "CREATE TABLE IF NOT EXISTS pm_task_assignees", 1,
    )[1].split(");", 1)[0]
    assert re.search(r"assignee\s+TEXT\s+NOT\s+NULL", block, re.I)
    assert "app_user" not in block


def test_the_activity_spine_requires_a_target(bare: str) -> None:
    """A timeline row pointing at nothing is unreachable from every read path,
    so it is refused at the schema rather than discovered as a gap in a report.
    Same CHECK as crm_activities."""
    block = bare.split(
        "CREATE TABLE IF NOT EXISTS pm_activities", 1,
    )[1].split(");", 1)[0]
    assert re.search(
        r"CHECK\s*\(\s*task_id\s+IS\s+NOT\s+NULL\s+OR\s+project_id\s+IS\s+NOT\s+NULL",
        block, re.I,
    )


def test_a_status_in_use_cannot_be_deleted(bare: str) -> None:
    """RESTRICT, not SET NULL: a task with no status has no lane on any board,
    and the API turns the refusal into a 409 naming the count."""
    block = bare.split("CREATE TABLE IF NOT EXISTS pm_tasks", 1)[1].split(");", 1)[0]
    assert re.search(
        r"status_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+pm_task_statuses\s*\(id\)"
        r"\s+ON\s+DELETE\s+RESTRICT",
        block, re.I,
    )


def test_deleting_a_task_promotes_its_subtasks(bare: str) -> None:
    """SET NULL, not CASCADE. Deleting a parent must not destroy work nobody
    asked to delete — and the delete route reports the promotion rather than
    counting it as a cascade."""
    block = bare.split("CREATE TABLE IF NOT EXISTS pm_tasks", 1)[1].split(");", 1)[0]
    assert re.search(
        r"parent_task_id\s+UUID\s+REFERENCES\s+pm_tasks\s*\(id\)"
        r"\s+ON\s+DELETE\s+SET\s+NULL",
        block, re.I,
    )


def test_the_clickup_snapshot_exists_for_the_three_way_merge(bare: str) -> None:
    """D-PM-7's base. Without it "both sides changed" is indistinguishable from
    "one side changed", and the two-way sync degrades to last-writer-wins."""
    block = bare.split("CREATE TABLE IF NOT EXISTS pm_tasks", 1)[1].split(");", 1)[0]
    assert re.search(r"clickup_snapshot\s+JSONB", block, re.I)
    assert re.search(r"clickup_id\s+TEXT\s+UNIQUE", block, re.I)


def test_the_feature_row_is_registered_and_not_a_default(bare: str) -> None:
    row = re.search(r"INSERT\s+INTO\s+feature_catalog.*?VALUES\s*(.*?)ON\s+CONFLICT",
                    bare, re.I | re.S)
    assert row is not None
    values = row.group(1)
    assert "'projects'" in values
    assert "'/projects'" in values
    assert "'apps'" in values
    # is_default false — same posture as the CRM: the slug reaches `*`-holders
    # and `admin` until an admin grants it.
    assert re.search(r",\s*false\s*\)", values, re.I)
