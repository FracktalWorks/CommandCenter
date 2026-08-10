"""WS-27h — every legacy column has a named destination before the move runs.

Spec: ``project-docs/specs/project_management_app.md`` §7.5.1.

The retirement plan used to say the move was "a copy rather than a translation."
That was true of the seven overlay columns ``pm_task_personal`` mirrors and false
of the other twenty-odd. Executed on that sentence, WS-27h would have deleted the
founder priority matrix, all of timeboxing and the whole Waiting-For view — and
reported success, because a migration that drops a column nobody mapped looks
exactly like a migration that had nothing to map.

So §7.5.1 names a destination for every column, and this file is the fence that
keeps it honest. It fails when somebody adds a column to the legacy store without
saying where it goes — which is the only way the gap could reopen, since the spec
itself is now complete.

Deliberately a spec test, not a schema test: it compares the SQL on disk against
the prose that governs it. Both are checked in, so a drift between them is a
merge-time failure rather than a discovery on migration day.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MIGRATIONS = REPO / "infra" / "postgres"
SPEC = REPO / "project-docs" / "specs" / "project_management_app.md"

#: Columns that exist in the legacy table but are pure plumbing — a destination
#: for them would be noise. `id` is the row's identity and does not travel; the
#: `pm_tasks` row gets its own.
_PLUMBING: frozenset[str] = frozenset({"id"})


def _read(path: Path) -> str:
    # Windows defaults to cp1252 and crashes on this tree's em-dashes.
    return path.read_text(encoding="utf-8")


def _columns_of(table: str) -> set[str]:
    """Every column `table` has ever gained, across CREATE and ALTER.

    Reads the migrations rather than a live database on purpose: this must run
    in CI with no Postgres, and the question is about the *plan*, not about what
    some box happens to have applied.
    """
    columns: set[str] = set()

    for path in sorted(MIGRATIONS.glob("*.sql")):
        sql = _read(path)

        create = re.search(
            rf"CREATE TABLE IF NOT EXISTS {table} \((.*?)\n\);", sql, re.S,
        )
        if create:
            for line in create.group(1).splitlines():
                bare = line.strip()
                if not bare or bare.startswith("--"):
                    continue
                name = re.match(r"([a-z_]+)\s+[A-Z]", bare)
                if name:
                    columns.add(name.group(1))

        # `ALTER TABLE t ADD COLUMN IF NOT EXISTS c TYPE` — one statement may
        # carry several ADDs separated by commas across lines, so scan the whole
        # statement rather than the matching line.
        for statement in re.findall(
            rf"ALTER TABLE {table}\b(.*?);", sql, re.S,
        ):
            for name in re.findall(
                r"ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_]+)", statement,
            ):
                columns.add(name)

    return columns - _PLUMBING


@pytest.fixture(scope="module")
def destination_section() -> str:
    """§7.5.1, the destination table, as text."""
    spec = _read(SPEC)
    start = spec.find("#### 7.5.1")
    assert start != -1, (
        "§7.5.1 (the WS-27h destination table) is missing from the spec — it is "
        "what stops the retirement from silently deleting features."
    )
    end = spec.find("\n### ", start)
    return spec[start : end if end != -1 else len(spec)]


@pytest.fixture(scope="module")
def named_in_spec(destination_section: str) -> set[str]:
    """Every identifier the destination table mentions in backticks."""
    return set(re.findall(r"`([a-z_]+)`", destination_section))


def test_gtd_items_columns_exist_at_all() -> None:
    """Guards the guard: a parser that silently matches nothing would make every
    coverage test below pass vacuously."""
    columns = _columns_of("gtd_items")
    assert len(columns) >= 25, (
        f"only parsed {len(columns)} gtd_items columns ({sorted(columns)}) — the "
        "migration parser is probably broken, which would make the coverage "
        "tests below pass while checking nothing"
    )
    for expected in ("disposition", "important", "deep_work", "scheduled_start"):
        assert expected in columns, f"parser missed a known column: {expected}"


def test_every_gtd_items_column_has_a_named_destination(
    named_in_spec: set[str],
) -> None:
    missing = sorted(_columns_of("gtd_items") - named_in_spec)
    assert not missing, (
        f"{len(missing)} gtd_items column(s) have no destination in spec §7.5.1: "
        f"{missing}. WS-27h would drop them and report success. Name where each "
        "one goes — pm_tasks if the fact is true for everyone on the task, "
        "pm_task_personal if two people on it could legitimately differ."
    )


def test_every_gtd_waiting_column_has_a_named_destination(
    named_in_spec: set[str],
) -> None:
    """The Waiting-For view (WS-18) rests entirely on this table, and it has no
    `pm_*` counterpart — the case most likely to be lost quietly."""
    missing = sorted(_columns_of("gtd_waiting") - named_in_spec)
    assert not missing, (
        f"{len(missing)} gtd_waiting column(s) have no destination in §7.5.1: "
        f"{missing}. This table IS the Waiting-For view."
    )


def test_the_blocked_destinations_are_still_marked_blocked(
    destination_section: str,
) -> None:
    """Two rows are not decisions this ticket may take.

    `horizon_id` belongs to WS-21, which is DO-NOT-DISPATCH; the provider columns
    cannot drop before WS-27g retires the arm that fills them. If either loses its
    marker, an executing agent reads the row as settled and acts on it.
    """
    assert "horizon_id" in destination_section
    horizon_row = next(
        line for line in destination_section.splitlines() if "horizon_id" in line
    )
    assert "WS-21" in horizon_row and "🔴" in horizon_row, (
        "the horizon_id row lost its blocked marker or its owner — it reads as a "
        f"decision this ticket may take, which it is not: {horizon_row}"
    )

    provider_row = next(
        line for line in destination_section.splitlines()
        if "provider_task_id" in line
    )
    assert "WS-27g" in provider_row, (
        "the provider-column row no longer names WS-27g — the sequencing "
        f"constraint is what stops SourceBadge losing its data early: {provider_row}"
    )


def test_the_new_schema_is_still_flagged_as_new(destination_section: str) -> None:
    """The columns that do not exist yet are the whole point of §7.5.1. If the
    NEW markers go, the section reads as "all destinations already exist" and the
    schema step disappears from the ticket."""
    assert destination_section.count("**NEW") >= 4, (
        "§7.5.1 has lost its 🔴 NEW markers — the twelve new pm_task_personal "
        "columns, the pm_tasks flag and the pm_task_waiting table are what make "
        "WS-27h a schema change and not just a data move"
    )
