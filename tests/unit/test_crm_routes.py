"""CRM · records, activities and admin — the list contract and the write paths.

Spec: ``ai-company-brain/specs/crm_app.md`` §3.8, §4 · ticket WS-26a done-when
4 and 6.

Hermetic: no Postgres, no network, no TestClient. Route functions are called
directly with ``_get_db`` monkeypatched onto each SUT submodule
(``test_tasks_people_scoping.py``'s convention), against the shared
``_crm_fakes.FakeCrmDB``.

Where a rule is decided **in SQL** the assertion is structural, against the
statement text: the fake re-implements clauses in Python and a mirror can only
agree with itself. Where a rule is decided in Python — the sort allowlist, the
required-field check, the loggable-type gate — the SUT runs for real and the
behavioural assertion is a genuine check on it.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from gateway.routes.crm import activities as crm_activities
from gateway.routes.crm import admin as crm_admin
from gateway.routes.crm import core as crm_core
from gateway.routes.crm import records as crm_records
from gateway.routes.crm.core import CONTACTS, DEALS, ENTITIES, LEADS, ORGANIZATIONS

from tests.unit._crm_fakes import FakeCrmDB, bind_db, crm_user

USER = crm_user()


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> FakeCrmDB:
    fake = FakeCrmDB()
    bind_db(monkeypatch, fake, (crm_core, crm_records, crm_activities, crm_admin))
    return fake


def _params(**over) -> crm_records.ListParams:
    """A ListParams built without FastAPI, with the same defaults."""
    base = {
        "q": None, "sort": None, "direction": "desc", "page": 1,
        "page_size": 50, "status_id": None, "owner": None, "source": None,
        "include_converted": False,
    }
    return crm_records.ListParams(**{**base, **over})


def _seed_pipeline(db: FakeCrmDB) -> tuple:
    lead_status = db.seed(
        "crm_lead_statuses", name="New", position=10, type="open", is_default=True,
    )
    deal_status = db.seed(
        "crm_deal_statuses", name="Qualification", position=10, type="open",
        is_default=True, probability=10,
    )
    return lead_status, deal_status


# ── The list contract ───────────────────────────────────────────────────────

@pytest.mark.parametrize("slug", sorted(ENTITIES))
async def test_the_list_shape_is_rows_and_total(db: FakeCrmDB, slug: str) -> None:
    """One contract, four entities. A per-entity response shape is how a
    shared list component grows four branches."""
    entity = ENTITIES[slug]
    db.seed(entity.table, **{f: "x" for f in ("name", "first_name", "lead_name")
                             if f in entity.model.model_fields})
    result = await crm_records._list(entity, _params())

    assert result.total == 1
    assert len(result.rows) == 1
    assert set(result.model_dump()) == {"rows", "total"}


@pytest.mark.parametrize("slug", sorted(ENTITIES))
async def test_an_unknown_sort_key_is_422(db: FakeCrmDB, slug: str) -> None:
    """trycompai's resolveOrderBy rule. Not a silent fall back to the default:
    a client sorting by a column it thinks exists and quietly getting
    created_at is a bug that survives review."""
    with pytest.raises(HTTPException) as exc:
        await crm_records._list(ENTITIES[slug], _params(sort="password"))

    assert exc.value.status_code == 422
    assert "password" in str(exc.value.detail)


async def test_an_unknown_sort_direction_is_422(db: FakeCrmDB) -> None:
    with pytest.raises(HTTPException) as exc:
        await crm_records._list(LEADS, _params(direction="sideways"))
    assert exc.value.status_code == 422


async def test_an_allowlisted_sort_key_reaches_the_order_by(db: FakeCrmDB) -> None:
    """Structural: the ORDER BY is decided in SQL, so read the statement.

    Also fences the injection: the ORDER BY carries the ALLOWLIST's value, not
    the caller's string, so the two must be checked separately from each other.
    """
    db.seed(DEALS.table, name="Printer order")
    await crm_records._list(DEALS, _params(sort="amount", direction="asc"))

    [listing] = [s for s in db.statements if "ORDER BY" in s]
    assert "ORDER BY amount ASC" in listing
    assert "LIMIT :limit OFFSET :offset" in listing


async def test_the_sort_allowlist_never_interpolates_caller_text(
    db: FakeCrmDB,
) -> None:
    """The injection attempt is refused before any SQL is built at all."""
    with pytest.raises(HTTPException):
        await crm_records._list(DEALS, _params(sort="amount; DROP TABLE crm_deals"))
    assert not db.statements


async def test_page_size_is_capped_at_one_hundred(db: FakeCrmDB) -> None:
    """§4's `page_size≤100`. The route signature enforces it with `le=`; this
    pins the kernel too, so a caller reaching `list_contract` another way
    (an agent tool, WS-26d) cannot ask for the whole table."""
    for n in range(3):
        db.seed(DEALS.table, name=f"deal-{n}")
    query = crm_core.list_contract(DEALS, page_size=10_000)
    assert query.limit == crm_core.MAX_PAGE_SIZE


async def test_paging_offsets_by_whole_pages(db: FakeCrmDB) -> None:
    for n in range(5):
        db.seed(DEALS.table, name=f"deal-{n}")
    page2 = await crm_records._list(DEALS, _params(page=2, page_size=2))

    assert page2.total == 5
    assert len(page2.rows) == 2


async def test_leads_hide_converted_rows_by_default(db: FakeCrmDB) -> None:
    """§3.3/B6 — a lead is converted while the deal it became still EXISTS.

    The filter keys on the FK link, not the timestamp: if the deal is deleted,
    SET NULL clears the link and the lead returns to the working list instead
    of being stranded invisible (review finding, 2026-08-05).
    """
    deal = db.seed(DEALS.table, name="Printer order")
    db.seed(LEADS.table, lead_name="Open one", converted_deal_id=None)
    db.seed(
        LEADS.table, lead_name="Already a deal",
        converted_at="2026-08-01", converted_deal_id=str(deal.id),
    )

    default = await crm_records._list(LEADS, _params())
    included = await crm_records._list(LEADS, _params(include_converted=True))

    assert default.total == 1
    assert included.total == 2
    assert any("converted_deal_id IS NULL" in s for s in db.statements)


async def test_a_lead_whose_deal_was_deleted_returns_to_the_list(
    db: FakeCrmDB,
) -> None:
    """The post-delete state: converted_at survives as history, the FK link is
    NULL. Keying the filter on converted_at would hide this lead forever."""
    db.seed(
        LEADS.table, lead_name="Deal was deleted",
        converted_at="2026-08-01", converted_deal_id=None,
    )
    default = await crm_records._list(LEADS, _params())
    assert default.total == 1


async def test_the_converted_filter_is_leads_only(db: FakeCrmDB) -> None:
    """Deals have no `converted_deal_id`; a shared clause applied to all four
    would be a column that does not exist."""
    db.seed(DEALS.table, name="Printer order")
    await crm_records._list(DEALS, _params())
    assert not any("converted_deal_id" in s for s in db.statements)


async def test_the_owner_filter_compares_case_insensitively(db: FakeCrmDB) -> None:
    """R10 — an IdP that re-cases a UPN must not empty somebody's own list."""
    db.seed(DEALS.table, name="Printer order", owner_email="VJVarada@Fracktal.in")
    result = await crm_records._list(DEALS, _params(owner="vjvarada@FRACKTAL.IN"))

    assert result.total == 1
    assert any("lower(owner_email) = :owner" in s for s in db.statements)


