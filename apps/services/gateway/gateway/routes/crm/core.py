"""CRM routes — the shared kernel.

The leaf module: it imports nothing from its siblings. It owns the shared
``router``, the entity registry, the Pydantic models, the row→model mapper, the
list contract, and the small set of SQL helpers every feature module builds on.
Spec: ``ai-company-brain/specs/crm_app.md`` sections 3 and 4 (WS-26a).

Two things here are load-bearing and worth stating once:

**The engine.** This package makes **zero** ``create_async_engine`` calls. It
consumes ``gateway.db`` — the shared seam BO-10 asked for and D-CRM-4 records —
and ``routes/tasks/core.py`` was converted to the same seam in the same change
as the proof it works.

**Sort keys are an allowlist, never interpolation.** Every identifier that
reaches an f-string in this module comes from a literal we wrote (a table name,
an entry in :attr:`Entity.sorts`, a model field name); every value the caller
supplies is a bound parameter. An unknown sort key is a 422, not a slower query
— trycompai's ``resolveOrderBy`` lesson, and the one place a list endpoint
usually grows an injection.

**Visibility.** CRM data is org-visible to ``feature:crm`` holders in v1 and
``owner_email`` is *assignment*, not an ACL (D-CRM-3, a departure recorded per
``user_management_contract.md`` §7). So there is deliberately no owner
predicate here and no 404-not-403 scoping — unlike ``routes/notes``, where the
opposite decision is equally deliberate. Do not "fix" one to look like the
other without changing the decision first.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from acb_auth import require_feature_router
from acb_common import get_logger
from fastapi import APIRouter, HTTPException
from gateway.db import get_db as _get_db  # noqa: F401  — the shared seam (D-CRM-4)
from pydantic import BaseModel
from sqlalchemy import text

_log = get_logger("gateway.crm")

router = APIRouter(
    prefix="/crm", tags=["crm"],
    dependencies=[require_feature_router("crm")],
)

#: The `source` vocabulary, mirrored from the CHECK constraint in migration 144.
#: Kept here so a bad value is a 422 at the boundary rather than an IntegrityError
#: 500 from the driver.
SOURCES: tuple[str, ...] = ("manual", "import", "email", "agent")

#: `crm_*_statuses.type` — the machine-readable class the pipeline rules key off.
STATUS_TYPES: tuple[str, ...] = ("open", "ongoing", "on_hold", "won", "lost")

#: Status types that close a record (§3.6: entering one stamps `closed_at`).
CLOSING_TYPES: tuple[str, ...] = ("won", "lost")

#: `crm_activities.type`, mirrored from the same migration.
ACTIVITY_TYPES: tuple[str, ...] = (
    "note", "call", "meeting", "task", "status_change", "system",
)

MAX_PAGE_SIZE = 100


# ── Models ──────────────────────────────────────────────────────────────────
#
# Output model field names are the table's column names, 1:1, so `row_to_model`
# can map any row generically. Input models are all-optional: the same model
# serves POST and PATCH, with the create-time requirements declared once on the
# Entity (`required`) and checked in `records.py`. Two near-identical models per
# entity is the shape that drifts.

class OrganizationModel(BaseModel):
    id: str
    name: str
    website: str | None = None
    industry: str | None = None
    no_of_employees: int | None = None
    annual_revenue: float | None = None
    phone: str | None = None
    email: str | None = None
    address: dict | None = None
    description: str | None = None
    linkedin_url: str | None = None
    owner_email: str | None = None
    source: str = "manual"
    zoho_id: str | None = None
    last_activity_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class OrganizationIn(BaseModel):
    name: str | None = None
    website: str | None = None
    industry: str | None = None
    no_of_employees: int | None = None
    annual_revenue: float | None = None
    phone: str | None = None
    email: str | None = None
    address: dict | None = None
    description: str | None = None
    linkedin_url: str | None = None
    owner_email: str | None = None
    source: str | None = None


class ContactModel(BaseModel):
    id: str
    first_name: str
    last_name: str | None = None
    email: str | None = None
    phone: str | None = None
    mobile: str | None = None
    title: str | None = None
    organization_id: str | None = None
    description: str | None = None
    linkedin_url: str | None = None
    owner_email: str | None = None
    source: str = "manual"
    zoho_id: str | None = None
    last_activity_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class ContactIn(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    email: str | None = None
    phone: str | None = None
    mobile: str | None = None
    title: str | None = None
    organization_id: str | None = None
    description: str | None = None
    linkedin_url: str | None = None
    owner_email: str | None = None
    source: str | None = None


class LeadModel(BaseModel):
    id: str
    first_name: str | None = None
    last_name: str | None = None
    lead_name: str
    email: str | None = None
    phone: str | None = None
    mobile: str | None = None
    organization_name: str | None = None
    website: str | None = None
    industry: str | None = None
    no_of_employees: int | None = None
    annual_revenue: float | None = None
    status_id: str | None = None
    lead_source: str | None = None
    owner_email: str | None = None
    description: str | None = None
    lost_reason_id: str | None = None
    lost_note: str | None = None
    converted_at: str | None = None
    converted_contact_id: str | None = None
    converted_organization_id: str | None = None
    converted_deal_id: str | None = None
    source: str = "manual"
    zoho_id: str | None = None
    last_activity_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class LeadIn(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    lead_name: str | None = None
    email: str | None = None
    phone: str | None = None
    mobile: str | None = None
    organization_name: str | None = None
    website: str | None = None
    industry: str | None = None
    no_of_employees: int | None = None
    annual_revenue: float | None = None
    status_id: str | None = None
    lead_source: str | None = None
    owner_email: str | None = None
    description: str | None = None
    lost_reason_id: str | None = None
    lost_note: str | None = None
    source: str | None = None


class DealModel(BaseModel):
    id: str
    name: str
    organization_id: str | None = None
    status_id: str | None = None
    status_changed_at: str | None = None
    amount: float | None = None
    currency: str = "INR"
    probability: int | None = None
    expected_close_date: str | None = None
    closed_at: str | None = None
    lost_reason_id: str | None = None
    lost_note: str | None = None
    next_step: str | None = None
    lead_id: str | None = None
    owner_email: str | None = None
    description: str | None = None
    source: str = "manual"
    zoho_id: str | None = None
    last_activity_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class DealIn(BaseModel):
    name: str | None = None
    organization_id: str | None = None
    status_id: str | None = None
    amount: float | None = None
    currency: str | None = None
    probability: int | None = None
    expected_close_date: str | None = None
    lost_reason_id: str | None = None
    lost_note: str | None = None
    next_step: str | None = None
    lead_id: str | None = None
    owner_email: str | None = None
    description: str | None = None
    source: str | None = None


class ActivityModel(BaseModel):
    id: str
    type: str
    subject: str | None = None
    body: str | None = None
    occurred_at: str | None = None
    due_at: str | None = None
    completed_at: str | None = None
    lead_id: str | None = None
    deal_id: str | None = None
    contact_id: str | None = None
    organization_id: str | None = None
    created_by: str | None = None
    meta: dict | None = None
    zoho_id: str | None = None
    created_at: str | None = None


class StatusModel(BaseModel):
    id: str
    name: str
    color: str = "gray"
    position: int = 0
    type: str = "open"
    is_default: bool = False
    #: Deal statuses only — a lead status has no win probability.
    probability: int | None = None


class LostReasonModel(BaseModel):
    id: str
    label: str
    position: int = 0


class ListResponse(BaseModel):
    """The one list shape every collection endpoint returns."""

    rows: list[dict]
    total: int


# ── Entity registry ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Entity:
    """One CRM record type, and everything generic code needs to know about it."""

    slug: str
    table: str
    #: Singular, capitalised — what a 404 calls this record ("Lead not found").
    label: str
    #: The column in ``crm_activities`` that points at this entity.
    activity_column: str
    model: type[BaseModel]
    payload: type[BaseModel]
    #: Fields a POST must supply. PATCH never re-checks them.
    required: tuple[str, ...]
    #: Wire sort key → the SQL expression it is allowed to order by. This dict
    #: IS the allowlist: anything not a key here is a 422.
    sorts: dict[str, str]
    default_sort: str
    #: Columns ``?q=`` matches with ILIKE.
    search: tuple[str, ...] = ()
    #: The statuses table this entity's ``status_id`` points at, if any.
    status_table: str | None = None
    #: Leads only: default lists hide converted rows (§3.3). ``?include_converted``
    #: brings them back rather than a second endpoint.
    hides_converted: bool = False
    #: Child tables a DELETE takes with it, as ``(table, fk_column)``. Reported
    #: in the delete response — R7/R8: a destructive route names what cascaded.
    cascades: tuple[tuple[str, str], ...] = field(default_factory=tuple)


_TIMESTAMP_SORTS = {
    "created_at": "created_at",
    "updated_at": "updated_at",
    "last_activity_at": "last_activity_at",
}

ORGANIZATIONS = Entity(
    slug="organizations",
    table="crm_organizations",
    label="Organization",
    activity_column="organization_id",
    model=OrganizationModel,
    payload=OrganizationIn,
    required=("name",),
    sorts={"name": "name", "owner_email": "owner_email", **_TIMESTAMP_SORTS},
    default_sort="last_activity_at",
    search=("name", "email", "website"),
    cascades=(("crm_activities", "organization_id"),),
)

CONTACTS = Entity(
    slug="contacts",
    table="crm_contacts",
    label="Contact",
    activity_column="contact_id",
    model=ContactModel,
    payload=ContactIn,
    required=("first_name",),
    sorts={
        "first_name": "first_name", "last_name": "last_name", "email": "email",
        "owner_email": "owner_email", **_TIMESTAMP_SORTS,
    },
    default_sort="last_activity_at",
    search=("first_name", "last_name", "email"),
    cascades=(
        ("crm_activities", "contact_id"),
        ("crm_deal_contacts", "contact_id"),
    ),
)

LEADS = Entity(
    slug="leads",
    table="crm_leads",
    label="Lead",
    activity_column="lead_id",
    model=LeadModel,
    payload=LeadIn,
    required=(),  # lead_name is computed, never demanded — see compute_lead_name
    sorts={
        "lead_name": "lead_name", "email": "email", "owner_email": "owner_email",
        "status_id": "status_id", "annual_revenue": "annual_revenue",
        "converted_at": "converted_at", **_TIMESTAMP_SORTS,
    },
    default_sort="created_at",
    search=("lead_name", "email", "organization_name"),
    status_table="crm_lead_statuses",
    hides_converted=True,
    cascades=(("crm_activities", "lead_id"),),
)

DEALS = Entity(
    slug="deals",
    table="crm_deals",
    label="Deal",
    activity_column="deal_id",
    model=DealModel,
    payload=DealIn,
    required=("name",),
    sorts={
        "name": "name", "amount": "amount", "probability": "probability",
        "expected_close_date": "expected_close_date", "closed_at": "closed_at",
        "status_changed_at": "status_changed_at", "owner_email": "owner_email",
        **_TIMESTAMP_SORTS,
    },
    default_sort="last_activity_at",
    search=("name", "next_step"),
    status_table="crm_deal_statuses",
    cascades=(
        ("crm_activities", "deal_id"),
        ("crm_deal_contacts", "deal_id"),
    ),
)

#: URL segment → entity. The segment is matched against this dict, never
#: interpolated, so `/crm/{entity}/…` cannot name a table we did not choose.
ENTITIES: dict[str, Entity] = {
    e.slug: e for e in (LEADS, DEALS, CONTACTS, ORGANIZATIONS)
}


def resolve_entity(slug: str) -> Entity:
    """URL segment → :class:`Entity`, or 404."""
    entity = ENTITIES.get(slug)
    if entity is None:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown CRM entity '{slug}'. One of: {sorted(ENTITIES)}.",
        )
    return entity


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
    would reject it. Same rule, same reason, as
    ``routes/tasks/core.py::_parse_jsonb``.
    """
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def row_to_model(row: Any, model: type[BaseModel]) -> Any:
    """Map a DB row onto ``model`` by field name.

    Generic on purpose: the output models' fields ARE the table's columns, so a
    column added to a table and its model needs no mapper edit — and a column
    added to only one of the two shows up as a missing field rather than as a
    silently dropped value.
    """
    data = {
        name: (
            from_jsonb(getattr(row, name, None)) if name in JSONB_COLUMNS
            else wire(getattr(row, name, None))
        )
        for name in model.model_fields
    }
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


