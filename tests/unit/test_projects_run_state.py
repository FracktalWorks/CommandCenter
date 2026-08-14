"""WS-27bg slice 1 — the run-state axis, read against the migration that owns it.

Spec: ``project-docs/specs/project_management_app.md`` §9.8.3, D-PM-25/26/27.

**Why the vocabulary tests read the SQL file.** ``core.PROJECT_STATUSES`` is a
hand-written mirror of a CHECK constraint, and this package has already paid for
one of those going out of step: migration 150 added ``attachment`` to
``pm_activities``' CHECK, ``ACTIVITY_TYPES`` was not updated, and every file
upload answered 422 while all 25 attachment tests passed — because they
monkeypatched the function that guards the vocabulary. That constant's own
docstring draws the conclusion: *"A tuple that mirrors a migration by hand needs
a test that reads the migration; anything else is a comment claiming to be an
invariant."* So these read the file.

The migration is found by CONTENT (``archived_root_id``), never by number — R1
forbids pinning a future number, and a renumber in review must cost nothing.

⚠️ **What is NOT tested here, deliberately.** The subtree walk, the reversibility
of ``archived_root_id``, the three automation guards and the read path's plan are
all in ``tests/live/live_ws27bg.py``, against a real Postgres. They are
statements about what SQL *matched*, and the hermetic fake agrees with whatever
SQL it is handed (R8). Asserting them here would produce a green suite that
proves nothing, which is the failure mode this file is trying not to repeat.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from gateway.routes.projects.core import (
    PROJECT_STATUSES,
    RUN_STATES,
    RUNNABLE_STATUSES,
    is_runnable,
    runnable_project_clause,
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "infra" / "postgres"
PROJECTS = (
    Path(__file__).resolve().parents[2]
    / "apps" / "services" / "gateway" / "gateway" / "routes" / "projects"
)


def _run_state_migration() -> Path:
    """The migration that adds ``archived_root_id``, whatever it is numbered."""
    found = [
        path for path in sorted(MIGRATIONS.glob("*.sql"))
        if path.name != "schema.generated.sql"
        and "archived_root_id" in path.read_text(encoding="utf-8")
    ]
    assert found, "no migration adds archived_root_id"
    # If a later migration also mentions the column, the one that ADDs it wins.
    adds = [p for p in found if "ADD COLUMN IF NOT EXISTS archived_root_id" in
            p.read_text(encoding="utf-8")]
    assert len(adds) == 1, f"expected exactly one migration to add it, got {adds}"
    return adds[0]


def _checked_statuses() -> list[str]:
    """The values the migration's widened CHECK actually accepts."""
    sql = _run_state_migration().read_text(encoding="utf-8")
    match = re.search(
        r"ADD CONSTRAINT pm_projects_status_check\s*CHECK \(status IN \((.*?)\)\)",
        sql, re.S,
    )
    assert match, "the widened status CHECK is not in the migration"
    body = match.group(1)
    # Strip the SQL comments the block carries, then take the quoted literals.
    body = re.sub(r"--[^\n]*", "", body)
    return re.findall(r"'([a-z_]+)'", body)


# ── The mirror ──────────────────────────────────────────────────────────────

def test_project_statuses_mirrors_the_check_in_the_migration():
    assert sorted(PROJECT_STATUSES) == sorted(_checked_statuses())


def test_the_run_state_axis_excludes_the_retained_archived_value():
    """D-PM-25. `archived` is kept in the CHECK for the deploy window only.

    It is not a run state, and anything offering a picker or a hue map keys off
    `RUN_STATES`. If this ever fails because somebody added `archived` back to
    the axis, the fix is to read D-PM-25, not to widen the assertion.
    """
    assert "archived" not in RUN_STATES
    assert "archived" in PROJECT_STATUSES
    assert set(RUN_STATES) < set(PROJECT_STATUSES)


def test_the_run_states_are_the_five_the_decision_named():
    assert RUN_STATES == ("queued", "active", "on_hold", "stopped", "done")


def test_the_migration_is_idempotent_shaped():
    """It is replayed on every deploy (`infra/postgres/README.md`)."""
    sql = _run_state_migration().read_text(encoding="utf-8")
    assert "DROP CONSTRAINT IF EXISTS pm_projects_status_check" in sql
    assert "ADD COLUMN IF NOT EXISTS archived_root_id" in sql
    assert "CREATE INDEX IF NOT EXISTS idx_pm_projects_archived_root" in sql
    # The backfill must select on the very value it removes, or a replay would
    # re-stamp `archived_at` on rows that already moved.
    assert "WHERE status = 'archived'" in sql
    assert "coalesce(archived_at, now())" in sql


def test_the_contraction_names_its_own_trigger():
    """R6. We cannot roll back, so the follow-up must not become folklore."""
    sql = _run_state_migration().read_text(encoding="utf-8")
    assert "later release" in sql.lower()
    assert "DROP CONSTRAINT pm_projects_status_check" in sql


# ── The one runnable predicate ──────────────────────────────────────────────

def test_only_active_is_runnable():
    assert RUNNABLE_STATUSES == frozenset({"active"})


@pytest.mark.parametrize("status", ["queued", "on_hold", "stopped", "done"])
def test_no_other_run_state_is_runnable(status):
    assert is_runnable({"status": status, "archived_at": None}) is False


def test_an_archived_project_is_not_runnable_even_when_active():
    """The two axes are ANDed, not chosen between (D-PM-25).

    An archived project is out of every default surface, so advancing its work
    would be automation acting on rows the product has stopped showing.
    """
    assert is_runnable({"status": "active", "archived_at": None}) is True
    assert is_runnable({"status": "active", "archived_at": "2026-08-13"}) is False


def test_is_runnable_takes_a_row_or_a_mapping():
    class Row:
        status = "active"
        archived_at = None

    assert is_runnable(Row()) is True
    assert is_runnable(None) is False


def test_the_sql_and_python_halves_name_the_same_two_axes():
    clause = runnable_project_clause("p")
    assert "p.status = 'active'" in clause
    assert "p.archived_at IS NULL" in clause


# ── The guard is consulted, in all three places ─────────────────────────────
#
# Structural, and honestly labelled: this proves the call EXISTS, not that it
# WORKS. That each guard actually changes behaviour is mutation-measured in
# `tests/live/live_ws27bg.py` — removing any one of them turns a live check red
# while its paired "and it still fires when active" check stays green.

@pytest.mark.parametrize("module", ["automation.py", "recurrence.py",
                                    "agent_dispatch.py"])
def test_every_automation_path_consults_the_shared_predicate(module):
    source = (PROJECTS / module).read_text(encoding="utf-8")
    assert "is_runnable" in source, (
        f"{module} runs work without consulting the project's run state — "
        f"see §9.8.2 for what each of these corrupts"
    )


def test_no_automation_path_rolls_its_own_run_state_check():
    """CLAUDE.md §5 — a second way to ask an existing question is a defect.

    A literal `'on_hold'` or `status == 'active'` inside an automation module is
    the shape this would take, and it is how the one predicate becomes three
    that disagree.
    """
    for module in ("automation.py", "recurrence.py", "agent_dispatch.py"):
        source = (PROJECTS / module).read_text(encoding="utf-8")
        code = "\n".join(
            line for line in source.splitlines()
            if not line.lstrip().startswith("#")
        )
        assert "'on_hold'" not in code and '"on_hold"' not in code, module