async def test_search_matches_the_declared_columns(db: FakeCrmDB) -> None:
    db.seed(LEADS.table, lead_name="Anitha Kumar", email="anitha@acme.in")
    db.seed(LEADS.table, lead_name="Bosch India", email="p@bosch.in")
    result = await crm_records._list(LEADS, _params(q="anitha"))

    assert result.total == 1


# ── Create ──────────────────────────────────────────────────────────────────

async def test_a_missing_required_field_is_422(db: FakeCrmDB) -> None:
    with pytest.raises(HTTPException) as exc:
        await crm_records.create_record(
            DEALS, crm_core.DealIn(amount=10.0), USER,
        )
    assert exc.value.status_code == 422
    assert "name" in str(exc.value.detail)


async def test_a_new_deal_lands_in_the_default_status(db: FakeCrmDB) -> None:
    _, deal_status = _seed_pipeline(db)
    deal = await crm_records.create_record(
        DEALS, crm_core.DealIn(name="Printer order"), USER,
    )
    assert deal["status_id"] == str(deal_status.id)


async def test_a_new_deal_inherits_its_stage_probability(db: FakeCrmDB) -> None:
    """§3.4 — auto-filled from the status default when the deal states none."""
    _seed_pipeline(db)
    deal = await crm_records.create_record(
        DEALS, crm_core.DealIn(name="Printer order"), USER,
    )
    assert deal["probability"] == 10