def compute_lead_name(values: dict[str, Any]) -> str:
    """§3.3's fallback chain — a lead always renders as *something*.

    names → organization_name → email local-part → 'Unnamed lead'. A NOT NULL
    column with no computed fallback is how "Untitled" ends up in a pipeline.
    """
    explicit = (values.get("lead_name") or "").strip()
    if explicit:
        return explicit
    person = " ".join(
        part for part in (values.get("first_name"), values.get("last_name"))
        if (part or "").strip()
    ).strip()
    if person:
        return person
    org = (values.get("organization_name") or "").strip()
    if org:
        return org
    email = (values.get("email") or "").strip()
    if email and "@" in email:
        return email.split("@", 1)[0]
    return email or "Unnamed lead"


# ── The list contract ───────────────────────────────────────────────────────

DIRECTIONS: dict[str, str] = {"asc": "ASC", "desc": "DESC"}


@dataclass(frozen=True)
class ListQuery:
    """A validated list request, rendered as SQL fragments + bound parameters."""

    where: str
    order_by: str
    limit: int
    offset: int
    params: dict[str, Any]


def list_contract(
    entity: Entity,
    *,
    q: str | None = None,
    sort: str | None = None,
    direction: str = "desc",
    page: int = 1,
    page_size: int = 50,
    status_id: str | None = None,
    owner: str | None = None,
    source: str | None = None,
    extra_where: tuple[str, ...] = (),
    extra_params: dict[str, Any] | None = None,
) -> ListQuery:
    """Validate one list request and render it. The same contract for all four.

    Raises 422 for an unknown sort key or direction. That is deliberately not a
    silent fall back to the default: a client sorting by a column it thinks
    exists and quietly getting `created_at` is a bug that survives review.
    """
    column = entity.sorts.get(sort or entity.default_sort)
    if column is None:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unknown sort key '{sort}' for {entity.slug}. "
                f"One of: {sorted(entity.sorts)}."
            ),
        )
    order = DIRECTIONS.get((direction or "").lower())
    if order is None:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown sort direction '{direction}'. One of: asc, desc.",
        )

    clauses: list[str] = list(extra_where)
    params: dict[str, Any] = dict(extra_params or {})

    if q and entity.search:
        params["q"] = f"%{q.strip()}%"
        matches = " OR ".join(f"{col} ILIKE :q" for col in entity.search)
        clauses.append(f"({matches})")
    if status_id and entity.status_table:
        clauses.append("status_id = CAST(:status_id AS uuid)")
        params["status_id"] = status_id
    if owner:
        # R10 — email comparisons are case-insensitive on both sides.
        clauses.append("lower(owner_email) = :owner")
        params["owner"] = owner.strip().lower()
    if source:
        clauses.append("source = :source")
        params["source"] = source

    page = max(1, page)
    page_size = max(1, min(page_size, MAX_PAGE_SIZE))
    return ListQuery(
        where=(" WHERE " + " AND ".join(clauses)) if clauses else "",
        # `column` is a value from the entity's own allowlist and `order` is one
        # of two literals — neither is caller text.
        order_by=f"{column} {order} NULLS LAST, id {order}",
        limit=page_size,
        offset=(page - 1) * page_size,
        params=params,
    )


