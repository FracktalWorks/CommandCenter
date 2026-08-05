"""CRM · sync_zoho — the two-way Zoho sync engine, and its scheduled loop.

Spec: ``ai-company-brain/specs/crm_app.md`` §7.1 (all seven sync bullets) ·
D-CRM-6 · D-CRM-7 · D-CRM-8 · ticket WS-26b done-when 3, 4 and 5.

    POST /crm/sync/zoho    run ONE cycle now (admin:access:manage), with or
                           without the flag — a hand-run cycle is an explicit
                           admin act, not a scheduled one.

**One cycle = pull, then apply Zoho's deletes, then push.** In that order, on
purpose: pulling first means a native row that lost a conflict is already
corrected before the push phase looks at what is dirty, so the same cycle never
pushes a value it is about to overwrite.

Seven rules this module exists to keep, each from §7.1:

1. **Single writer, through the broker gate.** Every Zoho write in the repo
   lives in ``ingestion/sources/zoho/writer.py``, and :func:`execute_push` is
   its ONLY caller — grep-asserted in ``tests/unit/test_crm_zoho_sync.py``.
   Every push goes through ``broker_handlers.broker_gate`` first (D-CRM-8), so
   there is one audited chokepoint and an audit row per push.
2. **Zoho → native is incremental**, driven by ``crm_sync_cursors`` (a cursor
   that is not persisted re-reads the tenant after every restart) plus Zoho's
   deleted-records API, because a deleted record simply stops appearing in a
   list call and can never be inferred from one.
3. **Native → Zoho is dirty-driven.** ``zoho_dirty`` is set at the ONE write
   choke point (``core.insert_row`` / ``core.update_row``); a create acquires
   a ``zoho_id``, an update writes onto it.
4. **Deletes are tombstoned, both ways.** A native delete writes
   ``crm_zoho_tombstones`` inside its own transaction (``core``/``records``);
   a Zoho delete is applied natively here and **writes no tombstone** — that
   would push the deletion straight back at the tenant it came from.
5. **Conflicts are record-level last-writer-wins, counted, never silent.**
   Zoho's ``Modified_Time`` against the native ``updated_at``. No field-level
   merge in v1 (D-CRM-6).
6. **Echo suppression is a rule, not a hope.** A pull-applied write goes
   through ``touch=False`` and carries an explicit ``zoho_dirty``, so it can
   never mark the row for a push back. Two cycles over an unchanged fake
   tenant converge to zero pushes; the test pins exactly that.
7. **Vocabulary flows DOWN only.** Zoho's stage names are auto-created as
   native lanes (the importer's :func:`~.import_zoho.ensure_status`); native
   status creation is never pushed — Zoho picklist mutation needs the settings
   API, and the vocabulary dies with Zoho anyway.

**The flag gates the LOOP, not the engine.** ``CRM_ZOHO_SYNC`` ships OFF, so
the gateway lifespan registers no loop; ``POST /crm/sync/zoho`` still runs a
cycle, because an admin asking for one is a decision, not a schedule. Enabling
the flag, the first backfill, and any hand-run cycle against the production
tenant are all OWNER-GATE (``work_plan.md`` §6) — **this engine WRITES the live
Zoho tenant.**
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime
from functools import partial
from typing import Any

from acb_auth import UserContext, get_current_user, require_permission
from acb_common import get_logger, get_settings
from fastapi import Depends
from gateway.routes.crm.broker_handlers import broker_gate
from gateway.routes.crm.core import (
    CONTACTS,
    ENTITIES,
    LEADS,
    ORGANIZATIONS,
    Entity,
    _get_db,
    count_where,
    load_by_zoho_id,
    load_row,
    now,
    router,
    update_row,
)
from gateway.routes.crm.import_zoho import (
    ACTIVITY_MODULES,
    ALL_MODULES,
    RECORD_MODULES,
    ImportReport,
    ModuleReport,
    _fetch,
    apply_module,
    modified_time,
    owner_index,
)
from pydantic import BaseModel
from sqlalchemy import text

_log = get_logger("gateway.crm.sync_zoho")

#: §7.1 — "Interval ~10 min".
SYNC_INTERVAL_SECS = 600
#: Floor, so a misconfigured interval cannot hammer Zoho's rate limit.
MIN_INTERVAL_SECS = 60
#: Ceiling on how much one cycle pushes, so a first cycle after a large import
#: cannot run for an unbounded time holding one transaction open.
PUSH_BATCH_LIMIT = 500

#: The activity types that have a Zoho analog (§7.1). ``status_change`` and
#: ``system`` deliberately never push: Zoho keeps its own stage history, and a
#: synthetic note per transition would double every funnel move.
PUSHABLE_ACTIVITY_TYPES: tuple[str, ...] = ("note", "task")

#: ``crm_activities`` target column → the Zoho module its parent lives in.
_PARENT_MODULES: dict[str, str] = {
    entity.activity_column: entity.zoho_module or ""
    for entity in ENTITIES.values()
}
_PARENT_TABLES: dict[str, str] = {
    entity.activity_column: entity.table for entity in ENTITIES.values()
}


# ── Seams ───────────────────────────────────────────────────────────────────

def _client() -> Any:
    """The Zoho READ client. A function so tests bind a fake in one place."""
    from ingestion.sources.zoho import client

    return client


def _writer() -> Any:
    """The Zoho WRITE client — ``ingestion/sources/zoho/writer.py``.

    ⚠️ **This function is the writer's only import site in the whole repo**,
    and :func:`execute_push` is its only caller. That is §7.1's single-writer
    rule expressed in code rather than in a comment, and
    ``tests/unit/test_crm_zoho_sync.py`` greps the tree to keep it true. If you
    need Zoho written from somewhere else, the answer is to write the native
    CRM and let this engine propagate it.
    """
    from ingestion.sources.zoho import writer

    return writer


def sync_enabled() -> bool:
    """``CRM_ZOHO_SYNC`` — gates the scheduled LOOP only (§7.1).

    Ships OFF. Flipping it is an OWNER-GATE act because the loop then writes
    the live Zoho tenant unattended.
    """
    return bool(getattr(get_settings(), "crm_zoho_sync", False))


# ── The cycle report ────────────────────────────────────────────────────────

class PushReport(BaseModel):
    """What this cycle pushed UP. Loud counts (§7.1) — including the failures."""

    created: int = 0
    updated: int = 0
    deleted: int = 0
    activities: int = 0
    #: Pushes the broker QUEUED for approval because ``ACTION_BROKER_ENFORCE``
    #: is on. They have NOT happened: the rows stay dirty for the next cycle.
    queued: int = 0
    errors: list[str] = []


class DeleteReport(BaseModel):
    """Zoho deletions applied natively, per module, with the cascade counted."""

    applied: dict[str, int] = {}
    cascaded_activities: int = 0


class SyncCycleReport(BaseModel):
    """One cycle, end to end. Everything a human needs to trust the run."""

    started_at: str
    finished_at: str | None = None
    #: Zoho → native, per module.
    pulled: dict[str, ModuleReport] = {}
    #: Rows a pull skipped because a pending native edit won (§7.1's LWW).
    pull_skipped_native_newer: int = 0
    zoho_deletes: DeleteReport = DeleteReport()
    pushed: PushReport = PushReport()
    #: §7.1 — "both-changed conflicts are counted and logged per cycle, never
    #: silent". Split by winner so "the sync is losing my edits" is answerable.
    conflicts: int = 0
    conflicts_zoho_won: int = 0
    conflicts_native_won: int = 0
    statuses_created: int = 0
    unmatched_owners: int = 0
    errors: list[str] = []


# ── Cursors (§7.1: "pull cursors are schema too") ───────────────────────────

async def read_cursor(db: Any, module: str) -> datetime | None:
    """The watermark the next pull of ``module`` sends as If-Modified-Since."""
    row = (await db.execute(
        text("SELECT * FROM crm_sync_cursors WHERE module = :module"),
        {"module": module},
    )).fetchone()
    return getattr(row, "last_pulled_at", None) if row is not None else None


async def write_cursor(
    db: Any, module: str, *, pulled_at: datetime | None, status: str,
) -> None:
    """Persist one module's cursor. ``ON CONFLICT`` because it is a PK upsert."""
    await db.execute(
        text(
            "INSERT INTO crm_sync_cursors "
            "(module, last_pulled_at, last_run_at, last_status) "
            "VALUES (:module, :last_pulled_at, :last_run_at, :last_status) "
            "ON CONFLICT (module) DO UPDATE SET "
            "last_pulled_at = EXCLUDED.last_pulled_at, "
            "last_run_at = EXCLUDED.last_run_at, "
            "last_status = EXCLUDED.last_status"
        ),
        {
            "module": module,
            "last_pulled_at": pulled_at,
            "last_run_at": now(),
            "last_status": status[:200],
        },
    )