async def test_a_stated_probability_is_not_overwritten(db: FakeCrmDB) -> None:
    _seed_pipeline(db)
    deal = await crm_records.create_record(
        DEALS, crm_core.DealIn(name="Printer order", probability=90), USER,
    )
    assert deal["probability"] == 90


async def test_a_deal_created_directly_into_a_terminal_status_gets_closed_at(
    db: FakeCrmDB,
) -> None:
    """Verifier finding 2026-08-05: PATCH into Closed Won stamped closed_at
    while POST straight into it stored NULL — §3.6's rule belongs to the
    status type, so it must reach both verbs (the same reach as the lost gate).
    """
    _seed_pipeline(db)
    won = db.seed(
        "crm_deal_statuses", name="Closed Won", position=60, type="won",
        is_default=False, probability=100,
    )
    deal = await crm_records.create_record(
        DEALS,
        crm_core.DealIn(name="Printer order", status_id=str(won.id)),
        USER,
    )
    assert deal["closed_at"] is not None


async def test_an_absent_owner_defaults_to_the_acting_user(db: FakeCrmDB) -> None:
    """Identity comes from the authenticated context (R3), never a body field."""
    _seed_pipeline(db)
    deal = await crm_records.create_record(
        DEALS, crm_core.DealIn(name="Printer order"), USER,
    )
    assert deal["owner_email"] == USER.email


async def test_an_explicit_null_owner_stays_unassigned(db: FakeCrmDB) -> None:
    """"Deliberately unassigned" and "not mentioned" are different requests."""
    _seed_pipeline(db)
    deal = await crm_records.create_record(
        DEALS, crm_core.DealIn.model_validate(
            {"name": "Printer order", "owner_email": None},
        ), USER,
    )
    assert deal["owner_email"] is None


async def test_an_unknown_source_is_422(db: FakeCrmDB) -> None:
    """The migration's CHECK is the boundary of record; this is the same rule
    stated where it produces a 422 instead of a driver 500."""
    _seed_pipeline(db)
    with pytest.raises(HTTPException) as exc:
        await crm_records.create_record(
            DEALS,
            crm_core.DealIn.model_validate({"name": "x", "source": "telepathy"}),
            USER,
        )
    assert exc.value.status_code == 422


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"first_name": "Anitha", "last_name": "Kumar"}, "Anitha Kumar"),
        ({"organization_name": "Bosch India"}, "Bosch India"),
        ({"email": "anitha@acme.in"}, "anitha"),
        ({}, "Unnamed lead"),
    ],
)
async def test_the_lead_name_fallback_chain(
    db: FakeCrmDB, payload: dict, expected: str,
) -> None:
    """§3.3 — a NOT NULL display column with no computed fallback is how
    'Untitled' ends up in a pipeline."""
    _seed_pipeline(db)
    lead = await crm_records.create_record(
        LEADS, crm_core.LeadIn.model_validate(payload), USER,
    )
    assert lead["lead_name"] == expected


async def test_a_lead_name_is_re_derived_when_its_inputs_change(
    db: FakeCrmDB,
) -> None:
    lead_status, _ = _seed_pipeline(db)
    seeded = db.seed(
        LEADS.table, lead_name="Anitha", first_name="Anitha",
        status_id=lead_status.id,
    )
    patched = await crm_records.patch_record(
        LEADS, str(seeded.id), crm_core.LeadIn(last_name="Kumar"), USER,
    )
    assert patched["lead_name"] == "Anitha Kumar"


async def test_an_untouched_lead_name_is_left_alone(db: FakeCrmDB) -> None:
    """A hand-edited display name survives a patch that does not touch its
    inputs — otherwise every unrelated edit silently reverts it."""
    lead_status, _ = _seed_pipeline(db)
    seeded = db.seed(
        LEADS.table, lead_name="Bosch — printer RFQ", first_name="Anitha",
        status_id=lead_status.id,
    )
    patched = await crm_records.patch_record(
        LEADS, str(seeded.id), crm_core.LeadIn(description="called back"), USER,
    )
    assert patched["lead_name"] == "Bosch — printer RFQ"