async def run_list(db: Any, entity: Entity, query: ListQuery) -> ListResponse:
    """Execute a :class:`ListQuery` and return the ``{rows, total}`` shape."""
    total = (await db.execute(
        text(f"SELECT count(*) FROM {entity.table}{query.where}"), query.params,
    )).scalar() or 0
    rows = (await db.execute(
        text(
            f"SELECT * FROM {entity.table}{query.where} "
            f"ORDER BY {query.order_by} LIMIT :limit OFFSET :offset"
        ),
        {**query.params, "limit": query.limit, "offset": query.offset},
    )).fetchall()
    return ListResponse(
        rows=[row_to_dict(r, entity.model) for r in rows], total=int(total),
    )


# ── SQL helpers ─────────────────────────────────────────────────────────────
#
# Every identifier reaching an f-string below is one of ours: a table name from
# the registry, or a key of a dict this module built from a Pydantic model's
# declared fields. Caller values are always bound parameters.

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


#: Columns declared ``JSONB`` in migration 144. asyncpg has no codec for a bare
#: Python dict, so these are serialized here and cast in the statement.
JSONB_COLUMNS: frozenset[str] = frozenset({"address", "meta"})

#: ``TIMESTAMPTZ`` / ``DATE`` columns a request body may set as an ISO string.
#: asyncpg binds real ``datetime``/``date`` objects, so the string is parsed
#: here rather than cast in SQL — a ``CAST(:col AS timestamptz)`` would force
#: the parameter to text and then break the paths that bind a real datetime.
TIMESTAMP_COLUMNS: frozenset[str] = frozenset({
    "occurred_at", "due_at", "completed_at", "converted_at", "closed_at",
    "status_changed_at", "changed_at", "last_activity_at",
})
DATE_COLUMNS: frozenset[str] = frozenset({"expected_close_date"})


