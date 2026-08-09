"""Projects · the task-list filter vocabulary (WS-27k).

Spec: ``ai-company-brain/specs/project_management_app.md`` §11.2 item 3.

*"My open bugs in Ops, grouped by assignee"* is a daily question the board had
no way to answer. This is the filter half; grouping is presentation and lives in
the browser, over rows this module makes groupable.

**One builder, used by the list endpoint AND by saved views.** A saved view is
nothing but a stored set of these filters, so if the two had separate
implementations a view would eventually show a different set of tasks than the
same filters typed by hand — which is the one thing a *saved* view may not do.

**Every filter is a WHERE clause, never a post-filter in Python.** Pagination
happens in SQL; a filter applied after `LIMIT` would silently return short
pages, and "page 2 is empty but there are 40 more tasks" is the kind of bug
people work around for months instead of reporting.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text

#: `pm_task_statuses.category`. Mirrored from migration 146's CHECK and pinned
#: by `test_projects_filters`.
STATUS_CATEGORIES: tuple[str, ...] = (
    "backlog", "todo", "in_progress", "done", "cancelled",
)

#: Categories that mean "this task is finished". Shared with
#: `core.CLOSING_CATEGORIES` in spirit; kept here as the *filter* vocabulary so
#: the SQL and the status-transition logic can be read independently.
CLOSED_CATEGORIES: tuple[str, ...] = ("done", "cancelled")

#: How many values one multi-valued filter may carry. A filter is a convenience;
#: an unbounded `IN` list is a way to hand the database a megabyte of literals.
MAX_MULTI = 100


def split_csv(raw: str | None) -> list[str]:
    """``"a, b ,,c"`` → ``["a", "b", "c"]``.

    Blanks are dropped rather than becoming an empty-string filter value that
    matches nothing — a trailing comma is a typo, not a request for no results.
    """
    return [part.strip() for part in (raw or "").split(",") if part.strip()]


def validate_categories(values: list[str]) -> list[str]:
    """Refuse a category the schema does not have.

    422 rather than an empty board: a client filtering on `in-progress`
    (hyphen) would otherwise see "no tasks" and conclude the project is empty.
    """
    unknown = [v for v in values if v not in STATUS_CATEGORIES]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown status category {unknown}. "
                   f"One of: {list(STATUS_CATEGORIES)}.",
        )
    return values


def like_escape(term: str) -> str:
    """Neutralise LIKE's metacharacters in a term a human typed (WS-27r).

    ⚠️ **This was a live defect, not a precaution for new code.** `_` matches
    any single character, so searching `task_id` also returned `taskXid` and
    `task-id` — and in a workspace where people search for identifiers all day,
    that is a steady drip of hits nobody asked for. `%` matches any run, so
    `50%` quietly meant `50`.

    Backslash first, or escaping it afterwards would double the backslashes
    this function has just introduced. Postgres' default LIKE escape is the
    backslash and the pattern is BOUND rather than interpolated, so
    `standard_conforming_strings` does not enter into it.
    """
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def parse_when(raw: str, *, field: str) -> datetime:
    """A query-string timestamp → a real ``datetime``.

    **Parsed here rather than left to Postgres.** ``CAST(:x AS timestamptz)``
    looks like it would take the string, but asyncpg infers the parameter's type
    from that cast and then refuses to encode a ``str`` at all — the query never
    reaches the database, and the endpoint answers 500. Binding a `datetime` is
    the only shape that works, so the parsing has to happen on this side.

    A value that is not a timestamp is a **422**: it is the client's mistake,
    and `due_before=tomorrow` deserves to be told so rather than to read as a
    server fault.

    A naive value is taken as UTC. ``due_at`` is a ``timestamptz`` and `overdue`
    compares against `now()`, so UTC is the frame this module already works in —
    stated rather than left to whatever the connection's TimeZone happens to be.
    """
    try:
        parsed = datetime.fromisoformat(raw.strip())
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail=f"'{raw}' is not a valid {field}. "
                   f"Expected an ISO 8601 date or timestamp, e.g. 2026-08-31 "
                   f"or 2026-08-31T17:00:00Z.",
        ) from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def build_task_filters(
    *,
    parent_task_id: str | None = None,
    status_id: str | None = None,
    status_category: str | None = None,
    assignee: str | None = None,
    assignees: str | None = None,
    unassigned: bool = False,
    overdue: bool = False,
    due_before: str | None = None,
    importance_gte: int | None = None,
    q: str | None = None,
    tags: str | None = None,
    tags_all: str | None = None,
    include_archived: bool = False,
) -> tuple[list[str], dict[str, Any]]:
    """The WHERE fragments for one task query, and their bound parameters.

    Pure: no database, no request. That is what lets the same function serve the
    endpoint and a saved view, and lets the interesting claims — *which clauses
    exist at all* — be tested without a fake Postgres agreeing with itself.

    Every fragment addresses ``t`` (``pm_tasks``); the caller supplies the
    visibility clause and any project scoping, because those need a database
    round trip and a 404 decision this function must not make.
    """
    clauses: list[str] = []
    params: dict[str, Any] = {}

    if parent_task_id:
        clauses.append("t.parent_task_id = CAST(:parent AS uuid)")
        params["parent"] = parent_task_id

    if status_id:
        clauses.append("t.status_id = CAST(:status_id AS uuid)")
        params["status_id"] = status_id

    categories = validate_categories(split_csv(status_category))[:MAX_MULTI]
    if categories:
        # Joined through the status row rather than stored on the task: the
        # category is the status's property, and denormalising it onto tasks
        # would need re-stamping every task whenever a lane is recategorised.
        clauses.append(
            "EXISTS (SELECT 1 FROM pm_task_statuses s "
            "        WHERE s.id = t.status_id AND s.category = ANY(:categories))"
        )
        params["categories"] = categories

    wanted = [a.lower() for a in split_csv(assignees)][:MAX_MULTI]
    if assignee and assignee.strip():
        wanted.append(assignee.strip().lower())
    if wanted:
        clauses.append(
            "EXISTS (SELECT 1 FROM pm_task_assignees a "
            "        WHERE a.task_id = t.id AND lower(a.assignee) = ANY(:assignees))"
        )
        params["assignees"] = sorted(set(wanted))

    if unassigned:
        # Compatible with an assignee filter on purpose — "assigned to Priya OR
        # to nobody" is not a question anyone asks, so the two together
        # correctly return nothing rather than being silently reconciled.
        clauses.append(
            "NOT EXISTS (SELECT 1 FROM pm_task_assignees a WHERE a.task_id = t.id)"
        )

    if overdue:
        # Overdue means "past due AND still open". A finished task with a past
        # due date is not overdue, it is done — colouring it red forever is how
        # a board teaches people to ignore red.
        clauses.append(
            "t.due_at < now() AND NOT EXISTS ("
            "  SELECT 1 FROM pm_task_statuses s "
            "  WHERE s.id = t.status_id AND s.category = ANY(:closed))"
        )
        params["closed"] = list(CLOSED_CATEGORIES)

    if due_before:
        clauses.append("t.due_at < :due_before")
        params["due_before"] = parse_when(due_before, field="due_before")

    if importance_gte is not None:
        clauses.append("t.importance >= :importance_gte")
        params["importance_gte"] = importance_gte

    if q and q.strip():
        clauses.append("(t.title ILIKE :q OR t.description ILIKE :q)")
        params["q"] = f"%{like_escape(q.strip())}%"

    # WS-27m. TWO tag filters, because both questions get asked and one cannot
    # answer the other: `tags` is ANY (`&&` — "show me bugs or regressions"),
    # `tags_all` is ALL (`@>` — "the ones that are both"). Collapsing them into
    # one parameter would silently pick a meaning, and with three tags the two
    # answers differ by almost everything.
    #
    # Both use the array operators the GIN index on `pm_tasks.tags` (146) serves,
    # so a tag filter across an imported workspace is an index scan.
    wanted_any = split_csv(tags)[:MAX_MULTI]
    if wanted_any:
        clauses.append("t.tags && CAST(:tags_any AS text[])")
        params["tags_any"] = wanted_any

    wanted_all = split_csv(tags_all)[:MAX_MULTI]
    if wanted_all:
        clauses.append("t.tags @> CAST(:tags_all AS text[])")
        params["tags_all"] = wanted_all

    if not include_archived:
        clauses.append("t.archived_at IS NULL")

    return clauses, params


#: The keys a saved view's `config.filters` may carry — exactly the arguments
#: `build_task_filters` accepts, minus the ones a view has no business pinning
#: (`parent_task_id` is navigation, not a filter).
VIEW_FILTER_KEYS: frozenset[str] = frozenset({
    "status_id", "status_category", "assignee", "assignees", "unassigned",
    "overdue", "due_before", "importance_gte", "q", "tags", "tags_all",
    "include_archived",
})

#: What a board may group by. `status` is the board's own axis; the others are
#: what §11.2 asked for by name.
GROUP_BY: tuple[str, ...] = (
    "status", "assignee", "project", "importance", "tag", "none",
)


def normalise_view_config(config: Any) -> dict[str, Any]:
    """A stored view's config, reduced to what the board can actually apply.

    Unknown keys are DROPPED rather than rejected. A view is a saved preference
    written by an older client, and refusing to open one because it carries a
    key this version does not know would turn every deploy into a migration of
    everybody's saved views. Dropping is forgiving in the direction that keeps
    the board usable.

    A bad *value* is different from a bad key and is not silently coerced: an
    unknown `group_by` falls back to `status` because rendering must produce
    something, and that fallback is the board's own default rather than a guess.
    """
    if not isinstance(config, dict):
        return {"filters": {}, "group_by": "status"}
    raw = config.get("filters")
    filters = {
        key: value for key, value in (raw or {}).items()
        if key in VIEW_FILTER_KEYS
    } if isinstance(raw, dict) else {}
    group_by = config.get("group_by")
    return {
        "filters": filters,
        "group_by": group_by if group_by in GROUP_BY else "status",
    }


#: Assignees for a page of tasks, in ONE query.
#:
#: Not a subquery on the list itself (which would repeat a task per assignee and
#: break `LIMIT`), and emphatically not one query per row: an imported ClickUp
#: workspace is hundreds of tasks, and N+1 there is a board that takes a visible
#: second to paint.
_ASSIGNEES_SQL = """
SELECT task_id, array_agg(assignee ORDER BY assignee) AS people
  FROM pm_task_assignees
 WHERE task_id = ANY(CAST(:ids AS uuid[]))
 GROUP BY task_id