# ── Driver-shaped writes ────────────────────────────────────────────────────
#
# These three are the class of defect a fake cannot find on its own: every case
# above passes with a dict bound straight at a jsonb column and an ISO string
# bound straight at a timestamptz, and both are driver errors against real
# Postgres. `coerce_write_values` / the jsonb cast are the one choke point, so
# they are pinned where they are decided.

async def test_a_jsonb_column_is_cast_and_serialized(db: FakeCrmDB) -> None:
    """asyncpg has no codec for a bare dict; raw `text()` declares no column
    type, so the statement has to say `jsonb` and the value has to be JSON."""
    await crm_records.create_record(
        ORGANIZATIONS,
        crm_core.OrganizationIn(
            name="Bosch India", address={"city": "Bengaluru", "pin": "560058"},
        ),
        USER,
    )
    [insert] = db.statements_touching("INSERT INTO crm_organizations")
    assert "CAST(:address AS jsonb)" in insert
    [(_, params)] = [c for c in db.calls if "INSERT INTO crm_organizations" in c[0]]
    assert isinstance(params["address"], str)


async def test_a_jsonb_column_round_trips_back_to_a_dict(db: FakeCrmDB) -> None:
    """The read half: jsonb comes back from the driver as a STRING, and a model
    field typed `dict` would reject it."""
    created = await crm_records.create_record(
        ORGANIZATIONS,
        crm_core.OrganizationIn(name="Bosch India", address={"city": "Bengaluru"}),
        USER,
    )
    assert created["address"] == {"city": "Bengaluru"}


async def test_an_iso_instant_is_parsed_into_a_datetime(db: FakeCrmDB) -> None:
    """asyncpg binds real datetimes. A string reaches timestamptz as text."""
    org = db.seed(ORGANIZATIONS.table, name="Bosch India")
    await crm_activities._log_activity(
        ORGANIZATIONS, str(org.id),
        crm_activities.ActivityIn(type="call", due_at="2026-09-01T10:30:00+00:00"),
        USER,
    )
    [(_, params)] = [c for c in db.calls if "INSERT INTO crm_activities" in c[0]]
    assert params["due_at"].year == 2026 and params["due_at"].month == 9


async def test_an_iso_date_is_parsed_into_a_date(db: FakeCrmDB) -> None:
    _seed_pipeline(db)
    await crm_records.create_record(
        DEALS,
        crm_core.DealIn(name="Printer order", expected_close_date="2026-09-30"),
        USER,
    )
    [(_, params)] = [c for c in db.calls if "INSERT INTO crm_deals" in c[0]]
    assert str(params["expected_close_date"]) == "2026-09-30"


async def test_a_malformed_instant_is_422_naming_the_column(db: FakeCrmDB) -> None:
    """A 422 a caller can act on, rather than a driver error they cannot."""
    org = db.seed(ORGANIZATIONS.table, name="Bosch India")
    with pytest.raises(HTTPException) as exc:
        await crm_activities._log_activity(
            ORGANIZATIONS, str(org.id),
            crm_activities.ActivityIn(due_at="next tuesday"), USER,
        )
    assert exc.value.status_code == 422
    assert "due_at" in str(exc.value.detail)


def test_every_jsonb_and_temporal_column_is_declared() -> None:
    """Structural: the coercion lists are hand-kept, so pin them against the
    migration. A column added there and forgotten here is a driver error on
    the first request that sets it."""
    from pathlib import Path

    migration = (
        Path(__file__).resolve().parents[2] / "infra" / "postgres" / "144_crm.sql"
    ).read_text(encoding="utf-8")

    declared = {
        "JSONB": crm_core.JSONB_COLUMNS,
        "TIMESTAMPTZ": crm_core.TIMESTAMP_COLUMNS,
        "DATE": crm_core.DATE_COLUMNS,
    }
    for sql_type, names in declared.items():
        for line in migration.splitlines():
            parts = line.strip().split()
            if len(parts) < 2 or parts[1].upper() != sql_type:
                continue
            column = parts[0]
            if column in ("created_at", "updated_at"):
                continue  # never settable from a request body
            assert column in names or any(
                column in group for group in declared.values()
            ), f"{column} is {sql_type} in 144_crm.sql but no list claims it"


# ── Read / update / delete ──────────────────────────────────────────────────

async def test_an_unknown_id_is_404(db: FakeCrmDB) -> None:
    with pytest.raises(HTTPException) as exc:
        await crm_records._get(DEALS, "00000000-0000-0000-0000-000000000000")
    assert exc.value.status_code == 404
    assert "Deal" in str(exc.value.detail)