def coerce_write_values(values: dict[str, Any]) -> dict[str, Any]:
    """Request-shaped values → driver-shaped values. ONE choke point.

    Every write in this package goes through :func:`insert_row` or
    :func:`update_row`, so this runs on all of them and a new endpoint inherits
    it. A malformed instant answers **422 naming the column** rather than
    surfacing as a driver error a caller cannot act on.
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


def _parse(parser: Any, value: str, column: str, what: str) -> Any:
    try:
        return parser(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"'{column}' is not a valid ISO-8601 {what}: {value!r}.",
        ) from exc


def _placeholder(column: str) -> str:
    """The bind expression for one column — jsonb needs the cast, nothing else."""
    return f"CAST(:{column} AS jsonb)" if column in JSONB_COLUMNS else f":{column}"


def _bindable(values: dict[str, Any]) -> dict[str, Any]:
    """Coerce, then serialize the jsonb columns to the text their cast expects."""
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


async def load_default_status(db: Any, table: str) -> Any:
    """The status a new record lands in: the flagged default, else the first lane.

    Falling back to the lowest ``position`` rather than failing is deliberate —
    an owner who deletes the row that happened to carry ``is_default`` must not
    discover it by being unable to create a deal.
    """
    for clause in ("WHERE is_default ", ""):
        row = (await db.execute(
            text(f"SELECT * FROM {table} {clause}ORDER BY position, name LIMIT 1"),
            {},
        )).fetchone()
        if row is not None:
            return row
    raise HTTPException(
        status_code=422,
        detail=f"No statuses are configured in {table}; create one first.",
    )


def has_column(entity: Entity, name: str) -> bool:
    """Does this entity's table carry ``name``?

    Answered from the output model, which mirrors the columns 1:1 — so
    "deals have a stage-age clock and leads do not" is read from the schema's
    own projection rather than from a second hand-kept list.
    """
    return name in entity.model.model_fields


async def count_where(db: Any, table: str, column: str, value: str) -> int:
    total = (await db.execute(
        text(f"SELECT count(*) FROM {table} WHERE {column} = CAST(:value AS uuid)"),
        {"value": value},
    )).scalar()
    return int(total or 0)


async def bump_last_activity(db: Any, table: str, record_id: str) -> None:
    """Denormalized recency, maintained by every write to a record's timeline.

    trycompai's discipline, and the reason "sort by last touched" is an index
    scan rather than a correlated subquery over the activity spine.
    """
    await db.execute(
        text(
            f"UPDATE {table} SET last_activity_at = now() "
            f"WHERE id = CAST(:id AS uuid)"
        ),
        {"id": record_id},
    )


async def record_activity(
    db: Any,
    *,
    activity_type: str,
    created_by: str,
    target_column: str,
    target_id: str,
    subject: str | None = None,
    body: str | None = None,
    occurred_at_now: bool = True,
    extra: dict[str, Any] | None = None,
) -> Any:
    """Write one timeline row and bump its target's ``last_activity_at``.

    ``target_column`` is an entity's ``activity_column`` — one of four literals
    from the registry — so the CHECK constraint requiring at least one target
    can never be reached with all four NULL through this path.
    """
    values: dict[str, Any] = {
        "type": activity_type,
        "subject": subject,
        "body": body,
        "created_by": created_by,
        target_column: target_id,
        **(extra or {}),
    }
    if occurred_at_now:
        values.setdefault("occurred_at", _now())
    return await insert_row(db, "crm_activities", values)


def _now() -> datetime:
    from datetime import UTC

    return datetime.now(UTC)


def now() -> datetime:
    """The one clock this package reads, so tests can freeze it in one place."""
    return _now()


def clean_payload(payload: BaseModel) -> dict[str, Any]:
    """A PATCH body → only the fields the caller actually sent.

    ``exclude_unset`` and not ``exclude_none``: sending ``null`` is how a client
    clears a field, and collapsing the two would make "unset" and "clear" the
    same request.
    """
    return payload.model_dump(exclude_unset=True)


def validate_source(values: dict[str, Any]) -> None:
    source = values.get("source")
    if source is not None and source not in SOURCES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown source '{source}'. One of: {list(SOURCES)}.",
        )
