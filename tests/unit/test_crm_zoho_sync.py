"""CRM · the two-way Zoho sync engine — the seven rules §7.1 makes binding.

Spec: ``ai-company-brain/specs/crm_app.md`` §7.1 · D-CRM-6/7/8 · ticket WS-26b
done-when 3, 4 and 5.

Hermetic: no Postgres, no network, no Zoho, no credential. The engine's two
seams — ``_client()`` (read) and ``_writer()`` (write) — are bound to fakes,
``core._get_db`` to ``_crm_fakes.FakeCrmDB``, and the Action Broker's audit
sink to a list. The **real** broker gate runs: disposition policy, auto-apply
default and the queued-write marker are all the shipped code, because the whole
point of D-CRM-8 is that pushes cannot reach Zoho another way.

The fake writer writes back into the fake tenant, which is what makes the
two-cycle echo-suppression test real: cycle 1 pushes a native row up, cycle 2
pulls that same record back, and the assertion is that it does **not** come
back dirty.
"""

from __future__ import annotations

import itertools
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from gateway.routes.crm import activities as crm_activities
from gateway.routes.crm import admin as crm_admin
from gateway.routes.crm import broker_handlers as crm_broker
from gateway.routes.crm import core as crm_core
from gateway.routes.crm import import_zoho as crm_import
from gateway.routes.crm import records as crm_records
from gateway.routes.crm import sync_zoho as crm_sync
from gateway.routes.crm.core import CONTACTS, DEALS, LEADS, ORGANIZATIONS

from tests.unit._crm_fakes import FakeCrmDB, bind_db, crm_user
from tests.unit.test_crm_zoho_import import FakeZoho, permission_checks

USER = crm_user()
REPO = Path(__file__).resolve().parents[2]

CRM_MODULES = (
    crm_core, crm_records, crm_activities, crm_admin, crm_import, crm_sync,
)


# ── Fakes ───────────────────────────────────────────────────────────────────

class FakeWriter:
    """The four functions ``sync_zoho.execute_push`` calls on the real writer.

    Writes land back in the fake TENANT, so the next pull sees what the last
    push did — the only way a two-cycle convergence test proves anything.
    """

    def __init__(self, tenant: FakeZoho) -> None:
        self.tenant = tenant
        self.creates: list[tuple[str, dict]] = []
        self.updates: list[tuple[str, str, dict]] = []
        self.deletes: list[tuple[str, str]] = []
        self._ids = itertools.count(1)

    @property
    def pushes(self) -> int:
        return len(self.creates) + len(self.updates) + len(self.deletes)

    async def create_record(self, module: str, payload: dict) -> dict:
        zoho_id = f"z-pushed-{next(self._ids)}"
        self.creates.append((module, payload))
        self.tenant.data.setdefault(module, []).append({
            "id": zoho_id, "Modified_Time": "2026-08-05T12:00:00+05:30", **payload,
        })
        return {"status": "success", "details": {"id": zoho_id}}

    async def update_record(self, module: str, record_id: str, payload: dict) -> dict:
        self.updates.append((module, record_id, payload))
        for row in self.tenant.data.get(module, []):
            if row.get("id") == record_id:
                row.update(payload)
        return {"status": "success", "details": {"id": record_id}}

    async def delete_record(self, module: str, record_id: str) -> dict:
        self.deletes.append((module, record_id))
        self.tenant.data[module] = [
            r for r in self.tenant.data.get(module, []) if r.get("id") != record_id
        ]
        return {"status": "success", "details": {"id": record_id}}

    @staticmethod
    def record_id_of(result: dict) -> str | None:
        found = (result.get("details") or {}).get("id")
        return str(found) if found else None


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> FakeCrmDB:
    fake = FakeCrmDB()
    bind_db(monkeypatch, fake, CRM_MODULES)
    return fake


@pytest.fixture
def zoho(monkeypatch: pytest.MonkeyPatch) -> FakeZoho:
    tenant = FakeZoho()
    monkeypatch.setattr(crm_import, "_client", lambda: tenant)
    monkeypatch.setattr(crm_sync, "_client", lambda: tenant)
    return tenant


@pytest.fixture
def writer(monkeypatch: pytest.MonkeyPatch, zoho: FakeZoho) -> FakeWriter:
    fake = FakeWriter(zoho)
    monkeypatch.setattr(crm_sync, "_writer", lambda: fake)
    return fake