async def test_a_patch_with_no_fields_writes_nothing(db: FakeCrmDB) -> None:
    seeded = db.seed(ORGANIZATIONS.table, name="Bosch India")
    await crm_records.patch_record(
        ORGANIZATIONS, str(seeded.id), crm_core.OrganizationIn(), USER,
    )
    assert not db.statements_touching("UPDATE")


async def test_a_patch_touches_updated_at(db: FakeCrmDB) -> None:
    seeded = db.seed(ORGANIZATIONS.table, name="Bosch India")
    await crm_records.patch_record(
        ORGANIZATIONS, str(seeded.id), crm_core.OrganizationIn(industry="Auto"), USER,
    )
    [update] = db.statements_touching("UPDATE crm_organizations SET")
    assert "updated_at = now()" in update


async def test_delete_reports_what_cascaded(db: FakeCrmDB) -> None:
    """R7/R8 — 'deleted' with no blast radius is the response that hides a
    cascade. Counted BEFORE the delete: afterwards the honest number is gone."""
    _, deal_status = _seed_pipeline(db)
    deal = db.seed(DEALS.table, name="Printer order", status_id=deal_status.id)
    db.seed("crm_activities", type="note", deal_id=deal.id, created_by="a@b.in")
    db.seed("crm_activities", type="call", deal_id=deal.id, created_by="a@b.in")
    db.seed("crm_deal_contacts", deal_id=deal.id, contact_id=str(deal.id))

    result = await crm_records.delete_record(DEALS, str(deal.id))

    assert result.cascaded == {"crm_activities": 2, "crm_deal_contacts": 1}
    counts = [s for s in db.statements if s.startswith("SELECT count(*)")]
    deletes = [s for s in db.statements if s.startswith("DELETE")]
    assert db.statements.index(counts[-1]) < db.statements.index(deletes[0])


def test_every_entity_declares_the_tables_its_delete_cascades() -> None:
    """Structural, because the fake models no foreign keys and therefore no
    cascades: a behavioural case here would agree that nothing was destroyed.

    The registry's `cascades` is what the response reports, so it is pinned
    against the FK graph derived from the migrations themselves.
    """
    from tests.unit._schema_cascade import cascade_children

    for entity in ENTITIES.values():
        declared = {table for table, _ in entity.cascades}
        actual = cascade_children(entity.table)
        assert declared == actual, (
            f"{entity.table} declares cascades onto {sorted(declared)} but "
            f"infra/postgres/ says {sorted(actual)}. An UNDERSTATED map is the "
            "wrong direction of error: the delete response is what tells an "
            "operator the blast radius before they click."
        )


# ── Activities ──────────────────────────────────────────────────────────────

async def test_logging_an_activity_stamps_the_target_and_the_author(
    db: FakeCrmDB,
) -> None:
    """§3.8's CHECK requires at least one target. The target here is
    STRUCTURAL — it comes from the entity registry, not from the request — so
    the constraint cannot be reached with all four columns NULL."""
    _, deal_status = _seed_pipeline(db)
    deal = db.seed(DEALS.table, name="Printer order", status_id=deal_status.id)

    logged = await crm_activities._log_activity(
        DEALS, str(deal.id), crm_activities.ActivityIn(type="call", subject="Rang"),
        USER,
    )

    assert logged["deal_id"] == str(deal.id)
    assert logged["lead_id"] is None
    assert logged["created_by"] == USER.email


@pytest.mark.parametrize("slug", sorted(ENTITIES))
async def test_every_entity_logs_to_its_own_target_column(
    db: FakeCrmDB, slug: str,
) -> None:
    entity = ENTITIES[slug]
    seeded = db.seed(entity.table, **(
        {"lead_name": "x"} if entity is LEADS else
        {"first_name": "x"} if entity is CONTACTS else {"name": "x"}
    ))
    logged = await crm_activities._log_activity(
        entity, str(seeded.id), crm_activities.ActivityIn(body="note"), USER,
    )
    assert logged[entity.activity_column] == str(seeded.id)
    targets = {"lead_id", "deal_id", "contact_id", "organization_id"}
    assert [c for c in targets if logged[c] is not None] == [entity.activity_column]


