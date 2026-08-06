"""In-memory doubles for the ``gateway.routes.crm`` package.

One fake, shared by ``test_crm_routes.py`` / ``test_crm_pipeline.py`` /
``test_crm_convert.py``: two copies of a DB mirror drift, and the copy that
drifts is the one that stops failing (the ``_admin_fakes.py`` lesson).

Not named ``test_*``, so pytest imports it without collecting it.

Convention: the route functions are called directly as async functions with
``core._get_db`` monkeypatched, so nothing here touches Postgres and no
TestClient is started. Same shape as ``test_tasks_people_scoping.py``.

⚠️ **This is a MIRROR, and a mirror can only agree with itself.** It reads the
statement *text* to decide which rows a clause addresses — which column, which
bound parameter, which ``IS NULL`` filter, which ``ORDER BY`` — rather than
restating each route's predicate in Python, so a clause that changes column or
drops a filter changes the answer here too. That is a weaker mirror than a
hand-written copy, on purpose. It still cannot see:

* **foreign keys and therefore cascades.** Deleting a ``crm_deals`` row leaves
  the seeded ``crm_activities`` rows where they are; Postgres would take them.
  The delete route's blast-radius counts are therefore asserted against the
  statement text and the entity registry, not against survivors here.
* **CHECK constraints.** ``crm_activities``' "at least one target" and the
  ``source``/``type`` vocabularies are enforced by the database; the API's
  matching guards are asserted structurally against the migration text in
  ``test_crm_migration.py`` and behaviourally against the route's own 422.

An unparseable WHERE clause raises rather than matching every row: a clause the
fake cannot read must never silently mean "the whole table".
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

# ── Statement shapes the routes actually emit ───────────────────────────────

_TABLE_RE = re.compile(
    r"(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM)\s+([a-z_][a-z0-9_]*)", re.I
)
_WHERE_RE = re.compile(r"\bWHERE\b(.*?)(?:\bORDER\s+BY\b|\bLIMIT\b|\bRETURNING\b|$)", re.I | re.S)
#: The first ORDER BY term, with an optional table alias in front of it
#: (``ORDER BY dc.is_primary DESC``) — a joined read orders by a qualified
#: column and the unqualified form would read the alias as the column.
_ORDER_RE = re.compile(
    r"\bORDER\s+BY\s+(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*(ASC|DESC)?", re.I
)
#: ``SELECT base.*`` / ``SELECT c.*`` — which relation supplies the row body.
_SELECT_STAR_RE = re.compile(r"SELECT\s+(\w+)\.\*", re.I)
_LIMIT_RE = re.compile(r"\bLIMIT\s+:(\w+)", re.I)
_OFFSET_RE = re.compile(r"\bOFFSET\s+:(\w+)", re.I)
_INSERT_COLS_RE = re.compile(r"INSERT\s+INTO\s+\w+\s*\(([^)]*)\)", re.I)
_SET_RE = re.compile(r"\bSET\b(.*?)\bWHERE\b", re.I | re.S)
_MAX_RE = re.compile(r"SELECT\s+max\((\w+)\)", re.I)
#: The bound parameter inside a SET value — ``:meta`` or ``CAST(:meta AS jsonb)``.
_BOUND_RE = re.compile(r":(\w+)")

#: ``<col> = CAST(:param AS uuid)``
_UUID_EQ = re.compile(r"(\w+)\s*=\s*CAST\(:(\w+)\s+AS\s+uuid\)", re.I)
#: ``lower(<col>) = :param``
_LOWER_EQ = re.compile(r"lower\((\w+)\)\s*=\s*:(\w+)", re.I)
#: ``<col> = :param`` — never inside a lower() or a CAST.
_PLAIN_EQ = re.compile(r"(?<!lower\()\b(\w+)\s*=\s*:(\w+)\b")
#: ``<col> = 'literal'``
_LITERAL_EQ = re.compile(r"\b(\w+)\s*=\s*'([^']*)'")
#: ``<col> IS [NOT] NULL``
_IS_NULL = re.compile(r"\b(\w+)\s+IS\s+(NOT\s+)?NULL", re.I)
#: ``<col> ILIKE :q``
_ILIKE = re.compile(r"(\w+)\s+ILIKE\s+:(\w+)", re.I)
#: ``<col> IN ('a', 'b')`` — a closed literal vocabulary. Added for WS-26b's
#: activity push, whose whole safety property is the ``type IN ('note','task')``
#: predicate that keeps ``status_change`` rows out of Zoho: without a reader
#: for it the fake would answer with every activity and the test would pass
#: against a query that pushes the funnel's own history upstream.
_IN_LITERALS = re.compile(r"\b(\w+)\s+IN\s*\(\s*'([^)]*)'\s*\)", re.I)
#: ``coalesce(<col>, :default) <= :param`` — the retry queues' "is it due yet"
#: gate. Written as a coalesce rather than ``IS NULL OR <=`` so the predicate
#: is ONE comparison the fake can read; a disjunction it read as "IS NULL"
#: alone would answer that a backed-off row is due.
_COALESCE_CMP = re.compile(
    r"coalesce\((\w+),\s*:(\w+)\)\s*(<=|<|>=|>)\s*:(\w+)", re.I
)
#: ``<col> < :param`` — the attempt ceiling.
_NUM_CMP = re.compile(r"\b(\w+)\s*(<=|<|>=|>)\s*:(\w+)")

#: ``LEFT JOIN crm_organizations org ON org.id = base.organization_id`` — the
#: display-name projection ``core.project_joined`` wraps a list/board SELECT
#: in. Read from the statement (which table, which alias, which foreign key)
#: rather than hard-coded, so changing the join changes the answer here too.
_LEFT_JOIN = re.compile(
    r"LEFT\s+JOIN\s+(\w+)\s+(\w+)\s+ON\s+\2\.id\s*=\s*base\.(\w+)", re.I
)
#: ``JOIN crm_contacts c ON c.id = dc.contact_id`` — the deal-contacts read.
_INNER_JOIN = re.compile(
    r"(?<!LEFT\s)JOIN\s+(\w+)\s+(\w+)\s+ON\s+\2\.id\s*=\s*(\w+)\.(\w+)", re.I
)
#: ``org.name AS organization_name`` — one projected column.
_ALIASED_COL = re.compile(r"\b(\w+)\.(\w+)\s+AS\s+(\w+)", re.I)


#: SQL literals a SET clause can name instead of a bound parameter.
_SQL_LITERALS: dict[str, Any] = {"false": False, "true": True, "null": None}


def _table(sql: str) -> str:
    match = _TABLE_RE.search(sql)
    if match is None:  # pragma: no cover — every statement names a table
        raise AssertionError(f"fake could not find a table in: {sql}")
    return match.group(1)


class _Result:
    """The slice of the SQLAlchemy result surface these routes use."""

    def __init__(self, rows: list[Any], scalar: Any = None):
        self._rows = rows
        self._scalar = scalar

    def fetchone(self) -> Any:
        return self._rows[0] if self._rows else None

    def first(self) -> Any:
        return self.fetchone()

    def fetchall(self) -> list[Any]:
        return list(self._rows)

    def scalar(self) -> Any:
        if self._scalar is not None:
            return self._scalar
        return None


def _now() -> datetime:
    return datetime.now(UTC)


#: Column defaults migration 144 declares. Kept here so a row read back after an
#: INSERT looks like Postgres would have returned it.
_DEFAULTS: dict[str, dict[str, Any]] = {
    "crm_organizations": {"source": "manual"},
    "crm_contacts": {"source": "manual"},
    "crm_leads": {"source": "manual"},
    "crm_deals": {"source": "manual", "currency": "INR", "probability": None},
    "crm_lead_statuses": {"color": "gray", "position": 0, "is_default": False},
    "crm_deal_statuses": {
        "color": "gray", "position": 0, "is_default": False, "probability": 0,
    },
    "crm_lost_reasons": {"position": 0},
    "crm_deal_contacts": {"is_primary": False},
    # Migration 145's retry trio on the activity queue.
    "crm_activities": {
        "zoho_push_attempts": 0, "zoho_push_error": None,
        "zoho_next_attempt_at": None,
    },
    "crm_status_changes": {},
    # Migration 145 (WS-26b). `zoho_dirty` defaults false on the four record
    # tables too — see `_ZOHO_TRACKED` below, which cannot live here because
    # those tables already have entries.
    "crm_zoho_tombstones": {
        "pushed_at": None, "attempts": 0, "last_error": None,
        "next_attempt_at": None,
    },
    "crm_sync_cursors": {
        "last_pulled_at": None, "last_run_at": None, "last_status": None,
    },
}

#: Migration 145's column defaults on the four record tables. A row seeded
#: without them must read back as Postgres would: `zoho_dirty = false`, not
#: `None` — otherwise "is this row dirty" is answered by a missing key and the
#: push phase's predicate looks correct while matching nothing. Same for the
#: retry trio: `zoho_push_attempts = 0`, not NULL, or the `< :max_attempts`
#: gate would exclude every row that has never failed.
_ZOHO_TRACKED: dict[str, Any] = {
    "zoho_dirty": False, "zoho_synced_at": None,
    "zoho_push_attempts": 0, "zoho_push_error": None,
    "zoho_next_attempt_at": None,
}

#: Tables whose rows carry the timestamp trio.
_TIMESTAMPED = {
    "crm_organizations", "crm_contacts", "crm_leads", "crm_deals",
}


class _FakeSavepoint:
    """What :meth:`FakeCrmDB.begin_nested` hands back — an async CM."""

    def __init__(self, db: FakeCrmDB) -> None:
        self._db = db

    async def __aenter__(self) -> _FakeSavepoint:
        self._db.savepoints += 1
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        if exc_type is not None:
            self._db.savepoint_rollbacks += 1
        return False  # never swallow — the caller's except decides


class FakeCrmDB:
    """An in-memory ``crm_*`` schema that answers the package's statements."""

    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {}
        self.statements: list[str] = []
        #: ``(statement, params)`` in order — how a test proves a write happened
        #: with the values it expects rather than merely that a write happened.
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.committed = 0
        self.rollbacks = 0
        self.closed = False
        #: Savepoints opened / exited through the rollback arm (WS-26b).
        self.savepoints = 0
        self.savepoint_rollbacks = 0
        #: ``[needle, remaining]`` — see :meth:`fail_on`.
        self._failures: list[list[Any]] = []

    # seeding ------------------------------------------------------------
    def seed(self, table: str, **columns: Any) -> SimpleNamespace:
        row = {
            "id": columns.pop("id", str(uuid4())),
            **_DEFAULTS.get(table, {}),
            **columns,
        }
        if table in _TIMESTAMPED:
            row.setdefault("created_at", _now() - timedelta(days=1))
            row.setdefault("updated_at", _now() - timedelta(days=1))
            row.setdefault("last_activity_at", None)
            for column, default in _ZOHO_TRACKED.items():
                row.setdefault(column, default)
        self.tables.setdefault(table, []).append(row)
        return SimpleNamespace(**row)

    def rows(self, table: str) -> list[dict[str, Any]]:
        return self.tables.get(table, [])

    def statements_touching(self, needle: str) -> list[str]:
        return [s for s in self.statements if needle in s]

    # session surface ----------------------------------------------------
    async def commit(self) -> None:
        self.committed += 1

    async def rollback(self) -> None:
        self.rollbacks += 1

    async def close(self) -> None:
        self.closed = True

    def begin_nested(self) -> _FakeSavepoint:
        """The SAVEPOINT seam ``core.savepoint`` uses.

        ⚠️ It does NOT undo writes — an in-memory dict has no MVCC. What it
        models is the *shape*: that the SUT opens a savepoint per record and
        that a raising record exits through the rollback arm. The property
        that matters against a real database — "the transaction is not
        poisoned" — is unobservable here, which is why the tests assert the
        savepoint was TAKEN and that the batch, the cursor write and the
        commit all still happen after a statement error.
        """
        return _FakeSavepoint(self)

    def fail_on(self, needle: str, *, times: int = 1) -> None:
        """Make the next ``times`` statements containing *needle* raise.

        Simulates a driver-level statement error — a `numeric field overflow`,
        a CHECK violation — which is the class of failure a plain
        ``try/except`` around a record cannot actually contain in Postgres.
        """
        self._failures.append([needle, times])

    async def execute(self, sql: Any, params: dict | None = None) -> _Result:
        statement = " ".join(str(sql).split())
        args = dict(params or {})
        self.statements.append(statement)
        self.calls.append((statement, args))
        for entry in self._failures:
            if entry[0] in statement and entry[1] > 0:
                entry[1] -= 1
                raise RuntimeError(
                    f"fake driver error on statement containing {entry[0]!r}"
                )
        head = statement.split(None, 1)[0].upper()
        table = _table(statement)
        if head == "INSERT":
            return self._insert(statement, table, args)
        if head == "UPDATE":
            return self._update(statement, table, args)
        if head == "DELETE":
            return self._delete(statement, table, args)
        return self._select(statement, table, args)

    # verbs --------------------------------------------------------------
    def _insert(self, statement: str, table: str, args: dict) -> _Result:
        columns = [
            c.strip() for c in _INSERT_COLS_RE.search(statement).group(1).split(",")
        ]
        # A column NAMED in the INSERT takes the bound value even when that
        # value is None — Postgres applies a DEFAULT only to an omitted column,
        # and collapsing the two would hide "the route explicitly sent NULL".
        row = {
            "id": str(uuid4()),
            **_DEFAULTS.get(table, {}),
            **{c: args.get(c) for c in columns},
        }
        if table in _TIMESTAMPED:
            row.setdefault("created_at", _now())
            row.setdefault("updated_at", _now())
            row.setdefault("last_activity_at", None)
            for column, default in _ZOHO_TRACKED.items():
                row.setdefault(column, default)
        if table == "crm_deals":
            row.setdefault("status_changed_at", _now())
            row.setdefault("closed_at", None)
        if table in ("crm_status_changes", "crm_activities"):
            row.setdefault("created_at", _now())
            row.setdefault("changed_at", _now())
        self.tables.setdefault(table, []).append(row)
        return _Result([SimpleNamespace(**row)])

    def _update(self, statement: str, table: str, args: dict) -> _Result:
        assignments = _SET_RE.search(statement)
        matched = self._matching(statement, table, args)
        for row in matched:
            for part in (assignments.group(1) if assignments else "").split(","):
                column, _, value = part.partition("=")
                column, value = column.strip(), value.strip()
                if not column:
                    continue
                bound = _BOUND_RE.search(value)
                if bound:
                    # Covers both `col = :param` and the jsonb form
                    # `col = CAST(:param AS jsonb)`.
                    row[column] = args.get(bound.group(1))
                elif value.lower().startswith("now()"):
                    row[column] = _now()
                elif value.lower() in _SQL_LITERALS:
                    # `SET is_primary = false` — a literal, not a parameter.
                    # Skipping it would leave the demote-the-incumbent write
                    # in link_deal_contact silently inert here, and a fake
                    # that ignores a write agrees with the bug.
                    row[column] = _SQL_LITERALS[value.lower()]
        return _Result([SimpleNamespace(**r) for r in matched])

    def _delete(self, statement: str, table: str, args: dict) -> _Result:
        matched = self._matching(statement, table, args)
        keep = [r for r in self.tables.get(table, []) if r not in matched]
        self.tables[table] = keep
        return _Result([])

    def _select(self, statement: str, table: str, args: dict) -> _Result:
        matched = self._matching(statement, table, args)
        matched = self._ordered(statement, matched)
        matched = self._paged(statement, matched, args)
        upper = statement.upper()

        if "COUNT(*) AS COUNT" in upper:
            total = sum(float(r.get("amount") or 0) for r in matched)
            return _Result([SimpleNamespace(count=len(matched), amount=total)])
        if upper.startswith("SELECT COUNT(*)"):
            return _Result([], scalar=len(matched))
        aggregate = _MAX_RE.search(statement)
        if aggregate:
            values = [
                r.get(aggregate.group(1)) for r in matched
                if r.get(aggregate.group(1)) is not None
            ]
            return _Result([], scalar=max(values) if values else None)
        matched = self._joined(statement, matched)
        return _Result([SimpleNamespace(**r) for r in matched])

    # joins --------------------------------------------------------------
    def _joined(self, statement: str, rows: list[dict]) -> list[dict]:
        """Resolve the JOINs a statement declares, reading it for the shape.

        Two shapes exist in this package and both are read here rather than
        special-cased: ``core.project_joined``'s display-name wrapper
        (``LEFT JOIN crm_organizations org ON org.id = base.organization_id``
        plus ``org.name AS organization_name``) and the deal-contacts read
        (``JOIN crm_contacts c ON c.id = dc.contact_id``, whose ``SELECT c.*``
        makes the CONTACT the row body). Change the join in the route and this
        follows it; delete the join and ``organization_name`` disappears from
        the answer, which is what the assertion is for.
        """
        joins: dict[str, tuple[str, str]] = {
            alias: (table, fk)
            for table, alias, fk in _LEFT_JOIN.findall(statement)
        }
        inner = {
            alias: (table, fk)
            for table, alias, _qualifier, fk in _INNER_JOIN.findall(statement)
        }
        joins.update(inner)
        projected = _ALIASED_COL.findall(statement)
        if not joins and not projected:
            return rows

        body = _SELECT_STAR_RE.search(statement)
        out: list[dict] = []
        for row in rows:
            resolved = {
                alias: self._by_id(table, row.get(fk))
                for alias, (table, fk) in joins.items()
            }
            base = row
            if body and body.group(1) in resolved:
                found = resolved[body.group(1)]
                if found is None:
                    # An INNER JOIN with no match drops the row; a fake that
                    # kept it would report a link to a deleted contact.
                    continue
                base = found
            merged = dict(base)
            for alias, column, name in projected:
                source = resolved.get(alias) if alias in resolved else row
                merged[name] = (source or {}).get(column)
            out.append(merged)
        return out

    def _by_id(self, table: str, value: Any) -> dict[str, Any] | None:
        if value is None:
            return None
        for row in self.tables.get(table, []):
            if str(row.get("id")) == str(value):
                return row
        return None

    # predicate ----------------------------------------------------------
    def _matching(
        self, statement: str, table: str, args: dict,
    ) -> list[dict[str, Any]]:
        rows = list(self.tables.get(table, []))
        clause = _WHERE_RE.search(statement)
        if clause is None:
            return rows
        where = clause.group(1)
        seen = False

        for column, param in _UUID_EQ.findall(where):
            seen = True
            want = str(args.get(param))
            rows = [r for r in rows if str(r.get(column)) == want]
        for column, param in _LOWER_EQ.findall(where):
            seen = True
            want = str(args.get(param) or "").lower()
            rows = [r for r in rows if str(r.get(column) or "").lower() == want]
        for column, param in _PLAIN_EQ.findall(where):
            seen = True
            rows = [r for r in rows if r.get(column) == args.get(param)]
        for column, literal in _LITERAL_EQ.findall(where):
            seen = True
            rows = [r for r in rows if str(r.get(column)) == literal]
        for column, negated in _IS_NULL.findall(where):
            seen = True
            rows = [r for r in rows if (r.get(column) is not None) is bool(negated)]
        for column, listed in _IN_LITERALS.findall(where):
            seen = True
            wanted = {v.strip().strip("'") for v in f"'{listed}'".split(",")}
            rows = [r for r in rows if str(r.get(column)) in wanted]
        for column, default, operator, param in _COALESCE_CMP.findall(where):
            seen = True
            fallback = args.get(default)
            rows = [
                r for r in rows
                if _compare(
                    r.get(column) if r.get(column) is not None else fallback,
                    operator, args.get(param),
                )
            ]
        # Plain comparisons, with the coalesce ones removed first so their
        # inner `<=` is not read twice.
        for column, operator, param in _NUM_CMP.findall(_COALESCE_CMP.sub("", where)):
            seen = True
            rows = [
                r for r in rows if _compare(r.get(column), operator, args.get(param))
            ]
        ilike = _ILIKE.findall(where)
        if ilike:
            seen = True
            needle = str(args.get(ilike[0][1]) or "").strip("%").lower()
            rows = [
                r for r in rows
                if any(needle in str(r.get(c) or "").lower() for c, _ in ilike)
            ]
        if re.search(r"WHERE\s+is_default\b", statement, re.I):
            seen = True
            rows = [r for r in rows if r.get("is_default")]

        if not seen:
            raise AssertionError(
                f"fake could not read the WHERE clause — refusing to match every "
                f"row of {table}: {statement}"
            )
        return rows

    def _ordered(self, statement: str, rows: list[dict]) -> list[dict]:
        order = _ORDER_RE.search(statement)
        if order is None:
            return rows
        column = order.group(1)
        reverse = (order.group(2) or "ASC").upper() == "DESC"
        return sorted(
            rows,
            key=lambda r: (r.get(column) is None, _sortable(r.get(column))),
            reverse=reverse,
        )

    def _paged(self, statement: str, rows: list[dict], args: dict) -> list[dict]:
        offset = _OFFSET_RE.search(statement)
        if offset:
            rows = rows[int(args.get(offset.group(1), 0)):]
        limit = _LIMIT_RE.search(statement)
        if limit:
            rows = rows[: int(args.get(limit.group(1), len(rows)))]
        elif re.search(r"\bLIMIT\s+1\b", statement, re.I):
            rows = rows[:1]
        return rows