"""


#: Subtask progress and open-blocker counts for a page of tasks, in TWO queries.
#:
#: The same trade `_ASSIGNEES_SQL` makes and for the same reason: a board draws
#: these badges on every card, and asking per card is N+1 across an imported
#: workspace of hundreds. Aggregated over the page's ids rather than joined onto
#: the list itself, because a join would repeat the task row per child and break
#: `LIMIT`.
_SUBTASK_COUNTS_SQL = """
SELECT t.parent_task_id AS parent,
       count(*) AS total,
       count(*) FILTER (WHERE s.category = ANY(:closed)) AS done
  FROM pm_tasks t
  JOIN pm_task_statuses s ON s.id = t.status_id
 WHERE t.parent_task_id = ANY(CAST(:ids AS uuid[]))
   AND t.archived_at IS NULL
 GROUP BY t.parent_task_id
"""

#: How many still-OPEN tasks block each of these.
#:
#: Filtered to open blockers in SQL rather than counted and filtered after: a
#: finished blocker blocks nothing (WS-27p), and a card that stays marked
#: blocked after its dependency shipped is a card people learn to ignore.
_BLOCKER_COUNTS_SQL = """
SELECT l.target_task_id AS blocked, count(*) AS blockers
  FROM pm_task_links l
  JOIN pm_tasks t ON t.id = l.source_task_id
  JOIN pm_task_statuses s ON s.id = t.status_id
 WHERE l.link_type = 'blocks'
   AND l.target_task_id = ANY(CAST(:ids AS uuid[]))
   AND NOT (s.category = ANY(:closed))
 GROUP BY l.target_task_id
