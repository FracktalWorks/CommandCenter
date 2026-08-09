"""The projects migration, read as text — idempotency and the shape §3 specifies.

Spec: ``project-docs/specs/project_management_app.md`` §3 · WS-27a done-when 1.

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


# ── The activity vocabulary, and the mirror that went stale ─────────────────
#
# `core.ACTIVITY_TYPES` is a hand-maintained copy of `pm_activities`'s CHECK,
# and `record_activity` refuses anything outside it BEFORE the insert. When the
# two disagree the route does not degrade — it 422s and rolls back the whole
# write.
#
# It happened: migration 150 added `attachment` to the CHECK, the tuple was not
# updated, and every file upload to a project task failed with "Unknown
# activity type 'attachment'". All 25 attachment tests passed throughout,
# because they monkeypatch `record_activity` and so never reached the
# vocabulary it guards. These two tests are the fence that was missing — they
# read the migrations rather than restating them, so the next value added to
# either side fails here instead of in production.

def _activity_check_values() -> set[str]:
    """The vocabulary as the DATABASE will enforce it.

    Assembled from every migration that constrains `pm_activities.type`, taking
    the LAST one in file order — 146 creates the CHECK and later migrations
    replace it wholesale, so the newest definition is the one that survives a
    full replay.
    """
    latest: str | None = None
    for path in sorted(MIGRATIONS.glob("*.sql"), key=lambda p: p.name):
        if path.name == "schema.generated.sql":
            continue
        text = "\n".join(
            re.sub(r"--.*$", "", line)
            for line in path.read_text(encoding="utf-8").splitlines()
        )
        for match in re.finditer(
            r"CHECK\s*\(\s*type\s+IN\s*\((.*?)\)\s*\)", text, re.I | re.S,
        ):
            latest = match.group(1)
    assert latest is not None, "no migration constrains pm_activities.type"
    return set(re.findall(r"'([a-z_]+)'", latest))


def test_the_activity_vocabulary_mirror_is_exact() -> None:
    from gateway.routes.projects.core import ACTIVITY_TYPES

    assert set(ACTIVITY_TYPES) == _activity_check_values()


def test_every_activity_type_the_routes_write_is_in_the_vocabulary() -> None:
    """The other direction, and the one that actually broke.

    A route naming a type the tuple lacks is a 422 on a successful user action.
    Found by reading the call sites, so a new `record_activity(...)` anywhere
    in the package is covered without anyone remembering to list it here.
    """
    from gateway.routes.projects.core import ACTIVITY_TYPES

    package = Path(__file__).resolve().parents[2] / (
        "apps/services/gateway/gateway/routes/projects"
    )
    used: set[str] = set()
    for path in sorted(package.glob("*.py")):
        used |= set(re.findall(
            r"activity_type\s*=\s*[\"']([a-z_]+)[\"']",
            path.read_text(encoding="utf-8"),
        ))
    assert used, "no activity_type= call sites found — did the package move?"
    assert used <= set(ACTIVITY_TYPES), (
        f"routes write types the vocabulary refuses: "
        f"{sorted(used - set(ACTIVITY_TYPES))}"
    )


# ── The tenant key (WS-29a, migration 161) ──────────────────────────────────
#
# Same rules as everything above, applied to the SECOND file that defines the
# `pm_*` shape. Found by content for the same reason (R1 forbids pinning a
# number), and read with comments stripped for the same reason: this migration
# explains itself at length and an assertion its own prose can satisfy is not an
# assertion.
#
# Spec: project-docs/specs/multi_tenancy.md §3 (D-MT-1 (a), D-MT-3).

#: Every table §3 specifies, plus the six added by 147/150/152/155/156/160.
#: Listed rather than derived, so a table quietly dropped from the tenant
#: migration fails here instead of shrinking the expectation with it.
TENANT_SCOPED_TABLES: tuple[str, ...] = (
    *EXPECTED_TABLES,
    "pm_task_personal",
    "pm_task_attachments",
    "pm_notifications",
    "pm_custom_fields",
    "pm_tags",
    "pm_recurrences",
)


def _tenancy_migration() -> Path:
    """The migration that gives ``pm_projects`` its tenant key."""
    found = [
        path for path in sorted(MIGRATIONS.glob("*.sql"))
        if path.name != "schema.generated.sql"
        and re.search(
            r"ALTER TABLE pm_projects\s+ADD COLUMN IF NOT EXISTS organization_id",
            path.read_text(encoding="utf-8"),
        )
    ]
    assert len(found) == 1, (
        f"expected exactly one migration adding pm_projects.organization_id, "
        f"found {[p.name for p in found]}"
    )
    return found[0]


@pytest.fixture(scope="module")
def tenancy(request: pytest.FixtureRequest) -> str:
    raw = _tenancy_migration().read_text(encoding="utf-8")
    return "\n".join(re.sub(r"--.*$", "", line) for line in raw.splitlines())


@pytest.mark.parametrize("table", TENANT_SCOPED_TABLES)
def test_every_pm_table_gains_the_tenant_key(tenancy: str, table: str) -> None:
    """D-MT-3: the key is carried on EVERY tenant-owned table, even where it is
    derivable. A missing one is a table whose rows belong to nobody — and RLS,
    when D-MT-2 answers, cannot police what it cannot read off the row."""
    assert re.search(
        rf"ALTER TABLE {table}\s+ADD COLUMN IF NOT EXISTS organization_id\s+UUID",
        tenancy,
    ), f"{table} gains no organization_id"


@pytest.mark.parametrize("table", TENANT_SCOPED_TABLES)
def test_every_tenant_key_is_not_null(tenancy: str, table: str) -> None:
    """A nullable tenant key is a row belonging to nobody, which is either
    invisible to everybody or visible to everybody depending on how the
    predicate is written. Neither is an answer."""
    assert re.search(
        rf"ALTER TABLE {table}\s+ALTER COLUMN organization_id SET NOT NULL",
        tenancy,
    ), f"{table}.organization_id may be NULL"


@pytest.mark.parametrize("table", TENANT_SCOPED_TABLES)
def test_every_tenant_key_cascades_from_its_organization(
    tenancy: str, table: str,
) -> None:
    """Same posture as `app_user`, `org_group` and `org_role` (§6): deleting an
    organization takes its rows with it, rather than leaving orphans pointing at
    an id nothing resolves."""
    block = re.search(
        rf"ALTER TABLE {table}\s+ADD COLUMN IF NOT EXISTS organization_id[^;]*;",
        tenancy,
    )
    assert block is not None
    assert re.search(
        r"REFERENCES organization \(id\) ON DELETE CASCADE", block.group(0),
    ), f"{table}.organization_id is not a cascading FK onto organization"


@pytest.mark.parametrize("table", TENANT_SCOPED_TABLES)
def test_every_pm_table_is_backfilled_before_the_constraint(
    tenancy: str, table: str,
) -> None:
    """§2 predicted these tables were empty; the live database said otherwise.

    A `SET NOT NULL` on a table with one un-backfilled row fails the whole
    deploy, so the fill is not optional and is not conditional on the prediction
    having been right.
    """
    fill = re.search(rf"UPDATE {table}\s+SET organization_id", tenancy)
    constrain = re.search(
        rf"ALTER TABLE {table}\s+ALTER COLUMN organization_id SET NOT NULL",
        tenancy,
    )
    assert fill is not None, f"{table} is never backfilled"
    assert constrain is not None
    assert constrain.start() > fill.start(), (
        f"{table} is constrained before it is filled"
    )


def test_the_backfill_names_the_default_organization_and_nothing_else(
    tenancy: str,
) -> None:
    """`slug='default'` is the one seeded row (migration 130). Picking a row by
    ORDER BY, or inventing one, would be a silent guess at which organization
    owns somebody's work — worse than a failed migration."""
    fills = re.findall(
        r"UPDATE pm_\w+\s+SET organization_id = \(([^)]*)\)", tenancy,
    )
    # ⚠️ `\s+`, not a single space: the statements are column-aligned, and a
    # regex demanding one space silently matched exactly ONE of the seventeen —
    # found by a mutant that deleted a guard from the other sixteen and lived.
    assert len(fills) == len(TENANT_SCOPED_TABLES), (
        f"expected {len(TENANT_SCOPED_TABLES)} backfills, matched {len(fills)}"
    )
    for source in fills:
        assert source.strip() == "SELECT id FROM organization WHERE slug = 'default'"