async def test_an_activity_bumps_its_targets_last_activity_at(
    db: FakeCrmDB,
) -> None:
    """trycompai's denormalization discipline — the reason 'sort by last
    touched' is an index scan and not a correlated subquery."""
    org = db.seed(ORGANIZATIONS.table, name="Bosch India")
    await crm_activities._log_activity(
        ORGANIZATIONS, str(org.id), crm_activities.ActivityIn(body="met"), USER,
    )
    assert db.statements_touching(
        "UPDATE crm_organizations SET last_activity_at = now()"
    )


@pytest.mark.parametrize("kind", ["status_change", "system"])
async def test_a_platform_activity_type_cannot_be_hand_logged(
    db: FakeCrmDB, kind: str,
) -> None:
    """A hand-written status_change is a funnel event with no transition
    behind it — the log would say something happened that did not."""
    org = db.seed(ORGANIZATIONS.table, name="Bosch India")
    with pytest.raises(HTTPException) as exc:
        await crm_activities._log_activity(
            ORGANIZATIONS, str(org.id), crm_activities.ActivityIn(type=kind), USER,
        )
    assert exc.value.status_code == 422


async def test_a_platform_activity_cannot_be_deleted(db: FakeCrmDB) -> None:
    entry = db.seed(
        "crm_activities", type="status_change", created_by="a@b.in",
        deal_id=str(db.seed(DEALS.table, name="d").id),
    )
    with pytest.raises(HTTPException) as exc:
        await crm_activities.delete_activity(str(entry.id), USER)
    assert exc.value.status_code == 409


@pytest.mark.parametrize("kind", ["status_change", "system"])
async def test_a_platform_activity_cannot_be_edited_either(
    db: FakeCrmDB, kind: str,
) -> None:
    """Review finding 2026-08-05: one rule, both verbs. An edited
    status_change disagrees with crm_status_changes with no way to tell which
    one is lying — so PATCH refuses exactly what DELETE refuses."""
    entry = db.seed(
        "crm_activities", type=kind, created_by="a@b.in",
        deal_id=str(db.seed(DEALS.table, name="d").id),
    )
    with pytest.raises(HTTPException) as exc:
        await crm_activities.patch_activity(
            str(entry.id), crm_activities.ActivityPatch(subject="rewritten"), USER,
        )
    assert exc.value.status_code == 409
    assert not db.statements_touching("UPDATE crm_activities SET")


async def test_record_activity_bumps_the_target_itself(db: FakeCrmDB) -> None:
    """Review finding 2026-08-05: the docstring promised the bump and the body
    didn't do it — correct for today's callers, wrong for the next one (the
    WS-26b importer, WS-26d's agent tools). Now the function keeps its own
    promise."""
    deal = db.seed(DEALS.table, name="Printer order")
    await crm_core.record_activity(
        db, activity_type="note", created_by="a@b.in",
        target_column="deal_id", target_id=str(deal.id),
    )
    assert db.statements_touching("UPDATE crm_deals SET last_activity_at = now()")


async def test_completing_a_task_writes_completed_at(db: FakeCrmDB) -> None:
    entry = db.seed(
        "crm_activities", type="task", created_by="a@b.in", completed_at=None,
        deal_id=str(db.seed(DEALS.table, name="d").id),
    )
    done = await crm_activities.patch_activity(
        str(entry.id),
        crm_activities.ActivityPatch(completed_at="2026-08-05T10:00:00+00:00"),
        USER,
    )
    assert done["completed_at"] == "2026-08-05T10:00:00+00:00"


async def test_an_activity_update_does_not_touch_a_column_it_has_not_got(
    db: FakeCrmDB,
) -> None:
    """`crm_activities` carries no `updated_at` — it is a log entry, not a
    record. Writing one would be a 500 from the driver."""
    entry = db.seed(
        "crm_activities", type="note", created_by="a@b.in",
        deal_id=str(db.seed(DEALS.table, name="d").id),
    )
    await crm_activities.patch_activity(
        str(entry.id), crm_activities.ActivityPatch(body="edited"), USER,
    )
    [update] = db.statements_touching("UPDATE crm_activities SET")
    assert "updated_at" not in update


# ── Admin: statuses and lost reasons ────────────────────────────────────────