"""


#: The `blocks` edges BETWEEN tasks in one window (WS-27t).
#:
#: **Both ends must be in the set**, because an arrow is drawn between two bars
#: and a bar that is not on screen has no end to attach to. The edge to an
#: off-window blocker is not lost, only undrawable — `blocked_by_count` already
#: puts a badge on the bar, which is the honest rendering of "something you
#: cannot see is holding this up".
#:
#: Only `blocks`. `relates_to` and `duplicates` are associations with no
#: direction that means anything to a schedule (WS-27p's `DIRECTED_TYPES`), and
#: drawing them as arrows would claim a sequence that was never asserted.
_WINDOW_LINKS_SQL = """
SELECT l.id, l.source_task_id AS blocker, l.target_task_id AS blocked
  FROM pm_task_links l
 WHERE l.link_type = 'blocks'
   AND l.source_task_id = ANY(CAST(:ids AS uuid[]))
   AND l.target_task_id = ANY(CAST(:ids AS uuid[]))
 ORDER BY l.id
"""


async def window_links(db: Any, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The drawable dependency edges among ``rows``, in ONE query.

    Returned beside the rows rather than folded into them: an edge belongs to
    two tasks, and hanging it off one of them makes the client reconstruct the
    other end — which is how a chart ends up drawing an arrow to a bar it has
    already scrolled past.
    """
    ids = [str(r["id"]) for r in rows if r.get("id")]
    if not ids:
        return []
    found = (await db.execute(text(_WINDOW_LINKS_SQL), {"ids": ids})).fetchall()
    return [
        {
            "id": str(r.id),
            "blocker_id": str(r.blocker),
            "blocked_id": str(r.blocked),
        }
        for r in found
    ]