# ── Conflict resolution (§7.1 / D-CRM-6: record-level last-writer-wins) ─────

def _later(left: datetime | None, right: datetime | None) -> bool:
    """Is ``left`` strictly later than ``right``? Unknowable → False.

    A missing or naive timestamp means we cannot honestly say Zoho is newer,
    and the conservative answer is "no" — the native edit survives and is
    pushed, which is recoverable. The other direction silently discards a
    colleague's typing.
    """
    if left is None or right is None:
        return False
    try:
        return left > right
    except TypeError:
        # naive vs aware — the stored value cannot be compared to Zoho's.
        return False


def _zoho_changed_since_agreement(record: dict[str, Any], existing: Any) -> bool:
    """Has Zoho moved since the last time the two sides agreed?

    ``zoho_synced_at`` is that agreement point. Unknown on either side is read
    as "yes": treating an unprovable case as *not* a conflict is how a real
    conflict resolves silently.
    """
    synced = getattr(existing, "zoho_synced_at", None)
    changed = modified_time(record)
    if synced is None or changed is None:
        return True
    try:
        return changed > synced
    except TypeError:
        return True


async def resolve_conflicts(
    db: Any,
    entity: Entity | None,
    records: list[dict[str, Any]],
    report: SyncCycleReport,
) -> list[dict[str, Any]]:
    """Filter a pulled batch down to the records the pull is allowed to apply.

    Three outcomes per record:

    * **not dirty natively** → apply. The overwhelming majority.
    * **dirty, Zoho unchanged since the agreement** → skip, silently and
      correctly: the native edit is queued for push and applying the pull
      would clobber it with the value we are about to overwrite anyway. Not a
      conflict — only one side moved.
    * **dirty AND Zoho moved** → a genuine conflict. Counted, logged, and
      decided by last-writer-wins: Zoho later ⇒ apply the pull (which clears
      ``zoho_dirty``, discarding the native edit); native later ⇒ skip, leave
      the row dirty, and the push phase later this cycle overwrites Zoho.

    Activities have no LWW: they are append-only log rows keyed by
    ``zoho_id``, so re-applying one is a no-op.
    """
    if entity is None:
        return records
    keep: list[dict[str, Any]] = []
    for record in records:
        zoho_id = str(record.get("id") or "").strip()
        existing = (
            await load_by_zoho_id(db, entity.table, zoho_id) if zoho_id else None
        )
        if existing is None or not getattr(existing, "zoho_dirty", False):
            keep.append(record)
            continue
        if not _zoho_changed_since_agreement(record, existing):
            report.pull_skipped_native_newer += 1
            continue

        report.conflicts += 1
        zoho_wins = _later(
            modified_time(record), getattr(existing, "updated_at", None),
        )
        if zoho_wins:
            report.conflicts_zoho_won += 1
            keep.append(record)
        else:
            report.conflicts_native_won += 1
        _log.info(
            "crm.sync.conflict", table=entity.table, zoho_id=zoho_id,
            winner="zoho" if zoho_wins else "native",
        )
    return keep