async def test_deleting_a_status_in_use_is_409_not_a_driver_error(
    db: FakeCrmDB,
) -> None:
    """The FK is ON DELETE RESTRICT, so Postgres refuses it either way — but as
    an IntegrityError and a 500. Counting first turns 'the database said no'
    into 'Proposal still has 1 deal in it'."""
    _, deal_status = _seed_pipeline(db)
    db.seed(DEALS.table, name="Printer order", status_id=deal_status.id)

    with pytest.raises(HTTPException) as exc:
        await crm_admin.delete_status("deal", str(deal_status.id), USER)

    assert exc.value.status_code == 409
    assert not db.statements_touching("DELETE FROM crm_deal_statuses")


async def test_deleting_an_unused_status_succeeds(db: FakeCrmDB) -> None:
    _, deal_status = _seed_pipeline(db)
    result = await crm_admin.delete_status("deal", str(deal_status.id), USER)
    assert result["deleted"] == str(deal_status.id)
    assert db.rows("crm_deal_statuses") == []


async def test_an_unknown_status_kind_is_404(db: FakeCrmDB) -> None:
    with pytest.raises(HTTPException) as exc:
        await crm_admin.list_statuses("prospect", USER)
    assert exc.value.status_code == 404


async def test_a_new_lane_is_appended_not_prepended(db: FakeCrmDB) -> None:
    """Defaulting position to 0 would silently reorder every existing lane."""
    _seed_pipeline(db)
    created = await crm_admin.create_status(
        "deal", crm_admin.StatusIn(name="Pilot", type="ongoing"), USER,
    )
    assert created.position > 10


async def test_a_lead_status_cannot_carry_a_probability(db: FakeCrmDB) -> None:
    """That column is deal-only; accepting it would silently drop the value."""
    with pytest.raises(HTTPException) as exc:
        await crm_admin.create_status(
            "lead", crm_admin.StatusIn(name="Pilot", probability=50), USER,
        )
    assert exc.value.status_code == 422


async def test_an_unknown_status_type_is_422(db: FakeCrmDB) -> None:
    with pytest.raises(HTTPException) as exc:
        await crm_admin.create_status(
            "deal", crm_admin.StatusIn(name="Pilot", type="maybe"), USER,
        )
    assert exc.value.status_code == 422


# ── Wiring ──────────────────────────────────────────────────────────────────

def test_the_router_is_gated_on_feature_crm() -> None:
    """Router-level, so an endpoint added tomorrow is covered by default —
    the failure mode of per-route gating is the route someone forgets."""
    names = [
        getattr(getattr(d, "dependency", None), "__qualname__", "")
        for d in crm_core.router.dependencies
    ]
    assert any(n.startswith("require_feature_router") for n in names)


def test_no_crm_module_opens_its_own_engine() -> None:
    """D-CRM-4 / BO-10, grep-assertable: this package consumes `gateway.db` and
    adds no thirteenth engine. Read off the source, because an engine created
    lazily inside a function would never show up in a behavioural test."""
    from pathlib import Path

    package = Path(crm_core.__file__).parent
    checked = 0
    for path in sorted(package.glob("*.py")):
        source = path.read_text(encoding="utf-8")
        checked += 1
        # The CALL, not the name: the module docstrings discuss the seam by
        # name, and a check that cannot survive its own explanation is one
        # somebody deletes.
        assert "create_async_engine(" not in source, (
            f"{path.name} creates its own engine — routes/crm must consume "
            "gateway.db (specs/crm_app.md D-CRM-4)."
        )
    assert checked >= 5, "the crm package lost modules — this check went vacuous"
    assert "from gateway.db import" in (package / "core.py").read_text(
        encoding="utf-8",
    )


def test_tasks_consumes_the_shared_engine_seam() -> None:
    """The other half of D-CRM-4: `routes/tasks/core.py` was converted as the
    proof the seam works, so the seam has a consumer that predates it."""
    from pathlib import Path

    import gateway.routes.tasks.core as tasks_core

    source = Path(tasks_core.__file__).read_text(encoding="utf-8")
    assert "create_async_engine" not in source
    assert "from gateway.db import" in source


def test_every_entity_sort_allowlist_names_real_columns() -> None:
    """An allowlisted key pointing at a column that does not exist is a 500
    waiting for the first person who sorts by it."""
    for entity in ENTITIES.values():
        fields = set(entity.model.model_fields)
        unknown = {v for v in entity.sorts.values()} - fields
        assert not unknown, f"{entity.slug} sorts by unknown column(s): {unknown}"
        assert entity.default_sort in entity.sorts
