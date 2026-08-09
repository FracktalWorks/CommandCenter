"""WS-27k — filters and saved views.

Spec: `ai-company-brain/specs/project_management_app.md` §11.2 item 3.

*"My open bugs in Ops, grouped by assignee"* is a daily question the board could
not answer. This is the filter half.

The claims worth pinning are the ones where a wrong answer is *plausible* rather
than obviously broken:

* **every filter is a WHERE clause.** Pagination is done in SQL, so a filter
  applied in Python after `LIMIT` returns short pages — "page 2 is empty but
  there are 40 more" is a bug people work around for months instead of
  reporting.
* **`overdue` means past due AND still open.** A finished task with a past due
  date is not overdue, and colouring it red forever is how a board teaches
  people to ignore red.
* **an unknown status category is a 422, not an empty board.** A client
  filtering on `in-progress` (hyphen) must not conclude the project is empty.
* **a saved view and the same filters typed by hand produce one query.** Two
  implementations would drift, and a *saved* view that shows a different set is
  the one thing it may not do.

Pure functions, tested directly. No Postgres, no fake.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import HTTPException
from gateway.routes.projects.filters import (
    CLOSED_CATEGORIES,
    GROUP_BY,
    MAX_MULTI,
    STATUS_CATEGORIES,
    VIEW_FILTER_KEYS,
    build_task_filters,
    normalise_view_config,
    split_csv,
)

REPO = Path(__file__).resolve().parents[2]


def sql(**kwargs) -> str:
    return " ".join(build_task_filters(**kwargs)[0])


def bound(**kwargs) -> dict:
    return build_task_filters(**kwargs)[1]


# ── The vocabulary matches the schema ───────────────────────────────────────

def migrated_status_categories() -> set[str]:
    """The category vocabulary as the DATABASE will enforce it.

    Assembled from every migration that constrains `pm_task_statuses.category`,
    taking the LAST one in file order — 146 creates the CHECK inline and 164
    (WS-27u) replaces it wholesale to admit `triage`, so the newest definition
    is the one that survives a full replay. The same aggregation
    `test_projects_migration._activity_check_values` does for the activity
    vocabulary, and for the same reason: a mirror pinned to the file that
    CREATED the check goes quietly stale the day a later file widens it.

    Scoped to files that name `pm_task_statuses`, because `feature_catalog`
    (130/140) constrains a `category` column of its own.
    """
    latest: str | None = None
    for path in sorted((REPO / "infra/postgres").glob("*.sql")):
        if path.name == "schema.generated.sql":
            continue
        text = "\n".join(
            re.sub(r"--.*$", "", line)
            for line in path.read_text(encoding="utf-8").splitlines()
        )
        if "pm_task_statuses" not in text:
            continue
        for match in re.finditer(
            r"CHECK\s*\(\s*category\s+IN\s*\((.*?)\)\s*\)", text, re.S | re.I,
        ):
            latest = match.group(1)
    assert latest is not None, "no migration constrains pm_task_statuses.category"
    return set(re.findall(r"'([a-z_]+)'", latest))


def test_the_categories_are_the_ones_the_database_has():
    """Read from the migrations, not restated. A filter vocabulary that drifts
    from the CHECK is a filter that silently matches nothing."""
    assert migrated_status_categories() == set(STATUS_CATEGORIES)


def test_closed_means_done_or_cancelled():
    assert set(CLOSED_CATEGORIES) == {"done", "cancelled"}


# ── Nothing matches everything by accident ─────────────────────────────────

def test_the_default_query_still_excludes_archived_tasks():
    """The one clause that is present when nothing is asked for."""
    assert "t.archived_at IS NULL" in sql()


def test_asking_for_archived_drops_that_clause_and_adds_nothing_else():
    assert build_task_filters(include_archived=True) == ([], {})


def test_no_filter_leaks_a_parameter_it_did_not_use():
    """A stray bound parameter is how a query starts failing with "parameter
    not used" once a clause is refactored away."""
    clauses, params = build_task_filters(overdue=True)
    joined = " ".join(clauses)
    for name in params:
        assert f":{name}" in joined, f"{name} is bound but never referenced"


# ── overdue ────────────────────────────────────────────────────────────────