# ── Phase 1: pull ───────────────────────────────────────────────────────────

def _newest(records: list[dict[str, Any]]) -> datetime | None:
    stamps = [t for t in (modified_time(r) for r in records) if t is not None]
    return max(stamps) if stamps else None


async def pull_phase(
    db: Any, zoho: Any, owners: dict[str, str], actor_email: str,
    report: SyncCycleReport,
) -> None:
    """Zoho → native, one module at a time, incrementally from the cursors."""
    entities = dict(RECORD_MODULES)
    for module in ALL_MODULES:
        cursor = await read_cursor(db, module)
        try:
            records = await _fetch(zoho, module, modified_since=cursor)
        except Exception as exc:
            message = f"{module} pull failed: {str(exc)[:200]}"
            report.errors.append(message)
            report.pulled[module] = ModuleReport(errors=[message])
            await write_cursor(db, module, pulled_at=cursor, status="error")
            _log.warning("crm.sync.pull_failed", module=module, error=str(exc)[:200])
            continue

        applicable = await resolve_conflicts(
            db, entities.get(module), records, report,
        )
        # The importer owns the field mapping for BOTH directions of read, so a
        # backfill and a pull can never map `Deal_Name` differently.
        carrier = ImportReport(dry_run=False, modules={})
        module_report = await apply_module(
            db, module, applicable,
            owners=owners, fallback_owner=actor_email, report=carrier,
        )
        module_report.fetched = len(records)
        module_report.skipped += len(records) - len(applicable)
        report.pulled[module] = module_report
        report.statuses_created += carrier.statuses_created
        report.unmatched_owners += carrier.unmatched_owners
        await write_cursor(
            db, module,
            pulled_at=_newest(records) or cursor or report_started(report),
            status="ok" if not module_report.errors else "partial",
        )


