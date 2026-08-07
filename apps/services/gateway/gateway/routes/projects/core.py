"""Projects routes — the shared kernel.

The leaf module: it imports nothing from its siblings. It owns the shared
``router``, the Pydantic models, the row→model mapper, the SQL helpers, the
**visibility read model**, the status-transition helper and the event seam.
Spec: ``ai-company-brain/specs/project_management_app.md`` §3 and §4 (WS-27a).

Four things here are load-bearing and worth stating once:

**The engine.** This package makes **zero** ``create_async_engine`` calls. It
consumes ``gateway.db`` — the shared seam BO-10 asked for, which WS-26a built
and proved by converting ``routes/tasks/core.py`` onto it. Adding engine
thirteen is the failure mode this seam exists to prevent.

**Visibility is grant-based, and it is a DATA boundary, not a nav one.** Unlike
``routes/crm`` — where D-CRM-3 deliberately made records org-visible to feature
holders — a project is visible only when a grant on it *or on one of its
ancestors* matches the caller (D-PM-3). Center slices are the whole point of
this app, so the scoping could not be deferred. A caller who cannot see a
project gets **404, never 403** (R5), which is why every loader in this package
takes the visibility clause rather than checking after the fetch.

**Sort keys are an allowlist, never interpolation.** Every identifier reaching
an f-string here is one of ours — a table name, a key of :data:`TASK_SORTS`, a
field name declared on a Pydantic model. Every caller value is a bound
parameter. An unknown sort key is a 422, not a slower query.

**One status transition, three effects.** ``apply_status_transition`` writes the
new ``status_id``, stamps or clears ``completed_at`` on the done boundary, and
records a ``status_change`` activity. A PATCH that writes only the column looks
correct in the UI and silently empties the timeline — the CRM learned this in
``pipeline.apply_status_transition`` and the rule is the same here.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from acb_auth import UserContext, require_feature_router
from acb_common import get_logger
from fastapi import APIRouter, HTTPException, Query
from gateway.db import get_db as _get_db  # noqa: F401  — the shared seam (BO-10)
from pydantic import BaseModel
from sqlalchemy import text

_log = get_logger("gateway.projects")

router = APIRouter(
    prefix="/projects", tags=["projects"],
    dependencies=[require_feature_router("projects")],
)

#: `pm_projects.status`, mirrored from the CHECK in migration 145. Kept here so
#: a bad value is a 422 at the boundary rather than an IntegrityError 500.
PROJECT_STATUSES: tuple[str, ...] = ("active", "on_hold", "done", "archived")

#: `pm_task_statuses.category` — the machine-readable half of a status. Name and
#: colour are the owner's; this is what completion, the personal mirror (§6.1)
#: and automation gates (§6.3) key off.
STATUS_CATEGORIES: tuple[str, ...] = (
    "backlog", "todo", "in_progress", "done", "cancelled",
)

#: Categories that close a task: crossing INTO one stamps ``completed_at``,
#: crossing out clears it. ``cancelled`` counts as closed — a cancelled task is
#: not outstanding work, and leaving it open would keep it in every "what is
#: still due" read forever.
CLOSING_CATEGORIES: frozenset[str] = frozenset({"done", "cancelled"})

#: `pm_activities.type`, mirrored from the same migration.
ACTIVITY_TYPES: tuple[str, ...] = (
    "comment", "status_change", "field_change", "link", "assignment",
    "agent_run", "sync", "system",
)

#: `pm_projects.source` / `pm_tasks.source`. Tasks carry two extra origins.
PROJECT_SOURCES: tuple[str, ...] = ("manual", "import", "agent")
TASK_SOURCES: tuple[str, ...] = ("manual", "import", "email", "agent", "automation")

#: The one system task type. Its only rule — an Epic cannot have a parent —
#: makes it structurally the root level (§3.4). There is deliberately no
#: 'Subtask' type: a subtask is a task with a parent.
EPIC_TYPE_NAME = "Epic"

#: How far up a parent chain a cycle check walks before refusing. Paca's bound,
#: for Paca's reason: a real hierarchy never approaches it, and an unbounded
#: walk over corrupted data is an unbounded query.
MAX_DEPTH = 50

MAX_PAGE_SIZE = 100

#: The permission that opens the whole portfolio — every project, granted or
#: not. D14 measured `data:org:read` at **zero** consumers, so "manager has
#: org-wide visibility" was a name; this is deliberately its first, which is why
#: granting it is registered as an owner gate.
ORG_READ = "data:org:read"


# ── Models ──────────────────────────────────────────────────────────────────
#
# Output model field names are the table's column names, 1:1, so `row_to_model`
# maps any row generically — a column added to a table and its model needs no
# mapper edit, and a column added to only one shows up as a missing field rather
# than a silently dropped value. Input models are all-optional: the same model
# serves POST and PATCH, with create-time requirements checked at the call site.

class ProjectModel(BaseModel):
    id: str
    name: str
    description: str | None = None
    parent_project_id: str | None = None
    task_prefix: str | None = None
    status: str = "active"
    lead: str | None = None
    position: float | None = None
    source: str = "manual"
    clickup_id: str | None = None
    clickup_kind: str | None = None
    created_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    archived_at: str | None = None


class ProjectIn(BaseModel):
    name: str | None = None
    description: str | None = None
    parent_project_id: str | None = None
    task_prefix: str | None = None
    status: str | None = None
    lead: str | None = None
    position: float | None = None
    source: str | None = None


class TaskModel(BaseModel):
    id: str
    project_id: str
    root_project_id: str
    task_number: int | None = None
    parent_task_id: str | None = None
    type_id: str | None = None
    status_id: str
    title: str
    description: str | None = None
    importance: int | None = None
    estimate_mins: int | None = None
    start_date: str | None = None
    due_at: str | None = None
    completed_at: str | None = None
    tags: list[str] = []
    created_by: str | None = None
    source: str = "manual"
    clickup_id: str | None = None
    clickup_synced_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    archived_at: str | None = None


class TaskIn(BaseModel):
    project_id: str | None = None
    parent_task_id: str | None = None
    type_id: str | None = None
    status_id: str | None = None
    title: str | None = None
    description: str | None = None
    importance: int | None = None
    estimate_mins: int | None = None
    start_date: str | None = None
    due_at: str | None = None
    tags: list[str] | None = None
    source: str | None = None


class StatusModel(BaseModel):
    id: str
    project_id: str
    name: str
    color: str = "gray"
    position: int = 0
    category: str = "todo"
    is_default: bool = False


class TypeModel(BaseModel):
    id: str
    project_id: str
    name: str
    icon: str | None = None
    color: str | None = None
    is_default: bool = False
    is_system: bool = False


class ActivityModel(BaseModel):
    id: str
    task_id: str | None = None
    project_id: str | None = None
    type: str
    body: str | None = None
    meta: dict | None = None
    created_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class GrantModel(BaseModel):
    id: str
    project_id: str
    subject: str
    created_by: str | None = None
    created_at: str | None = None


class ViewModel(BaseModel):
    id: str
    project_id: str
    name: str
    view_type: str = "list"
    config: dict | None = None
    position: float | None = None
    created_by: str | None = None


class ListResponse(BaseModel):
    """The one list shape every collection endpoint returns."""

    rows: list[dict]
    total: int


class Page:
    """Pagination, declared once and bound by every paginated route.

    A FastAPI class dependency rather than two repeated parameters per handler,
    for the CRM's reason (``routes/crm/records.py::ListParams``): the contract
    is supposed to be the same everywhere, and the way that stops being true is
    one endpoint quietly growing a different cap. ``le=`` enforces the ceiling
    here, so a caller asking for 10 000 rows gets a 422 rather than a slow
    answer.

    It also keeps the routes **callable directly** — a bare ``page: int =
    Query(1)`` default is a ``Query`` object, not an ``int``, so the hermetic
    tests could not call the handler without FastAPI resolving it first.
    """

    def __init__(
        self,
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1, le=MAX_PAGE_SIZE),
    ) -> None:
        self.page = page
        self.page_size = page_size

    @property
    def limit(self) -> int:
        return self.page_size

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


#: Wire sort key → the column it may order by. This dict IS the allowlist:
#: anything not a key here is a 422, never a silent fall back to the default.
TASK_SORTS: dict[str, str] = {
    "created_at": "t.created_at",
    "updated_at": "t.updated_at",
    "due_at": "t.due_at",
    "importance": "t.importance",
    "title": "t.title",
    "task_number": "t.task_number",
    "completed_at": "t.completed_at",
}

DIRECTIONS: dict[str, str] = {"asc": "ASC", "desc": "DESC"}

#: Columns declared ``JSONB`` in migration 145. asyncpg has no codec for a bare
#: Python dict, so these are serialized here and cast in the statement.
JSONB_COLUMNS: frozenset[str] = frozenset({"meta", "config", "clickup_snapshot"})

#: ``TEXT[]``. asyncpg binds a Python list natively, so these must NOT go
#: through the jsonb path — serializing one would store the literal string
#: '["a"]' in a text array column.
ARRAY_COLUMNS: frozenset[str] = frozenset({"tags"})

TIMESTAMP_COLUMNS: frozenset[str] = frozenset({
    "due_at", "completed_at", "archived_at", "clickup_synced_at",
    # The personal overlay's instants (147). Same rule, same reason: bare
    # `text()` declares no column type, so an ISO string would arrive at a
    # timestamptz as text.
    "defer_until", "clarified_at",
})
DATE_COLUMNS: frozenset[str] = frozenset({"start_date"})


# ── Wire conversion ─────────────────────────────────────────────────────────

def wire(value: Any) -> Any:
    """One DB value → its JSON-safe form. UUIDs and instants become strings."""
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def from_jsonb(value: Any) -> Any:
    """A ``JSONB`` column as the driver hands it back.

    Raw ``text()`` over asyncpg returns jsonb as a **string** — there is no
    declared column type to decode against — so a model field typed ``dict``
    would reject it. Same rule, same reason, as ``routes/crm/core.py``.
    """
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def row_to_model(row: Any, model: type[BaseModel]) -> Any:
    data: dict[str, Any] = {}
    for name in model.model_fields:
        raw = getattr(row, name, None)
        if name in JSONB_COLUMNS:
            data[name] = from_jsonb(raw)
        elif name in ARRAY_COLUMNS:
            data[name] = list(raw) if raw is not None else []
        else:
            data[name] = wire(raw)
    return model(**data)


def row_to_dict(row: Any, model: type[BaseModel]) -> dict[str, Any]:
    return row_to_model(row, model).model_dump()


def actor(user: Any) -> str:
    """The acting identity, from the authenticated context only (R3/R4).

    Never from a query parameter or a body field: ``created_by`` is what the
    timeline attributes an action to, and a client-supplied one would let a
    caller write history in somebody else's name.
    """
    email = (getattr(user, "email", None) or "").strip()
    return email or "anonymous"


def now() -> datetime:
    """The one clock this package reads, so tests can freeze it in one place."""
    return datetime.now(UTC)


def clean_payload(payload: BaseModel) -> dict[str, Any]:
    """A PATCH body → only the fields the caller actually sent.

    ``exclude_unset`` and not ``exclude_none``: sending ``null`` is how a client
    clears a field, and collapsing the two would make "unset" and "clear" the
    same request.
    """
    return payload.model_dump(exclude_unset=True)


# ── Visibility — the grant read model (D-PM-3) ──────────────────────────────

#: The caller's `group:<slug>` subjects. Joined through `app_user` because the
#: grant subject names a group and the session carries an email — and matched
#: case-insensitively on both sides (R10).
_MY_GROUPS_SQL = """
SELECT 'group:' || g.slug AS subject
FROM org_group g
JOIN org_group_member m ON m.group_id = g.id
JOIN app_user au ON au.id = m.user_id
WHERE lower(au.email) = :email AND au.status = 'active'
"""

#: Projects the caller may see: those carrying a matching grant, plus everything
#: beneath them. The recursion descends from the granted seeds rather than
#: walking each project's ancestry upward — same answer, and it visits a subtree
#: once instead of once per descendant.
_VISIBLE_PROJECTS_SQL = """
WITH RECURSIVE granted AS (
    SELECT DISTINCT g.project_id AS id
    FROM pm_project_grants g
    WHERE g.subject = 'org'
       OR lower(g.subject) = :vis_email
       OR g.subject = ANY(:vis_groups)
    UNION
    SELECT p.id
    FROM pm_projects p
    JOIN granted a ON p.parent_project_id = a.id
)
SELECT id FROM granted
"""


@dataclass(frozen=True)
class Visibility:
    """What one caller may see, rendered as a reusable SQL fragment.

    ``unrestricted`` is the ``data:org:read`` holder — the People Center's
    full-portfolio view. For everyone else, :attr:`clause` is a subquery over
    the grant closure and callers ``AND`` it into their own WHERE.
    """

    unrestricted: bool
    email: str
    groups: tuple[str, ...]

    @property
    def params(self) -> dict[str, Any]:
        if self.unrestricted:
            return {}
        return {"vis_email": self.email, "vis_groups": list(self.groups)}

    def project_clause(self, column: str = "id") -> str:
        """A predicate restricting ``column`` (a project id) to the visible set."""
        if self.unrestricted:
            return "TRUE"
        return f"{column} IN ({_VISIBLE_PROJECTS_SQL})"


async def resolve_visibility(db: Any, user: UserContext) -> Visibility:
    """Read the caller's authority once per request.

    ``data:org:read`` short-circuits the group lookup: an unrestricted caller's
    groups cannot change the answer, and asking anyway would put a join on every
    portfolio read.
    """
    if user is not None and user.has_permission(ORG_READ):
        return Visibility(unrestricted=True, email="", groups=())
    email = actor(user).lower()
    rows = (await db.execute(text(_MY_GROUPS_SQL), {"email": email})).fetchall()
    return Visibility(
        unrestricted=False,
        email=email,
        groups=tuple(r.subject for r in rows if getattr(r, "subject", None)),
    )


async def load_visible_project(
    db: Any, vis: Visibility, project_id: str,
) -> Any:
    """One project the caller may see, or 404.

    404 and not 403 (R5): "no such project" and "not yours" must be the same
    answer, or the error code becomes an oracle for what exists in another
    department.
    """
    row = (await db.execute(
        text(
            f"SELECT * FROM pm_projects "
            f"WHERE id = CAST(:project_id AS uuid) AND {vis.project_clause()}"
        ),
        {"project_id": project_id, **vis.params},
    )).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return row


async def load_visible_task(db: Any, vis: Visibility, task_id: str) -> Any:
    """One task the caller may see, or 404.

    Two ways in, and the second is not a convenience: a task **assigned to the
    caller** is always visible even when its project is not granted to them.
    Delegation across a Center boundary is normal — somebody in Operations is
    asked to do one thing for Finance — and without this rule that task would
    404 for the very person expected to do it.
    """
    row = (await db.execute(
        text(
            "SELECT t.* FROM pm_tasks t "
            "WHERE t.id = CAST(:task_id AS uuid) AND ("
            f"  t.project_id IN ({_VISIBLE_PROJECTS_SQL})"
            "   OR EXISTS (SELECT 1 FROM pm_task_assignees a "
            "              WHERE a.task_id = t.id AND lower(a.assignee) = :vis_email)"
            ")"
            if not vis.unrestricted
            else "SELECT t.* FROM pm_tasks t WHERE t.id = CAST(:task_id AS uuid)"
        ),
        {"task_id": task_id, **vis.params},
    )).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return row


def task_visibility_clause(vis: Visibility, alias: str = "t") -> str:
    """The task-list counterpart of :meth:`Visibility.project_clause`.

    Same two ways in as :func:`load_visible_task`, so a task cannot be listable
    and unreadable (or the reverse) — the two would drift the moment one is
    edited alone.
    """
    if vis.unrestricted:
        return "TRUE"
    return (
        f"({alias}.project_id IN ({_VISIBLE_PROJECTS_SQL})"
        f" OR EXISTS (SELECT 1 FROM pm_task_assignees a"
        f"            WHERE a.task_id = {alias}.id"
        f"              AND lower(a.assignee) = :vis_email))"
    )


# ── SQL helpers ─────────────────────────────────────────────────────────────
#
# Every identifier reaching an f-string below is one of ours: a literal table
# name, or a key of a dict built from a Pydantic model's declared fields. Caller
# values are always bound parameters.

def _parse(parser: Any, value: str, column: str, what: str) -> Any:
    try:
        return parser(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"'{column}' is not a valid ISO-8601 {what}: {value!r}.",
        ) from exc


def coerce_write_values(values: dict[str, Any]) -> dict[str, Any]:
    """Request-shaped values → driver-shaped values. ONE choke point.

    Every write in this package goes through :func:`insert_row` or
    :func:`update_row`, so this runs on all of them and a new endpoint inherits
    it. Bare ``text()`` declares no column types to asyncpg, so without this an
    ISO string arrives at a ``timestamptz`` and a dict at a ``jsonb``. A
    malformed instant answers **422 naming the column** rather than surfacing as
    a driver error the caller cannot act on.
    """
    out = dict(values)
    for column, value in values.items():
        if value is None or not isinstance(value, str):
            continue
        if column in TIMESTAMP_COLUMNS:
            out[column] = _parse(datetime.fromisoformat, value, column, "instant")
        elif column in DATE_COLUMNS:
            out[column] = _parse(date.fromisoformat, value, column, "date")
    return out


def _placeholder(column: str) -> str:
    """The bind expression for one column — jsonb needs the cast, nothing else."""
    return f"CAST(:{column} AS jsonb)" if column in JSONB_COLUMNS else f":{column}"


def _bindable(values: dict[str, Any]) -> dict[str, Any]:
    out = coerce_write_values(values)
    for column in JSONB_COLUMNS & out.keys():
        if out[column] is not None and not isinstance(out[column], str):
            out[column] = json.dumps(out[column])
    return out


async def insert_row(db: Any, table: str, values: dict[str, Any]) -> Any:
    columns = list(values)
    placeholders = ", ".join(_placeholder(c) for c in columns)
    return (await db.execute(
        text(
            f"INSERT INTO {table} ({', '.join(columns)}) "
            f"VALUES ({placeholders}) RETURNING *"
        ),
        _bindable(values),
    )).fetchone()


async def update_row(
    db: Any, table: str, record_id: str, values: dict[str, Any],
    *, touch: bool = True,
) -> Any:
    assignments = [f"{c} = {_placeholder(c)}" for c in values]
    if touch:
        assignments.append("updated_at = now()")
    return (await db.execute(
        text(
            f"UPDATE {table} SET {', '.join(assignments)} "
            f"WHERE id = CAST(:record_id AS uuid) RETURNING *"
        ),
        {**_bindable(values), "record_id": record_id},
    )).fetchone()


async def load_row(db: Any, table: str, record_id: str) -> Any | None:
    return (await db.execute(
        text(f"SELECT * FROM {table} WHERE id = CAST(:id AS uuid)"),
        {"id": record_id},
    )).fetchone()


async def require_row(db: Any, table: str, record_id: str, what: str) -> Any:
    row = await load_row(db, table, record_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"{what} not found")
    return row


async def count_where(db: Any, table: str, column: str, value: str) -> int:
    total = (await db.execute(
        text(f"SELECT count(*) FROM {table} WHERE {column} = CAST(:value AS uuid)"),
        {"value": value},
    )).scalar()
    return int(total or 0)


# ── Hierarchy — the two self-FKs, and their only rules ──────────────────────

async def root_project_id(db: Any, project_id: str) -> str:
    """Walk to the root of ``project_id``'s tree.

    Bounded by :data:`MAX_DEPTH` for the same reason the cycle checks are: this
    runs on the write path, and a corrupted parent chain must fail loudly rather
    than spin.
    """
    current = project_id
    for _ in range(MAX_DEPTH):
        row = (await db.execute(
            text(
                "SELECT parent_project_id FROM pm_projects "
                "WHERE id = CAST(:id AS uuid)"
            ),
            {"id": current},
        )).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Project not found")
        parent = getattr(row, "parent_project_id", None)
        if parent is None:
            return str(current)
        current = str(parent)
    raise HTTPException(
        status_code=422,
        detail="Project hierarchy is deeper than the supported maximum.",
    )


async def assert_no_project_cycle(
    db: Any, project_id: str, new_parent_id: str | None,
) -> None:
    """Refuse a re-parent that would make a project its own ancestor."""
    if new_parent_id is None:
        return
    if str(new_parent_id) == str(project_id):
        raise HTTPException(
            status_code=422, detail="A project cannot be its own parent.",
        )
    current: str | None = str(new_parent_id)
    for _ in range(MAX_DEPTH):
        if current is None:
            return
        if str(current) == str(project_id):
            raise HTTPException(
                status_code=422,
                detail="That move would put the project inside its own subtree.",
            )
        row = (await db.execute(
            text(
                "SELECT parent_project_id FROM pm_projects "
                "WHERE id = CAST(:id AS uuid)"
            ),
            {"id": current},
        )).fetchone()
        if row is None:
            return
        parent = getattr(row, "parent_project_id", None)
        current = str(parent) if parent is not None else None
    raise HTTPException(
        status_code=422,
        detail="Project hierarchy is deeper than the supported maximum.",
    )


async def assert_no_task_cycle(
    db: Any, task_id: str, new_parent_id: str | None,
) -> None:
    """Refuse a re-parent that would make a task its own ancestor."""
    if new_parent_id is None:
        return
    if str(new_parent_id) == str(task_id):
        raise HTTPException(
            status_code=422, detail="A task cannot be its own parent.",
        )
    current: str | None = str(new_parent_id)
    for _ in range(MAX_DEPTH):
        if current is None:
            return
        if str(current) == str(task_id):
            raise HTTPException(
                status_code=422,
                detail="That move would put the task inside its own subtree.",
            )
        row = (await db.execute(
            text("SELECT parent_task_id FROM pm_tasks WHERE id = CAST(:id AS uuid)"),
            {"id": current},
        )).fetchone()
        if row is None:
            return
        parent = getattr(row, "parent_task_id", None)
        current = str(parent) if parent is not None else None
    raise HTTPException(
        status_code=422,
        detail="Task hierarchy is deeper than the supported maximum.",
    )


async def assert_epic_has_no_parent(
    db: Any, type_id: str | None, parent_task_id: str | None,
) -> None:
    """§3.4's one structural rule: an Epic-typed task cannot have a parent.

    This is what makes Epic the root level without a ``level`` column. It is
    checked against the type row's ``is_system`` flag as well as its name, so
    renaming the seeded Epic does not silently switch the rule off — and a
    user-created type merely *called* "Epic" does not switch it on.
    """
    if parent_task_id is None or type_id is None:
        return
    row = await load_row(db, "pm_task_types", str(type_id))
    if row is None:
        return
    if getattr(row, "is_system", False) and getattr(row, "name", "") == EPIC_TYPE_NAME:
        raise HTTPException(
            status_code=422,
            detail="An Epic cannot have a parent task; it is the top level.",
        )


async def next_task_number(db: Any, root_id: str) -> int:
    """Allocate the next human-readable number for a root project.

    One statement, so two concurrent creates cannot be handed the same number:
    the ``ON CONFLICT DO UPDATE`` re-reads and increments the committed row
    under the same lock that would have rejected the insert.
    """
    row = (await db.execute(
        text(
            "INSERT INTO pm_task_counters (project_id, last_value) "
            "VALUES (CAST(:root AS uuid), 1) "
            "ON CONFLICT (project_id) DO UPDATE "
            "SET last_value = pm_task_counters.last_value + 1 "
            "RETURNING last_value"
        ),
        {"root": root_id},
    )).fetchone()
    return int(getattr(row, "last_value", 1) or 1)


# ── Statuses ────────────────────────────────────────────────────────────────

async def load_default_status(db: Any, root_id: str) -> Any:
    """The status a new task lands in: the flagged default, else the first lane.

    Falling back to the lowest ``position`` rather than failing is deliberate —
    an owner who deletes the row that happened to carry ``is_default`` must not
    discover it by being unable to create a task.
    """
    for clause in ("AND is_default ", ""):
        row = (await db.execute(
            text(
                f"SELECT * FROM pm_task_statuses "
                f"WHERE project_id = CAST(:root AS uuid) {clause}"
                f"ORDER BY position, name LIMIT 1"
            ),
            {"root": root_id},
        )).fetchone()
        if row is not None:
            return row
    raise HTTPException(
        status_code=422,
        detail="No task statuses are configured for this project; create one first.",
    )


async def require_status_in_project(db: Any, root_id: str, status_id: str) -> Any:
    """A status, checked to belong to this project's tree.

    Without the project check a caller could move a task into another
    department's status — which would then render under a lane that project's
    board does not have, and would make the status undeletable there for a
    reason nobody could see.
    """
    row = (await db.execute(
        text(
            "SELECT * FROM pm_task_statuses "
            "WHERE id = CAST(:status_id AS uuid) AND project_id = CAST(:root AS uuid)"
        ),
        {"status_id": status_id, "root": root_id},
    )).fetchone()
    if row is None:
        raise HTTPException(
            status_code=422, detail="That status does not belong to this project.",
        )
    return row


async def apply_status_transition(
    db: Any, task: Any, new_status_id: str, *, created_by: str,
) -> dict[str, Any]:
    """Move a task to a new status. **Three effects, one helper.**

    1. the new ``status_id``;
    2. ``completed_at`` — stamped when the task crosses INTO a closing category,
       cleared when it crosses back out. Cleared, not left: a reopened task that
       keeps its completion stamp is done according to every report and open
       according to the board;
    3. a ``status_change`` activity naming both ends.

    Every mutator that can move a status calls this — the PATCH route today, the
    sync and the automation action later — because a write that sets only the
    column looks right in the UI and silently empties the timeline.
    """
    old_status = await require_row(
        db, "pm_task_statuses", str(task.status_id), "Status",
    )
    new_status = await require_status_in_project(
        db, str(task.root_project_id), str(new_status_id),
    )

    values: dict[str, Any] = {"status_id": str(new_status.id)}
    was_closed = old_status.category in CLOSING_CATEGORIES
    is_closed = new_status.category in CLOSING_CATEGORIES
    if is_closed and not was_closed:
        values["completed_at"] = now()
    elif was_closed and not is_closed:
        values["completed_at"] = None

    row = await update_row(db, "pm_tasks", str(task.id), values)
    await record_activity(
        db,
        activity_type="status_change",
        created_by=created_by,
        task_id=str(task.id),
        body=f"{old_status.name} → {new_status.name}",
        meta={
            "from": old_status.name,
            "to": new_status.name,
            "from_category": old_status.category,
            "to_category": new_status.category,
        },
    )
    return {"row": row, "from": old_status, "to": new_status}


# ── The activity spine ──────────────────────────────────────────────────────

async def record_activity(
    db: Any,
    *,
    activity_type: str,
    created_by: str,
    task_id: str | None = None,
    project_id: str | None = None,
    body: str | None = None,
    meta: dict[str, Any] | None = None,
) -> Any:
    """Write one timeline row.

    The migration's CHECK requires a target, and this refuses first so the
    failure names the caller's mistake instead of surfacing as an
    IntegrityError 500 from the driver.
    """
    if task_id is None and project_id is None:
        raise HTTPException(
            status_code=422,
            detail="An activity must name a task or a project.",
        )
    if activity_type not in ACTIVITY_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown activity type '{activity_type}'.",
        )
    return await insert_row(db, "pm_activities", {
        "type": activity_type,
        "task_id": task_id,
        "project_id": project_id,
        "body": body,
        "meta": meta,
        "created_by": created_by,
    })


def diff_changes(before: Any, after: Any, fields: tuple[str, ...]) -> list[dict]:
    """The ``field_change`` payload: what actually moved, old and new.

    Paca's shape, and the reason a change is revertible from the timeline
    without a second audit store. Fields whose value did not change are omitted
    — a diff that lists every column makes the one edit that mattered
    unfindable.
    """
    changes: list[dict] = []
    for name in fields:
        old, new = wire(getattr(before, name, None)), wire(getattr(after, name, None))
        if old != new:
            changes.append({"field": name, "old": old, "new": new})
    return changes


# ── Events (§6.3) ───────────────────────────────────────────────────────────

async def emit(event_type: str, payload: dict[str, Any]) -> None:
    """Publish one ``pm.*`` event on the platform's existing event seam.

    Deliberately the SAME path the ClickUp webhook already uses
    (``ingestion.event_hooks.emit_event`` → ``workflows.triggers.dispatch_event``),
    so binding this app to the automation engine is one seam rather than a new
    bus — WS-27f adds node types, not transport.

    Best-effort by construction: the import is inside the function so the
    gateway's import graph does not gain a dependency, and a failure is logged
    rather than raised. **A workflow that cannot run must never fail the write
    that triggered it** — the user's task edit already succeeded, and the
    alternative is a 500 on a successful mutation.
    """
    try:
        from ingestion.event_hooks import emit_event

        await emit_event("projects", event_type, payload)
    except Exception as exc:  # pragma: no cover — defensive, per the docstring
        # `event=` is structlog's own reserved key for the message; passing it
        # raises TypeError inside the logger and turns a swallowed bus failure
        # into the 500 this whole function exists to prevent.
        _log.warning("projects.event_emit_failed", topic=event_type, error=str(exc))


def validate_grant_subject(subject: str) -> str:
    """The grant subject vocabulary, and nothing else.

    ``org`` | ``group:<slug>`` | an email address — exactly what
    ``tenancy_and_visibility.md`` §3.2 already shipped for rooms, and §3.2 is
    binding: a second vocabulary would mean two answers to "who can see this".

    Lives here for WS-27a. WS-14 C1's done-when 5 names
    ``packages/acb_auth/acb_auth/permissions.py`` as the shared home for the
    same validator; whichever ticket lands second should lift this rather than
    keep a copy — two validators is how the two vocabularies begin.
    """
    value = (subject or "").strip()
    if not value:
        raise HTTPException(status_code=422, detail="A grant subject is required.")
    if value == "org":
        return value
    if value.startswith("group:"):
        slug = value[len("group:"):].strip()
        if not slug:
            raise HTTPException(
                status_code=422, detail="A group subject must name a group.",
            )
        return f"group:{slug.lower()}"
    if "@" in value:
        # R10 — stored folded, because every read compares folded.
        return value.lower()
    raise HTTPException(
        status_code=422,
        detail=(
            f"Unknown grant subject '{subject}'. "
            "One of: 'org', 'group:<slug>', or an email address."
        ),
    )


def validate_choice(value: str | None, allowed: tuple[str, ...], what: str) -> None:
    if value is not None and value not in allowed:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown {what} '{value}'. One of: {list(allowed)}.",
        )