def test_overdue_excludes_finished_work():
    """Past due AND still open. Without the second half a done task stays red
    forever, and a board with permanent red is a board nobody reads."""
    clause = sql(overdue=True)
    assert "t.due_at < now()" in clause
    assert "NOT EXISTS" in clause
    assert bound(overdue=True)["closed"] == list(CLOSED_CATEGORIES)


def test_overdue_is_absent_unless_asked_for():
    assert "due_at < now()" not in sql()


# ── assignees ──────────────────────────────────────────────────────────────

def test_assignee_matching_is_case_insensitive_on_both_sides():
    """R10 — `pm_task_assignees` stores lowercased addresses, and a filter that
    compared raw text would match nothing for anyone who typed a capital."""
    assert "lower(a.assignee)" in sql(assignee="Priya@Fracktal.IN")
    assert bound(assignee="Priya@Fracktal.IN")["assignees"] == ["priya@fracktal.in"]


def test_the_single_and_multi_assignee_filters_combine():
    """Both spellings exist (one for a URL a human types, one for a saved
    view), and they must not silently drop each other."""
    params = bound(assignee="a@x.co", assignees="b@x.co,c@x.co")
    assert params["assignees"] == ["a@x.co", "b@x.co", "c@x.co"]


def test_a_duplicate_assignee_is_bound_once():
    assert bound(assignee="a@x.co", assignees="A@X.co")["assignees"] == ["a@x.co"]


def test_unassigned_is_a_NOT_EXISTS_not_an_empty_string_match():
    """"Nobody" is the absence of a row, not an assignee whose address is ''."""
    clause = sql(unassigned=True)
    assert "NOT EXISTS" in clause
    assert "pm_task_assignees" in clause


def test_a_multi_filter_cannot_be_unbounded():
    """An `IN` list a client controls is a way to hand the database a megabyte
    of literals."""
    huge = ",".join(f"p{i}@x.co" for i in range(MAX_MULTI + 50))
    assert len(bound(assignees=huge)["assignees"]) == MAX_MULTI


# ── categories ─────────────────────────────────────────────────────────────

def test_an_unknown_category_is_refused_and_lists_the_real_ones():
    with pytest.raises(HTTPException) as exc:
        build_task_filters(status_category="in-progress")
    assert exc.value.status_code == 422
    for known in STATUS_CATEGORIES:
        assert known in str(exc.value.detail)


def test_categories_are_matched_through_the_status_row():
    """The category belongs to the STATUS. Denormalising it onto the task would
    need re-stamping every task whenever a lane is recategorised."""
    clause = sql(status_category="todo,in_progress")
    assert "pm_task_statuses" in clause
    assert bound(status_category="todo,in_progress")["categories"] == [
        "todo", "in_progress",
    ]


def test_a_trailing_comma_is_a_typo_not_a_request_for_nothing():
    assert split_csv("todo, ,in_progress,") == ["todo", "in_progress"]
    assert split_csv(None) == []


# ── search ─────────────────────────────────────────────────────────────────

def test_search_covers_the_description_as_well_as_the_title():
    assert "t.description ILIKE" in sql(q="extruder")


def test_a_whitespace_only_search_is_not_a_filter():
    """`%   %` matches every task with a space in it — i.e. everything, slowly."""
    assert "ILIKE" not in sql(q="   ")


# ── due_before ─────────────────────────────────────────────────────────────

def test_a_timestamp_filter_binds_a_datetime_not_the_string_it_arrived_as():
    """Found against a real Postgres, invisible to a fake.

    ``CAST(:x AS timestamptz)`` reads like it would take the string, but asyncpg
    infers the parameter's type from that cast and then refuses to *encode* a
    `str` — the query never reaches the database and the endpoint answers 500.
    So the type of the bound value is the claim, not the shape of the SQL.
    """
    params = bound(due_before="2026-08-31")
    assert isinstance(params["due_before"], datetime)


def test_no_clause_casts_a_bound_parameter_to_a_timestamp():
    """The general form, and the reason this is worth a second test.

    Every timestamp cast over a bound parameter is this bug: asyncpg reads the
    cast, decides the parameter is a timestamp, and refuses the string. A future
    `after=` or `created_since=` filter written the obvious way fails here
    rather than the first time somebody clicks it.
    """
    clauses, _ = build_task_filters(
        due_before="2026-08-31", overdue=True, q="x", assignee="a@x.co",
        status_category="todo", importance_gte=1, parent_task_id=None,
    )
    for clause in clauses:
        assert not re.search(r"CAST\s*\(\s*:\w+\s+AS\s+timestamp", clause, re.I), (
            f"{clause!r} casts a bound parameter to a timestamp — parse it into "
            f"a datetime with `parse_when` instead, or asyncpg will 500"
        )