def _compare(left: Any, operator: str, right: Any) -> bool:
    """One SQL comparison, with SQL's NULL semantics: unknown never matches."""
    if left is None or right is None:
        return False
    try:
        if operator == "<":
            return bool(left < right)
        if operator == "<=":
            return bool(left <= right)
        if operator == ">":
            return bool(left > right)
        return bool(left >= right)
    except TypeError:  # naive/aware or mixed types — SQL would error; we skip
        return False


def _sortable(value: Any) -> Any:
    """A total order across the mixed types one column can hold in a fake."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.timestamp()
    if isinstance(value, bool | int | float):
        return float(value)
    return str(value)


# ── Principals ──────────────────────────────────────────────────────────────

def crm_user(email: str = "vjvarada@fracktal.in", *, features: str = "*") -> Any:
    """A caller holding ``feature:crm``.

    Built with the real ``build_access`` so the permission the routes are gated
    on is the one this principal actually resolves.
    """
    from acb_auth import UserContext, UserRole, build_access

    return UserContext(
        email=email, role=UserRole.EMPLOYEE, access=build_access([features]),
    )


def bind_db(monkeypatch: Any, fake: FakeCrmDB, modules: tuple[Any, ...]) -> None:
    """Point each CRM submodule's ``_get_db`` seam at ``fake``.

    Per-module and not per-package because each module imports ``_get_db`` from
    ``core`` by name, so patching ``core`` alone would not reach them.
    """
    async def _get_db() -> FakeCrmDB:
        return fake

    for module in modules:
        monkeypatch.setattr(module, "_get_db", _get_db)