def report_started(report: SyncCycleReport) -> datetime | None:
    """The cycle's start instant, for a module that pulled nothing at all.

    Without it a module Zoho has never changed keeps a NULL cursor forever and
    re-reads its whole table every ten minutes.
    """
    from gateway.routes.crm.import_zoho import parse_instant

    return parse_instant(report.started_at)


# ── Phase 2: apply Zoho's deletes ───────────────────────────────────────────

async def apply_zoho_deletes(
    db: Any, zoho: Any, report: SyncCycleReport,
) -> None:
    """Zoho deletions become native deletions, loudly counted (§7.1).

    ⚠️ These deletes deliberately bypass ``records.delete_record`` and
    therefore write **no tombstone**: a tombstone here would push the deletion
    straight back at the tenant that just told us about it — an echo, in the
    most destructive direction available.

    The cascade (``crm_activities``, ``crm_deal_contacts``) is Postgres's, per
    the FK graph; the activity count is read BEFORE the delete because
    afterwards the honest number is unobtainable.
    """
    for module, entity in RECORD_MODULES:
        cursor = await read_cursor(db, module)
        try:
            deleted = await zoho.list_deleted(module, since=cursor)
        except Exception as exc:
            report.errors.append(f"{module} deleted-records read failed: "
                                 f"{str(exc)[:200]}")
            _log.warning(
                "crm.sync.deleted_read_failed", module=module, error=str(exc)[:200],
            )
            continue

        applied = 0
        for row in deleted:
            zoho_id = str(row.get("id") or "").strip()
            if not zoho_id:
                continue
            native = await load_by_zoho_id(db, entity.table, zoho_id)
            if native is None:
                continue
            report.zoho_deletes.cascaded_activities += await count_where(
                db, "crm_activities", entity.activity_column, str(native.id),
            )
            await db.execute(
                text(f"DELETE FROM {entity.table} WHERE id = CAST(:id AS uuid)"),
                {"id": str(native.id)},
            )
            applied += 1
        if applied:
            report.zoho_deletes.applied[module] = applied
            _log.info("crm.sync.zoho_deletes_applied", module=module, count=applied)


# ── Native → Zoho payloads (the push direction's mapping) ───────────────────

def _address_fields(row: Any, prefix: str) -> dict[str, Any]:
    """The ``address`` JSONB unfolded back into Zoho's five flat columns."""
    address = getattr(row, "address", None)
    if isinstance(address, str):
        import json

        with contextlib.suppress(ValueError):
            address = json.loads(address)
    if not isinstance(address, dict):
        return {}
    return {
        f"{prefix}_{zoho}": address.get(key)
        for key, zoho in (
            ("street", "Street"), ("city", "City"), ("state", "State"),
            ("code", "Code"), ("country", "Country"),
        )
        if address.get(key)
    }


