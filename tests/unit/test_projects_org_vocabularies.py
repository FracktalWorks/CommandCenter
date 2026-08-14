"""WS-27bj / D-PM-16 — org-wide vocabularies.

Mirrors migration 172. The file is found by CONTENT, never by number: migration
numbers are taken at build time and re-checked at merge (R1, after three
collisions in two weeks), so a test that hard-codes 172 goes red on a renumber
that changed nothing.

⚠️ These assert the SQL was WRITTEN correctly. That the constraints BEHAVE is a
separate, stronger claim, proved against a real database (spec §9.11) -- a
hermetic check agrees with whatever SQL it is handed, which is exactly how five
live bugs shipped green (R8).
"""

from __future__ import annotations

from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[2] / "infra" / "postgres"
TABLES = ("pm_task_types", "pm_custom_fields", "pm_tags")


@pytest.fixture(scope="module")
def sql() -> str:
    hits = [
        p for p in MIGRATIONS.glob("*.sql")
        if "org-wide vocabularies" in p.read_text(encoding="utf-8")
    ]
    assert len(hits) == 1, f"expected exactly one org-vocabulary migration, got {hits}"
    return hits[0].read_text(encoding="utf-8")


@pytest.mark.parametrize("table", TABLES)
def test_project_id_is_widened_on_every_vocabulary_table(sql: str, table: str) -> None:
    """All three, or the ruling is only half-applied and the odd one out is the
    table people then work around."""
    assert f"ALTER TABLE {table}" in sql
    assert "ALTER COLUMN project_id DROP NOT NULL" in sql


@pytest.mark.parametrize("table", TABLES)
def test_each_table_gets_a_PAIR_of_partial_uniques(sql: str, table: str) -> None:
    """One partial alone is the bug this pairing exists to prevent.

    Keep only the ``project_id IS NOT NULL`` half and org-wide rows are
    unconstrained -- a tenant could hold two org-wide "Bug" rows and every read
    would have to pick one arbitrarily.
    """
    assert f"ON {table} (project_id" in sql
    assert f"ON {table} (organization_id" in sql
    assert sql.count(f"ON {table} (") >= 2


def test_org_wide_half_is_keyed_on_the_tenant(sql: str) -> None:
    """The tenant anchor is what makes ``project_id IS NULL`` safe.

    ``organization_id`` is already NOT NULL on all three (migration 161), so an
    org-wide row is org-wide WITHIN ONE ORGANIZATION, never global. An org-wide
    unique keyed on anything else would let one tenant's vocabulary collide with
    another's -- or worse, be read by it.
    """
    for table in TABLES:
        assert f"ON {table} (organization_id" in sql
    assert "WHERE project_id IS NULL" in sql


def test_tag_identity_stays_case_insensitive_on_both_halves(sql: str) -> None:
    """``idx_pm_tags_project_name`` was already ``lower(name)``: typing "Bug"
    when "bug" exists means the tag you can already see. The org-wide half
    inherits that rule rather than inventing a second, stricter one."""
    assert "ON pm_tags (project_id, lower(name))" in sql
    assert "ON pm_tags (organization_id, lower(name))" in sql


def test_custom_fields_are_keyed_on_field_key_not_name(sql: str) -> None:
    """``field_key`` is the stable identity values are stored under; ``name`` is
    free to change. Keying the uniqueness on the display name would make
    renaming a field a constraint violation."""
    assert "ON pm_custom_fields (project_id, field_key)" in sql
    assert "ON pm_custom_fields (organization_id, field_key)" in sql
    assert "(project_id, name)" not in sql.split("pm_custom_fields")[-1]


@pytest.mark.parametrize("table", TABLES)
def test_the_old_whole_table_unique_is_removed(sql: str, table: str) -> None:
    """Left in place it would forbid the shadowing case D-PM-16 requires --
    an org-wide "bug" and a root-local "bug" must coexist."""
    assert "DROP CONSTRAINT IF EXISTS" in sql or "DROP INDEX IF EXISTS" in sql


def test_it_is_idempotent(sql: str) -> None:
    """Re-applying a migration must be a no-op: the ladder replays from 01."""
    creates = [ln for ln in sql.splitlines() if ln.strip().startswith("CREATE ")]
    assert creates
    for line in creates:
        assert "IF NOT EXISTS" in line, line
    for line in sql.splitlines():
        if line.strip().startswith(("DROP CONSTRAINT", "DROP INDEX")) or "DROP CONSTRAINT" in line:
            assert "IF EXISTS" in line, line


def test_it_does_not_promote_any_existing_row(sql: str) -> None:
    """R6 expand-only, and the D-PM-16 boundary: deciding which per-project row
    becomes org-wide is a judgement call this migration must never make on
    somebody's behalf. No UPDATE may set project_id to NULL."""
    lowered = sql.lower()
    assert "set project_id = null" not in lowered
    assert "update pm_tags" not in lowered
    assert "update pm_task_types" not in lowered
    assert "update pm_custom_fields" not in lowered