async def attach_relation_counts(
    db: Any, rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Fill each row's ``subtasks`` and ``blocked_by_count``, mutating in place.

    Every row gets both keys, including the ones with neither — a missing key
    and a zero read the same to a careless client, and "has no subtasks" is a
    state the card draws nothing for rather than an absence it guesses at.
    """
    for row in rows:
        row["subtasks"] = {"done": 0, "total": 0}
        row["blocked_by_count"] = 0
    ids = [str(r["id"]) for r in rows if r.get("id")]
    if not ids:
        return rows

    args = {"ids": ids, "closed": list(CLOSED_CATEGORIES)}
    counts = (await db.execute(text(_SUBTASK_COUNTS_SQL), args)).fetchall()
    by_parent = {
        str(r.parent): {"done": int(r.done or 0), "total": int(r.total or 0)}
        for r in counts
    }
    blocked = (await db.execute(text(_BLOCKER_COUNTS_SQL), args)).fetchall()
    by_blocked = {str(r.blocked): int(r.blockers or 0) for r in blocked}

    for row in rows:
        key = str(row["id"])
        row["subtasks"] = by_parent.get(key, {"done": 0, "total": 0})
        row["blocked_by_count"] = by_blocked.get(key, 0)
    return rows


async def attach_assignees(db: Any, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fill each row's ``assignees``, mutating and returning the list.

    Every row gets the key, including the ones with nobody on them — a missing
    key and an empty list read the same to a careless client, and "unassigned"
    is a state the board draws, not an absence it ignores.
    """
    for row in rows:
        row["assignees"] = []
    ids = [str(r["id"]) for r in rows if r.get("id")]
    if not ids:
        return rows
    found = (await db.execute(text(_ASSIGNEES_SQL), {"ids": ids})).fetchall()
    by_task = {str(r.task_id): list(r.people or []) for r in found}
    for row in rows:
        row["assignees"] = by_task.get(str(row["id"]), [])
    return rows