def _pruned(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop the keys we have nothing for.

    Sending ``None`` at Zoho CLEARS the field, so a native model that simply
    does not carry a column would quietly blank it upstream every cycle.
    """
    return {k: v for k, v in payload.items() if v is not None}


def to_zoho_account(row: Any) -> dict[str, Any]:
    return _pruned({
        "Account_Name": row.name,
        "Website": getattr(row, "website", None),
        "Industry": getattr(row, "industry", None),
        "Employees": getattr(row, "no_of_employees", None),
        "Annual_Revenue": getattr(row, "annual_revenue", None),
        "Phone": getattr(row, "phone", None),
        "Description": getattr(row, "description", None),
        **_address_fields(row, "Billing"),
    })


def to_zoho_contact(row: Any, *, account_id: str | None) -> dict[str, Any]:
    # Zoho requires Last_Name on a Contact; ours is optional (§3.2), so the
    # first name stands in rather than the push failing validation.
    last = getattr(row, "last_name", None) or row.first_name
    return _pruned({
        "First_Name": getattr(row, "first_name", None),
        "Last_Name": last,
        "Email": getattr(row, "email", None),
        "Phone": getattr(row, "phone", None),
        "Mobile": getattr(row, "mobile", None),
        "Title": getattr(row, "title", None),
        "Description": getattr(row, "description", None),
        "Account_Name": {"id": account_id} if account_id else None,
    })


def to_zoho_lead(row: Any, *, status_name: str | None) -> dict[str, Any]:
    last = getattr(row, "last_name", None) or row.lead_name
    return _pruned({
        "First_Name": getattr(row, "first_name", None),
        "Last_Name": last,
        # Zoho requires Company on a Lead; ours is free text and optional.
        "Company": getattr(row, "organization_name", None) or row.lead_name,
        "Email": getattr(row, "email", None),
        "Phone": getattr(row, "phone", None),
        "Mobile": getattr(row, "mobile", None),
        "Website": getattr(row, "website", None),
        "Industry": getattr(row, "industry", None),
        "No_of_Employees": getattr(row, "no_of_employees", None),
        "Annual_Revenue": getattr(row, "annual_revenue", None),
        "Lead_Source": getattr(row, "lead_source", None),
        "Description": getattr(row, "description", None),
        "Lead_Status": status_name,
    })


def to_zoho_deal(
    row: Any, *, status_name: str | None, account_id: str | None,
) -> dict[str, Any]:
    closing = getattr(row, "expected_close_date", None)
    return _pruned({
        "Deal_Name": row.name,
        "Amount": getattr(row, "amount", None),
        "Stage": status_name,
        "Closing_Date": closing.isoformat() if hasattr(closing, "isoformat")
        else closing,
        "Probability": getattr(row, "probability", None),
        "Next_Step": getattr(row, "next_step", None),
        "Description": getattr(row, "description", None),
        "Account_Name": {"id": account_id} if account_id else None,
    })


async def _status_name(db: Any, entity: Entity, row: Any) -> str | None:
    if not entity.status_table:
        return None
    status_id = getattr(row, "status_id", None)
    if not status_id:
        return None
    status = await load_row(db, entity.status_table, str(status_id))
    return getattr(status, "name", None) if status is not None else None


async def _linked_zoho_id(db: Any, table: str, record_id: Any) -> str | None:
    """The Zoho id of a linked native row, if it has one yet."""
    if not record_id:
        return None
    row = await load_row(db, table, str(record_id))
    return (getattr(row, "zoho_id", None) or None) if row is not None else None


async def build_payload(db: Any, entity: Entity, row: Any) -> dict[str, Any]:
    """One native row → the Zoho body for its module."""
    if entity is ORGANIZATIONS:
        return to_zoho_account(row)
    account_id = await _linked_zoho_id(
        db, ORGANIZATIONS.table, getattr(row, "organization_id", None),
    )
    if entity is CONTACTS:
        return to_zoho_contact(row, account_id=account_id)
    status_name = await _status_name(db, entity, row)
    if entity is LEADS:
        return to_zoho_lead(row, status_name=status_name)
    return to_zoho_deal(row, status_name=status_name, account_id=account_id)


# ── The one call that reaches the writer ────────────────────────────────────

async def execute_push(
    *, module: str, op: str, record_id: str | None = None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Perform one Zoho write. **The writer's only caller** (§7.1).

    Called two ways and only two: by :func:`push_one` behind the broker gate
    (the auto-apply path), and by ``broker_handlers._handle_crm_zoho_write``
    when an operator approves a QUEUED push in the ``/actions`` inbox. Both
    arrive having already passed the gate, which is why this function does not
    consult it — a third caller that skipped it would be the hole.
    """
    writer = _writer()
    if op == "create":
        result = await writer.create_record(module, body or {})
    elif op == "update":
        if not record_id:
            raise RuntimeError(f"update of {module} with no Zoho id")
        result = await writer.update_record(module, record_id, body or {})
    elif op == "delete":
        if not record_id:
            raise RuntimeError(f"delete of {module} with no Zoho id")
        result = await writer.delete_record(module, record_id)
    else:
        raise RuntimeError(f"unknown Zoho push op {op!r}")
    return {
        "ok": True,
        "zoho_id": writer.record_id_of(result) or record_id,
        "result": result,
    }


async def push_one(
    *, module: str, op: str, record_id: str | None, body: dict[str, Any] | None,
    target: str,
) -> dict[str, Any]:
    """Take one push through the Action-Broker gate, then execute it (D-CRM-8).

    The audit payload carries everything a later approval needs — module, verb,
    id, body — because a proposal approved next week must not depend on this
    process still being alive.
    """
    args = {"module": module, "op": op, "record_id": record_id, "body": body or {}}
    return await broker_gate(
        f"crm.zoho_{op}", target, {"args": args},
        partial(execute_push, module=module, op=op, record_id=record_id, body=body),
    )


# ── Phase 3: push ───────────────────────────────────────────────────────────

async def push_records(db: Any, report: SyncCycleReport) -> None:
    """Every dirty row in the four record tables, created or updated upstream."""
    for module, entity in RECORD_MODULES:
        rows = (await db.execute(
            text(
                f"SELECT * FROM {entity.table} WHERE zoho_dirty = :dirty "
                f"ORDER BY updated_at LIMIT :limit"
            ),
            {"dirty": True, "limit": PUSH_BATCH_LIMIT},
        )).fetchall()
        for row in rows:
            zoho_id = (getattr(row, "zoho_id", None) or "").strip() or None
            op = "update" if zoho_id else "create"
            try:
                body = await build_payload(db, entity, row)
                result = await push_one(
                    module=module, op=op, record_id=zoho_id, body=body,
                    target=f"{module}:{zoho_id or 'new'}",
                )
            except Exception as exc:
                # Left dirty on purpose: the next cycle retries. A push that
                # failed and cleared the flag is a change silently dropped.
                report.pushed.errors.append(
                    f"{entity.table}/{row.id}: {str(exc)[:200]}"
                )
                _log.warning(
                    "crm.sync.push_failed", table=entity.table,
                    record_id=str(row.id), error=str(exc)[:200],
                )
                continue

            if result.get("pending"):
                # BO-1b's lesson: a QUEUED write has not happened. Clearing the
                # flag here would show a row as synced that exists in no tenant.
                report.pushed.queued += 1
                continue

            updates: dict[str, Any] = {"zoho_dirty": False, "zoho_synced_at": now()}
            if op == "create":
                acquired = result.get("zoho_id")
                if not acquired:
                    report.pushed.errors.append(
                        f"{entity.table}/{row.id}: Zoho returned no id on create"
                    )
                    continue
                updates["zoho_id"] = str(acquired)
                report.pushed.created += 1
            else:
                report.pushed.updated += 1
            await update_row(db, entity.table, str(row.id), updates, touch=False)


async def push_activities(db: Any, report: SyncCycleReport) -> None:
    """Native notes and follow-up tasks become Zoho Notes and Tasks (§7.1).

    The push signal is a NULL ``zoho_id``, not a dirty column: an activity is a
    log entry, so "has it been pushed" and "has it changed" are the same
    question, and stamping the id on success is what makes this idempotent.

    ``status_change`` and ``system`` rows are excluded **in the predicate** —
    they have no Zoho analog and pushing them would double Zoho's own stage
    history.
    """
    rows = (await db.execute(
        text(
            "SELECT * FROM crm_activities "
            "WHERE zoho_id IS NULL AND type IN ('note', 'task') "
            "ORDER BY created_at LIMIT :limit"
        ),
        {"limit": PUSH_BATCH_LIMIT},
    )).fetchall()
    module_of = {value: key for key, value in ACTIVITY_MODULES.items()}
    for row in rows:
        column = next(
            (c for c in _PARENT_TABLES if getattr(row, c, None)), None,
        )
        if column is None:
            continue
        parent_zoho_id = await _linked_zoho_id(
            db, _PARENT_TABLES[column], getattr(row, column),
        )
        if not parent_zoho_id:
            # The parent has not reached Zoho yet. Skipped, not failed: the
            # next cycle finds it once the record push has given it an id.
            continue
        module = module_of[row.type]
        body = _activity_payload(row, module, parent_zoho_id, column)
        try:
            result = await push_one(
                module=module, op="create", record_id=None, body=body,
                target=f"{module}:new",
            )
        except Exception as exc:
            report.pushed.errors.append(f"crm_activities/{row.id}: {str(exc)[:200]}")
            continue
        if result.get("pending"):
            report.pushed.queued += 1
            continue
        acquired = result.get("zoho_id")
        if not acquired:
            continue
        await update_row(
            db, "crm_activities", str(row.id),
            {"zoho_id": str(acquired)}, touch=False,
        )
        report.pushed.activities += 1


def _activity_payload(
    row: Any, module: str, parent_zoho_id: str, column: str,
) -> dict[str, Any]:
    if module == "Notes":
        return _pruned({
            "Note_Title": getattr(row, "subject", None),
            "Note_Content": getattr(row, "body", None) or "",
            "Parent_Id": parent_zoho_id,
            "se_module": _PARENT_MODULES.get(column) or None,
        })
    due = getattr(row, "due_at", None)
    return _pruned({
        "Subject": getattr(row, "subject", None) or "Follow up",
        "Description": getattr(row, "body", None),
        "Due_Date": due.date().isoformat() if hasattr(due, "date") else due,
        "Status": "Completed" if getattr(row, "completed_at", None) else "Not Started",
        # Zoho splits a task's parent: Who_Id for a person, What_Id otherwise.
        ("Who_Id" if column == "contact_id" else "What_Id"): parent_zoho_id,
    })


async def push_tombstones(db: Any, report: SyncCycleReport) -> None:
    """Native deletions, propagated as Zoho deletes (§7.1).

    ``pushed_at`` is stamped only after the delete is accepted, so a failure is
    simply retried next cycle rather than lost. The tombstone row itself is
    kept: it is the record that the deletion left this app.
    """
    rows = (await db.execute(
        text(
            "SELECT * FROM crm_zoho_tombstones WHERE pushed_at IS NULL "
            "ORDER BY deleted_at LIMIT :limit"
        ),
        {"limit": PUSH_BATCH_LIMIT},
    )).fetchall()
    for row in rows:
        try:
            result = await push_one(
                module=row.module, op="delete", record_id=row.zoho_id, body=None,
                target=f"{row.module}:{row.zoho_id}",
            )
        except Exception as exc:
            report.pushed.errors.append(f"tombstone/{row.id}: {str(exc)[:200]}")
            continue
        if result.get("pending"):
            report.pushed.queued += 1
            continue
        await db.execute(
            text(
                "UPDATE crm_zoho_tombstones SET pushed_at = :pushed_at "
                "WHERE id = CAST(:id AS uuid)"
            ),
            {"pushed_at": now(), "id": str(row.id)},
        )
        report.pushed.deleted += 1


# ── One cycle ───────────────────────────────────────────────────────────────

async def run_cycle(*, actor_email: str = "crm:zoho-sync") -> SyncCycleReport:
    """Pull, apply Zoho's deletes, push. The whole engine, in one call."""
    report = SyncCycleReport(started_at=now().isoformat())
    zoho = _client()
    try:
        owners = owner_index(await zoho.list_users())
    except Exception as exc:
        # Not fatal: an unresolved owner falls back to the sync identity, which
        # is exactly what the importer already does for an unmatched user.
        owners = {}
        report.errors.append(f"owner mapping unavailable: {str(exc)[:200]}")

    db = await _get_db()
    try:
        await pull_phase(db, zoho, owners, actor_email, report)
        await apply_zoho_deletes(db, zoho, report)
        await push_records(db, report)
        await push_activities(db, report)
        await push_tombstones(db, report)
        await db.commit()
    finally:
        await db.close()

    report.finished_at = now().isoformat()
    _log.info(
        "crm.sync.cycle",
        pulled={m: r.fetched for m, r in report.pulled.items()},
        zoho_deletes=report.zoho_deletes.applied,
        pushed=report.pushed.model_dump(),
        conflicts=report.conflicts,
        conflicts_zoho_won=report.conflicts_zoho_won,
        conflicts_native_won=report.conflicts_native_won,
        errors=len(report.errors) + len(report.pushed.errors),
    )
    return report


# ── The scheduled loop (the gateway's own pattern, NOT ingestion's) ─────────
#
# `routes/workflows/scheduler.py` / `routes/tasks/scheduler.py` are the model:
# one supervised asyncio task owned by the gateway lifespan. It cannot live in
# `ingestion/scheduler.py` — ingestion's pyproject cannot depend on the
# gateway, so a `routes/crm` engine cannot be driven from there.

_sync_task: asyncio.Task | None = None


async def _sync_loop() -> None:
    interval = max(SYNC_INTERVAL_SECS, MIN_INTERVAL_SECS)
    while True:
        try:
            await run_cycle()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # never let one bad cycle kill the loop
            _log.warning("crm.sync.cycle_failed", error=str(exc)[:200])
        await asyncio.sleep(interval)


async def start_crm_zoho_sync() -> bool:
    """Start the loop **only when ``CRM_ZOHO_SYNC`` is on**. Returns started?

    Called from the gateway lifespan. With the flag off — the default and the
    state of every environment — this registers nothing at all, which is the
    OFF-state property WS-26b done-when 4 asserts.
    """
    global _sync_task
    if not sync_enabled():
        _log.info("crm.sync.disabled")
        return False
    if _sync_task is not None and not _sync_task.done():
        return True
    _sync_task = asyncio.get_running_loop().create_task(
        _sync_loop(), name="crm-zoho-sync",
    )
    _log.info("crm.sync.started", interval_secs=SYNC_INTERVAL_SECS)
    return True


async def stop_crm_zoho_sync() -> None:
    """Cancel the loop. Called unconditionally on shutdown — a flag-gated loop
    that may never have started is still stopped, the same contract the other
    six supervised loops keep."""
    global _sync_task
    task, _sync_task = _sync_task, None
    if task is not None and not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


def sync_status() -> dict[str, Any]:
    """Live loop state, for health and debug."""
    return {
        "enabled": sync_enabled(),
        "running": _sync_task is not None and not _sync_task.done(),
        "interval_secs": SYNC_INTERVAL_SECS,
    }


# ── The manual endpoint ─────────────────────────────────────────────────────

@router.post(
    "/sync/zoho",
    response_model=SyncCycleReport,
    dependencies=[require_permission("admin:access:manage")],
)
async def run_sync_cycle_now(
    user: UserContext = Depends(get_current_user),
) -> SyncCycleReport:
    """Run ONE sync cycle now — **with or without ``CRM_ZOHO_SYNC``**.

    §7.1: a hand-run cycle is an explicit admin act, so it does not need the
    scheduling flag; the flag only decides whether the platform does this
    unattended. Same ``admin:access:manage`` floor as the backfill, and the
    same warning: against the production tenant this WRITES live Zoho and is
    an OWNER-GATE act (``work_plan.md`` §6).
    """
    from gateway.routes.crm.core import actor

    return await run_cycle(actor_email=actor(user))


__all__ = [
    "PUSHABLE_ACTIVITY_TYPES",
    "PUSH_BATCH_LIMIT",
    "SYNC_INTERVAL_SECS",
    "PushReport",
    "SyncCycleReport",
    "build_payload",
    "execute_push",
    "push_one",
    "read_cursor",
    "resolve_conflicts",
    "run_cycle",
    "start_crm_zoho_sync",
    "stop_crm_zoho_sync",
    "sync_enabled",
    "sync_status",
    "write_cursor",
]
