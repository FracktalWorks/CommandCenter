"""WS-27m — the tag registry.

Spec: `ai-company-brain/specs/project_management_app.md` §11.2 item 5, §11.10.

`paca_pm_research_2026-08.md` row 13 REFUSED Paca's bare array — "no registry,
no colors, no rename/merge" — and §5 shipped `pm_tasks.tags TEXT[]` in its
place with the registry named as additive later. This is the registry, and the
claims worth pinning are the ones that decide whether a tag set stays usable or
rots:

* **one spelling per tag.** "Bug", "bug" and "BUG" are one tag. The task's array
  stores the REGISTRY's spelling, which is what makes filtering by it find all
  of it rather than a third of it.
* **a merge leaves the target ONCE.** A task carrying both tags is the case that
  is easy to get wrong, and getting it wrong leaves a duplicate that renders
  twice and survives the next merge too.
* **a rename is not a merge.** Renaming onto an existing name is refused, because
  the two have different outcomes and one of them destroys a tag.
* **applying an unknown tag registers it.** Refusing would make tagging a
  two-step errand, which is how tagging gets abandoned.

Pure functions, tested directly. No Postgres, no fake.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import HTTPException
from gateway.routes.projects.tags import (
    MAX_TAG,
    MAX_TAGS_PER_TASK,
    canonicalise,
    merged_tags,
    normalise_tag,
    renamed_tags,
    unregistered,
)

REPO = Path(__file__).resolve().parents[2]
MIGRATION = REPO / "infra/postgres/156_projects_tags.sql"


def sql_without_comments() -> str:
    text = MIGRATION.read_text(encoding="utf-8")
    return "\n".join(re.sub(r"--.*$", "", line) for line in text.splitlines())


REGISTRY = {"bug": "bug", "needs review": "needs review", "ops": "Ops"}


# ── The schema and this module agree ────────────────────────────────────────

def test_identity_is_case_insensitive_in_the_DATABASE_not_only_here():
    """The claim rests on a unique index over `lower(name)`. Enforcing it only
    in Python means two requests racing can still create "Bug" beside "bug",
    and then nothing can tell them apart again."""
    sql = sql_without_comments()
    assert re.search(
        r"CREATE UNIQUE INDEX[^;]*ON pm_tags \(project_id, lower\(name\)\)",
        sql, re.I,
    ), "156 no longer makes tag identity case-insensitive"


def test_the_length_cap_is_the_one_the_database_enforces():
    """A tag this module accepts and the CHECK refuses is an opaque
    IntegrityError 500 instead of the 422 it writes."""
    match = re.search(r"length\(name\)\s*<=\s*(\d+)", sql_without_comments())
    assert match, "156 no longer caps the length of a tag"
    assert int(match.group(1)) == MAX_TAG


def test_the_database_refuses_an_untrimmed_name():
    """`' bug'` renders identically to `'bug'` and filters separately — the
    exact failure the registry exists to prevent, so both sides refuse it."""
    assert "name = trim(name)" in sql_without_comments()


def test_the_backfill_registers_the_tags_that_already_exist():
    """`tags` has been on `pm_tasks` since 146 and the import path writes them.
    An empty registry beside a tagged corpus means the first rename finds
    nothing and the manager shows nothing."""
    sql = sql_without_comments()
    assert "INSERT INTO pm_tags" in sql
    assert "unnest(t.tags)" in sql


def test_the_backfill_keeps_the_spelling_people_actually_use():
    """`min()` alone would canonicalise a corpus of 400 "Bug" to a single stray
    "BUG". The winner is the most frequent form, ties broken deterministically
    so the result does not depend on scan order."""
    sql = sql_without_comments()
    # Up to `AS rank`, not to the first `)` — the OVER clause contains nested
    # parens (`lower(tag)`, `count(*)`) and a non-greedy match stops inside them.
    window = re.search(r"row_number\(\)\s*OVER\s*\((.*?)\)\s*AS rank", sql, re.S | re.I)
    assert window, "the backfill no longer ranks the spellings"
    assert re.search(r"ORDER BY\s+count\(\*\)\s+DESC", window.group(1), re.I), (
        "the most-used spelling must win"
    )


# ── normalise ───────────────────────────────────────────────────────────────

def test_a_tag_is_trimmed():
    assert normalise_tag("  bug  ") == "bug"


def test_internal_whitespace_is_collapsed():
    """"needs  review" and "needs review" are the same label typed twice.
    Letting both in creates two tags that render almost identically."""
    assert normalise_tag("needs   review") == "needs review"
    assert normalise_tag("needs\treview") == "needs review"


def test_a_blank_is_not_a_tag_and_is_not_an_error():
    """It arrives from a trailing comma in a text box — a typo, not a request."""
    assert normalise_tag("") is None
    assert normalise_tag("   ") is None
    assert normalise_tag(None) is None
    assert normalise_tag(7) is None


def test_an_over_long_tag_is_refused_rather_than_truncated():
    """Truncating would silently merge two different long tags into one."""
    with pytest.raises(HTTPException) as exc:
        normalise_tag("x" * (MAX_TAG + 1))
    assert exc.value.status_code == 422


def test_a_tag_exactly_at_the_cap_is_allowed():
    assert normalise_tag("x" * MAX_TAG) == "x" * MAX_TAG


# ── canonicalise ────────────────────────────────────────────────────────────

def test_a_known_tag_is_stored_with_the_REGISTRY_spelling():
    """The central claim. Without it "Ops" and "Ops" written by two people are
    two array values and one filter finds half of them."""
    assert canonicalise(["ops"], REGISTRY) == ["Ops"]
    assert canonicalise(["OPS"], REGISTRY) == ["Ops"]


def test_an_unknown_tag_keeps_the_spelling_it_arrived_with():
    """It is about to be registered, and the form somebody typed is the form
    they meant."""
    assert canonicalise(["Regression"], REGISTRY) == ["Regression"]


def test_duplicates_are_collapsed_case_insensitively():
    """`["bug", "Bug"]` is one tag typed twice."""
    assert canonicalise(["bug", "Bug", "BUG"], REGISTRY) == ["bug"]


def test_order_is_preserved_because_a_tag_list_is_arranged_not_sorted():
    assert canonicalise(["zebra", "ops", "apple"], REGISTRY) == [
        "zebra", "Ops", "apple",
    ]


def test_blanks_are_dropped_rather_than_stored():
    assert canonicalise(["bug", "", "  "], REGISTRY) == ["bug"]


def test_none_is_an_empty_list_not_an_error():
    assert canonicalise(None, REGISTRY) == []


def test_something_that_is_not_a_list_is_refused():
    with pytest.raises(HTTPException):
        canonicalise("bug", REGISTRY)


def test_a_task_cannot_wear_unbounded_tags():
    """A task wearing thirty labels has none."""
    with pytest.raises(HTTPException) as exc:
        canonicalise([f"t{i}" for i in range(MAX_TAGS_PER_TASK + 1)], REGISTRY)
    assert exc.value.status_code == 422


def test_the_cap_counts_what_is_STORED_not_what_was_sent():
    """Duplicates collapse first, so sending "bug" thirty times is one tag and
    not a refusal — the cap is about the task, not about the payload."""
    assert canonicalise(["bug"] * (MAX_TAGS_PER_TASK + 5), REGISTRY) == ["bug"]


# ── unregistered ────────────────────────────────────────────────────────────

def test_only_the_tags_the_registry_has_never_seen_are_new():
    assert unregistered(["bug", "Regression"], REGISTRY) == ["Regression"]


def test_a_known_tag_is_not_re_registered_whatever_its_casing():
    assert unregistered(["OPS", "BUG"], REGISTRY) == []


def test_one_payload_naming_a_new_tag_twice_registers_it_once():
    """Otherwise the second insert trips the unique index on the request's own
    payload — a 500 caused by nothing but the sender repeating themselves."""
    assert unregistered(["Regression", "regression"], REGISTRY) == ["Regression"]


# ── merge ───────────────────────────────────────────────────────────────────

def test_a_task_carrying_BOTH_tags_ends_with_the_target_once():
    """The case that is easy to get wrong, and getting it wrong leaves a
    duplicate that renders twice and survives the next merge as well."""
    assert merged_tags(["bug", "defect"], "defect", "bug") == ["bug"]


def test_a_task_carrying_only_the_source_gets_the_target():
    assert merged_tags(["defect", "ops"], "defect", "bug") == ["bug", "ops"]


def test_a_task_carrying_neither_is_untouched():
    assert merged_tags(["ops"], "defect", "bug") == ["ops"]


def test_the_merge_matches_the_source_case_insensitively():
    """The registry allows one spelling, but a task tagged before the registry
    existed may hold another — and a merge that missed those would leave the
    tag it claims to have removed."""
    assert merged_tags(["Defect"], "defect", "bug") == ["bug"]


def test_the_merge_keeps_the_other_tags_in_order():
    # Not alphabetical, for the same reason as the rename case below.
    assert merged_tags(["zebra", "defect", "apple"], "defect", "bug") == [
        "zebra", "bug", "apple",
    ]


def test_the_merge_does_not_mutate_the_list_it_was_given():
    current = ["defect", "ops"]
    merged_tags(current, "defect", "bug")
    assert current == ["defect", "ops"]


# ── rename ──────────────────────────────────────────────────────────────────

def test_a_rename_keeps_the_tag_in_its_place():
    """Distinct from a merge on purpose. A tag jumping elsewhere in the list is
    the difference between a rename and a reshuffle.

    The fixture is deliberately NOT in alphabetical order: with `["a", "defect",
    "z"]` a sorted implementation returns the same answer by coincidence, and
    the assertion proves nothing."""
    assert renamed_tags(["zebra", "defect", "apple"], "defect", "bug") == [
        "zebra", "bug", "apple",
    ]


def test_a_rename_matches_case_insensitively():
    assert renamed_tags(["Defect"], "defect", "bug") == ["bug"]


def test_a_rename_leaves_everything_else_alone():
    assert renamed_tags(["ops"], "defect", "bug") == ["ops"]