def test_the_backfill_reruns_as_a_no_op(tenancy: str) -> None:
    """The runner replays this on every deploy. Without the WHERE, a second run
    would rewrite every row — including any a later ticket had deliberately
    moved to another organization."""
    statements = re.findall(r"UPDATE pm_\w+\s+SET organization_id[^;]*;", tenancy)
    assert len(statements) == len(TENANT_SCOPED_TABLES), (
        f"expected {len(TENANT_SCOPED_TABLES)} backfills, matched "
        f"{len(statements)} — the alignment defeated the pattern"
    )
    for statement in statements:
        assert "WHERE organization_id IS NULL" in statement, statement


def test_a_childs_tenant_is_checked_against_its_parents(tenancy: str) -> None:
    """D-MT-3 names this as the cost of carrying the key on every row.

    ⚠️ It cannot be a CHECK — a CHECK constraint may only read its own row, and
    Postgres refuses a subquery in one. A BEFORE trigger is the only in-database
    mechanism that can compare against another table, so the guard the spec asks
    for is a trigger and the migration says why.
    """
    assert "CREATE OR REPLACE FUNCTION pm_organization_from_parent()" in tenancy
    # The FILL half…
    assert re.search(
        r"IF NEW\.organization_id IS NULL THEN\s+NEW\.organization_id := parent_org",
        tenancy,
    ), "the trigger does not derive a missing tenant from the parent"
    # …and the REFUSE half, which is the one a mutant can hollow out while
    # leaving a `RAISE EXCEPTION` in the file for a checker to find. The
    # COMPARISON is the guard, not the raise.
    assert re.search(
        r"ELSIF NEW\.organization_id <> parent_org THEN\s+RAISE EXCEPTION",
        tenancy,
    ), "a child may carry a tenant that disagrees with its parent's"