@pytest.fixture
def audit(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """The broker's audit sink, collected instead of written.

    The GATE itself is the real one — only the ``acb_audit`` persistence is
    replaced, so the disposition policy under test is the shipped policy.
    """
    from action_broker import broker as broker_module

    events: list[Any] = []
    monkeypatch.setattr(broker_module, "record", events.append)
    monkeypatch.delenv("ACTION_BROKER_ENFORCE", raising=False)
    return events


def _stored(db: FakeCrmDB, table: str, record_id: Any) -> dict:
    """One seeded row read back by id.

    The fake models no ``ON CONFLICT``, so an upsert APPENDS rather than
    rewriting; reading by id keeps every assertion pointed at the row the test
    seeded rather than at whichever copy happens to sort first.
    """
    return next(r for r in db.rows(table) if r["id"] == record_id)


def _seed_pipeline(db: FakeCrmDB) -> tuple:
    lead_status = db.seed(
        "crm_lead_statuses", name="New", position=10, type="open", is_default=True,
    )
    deal_status = db.seed(
        "crm_deal_statuses", name="Qualification", position=10, type="open",
        is_default=True, probability=10,
    )
    return lead_status, deal_status


# ── Rule 1 — the single writer, and the broker gate in front of it ──────────

def test_the_zoho_writer_has_exactly_one_caller_in_the_whole_repo() -> None:
    """§7.1's single-writer rule, measured rather than asserted in prose.

    The writer is the only Zoho write surface; ``routes/crm/sync_zoho.py`` is
    its only importer. A second importer is how "no route handler, agent tool
    or skill reaches Zoho directly" quietly stops being true.
    """
    needles = ("sources.zoho import writer", "sources.zoho.writer")
    hits: list[str] = []
    for scope in ("apps", "packages", "scripts", "skills"):
        for path in (REPO / scope).rglob("*.py"):
            if path.name == "writer.py" and path.parent.name == "zoho":
                continue  # the module itself
            text = path.read_text(encoding="utf-8", errors="ignore")
            if any(needle in text for needle in needles):
                hits.append(path.name)
    assert sorted(hits) == ["sync_zoho.py"], hits


def test_the_engine_reaches_zoho_only_through_execute_push() -> None:
    """Structural: inside the engine, ``_writer()`` has exactly one caller too.

    Otherwise the single-import property above would be satisfied while three
    functions in this module each did their own un-gated write.
    """
    import inspect

    named = [
        name for name, value in vars(crm_sync).items()
        if inspect.isfunction(value)
        and value.__module__ == crm_sync.__name__
        and "_writer()" in inspect.getsource(value)
    ]
    # `_writer` matches its own `def` line; `execute_push` is the one call.
    assert sorted(named) == ["_writer", "execute_push"], named


def test_the_write_surface_is_three_verbs_and_every_one_has_a_caller() -> None:
    """The whole point of a single write client is that it stays countable.

    Three verbs, and each is reachable from ``execute_push``. An exported
    convenience wrapper with no caller (``upsert_record`` was one) is a fourth
    entry on the surface that the single-caller grep still passes over — and
    "upsert by id" is a DECISION, made in ``push_records`` where the acquired
    id is stamped back onto the native row, not a verb.
    """
    import inspect

    from ingestion.sources.zoho import writer as zoho_writer

    verbs = {"create_record", "update_record", "delete_record"}
    exported = {
        name for name in zoho_writer.__all__
        if inspect.iscoroutinefunction(getattr(zoho_writer, name, None))
    }
    assert exported == verbs, exported
    assert not hasattr(zoho_writer, "upsert_record")

    body = inspect.getsource(crm_sync.execute_push)
    for verb in verbs:
        assert f"writer.{verb}(" in body, verb


async def test_every_push_goes_through_the_broker_gate(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """D-CRM-8 — one audited chokepoint, one audit row per push."""
    db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_dirty=True)
    await crm_sync.run_cycle()

    assert writer.creates, "nothing was pushed"
    actions = [e.action for e in audit]
    assert "propose:crm.zoho_create" in actions
    assert "execute:crm.zoho_create" not in actions  # auto-apply, not queued


def test_all_three_gated_actions_have_a_registered_handler() -> None:
    """BO-1a's lesson, applied ahead of time: the ClickUp gate routes SIX
    action names and registers FOUR, so approving one of the other two is
    marked ``failed``. Every CRM action gated here is executable on approval."""
    from action_broker import broker as broker_module

    crm_broker.register_crm_broker_handlers()
    for action in crm_broker.CRM_ZOHO_ACTIONS:
        assert action in broker_module._HANDLERS, action
    assert set(crm_broker.CRM_ZOHO_ACTIONS) == {
        "crm.zoho_create", "crm.zoho_update", "crm.zoho_delete",
    }


async def test_an_approved_queued_push_really_executes(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """The registered handler re-enters through ``execute_push``, so an
    approval months later needs nothing that was only in memory."""
    from types import SimpleNamespace

    proposal = SimpleNamespace(
        action="crm.zoho_update",
        payload={"args": {
            "module": "Accounts", "op": "update", "record_id": "z-acc-1",
            "body": {"Account_Name": "Renamed"},
        }},
    )
    result = await crm_broker._handle_crm_zoho_write(proposal)

    assert result["ok"] is True
    assert writer.updates == [("Accounts", "z-acc-1", {"Account_Name": "Renamed"})]


async def test_broker_enforcement_queues_the_push_and_keeps_the_row_dirty(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D-CRM-8's accepted consequence: enforcement ON makes the sync
    SUPERVISED. And BO-1b's bug must not be reproduced — a queued write has
    NOT happened, so clearing ``zoho_dirty`` would show a row as synced that
    exists in no tenant, losing the edit permanently."""
    import action_broker

    monkeypatch.setenv("ACTION_BROKER_ENFORCE", "1")
    # Patched on the PACKAGE, which is the name `broker_gate` imports — the
    # real one persists a `pending_actions` row and this suite touches no DB.
    monkeypatch.setattr(action_broker, "enqueue", lambda proposal: "queued-1")
    row = db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_dirty=True)

    report = await crm_sync.run_cycle()

    assert writer.pushes == 0
    assert report.pushed.queued == 1
    assert report.pushed.created == 0
    stored = _stored(db, ORGANIZATIONS.table, row.id)
    assert stored["zoho_dirty"] is True
    assert stored.get("zoho_id") is None


# ── Rule 3 — dirty-driven push; a create acquires an id ─────────────────────

async def test_a_native_create_acquires_a_zoho_id(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    row = db.seed(
        ORGANIZATIONS.table, name="Fracktal Works", website="https://fracktal.in",
        zoho_dirty=True,
    )
    report = await crm_sync.run_cycle()

    [(module, payload)] = writer.creates
    assert module == "Accounts"
    assert payload["Account_Name"] == "Fracktal Works"
    assert report.pushed.created == 1

    stored = _stored(db, ORGANIZATIONS.table, row.id)
    assert stored["zoho_id"] == "z-pushed-1"
    assert stored["zoho_dirty"] is False
    assert stored["zoho_synced_at"] is not None


async def test_a_dirty_linked_row_is_updated_not_recreated(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    db.seed(
        ORGANIZATIONS.table, name="Renamed", zoho_id="z-acc-1", zoho_dirty=True,
    )
    report = await crm_sync.run_cycle()

    assert writer.creates == []
    [(module, record_id, payload)] = writer.updates
    assert (module, record_id) == ("Accounts", "z-acc-1")
    assert payload["Account_Name"] == "Renamed"
    assert report.pushed.updated == 1


async def test_a_clean_row_is_never_pushed(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_id="z-acc-1")
    await crm_sync.run_cycle()
    assert writer.pushes == 0


async def test_a_deal_push_carries_its_stage_name_not_its_status_uuid(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """Zoho's Stage is a picklist LABEL. Sending our UUID would be rejected —
    or worse, silently stored as a new picklist value."""
    _, deal_status = _seed_pipeline(db)
    org = db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_id="z-acc-1")
    db.seed(
        DEALS.table, name="10 printers", amount=450000,
        status_id=deal_status.id, organization_id=org.id, zoho_dirty=True,
    )
    await crm_sync.run_cycle()

    [(module, payload)] = [c for c in writer.creates if c[0] == "Deals"]
    assert module == "Deals"
    assert payload["Stage"] == "Qualification"
    assert payload["Amount"] == 450000
    # The org link travels as Zoho's own id, not ours.
    assert payload["Account_Name"] == {"id": "z-acc-1"}


async def test_a_push_never_sends_null_for_a_field_we_do_not_have(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """Sending ``None`` at Zoho CLEARS the field, so a column we simply do not
    carry would blank the tenant's copy on every cycle."""
    db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_dirty=True)
    await crm_sync.run_cycle()

    [(_, payload)] = writer.creates
    assert None not in payload.values()
    assert "Website" not in payload


async def test_a_failed_push_leaves_the_row_dirty_and_is_counted(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """A push that failed and cleared the flag is a change silently dropped."""
    async def _explode(module: str, payload: dict) -> dict:
        raise RuntimeError("Zoho said no")

    writer.create_record = _explode  # type: ignore[method-assign]
    row = db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_dirty=True)

    report = await crm_sync.run_cycle()

    assert report.pushed.created == 0
    assert len(report.pushed.errors) == 1
    stored = _stored(db, ORGANIZATIONS.table, row.id)
    assert stored["zoho_dirty"] is True


# ── Rule 2 — incremental pull, persisted cursors ────────────────────────────

async def test_the_first_pull_has_no_cursor_and_the_second_one_does(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """§7.1 — "pull cursors are schema too": without a PERSISTED cursor an
    incremental pull re-reads the world after every restart."""
    zoho.data["Accounts"] = [{
        "id": "z-acc-1", "Account_Name": "Fracktal",
        "Modified_Time": "2026-08-01T09:00:00+05:30",
    }]

    await crm_sync.run_cycle()
    first = [since for module, since in zoho.reads if module == "Accounts"]
    assert first == [None]

    zoho.reads.clear()
    await crm_sync.run_cycle()
    second = [since for module, since in zoho.reads if module == "Accounts"]
    assert second and second[0] is not None
    assert second[0].isoformat().startswith("2026-08-01T09:00")


async def test_the_cursor_upsert_is_keyed_on_the_module(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """A second cursor row for one module is not a second opinion — it would
    let the pull silently rewind. Pinned against the statement text because
    the fake models no ``ON CONFLICT``."""
    await crm_sync.run_cycle()

    inserts = db.statements_touching("INSERT INTO crm_sync_cursors")
    assert inserts
    assert "ON CONFLICT (module) DO UPDATE SET" in inserts[0]


async def test_the_deleted_records_read_uses_the_PRE_cycle_cursor(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """The cursor snapshot, and the reason it exists.

    ``pull_phase`` WRITES cursors as it goes. A deleted-records read that
    fetched the cursor afterwards would receive the watermark this very cycle
    just wrote, so Zoho would answer "nothing deleted since then" for every
    deletion older than this cycle's newest change — and those deletions are
    **permanently** missed, because the cursor only ever moves forward and no
    later cycle asks about that window again.
    """
    db.seed(
        "crm_sync_cursors", module="Accounts",
        last_pulled_at=_instant("2026-08-01T00:00:00+00:00"),
    )
    zoho.data["Accounts"] = [{
        "id": "z-acc-1", "Account_Name": "Fracktal",
        "Modified_Time": "2026-08-04T00:00:00+00:00",
    }]

    await crm_sync.run_cycle()

    [(_, deleted_since)] = [
        (m, since) for m, since in zoho.reads if m == "Accounts/deleted"
    ]
    assert deleted_since == _instant("2026-08-01T00:00:00+00:00")

    # And the pull really did move the cursor past it in the same cycle —
    # without which this test could pass against a version that never advances.
    [written] = [
        p for s, p in db.calls
        if s.startswith("INSERT INTO crm_sync_cursors") and p["module"] == "Accounts"
    ]
    assert written["last_pulled_at"] == _instant("2026-08-04T00:00:00+00:00")
    assert deleted_since < written["last_pulled_at"]


async def test_every_module_reads_its_delete_cursor_from_one_snapshot(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """One `SELECT * FROM crm_sync_cursors` per cycle, not one per module per
    phase: a per-phase read is exactly how the stale-watermark bug returns."""
    await crm_sync.run_cycle()
    reads = [s for s in db.statements if s == "SELECT * FROM crm_sync_cursors"]
    assert len(reads) == 1, db.statements_touching("crm_sync_cursors")


# ── The watermark never advances past a record that failed ─────────────────

@pytest.mark.parametrize(
    ("previous", "newest_applied", "fetched", "expected"),
    [
        # Nothing fetched → adopt the cycle start, or a module Zoho never
        # changes re-reads its whole table every ten minutes forever.
        (None, None, 0, "fallback"),
        # Fetched but nothing landed → stand still, so the next cycle retries.
        ("t1", None, 3, "t1"),
        (None, None, 3, None),
        # Normal: the newest record that actually landed.
        ("t1", "t2", 3, "t2"),
        # Never backwards — a rewound cursor re-reads a reconciled window.
        ("t2", "t1", 3, "t2"),
    ],
)
def test_advance_cursor_is_forward_only_and_never_past_a_failure(
    previous: Any, newest_applied: Any, fetched: int, expected: Any,
) -> None:
    stamps = {
        "t1": _instant("2026-08-01T00:00:00+00:00"),
        "t2": _instant("2026-08-02T00:00:00+00:00"),
        "fallback": _instant("2026-08-09T00:00:00+00:00"),
        None: None,
    }
    result = crm_sync.advance_cursor(
        stamps[previous], stamps[newest_applied],
        fetched=fetched, fallback=stamps["fallback"],
    )
    assert result == stamps[expected]


async def test_the_cursor_stops_short_of_a_record_that_failed_to_apply(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed record is counted and the batch continues (an import that
    aborts on row 900 of 3 000 is one nobody can finish) — but if the cursor
    advanced past it anyway, the next incremental pull would never ask for it
    again and the record would be dropped for good."""
    real = crm_import.map_account

    def _explode(record: dict) -> dict:
        if record.get("id") == "z-acc-bad":
            raise ValueError("bad account")
        return real(record)

    monkeypatch.setitem(crm_import.MAPPERS, "Accounts", _explode)
    zoho.data["Accounts"] = [
        {"id": "z-acc-ok", "Account_Name": "Good",
         "Modified_Time": "2026-08-01T00:00:00+00:00"},
        {"id": "z-acc-bad", "Account_Name": "Bad",
         "Modified_Time": "2026-08-05T00:00:00+00:00"},
    ]

    report = await crm_sync.run_cycle()

    [written] = [
        p for s, p in db.calls
        if s.startswith("INSERT INTO crm_sync_cursors") and p["module"] == "Accounts"
    ]
    assert written["last_pulled_at"] == _instant("2026-08-01T00:00:00+00:00")
    assert written["last_status"] == "partial"
    assert report.pulled["Accounts"].created == 1


async def test_a_failed_record_is_counted_in_the_cycle_summary(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The per-record errors live inside each ModuleReport; the cycle summary
    is what a human reads. A cycle that dropped rows while reporting zero
    errors is the report that hides the outage."""
    def _explode(record: dict) -> dict:
        raise ValueError("bad account")

    monkeypatch.setitem(crm_import.MAPPERS, "Accounts", _explode)
    zoho.data["Accounts"] = [{"id": "z-acc-1", "Account_Name": "Bad"}]

    report = await crm_sync.run_cycle()

    assert len(report.pulled["Accounts"].errors) == 1
    assert report.pull_record_errors == 1


async def test_a_module_whose_pull_fails_is_reported_and_does_not_stop_the_rest(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _explode(*, modified_since: Any = None) -> list[dict]:
        raise RuntimeError("Zoho 500")

    monkeypatch.setattr(zoho, "list_accounts", _explode, raising=False)
    zoho.data["Contacts"] = [{"id": "z-con-1", "First_Name": "Asha"}]

    report = await crm_sync.run_cycle()

    assert any("Accounts pull failed" in e for e in report.errors)
    assert report.pulled["Contacts"].created == 1


# ── Rule 5 — last-writer-wins, both directions, counted ────────────────────

def _instant(text: str) -> Any:
    from datetime import datetime

    return datetime.fromisoformat(text)


async def test_a_conflict_where_zoho_is_newer_applies_the_pull(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """D-CRM-6's surviving half: record-level LWW, never a field merge."""
    db.seed(
        ORGANIZATIONS.table, name="Native name", zoho_id="z-acc-1",
        zoho_dirty=True,
        zoho_synced_at=_instant("2026-08-01T09:00:00+00:00"),
        updated_at=_instant("2026-08-02T09:00:00+00:00"),
    )
    zoho.data["Accounts"] = [{
        "id": "z-acc-1", "Account_Name": "Zoho name",
        "Modified_Time": "2026-08-03T09:00:00+00:00",
    }]

    report = await crm_sync.run_cycle()

    assert report.conflicts == 1
    assert report.conflicts_zoho_won == 1
    assert report.conflicts_native_won == 0

    # The pull WAS applied, and the write it applied discards the native edit
    # by carrying zoho_dirty=false into the row.
    #
    # ⚠️ Asserted against the upsert's bound VALUES rather than against the
    # row afterwards, because the fake models no `ON CONFLICT`: in Postgres
    # the conflict arm rewrites the existing row (clearing the flag, so the
    # push phase finds nothing), while the fake appends a second row and
    # leaves the first one dirty. Reading the row back here would be
    # measuring the mirror's gap, not the engine.
    [(statement, params)] = [
        (s, p) for s, p in db.calls
        if s.startswith("INSERT INTO crm_organizations (")
    ]
    assert params["name"] == "Zoho name"
    assert params["zoho_dirty"] is False
    assert "zoho_dirty = EXCLUDED.zoho_dirty" in statement


async def test_a_conflict_where_the_native_edit_is_newer_keeps_it_and_pushes(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    row = db.seed(
        ORGANIZATIONS.table, name="Native name", zoho_id="z-acc-1",
        zoho_dirty=True,
        zoho_synced_at=_instant("2026-08-01T09:00:00+00:00"),
        updated_at=_instant("2026-08-04T09:00:00+00:00"),
    )
    zoho.data["Accounts"] = [{
        "id": "z-acc-1", "Account_Name": "Zoho name",
        "Modified_Time": "2026-08-03T09:00:00+00:00",
    }]

    report = await crm_sync.run_cycle()

    assert report.conflicts == 1
    assert report.conflicts_native_won == 1
    # The pull was skipped, the row stayed dirty, and the push overwrote Zoho.
    [(module, record_id, payload)] = writer.updates
    assert (module, record_id) == ("Accounts", "z-acc-1")
    assert payload["Account_Name"] == "Native name"
    stored = _stored(db, ORGANIZATIONS.table, row.id)
    assert stored["zoho_dirty"] is False


async def test_a_dirty_row_zoho_has_not_touched_is_not_a_conflict(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """Only one side moved. Counting it as a conflict would make the number
    meaningless — and applying the pull would clobber the pending edit with
    the value we are about to overwrite anyway."""
    db.seed(
        ORGANIZATIONS.table, name="Native name", zoho_id="z-acc-1",
        zoho_dirty=True,
        zoho_synced_at=_instant("2026-08-03T09:00:00+00:00"),
        updated_at=_instant("2026-08-04T09:00:00+00:00"),
    )
    zoho.data["Accounts"] = [{
        "id": "z-acc-1", "Account_Name": "Zoho name",
        "Modified_Time": "2026-08-01T09:00:00+00:00",
    }]

    report = await crm_sync.run_cycle()

    assert report.conflicts == 0
    assert report.pull_skipped_native_newer == 1
    assert len(writer.updates) == 1


def test_an_uncomparable_timestamp_never_lets_zoho_win_silently() -> None:
    """A naive/aware mismatch or a missing stamp means we cannot honestly say
    Zoho is newer. The conservative answer keeps the native edit, which is
    recoverable; the other direction discards a colleague's typing."""
    from datetime import UTC, datetime

    aware = datetime(2026, 8, 3, tzinfo=UTC)
    naive = datetime(2026, 8, 1)
    assert crm_sync._later(aware, naive) is False
    assert crm_sync._later(None, aware) is False
    assert crm_sync._later(aware, None) is False


# ── Rule 6 — echo suppression ──────────────────────────────────────────────

async def test_a_pull_applied_write_never_marks_the_row_dirty(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    zoho.data["Accounts"] = [{
        "id": "z-acc-1", "Account_Name": "Fracktal",
        "Modified_Time": "2026-08-01T09:00:00+05:30",
    }]
    await crm_sync.run_cycle()

    [row] = db.rows(ORGANIZATIONS.table)
    assert row["zoho_dirty"] is False
    assert writer.pushes == 0


async def test_two_cycles_converge_to_zero_pushes(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """done-when 3's named test. Cycle 1 pushes a native row up; the fake
    writer puts it in the tenant, so cycle 2 pulls that very record back. If
    the pull re-dirtied it the two sides would ping-pong forever, each cycle
    pushing the row it just received."""
    db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_dirty=True)

    first = await crm_sync.run_cycle()
    assert first.pushed.created == 1
    assert zoho.data["Accounts"], "the push never reached the fake tenant"

    before = writer.pushes
    second = await crm_sync.run_cycle()

    assert writer.pushes == before, "cycle 2 pushed again — the echo is not suppressed"
    assert second.pushed.created == 0
    assert second.pushed.updated == 0
    assert second.pulled["Accounts"].fetched == 1


async def test_a_pull_never_rewrites_the_source_provenance(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """A row typed into this app is `source='manual'` FOREVER — including
    after the sync pushes it to Zoho and pulls it straight back.

    Without `source` on the insert-only list, the conflict arm rewrote it to
    `'import'` on the first echo: a silent, one-way rewrite of the column the
    `?source=` filter and every "where did this come from" question read.
    Statement-text, because the fake models no conflict arm at all.
    """
    db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_id="z-acc-1", source="manual")
    zoho.data["Accounts"] = [{
        "id": "z-acc-1", "Account_Name": "Fracktal",
        "Modified_Time": "2026-08-04T00:00:00+00:00",
    }]

    await crm_sync.run_cycle()

    [statement] = db.statements_touching("INSERT INTO crm_organizations (")
    arm = statement.split("DO UPDATE SET", 1)[1]
    assert "source = EXCLUDED.source" not in arm
    assert "zoho_id = EXCLUDED.zoho_id" not in arm
    # …while the ordinary columns still are rewritten, or this would pass by
    # the upsert having no conflict arm at all.
    assert "name = EXCLUDED.name" in arm
    # `source` is still SENT — it is what a genuinely new row is created with.
    assert "source" in statement.split("DO UPDATE SET", 1)[0]
    assert set(crm_core.INSERT_ONLY_COLUMNS) == {"zoho_id", "source"}


async def test_a_pull_does_not_write_our_own_padding_back_into_a_native_null(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """Zoho requires Last_Name; §3.2 does not. The push therefore pads it from
    the first name — and without a guard the next pull writes that padding
    into the native NULL, the sync mutating native data purely by echoing
    itself. Full round trip: cycle 1 pushes, cycle 2 pulls the same record."""
    row = db.seed(
        CONTACTS.table, first_name="Vijay", last_name=None, zoho_dirty=True,
    )

    await crm_sync.run_cycle()
    [(module, payload)] = writer.creates
    assert (module, payload["Last_Name"]) == ("Contacts", "Vijay")  # the padding

    db.calls.clear()
    await crm_sync.run_cycle()

    applied = [
        p for s, p in db.calls if s.startswith("INSERT INTO crm_contacts (")
    ]
    assert applied, "cycle 2 never pulled the record back"
    assert all("last_name" not in p for p in applied)
    assert _stored(db, CONTACTS.table, row.id)["last_name"] is None


def test_the_padding_guard_only_fires_on_a_native_null(
    db: FakeCrmDB,
) -> None:
    """Narrow and provable rather than clever: it drops a pulled value only
    when the native column is NULL *and* the value is exactly what we would
    have padded it from. A real Zoho edit to a populated column is untouched."""
    from types import SimpleNamespace

    from gateway.routes.crm.import_zoho import strip_padding_echo

    blank = SimpleNamespace(first_name="Vijay", last_name=None)
    assert "last_name" not in strip_padding_echo(
        CONTACTS, {"first_name": "Vijay", "last_name": "Vijay"}, blank,
    )
    # A different surname is a real value and survives.
    assert strip_padding_echo(
        CONTACTS, {"last_name": "Varada"}, blank,
    ) == {"last_name": "Varada"}
    # A populated native column is Zoho's to change.
    populated = SimpleNamespace(first_name="Vijay", last_name="Varada")
    assert strip_padding_echo(
        CONTACTS, {"last_name": "Vijay"}, populated,
    ) == {"last_name": "Vijay"}
    # A brand-new record has nothing to protect.
    assert strip_padding_echo(
        CONTACTS, {"last_name": "Vijay"}, None,
    ) == {"last_name": "Vijay"}
    # Leads pad TWO columns, both from lead_name.
    lead = SimpleNamespace(
        lead_name="Asha Rao", last_name=None, organization_name=None,
    )
    assert strip_padding_echo(
        LEADS,
        {"last_name": "Asha Rao", "organization_name": "Asha Rao", "email": "a@b.in"},
        lead,
    ) == {"email": "a@b.in"}


def test_the_padding_map_covers_every_field_the_push_pads() -> None:
    """The guard and the padder must stay in step; a pad added to
    `to_zoho_*` without an entry here silently resumes the echo."""
    from gateway.routes.crm.import_zoho import PADDED_FROM

    assert PADDED_FROM["contacts"] == (("last_name", "first_name"),)
    assert PADDED_FROM["leads"] == (
        ("last_name", "lead_name"), ("organization_name", "lead_name"),
    )
    # Organizations and deals pad nothing — their required fields are NOT NULL
    # on our side too, so there is nothing to invent.
    assert "organizations" not in PADDED_FROM
    assert "deals" not in PADDED_FROM


def test_the_dirty_flag_is_set_at_the_one_write_choke_point() -> None:
    """``core.update_row``'s ``touch`` already means "this is a real edit".
    Reusing it means the pull's ``touch=False`` and "do not push this back"
    are ONE switch that cannot disagree, and a route added tomorrow inherits
    both without remembering either."""
    tracked = "crm_organizations"
    assert crm_core.mark_dirty_on_update(
        tracked, {"name": "x"}, touch=True,
    ) == {"name": "x", "zoho_dirty": True}
    assert crm_core.mark_dirty_on_update(
        tracked, {"name": "x"}, touch=False,
    ) == {"name": "x"}
    # An explicit flag always wins — that is how the push clears it.
    assert crm_core.mark_dirty_on_update(
        tracked, {"zoho_dirty": False}, touch=True,
    ) == {"zoho_dirty": False}
    # Statuses, activities and the change log are not tracked.
    assert crm_core.mark_dirty_on_update(
        "crm_activities", {"subject": "x"}, touch=True,
    ) == {"subject": "x"}


def test_a_row_that_arrived_from_zoho_is_not_born_dirty() -> None:
    """The create half of echo suppression, keyed on the payload rather than
    on a flag the caller must remember to pass."""
    assert crm_core.mark_dirty_on_insert(
        "crm_leads", {"lead_name": "Asha"},
    )["zoho_dirty"] is True
    assert crm_core.mark_dirty_on_insert(
        "crm_leads", {"lead_name": "Asha", "zoho_id": "z-1"},
    )["zoho_dirty"] is False


# ── Rule 4 — tombstones, both directions ───────────────────────────────────

async def test_a_native_delete_writes_a_tombstone_inside_the_transaction(
    db: FakeCrmDB,
) -> None:
    """A tombstone cannot be a column on a row that no longer exists, and it
    cannot be written afterwards either: the ``zoho_id`` it needs disappears
    with the row."""
    db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_id="z-acc-1")
    org = db.rows(ORGANIZATIONS.table)[0]

    result = await crm_records.delete_record(ORGANIZATIONS, str(org["id"]), USER)

    assert result.zoho_delete_queued is True
    [tomb] = db.rows("crm_zoho_tombstones")
    assert tomb["module"] == "Accounts"
    assert tomb["zoho_id"] == "z-acc-1"
    assert tomb["entity_type"] == "organization"
    assert tomb["deleted_by"] == USER.email
    assert tomb["pushed_at"] is None

    # Written BEFORE the DELETE and inside the same transaction: one commit.
    inserts = [
        i for i, s in enumerate(db.statements)
        if s.startswith("INSERT INTO crm_zoho_tombstones")
    ]
    deletes = [
        i for i, s in enumerate(db.statements)
        if s.startswith("DELETE FROM crm_organizations")
    ]
    assert inserts[0] < deletes[0]
    assert db.committed == 1


async def test_the_tombstone_is_pushed_as_a_zoho_delete_and_then_stamped(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    db.seed(
        "crm_zoho_tombstones", module="Deals", zoho_id="z-deal-9",
        entity_type="deal", deleted_by="vjvarada@fracktal.in",
    )
    report = await crm_sync.run_cycle()

    assert writer.deletes == [("Deals", "z-deal-9")]
    assert report.pushed.deleted == 1
    [tomb] = db.rows("crm_zoho_tombstones")
    assert tomb["pushed_at"] is not None
    assert "propose:crm.zoho_delete" in [e.action for e in audit]


async def test_an_unpushed_tombstone_is_retried_and_never_lost(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    async def _explode(module: str, record_id: str) -> dict:
        raise RuntimeError("Zoho 502")

    writer.delete_record = _explode  # type: ignore[method-assign]
    db.seed(
        "crm_zoho_tombstones", module="Deals", zoho_id="z-deal-9",
        entity_type="deal", deleted_by="vjvarada@fracktal.in",
    )
    report = await crm_sync.run_cycle()

    assert report.pushed.deleted == 0
    assert len(report.pushed.errors) == 1
    [tomb] = db.rows("crm_zoho_tombstones")
    assert tomb["pushed_at"] is None


async def test_a_zoho_delete_removes_the_native_row_and_is_counted(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """§7.1 — Zoho deletes become native deletes, "loudly counted"."""
    db.seed(DEALS.table, name="Printer", zoho_id="z-deal-1")
    db.seed("crm_activities", type="note", deal_id=db.rows(DEALS.table)[0]["id"],
            created_by="a@b.in")
    zoho.deleted["Deals"] = [{"id": "z-deal-1", "deleted_time": "2026-08-04"}]

    report = await crm_sync.run_cycle()

    assert db.rows(DEALS.table) == []
    assert report.zoho_deletes.applied == {"Deals": 1}
    assert report.zoho_deletes.cascaded_activities == 1


async def test_applying_a_zoho_delete_writes_no_tombstone(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """The most destructive possible echo: pushing a deletion straight back at
    the tenant that just told us about it."""
    db.seed(DEALS.table, name="Printer", zoho_id="z-deal-1")
    zoho.deleted["Deals"] = [{"id": "z-deal-1"}]

    await crm_sync.run_cycle()

    assert db.rows("crm_zoho_tombstones") == []
    assert writer.deletes == []


async def test_a_zoho_delete_for_a_record_we_never_imported_is_a_no_op(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    zoho.deleted["Deals"] = [{"id": "z-unknown"}]
    report = await crm_sync.run_cycle()
    assert report.zoho_deletes.applied == {}


# ── Activities: notes and tasks push, platform history never does ──────────

async def test_a_native_note_pushes_as_a_zoho_note(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    org = db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_id="z-acc-1")
    db.seed(
        "crm_activities", type="note", subject="Called", body="Wants a quote",
        organization_id=org.id, created_by="vjvarada@fracktal.in", zoho_id=None,
    )
    report = await crm_sync.run_cycle()

    [(module, payload)] = [c for c in writer.creates if c[0] == "Notes"]
    assert module == "Notes"
    assert payload["Note_Title"] == "Called"
    assert payload["Parent_Id"] == "z-acc-1"
    assert payload["se_module"] == "Accounts"
    assert report.pushed.activities == 1
    [note] = db.rows("crm_activities")
    assert note["zoho_id"] == "z-pushed-1"


async def test_a_status_change_activity_is_never_pushed(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """§7.1 — no Zoho analog: Zoho keeps its own stage history, and a
    synthetic note per transition would double every funnel move. Excluded in
    the PREDICATE, so a new push path cannot reach them by another route."""
    org = db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_id="z-acc-1")
    db.seed("crm_activities", type="status_change", subject="New → Won",
            organization_id=org.id, created_by="platform", zoho_id=None)
    db.seed("crm_activities", type="system", subject="Imported",
            organization_id=org.id, created_by="platform", zoho_id=None)

    report = await crm_sync.run_cycle()

    assert writer.pushes == 0
    assert report.pushed.activities == 0
    [statement] = db.statements_touching("SELECT * FROM crm_activities WHERE")
    assert "type IN ('note', 'task')" in statement
    assert crm_sync.PUSHABLE_ACTIVITY_TYPES == ("note", "task")


async def test_an_activity_whose_parent_has_no_zoho_id_yet_waits(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """Skipped, not failed: the next cycle finds it once the record push has
    given the parent an id."""
    org = db.seed(ORGANIZATIONS.table, name="Fracktal")
    db.seed("crm_activities", type="note", subject="Called",
            organization_id=org.id, created_by="a@b.in", zoho_id=None)

    report = await crm_sync.run_cycle()

    assert [c for c in writer.creates if c[0] == "Notes"] == []
    assert report.pushed.activities == 0
    assert report.pushed.errors == []


# ── Rule 7 — the flag gates the LOOP only (done-when 4) ────────────────────

def test_the_sync_flag_ships_off() -> None:
    from acb_common import get_settings

    assert get_settings().crm_zoho_sync is False
    assert crm_sync.sync_enabled() is False


async def test_with_the_flag_off_no_loop_is_registered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """done-when 4's first half. Asserted on the function the gateway lifespan
    calls, so "the lifespan registers no loop" is measured rather than read
    off a comment."""
    monkeypatch.setattr(crm_sync, "sync_enabled", lambda: False)
    crm_sync._sync_task = None

    started = await crm_sync.start_crm_zoho_sync()

    assert started is False
    assert crm_sync._sync_task is None
    assert crm_sync.sync_status()["running"] is False


async def test_the_flag_on_starts_exactly_one_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(crm_sync, "sync_enabled", lambda: True)
    monkeypatch.setattr(crm_sync, "SYNC_INTERVAL_SECS", 3600)

    async def _never() -> Any:  # the loop must not actually reach Zoho here
        raise AssertionError("run_cycle should not have run yet")

    monkeypatch.setattr(crm_sync, "run_cycle", _never)
    crm_sync._sync_task = None
    try:
        assert await crm_sync.start_crm_zoho_sync() is True
        assert await crm_sync.start_crm_zoho_sync() is True  # idempotent
        task = crm_sync._sync_task
        assert task is not None
    finally:
        await crm_sync.stop_crm_zoho_sync()
    assert crm_sync._sync_task is None


def test_the_gateway_lifespan_starts_it_gated_and_stops_it_unconditionally(
) -> None:
    """The contract the other six supervised loops keep: a flag-gated loop
    that may never have started is still stopped, so the shutdown path never
    has to know why it is absent."""
    main = (
        REPO / "apps" / "services" / "gateway" / "gateway" / "main.py"
    ).read_text(encoding="utf-8")
    before, _, after = main.partition("\n    yield\n")

    assert "start_crm_zoho_sync" in before
    assert "stop_crm_zoho_sync" in after
    assert "start_crm_zoho_sync" not in after
    # The gate lives INSIDE start_crm_zoho_sync, never as an `if` in main.py:
    # two places that both have to agree about what the flag means is how a
    # loop ends up running with the flag off.
    assert "sync_enabled" not in main
    assert "settings.crm_zoho_sync" not in main
    assert "register_crm_broker_handlers" in main


async def test_a_native_write_marks_the_row_dirty_with_the_flag_off(
    db: FakeCrmDB, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """done-when 4's second half, and the half that FAILS against the tree
    this branch started from: with the flag off a native write still records
    that the row owes Zoho a push, and ``zoho_synced_at`` stays NULL because
    nothing has been pushed."""
    monkeypatch.setattr(crm_sync, "sync_enabled", lambda: False)
    _seed_pipeline(db)

    created = await crm_records.create_record(
        ORGANIZATIONS, crm_core.OrganizationIn(name="Fracktal"), USER,
    )
    [row] = db.rows(ORGANIZATIONS.table)

    assert row["zoho_dirty"] is True
    assert row["zoho_synced_at"] is None
    assert created["name"] == "Fracktal"


async def test_a_native_patch_marks_the_row_dirty(
    db: FakeCrmDB,
) -> None:
    row = db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_id="z-acc-1")
    await crm_records.patch_record(
        ORGANIZATIONS, str(row.id), crm_core.OrganizationIn(website="x"), USER,
    )
    stored = _stored(db, ORGANIZATIONS.table, row.id)
    assert stored["zoho_dirty"] is True


async def test_a_timeline_bump_alone_does_not_dirty_the_row(
    db: FakeCrmDB,
) -> None:
    """``bump_last_activity`` is denormalized recency, not a Zoho-relevant
    field change — pushing on it would send a no-op update every time anybody
    logs a note."""
    row = db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_id="z-acc-1")
    await crm_core.bump_last_activity(db, ORGANIZATIONS.table, str(row.id))
    stored = _stored(db, ORGANIZATIONS.table, row.id)
    assert stored["zoho_dirty"] is False


# ── The manual cycle endpoint ──────────────────────────────────────────────

async def test_the_manual_cycle_runs_without_the_flag(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """§7.1 — a hand-run cycle is an explicit admin act, so it does not need
    the scheduling flag; the flag only decides whether the platform does this
    unattended."""
    monkeypatch.setattr(crm_sync, "sync_enabled", lambda: False)
    db.seed(ORGANIZATIONS.table, name="Fracktal", zoho_dirty=True)

    report = await crm_sync.run_sync_cycle_now(USER)

    assert report.pushed.created == 1
    assert report.finished_at is not None


async def test_the_manual_cycle_carries_the_same_admin_floor() -> None:
    checks = permission_checks("/crm/sync/zoho")
    assert checks, "the manual cycle route carries no permission dependency"
    member = crm_user(features="integrations:use:*")
    for check in checks:
        with pytest.raises(HTTPException) as exc:
            await check(user=member)
        assert exc.value.status_code == 403
        assert "admin:access:manage" in str(exc.value.detail)


# ── Vocabulary flows DOWN only ─────────────────────────────────────────────

async def test_a_native_status_is_never_pushed_as_a_picklist_value(
    db: FakeCrmDB, zoho: FakeZoho, writer: FakeWriter, audit: list,
) -> None:
    """§7.1 — Zoho picklist mutation needs the settings API (out of scope),
    and the vocabulary dies with Zoho anyway. Only a lane NAME rides along on
    a record push; the lane itself never becomes an outward write."""
    _seed_pipeline(db)
    db.seed("crm_deal_statuses", name="Awaiting PO", position=99, type="open")

    await crm_sync.run_cycle()

    assert writer.pushes == 0
    assert crm_sync.RECORD_MODULES == (
        ("Accounts", ORGANIZATIONS), ("Contacts", CONTACTS),
        ("Leads", LEADS), ("Deals", DEALS),
    )