def test_a_bare_date_and_a_full_timestamp_both_work():
    """A human types a date; a saved view stores what the picker produced."""
    assert bound(due_before="2026-08-31")["due_before"] == datetime(
        2026, 8, 31, tzinfo=UTC,
    )
    assert bound(due_before="2026-08-31T17:00:00Z")["due_before"] == datetime(
        2026, 8, 31, 17, 0, tzinfo=UTC,
    )


def test_a_naive_timestamp_is_read_as_UTC_rather_than_left_ambiguous():
    """`due_at` is a timestamptz and `overdue` compares against `now()`, so a
    value with no zone has to be given one somewhere. Doing it here beats
    inheriting whatever the connection's TimeZone happens to be."""
    assert bound(due_before="2026-08-31T17:00:00")["due_before"].tzinfo is not None


def test_an_unparseable_timestamp_is_a_422_and_says_what_was_expected():
    """`due_before=tomorrow` is the client's mistake. Before this it was a 500,
    which reads as a server fault and gets reported as an outage."""
    with pytest.raises(HTTPException) as exc:
        build_task_filters(due_before="tomorrow")
    assert exc.value.status_code == 422
    assert "due_before" in str(exc.value.detail)
    assert "ISO 8601" in str(exc.value.detail)


def test_the_clause_no_longer_carries_a_cast_that_would_reintroduce_it():
    """The fix is the bind, but the cast is what caused it — leaving it in place
    would invite the string back the next time someone edits this."""
    assert "timestamptz" not in sql(due_before="2026-08-31")


# ── saved views ────────────────────────────────────────────────────────────

def test_a_view_can_only_pin_filters_the_list_endpoint_accepts():
    """The set is derived from `build_task_filters`'s own signature, so a
    filter added there without being allowed here fails loudly rather than
    being unsavable in a view for a release."""
    import inspect

    accepted = set(inspect.signature(build_task_filters).parameters)
    assert accepted >= VIEW_FILTER_KEYS
    # `parent_task_id` is navigation, not a saved preference.
    assert "parent_task_id" not in VIEW_FILTER_KEYS


def test_an_unknown_config_key_is_dropped_rather_than_refused():
    """A view is a saved preference written by an older client. Refusing to
    open one because it carries a key this version has never heard of turns
    every deploy into a migration of everybody's saved views."""
    got = normalise_view_config({
        "filters": {"overdue": True, "colour": "purple"},
        "group_by": "assignee",
    })
    assert got == {"filters": {"overdue": True}, "group_by": "assignee"}


def test_an_unknown_group_by_falls_back_to_the_boards_own_default():
    """Rendering must produce something; `status` is the board's axis, not a
    guess."""
    assert normalise_view_config({"group_by": "phase"})["group_by"] == "status"


def test_a_config_that_is_not_an_object_still_yields_a_usable_view():
    for junk in (None, [], "board", 7):
        assert normalise_view_config(junk) == {"filters": {}, "group_by": "status"}


def test_filters_that_are_not_an_object_are_ignored():
    assert normalise_view_config({"filters": "overdue"})["filters"] == {}


@pytest.mark.parametrize("group_by", GROUP_BY)
def test_every_advertised_grouping_survives_normalisation(group_by):
    assert normalise_view_config({"group_by": group_by})["group_by"] == group_by


def test_a_saved_view_and_the_same_filters_typed_by_hand_are_one_query():
    """The whole reason the builder is shared. If these ever diverge, a saved
    view shows a different set of tasks than the filters it claims to hold."""
    config = normalise_view_config({
        "filters": {"status_category": "todo", "overdue": True,
                    "assignee": "priya@fracktal.in"},
    })
    from_view = build_task_filters(**config["filters"])
    typed = build_task_filters(
        status_category="todo", overdue=True, assignee="priya@fracktal.in",
    )
    assert from_view == typed