def test_the_trigger_is_declared_replaceably(tenancy: str) -> None:
    """`CREATE TRIGGER` has no `IF NOT EXISTS`; a plain one fails the second
    deploy, which is the deploy nobody watches."""
    plain = re.findall(r"CREATE\s+TRIGGER\s+\S+", tenancy, re.I)
    assert not plain, f"CREATE TRIGGER without OR REPLACE: {plain}"
    assert len(re.findall(r"CREATE OR REPLACE TRIGGER", tenancy)) >= len(
        TENANT_SCOPED_TABLES
    )


@pytest.mark.parametrize("table", TENANT_SCOPED_TABLES)
def test_every_pm_table_derives_its_tenant_from_a_parent(
    tenancy: str, table: str,
) -> None:
    """The FILL half, and the reason 43 INSERT sites did not have to change.

    A table with no attachment is a table whose every insert must remember the
    key by hand — D-MT-2 (b)'s named failure mode, and the discipline that
    produced 137 unscoped tables in the first place.
    """
    assert re.search(
        rf"BEFORE INSERT OR UPDATE ON {table}\b", tenancy,
    ), f"{table} has no tenant-derivation trigger"


def test_the_two_rows_that_name_two_parents_verify_both(tenancy: str) -> None:
    """⚠️ A link and a view position each name TWO rows, so each is a row that
    could STRADDLE two organizations. One attachment fills; the second is what
    makes the straddle impossible rather than merely unlikely."""
    for table, columns in (
        ("pm_task_links", ("source_task_id", "target_task_id")),
        ("pm_view_task_positions", ("view_id", "task_id")),
        # A task's denormalised root must live where the project it sits in does.
        ("pm_tasks", ("project_id", "root_project_id")),
        # An activity may hang off either, and when both are set they must agree.
        ("pm_activities", ("task_id", "project_id")),
    ):
        block = tenancy.split(f"BEFORE INSERT OR UPDATE ON {table}\n")
        assert len(block) == 3, f"{table} does not have exactly two attachments"
        for column in columns:
            assert f"'{column}')" in tenancy, f"{table} never verifies {column}"


def test_no_row_level_security_is_declared(tenancy: str) -> None:
    """⚠️ D-MT-2 is OPEN. RLS is *proposed*, not decided, and shipping a policy
    here would settle by default a decision the spec says is unsettled — while
    requiring a GUC that no connection in this system sets."""
    shouted = tenancy.upper()
    for forbidden in ("ROW LEVEL SECURITY", "CREATE POLICY", "CURRENT_SETTING"):
        assert forbidden not in shouted, (
            f"the tenancy migration declares {forbidden}; D-MT-2 is open"
        )
