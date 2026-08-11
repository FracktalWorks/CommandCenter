"""CRM · pipeline — status transitions, the lost gate, and the kanban board.

Spec: ``project-docs/specs/crm_app.md`` §3.6, §3.9, §4 · WS-26a done-when 4.

The headline claim under test: **a status transition has three effects, always.**
A ``PATCH`` that writes only the new ``status_id`` looks correct in the UI and
silently empties the funnel report that statuses-as-data exist to make free —
which is exactly the kind of defect no screenshot catches.

Hermetic: no Postgres, no network, no TestClient.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from gateway.routes.crm import activities as crm_activities
from gateway.routes.crm import admin as crm_admin
from gateway.routes.crm import core as crm_core
from gateway.routes.crm import pipeline as crm_pipeline
from gateway.routes.crm import records as crm_records
from gateway.routes.crm.core import DEALS, LEADS

from tests.unit._crm_fakes import FakeCrmDB, bind_db, crm_user

USER = crm_user()


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> FakeCrmDB:
    fake = FakeCrmDB()
    bind_db(
        monkeypatch, fake,
        (crm_core, crm_records, crm_pipeline, crm_activities, crm_admin),
    )
    return fake


def _deal_pipeline(db: FakeCrmDB) -> dict:
    """The seeded deal stages, by name."""
    stages = {
        "Qualification": ("open", 10, 10, True),
        "Proposal": ("ongoing", 30, 50, False),
        "Closed Won": ("won", 50, 100, False),
        "Closed Lost": ("lost", 60, 0, False),
    }
    return {
        name: db.seed(
            "crm_deal_statuses", name=name, type=kind, position=pos,
            probability=prob, is_default=default,
        )
        for name, (kind, pos, prob, default) in stages.items()
    }


def _lead_pipeline(db: FakeCrmDB) -> dict:
    stages = {
        "New": ("open", 10, True),
        "Contacted": ("ongoing", 20, False),
        "Qualified": ("won", 40, False),
        "Lost": ("lost", 50, False),
    }
    return {
        name: db.seed(
            "crm_lead_statuses", name=name, type=kind, position=pos,
            is_default=default,
        )
        for name, (kind, pos, default) in stages.items()
    }


def _seed_deal(db: FakeCrmDB, status, **over):
    columns = {
        "name": "Printer order",
        "status_id": status.id,
        # Seeded three days into its current stage, so dwell is measurable.
        "status_changed_at": datetime.now(UTC) - timedelta(days=3),
        "probability": None,
        "closed_at": None,
        "lost_reason_id": None,
    }
    return db.seed(DEALS.table, **{**columns, **over})


# ── The three effects ───────────────────────────────────────────────────────

async def test_a_transition_writes_the_dwell_log(db: FakeCrmDB) -> None:
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"])

    await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )

    [entry] = db.rows("crm_status_changes")
    assert entry["entity_type"] == "deal"
    assert entry["entity_id"] == str(deal.id)
    assert entry["from_status"] == "Qualification"
    assert entry["to_status"] == "Proposal"
    assert entry["changed_by"] == USER.email


async def test_a_transition_records_time_spent_in_the_previous_status(
    db: FakeCrmDB,
) -> None:
    """§3.9's `dwell_seconds` — the reason the funnel report is free."""
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"])

    await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )

    [entry] = db.rows("crm_status_changes")
    # Seeded three days into Qualification, ±a minute of slack.
    assert 3 * 86_400 - 60 <= entry["dwell_seconds"] <= 3 * 86_400 + 60


async def test_a_transition_writes_a_timeline_activity(db: FakeCrmDB) -> None:
    """The move shows up beside the notes and calls that explain it."""
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"])

    await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )

    [entry] = db.rows("crm_activities")
    assert entry["type"] == "status_change"
    assert entry["deal_id"] == str(deal.id)
    assert entry["created_by"] == USER.email
    assert "Qualification" in entry["subject"] and "Proposal" in entry["subject"]


async def test_a_transition_restamps_the_stage_age_clock(db: FakeCrmDB) -> None:
    """§3.4 — without this, 'how long has this sat in Proposal' answers with
    the age of the move BEFORE it."""
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"])
    before = deal.status_changed_at

    await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )

    [row] = db.rows(DEALS.table)
    assert row["status_changed_at"] > before


async def test_all_three_effects_land_in_one_patch(db: FakeCrmDB) -> None:
    """Counted together: each of the three has its own test above, and this is
    the one that fails if a refactor keeps two and drops the third."""
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"])

    await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )

    assert len(db.rows("crm_status_changes")) == 1
    assert len(db.rows("crm_activities")) == 1
    assert db.rows(DEALS.table)[0]["status_id"] == str(stages["Proposal"].id)


async def test_a_patch_that_does_not_move_the_status_writes_no_funnel_row(
    db: FakeCrmDB,
) -> None:
    """Re-sending the SAME status_id is not a transition. Logging it would put
    a zero-dwell entry in the funnel for every unrelated field edit."""
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"])

    await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(
            status_id=str(stages["Qualification"].id), next_step="Send quote",
        ), USER,
    )

    assert db.rows("crm_status_changes") == []
    assert db.rows("crm_activities") == []


async def test_a_field_only_patch_writes_no_funnel_row(db: FakeCrmDB) -> None:
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"])
    await crm_records.patch_record(
        DEALS, str(deal.id), crm_core.DealIn(amount=250_000.0), USER,
    )
    assert db.rows("crm_status_changes") == []


# ── The lost gate ───────────────────────────────────────────────────────────

async def test_entering_a_lost_status_without_a_reason_is_422(
    db: FakeCrmDB,
) -> None:
    """'Why did we lose it' is the whole reason the lost vocabulary exists; a
    nullable column with no gate collects blanks."""
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"])

    with pytest.raises(HTTPException) as exc:
        await crm_records.patch_record(
            DEALS, str(deal.id),
            crm_core.DealIn(status_id=str(stages["Closed Lost"].id)), USER,
        )

    assert exc.value.status_code == 422
    assert "lost_reason_id" in str(exc.value.detail)


async def test_a_refused_lost_transition_writes_nothing_at_all(
    db: FakeCrmDB,
) -> None:
    """The refusal must come BEFORE the three effects, or a rejected move
    still leaves a funnel row saying it happened."""
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"])

    with pytest.raises(HTTPException):
        await crm_records.patch_record(
            DEALS, str(deal.id),
            crm_core.DealIn(status_id=str(stages["Closed Lost"].id)), USER,
        )

    assert db.rows("crm_status_changes") == []
    assert db.rows("crm_activities") == []
    assert db.rows(DEALS.table)[0]["status_id"] == str(stages["Qualification"].id)
    assert db.committed == 0


async def test_a_lost_transition_with_a_reason_in_the_same_patch_succeeds(
    db: FakeCrmDB,
) -> None:
    """The reason may arrive WITH the move — demanding a prior write would make
    the UI do it in two requests and leave a window where it is unexplained."""
    stages = _deal_pipeline(db)
    reason = db.seed("crm_lost_reasons", label="Price", position=10)
    deal = _seed_deal(db, stages["Qualification"])

    result = await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(
            status_id=str(stages["Closed Lost"].id), lost_reason_id=str(reason.id),
        ), USER,
    )

    assert result["lost_reason_id"] == str(reason.id)
    assert len(db.rows("crm_status_changes")) == 1


async def test_a_lost_transition_uses_a_reason_already_on_the_record(
    db: FakeCrmDB,
) -> None:
    stages = _deal_pipeline(db)
    reason = db.seed("crm_lost_reasons", label="Competitor", position=20)
    deal = _seed_deal(db, stages["Qualification"], lost_reason_id=str(reason.id))

    await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Closed Lost"].id)), USER,
    )
    assert len(db.rows("crm_status_changes")) == 1


async def test_the_lost_gate_applies_to_leads_too(db: FakeCrmDB) -> None:
    """The gate belongs to the STATUS TYPE, not to the entity — a rule spelled
    per-entity is a rule that gets added to three of four."""
    stages = _lead_pipeline(db)
    lead = db.seed(
        LEADS.table, lead_name="Anitha Kumar", status_id=stages["New"].id,
        lost_reason_id=None,
    )
    with pytest.raises(HTTPException) as exc:
        await crm_records.patch_record(
            LEADS, str(lead.id),
            crm_core.LeadIn(status_id=str(stages["Lost"].id)), USER,
        )
    assert exc.value.status_code == 422


# ── WS-26h · stage entry requirements ───────────────────────────────────────
#
# The lost gate above, generalized: a stage may demand any of
# `core.STAGE_REQUIREABLE_FIELDS` before a deal is allowed to ENTER it. Every
# property the lost gate has is asserted again here, because "generalize
# exactly that" is the ticket and a generalisation that quietly dropped
# refuse-before-the-effects would be a regression wearing a new feature's name.


def _gate(db: FakeCrmDB, stage, *fields: str) -> None:
    """Put entry requirements on a seeded stage, as the settings grid would."""
    for row in db.rows("crm_deal_statuses"):
        if str(row["id"]) == str(stage.id):
            row["required_fields"] = list(fields)
            return
    raise AssertionError(f"no such seeded stage: {stage}")


async def test_entering_a_gated_stage_without_the_field_is_422(
    db: FakeCrmDB,
) -> None:
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "amount")
    deal = _seed_deal(db, stages["Qualification"], amount=None)

    with pytest.raises(HTTPException) as exc:
        await crm_records.patch_record(
            DEALS, str(deal.id),
            crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
        )

    assert exc.value.status_code == 422
    # The refusal NAMES what is missing: "422" in a toast is not an answer to
    # "why can I not move this card".
    assert "amount" in str(exc.value.detail)
    assert "Proposal" in str(exc.value.detail)


async def test_the_refusal_names_every_missing_field_at_once(
    db: FakeCrmDB,
) -> None:
    """Not the first one — a modal that asks for `amount`, is refused again for
    `owner_email` and again for the close date is three round trips."""
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "amount", "expected_close_date", "owner_email")
    deal = _seed_deal(
        db, stages["Qualification"],
        amount=None, expected_close_date=None, owner_email=None,
    )

    with pytest.raises(HTTPException) as exc:
        await crm_records.patch_record(
            DEALS, str(deal.id),
            crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
        )

    detail = str(exc.value.detail)
    for field in ("amount", "expected_close_date", "owner_email"):
        assert field in detail


async def test_a_refused_entry_writes_nothing_at_all(db: FakeCrmDB) -> None:
    """Refused BEFORE the transition's three effects, exactly as the lost gate
    is — otherwise a rejected move still leaves a funnel row saying it
    happened."""
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "amount")
    deal = _seed_deal(db, stages["Qualification"], amount=None)

    with pytest.raises(HTTPException):
        await crm_records.patch_record(
            DEALS, str(deal.id),
            crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
        )

    assert db.rows("crm_status_changes") == []
    assert db.rows("crm_activities") == []
    assert db.rows(DEALS.table)[0]["status_id"] == str(stages["Qualification"].id)
    assert db.committed == 0


async def test_the_same_patch_may_carry_the_missing_field(db: FakeCrmDB) -> None:
    """The ticket's whole shape: ONE PATCH with fields + status together. Two
    requests could half-apply, and the half that lands is the one that moved
    the deal."""
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "amount")
    deal = _seed_deal(db, stages["Qualification"], amount=None)

    result = await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id), amount=400000),
        USER,
    )

    assert result["status_id"] == str(stages["Proposal"].id)
    assert result["amount"] == 400000
    assert len(db.rows("crm_status_changes")) == 1


async def test_a_field_already_on_the_deal_satisfies_the_requirement(
    db: FakeCrmDB,
) -> None:
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "amount")
    deal = _seed_deal(db, stages["Qualification"], amount=250000)

    result = await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )

    assert result["status_id"] == str(stages["Proposal"].id)


async def test_a_non_move_patch_is_never_blocked_by_requirements(
    db: FakeCrmDB,
) -> None:
    """Entry-only. §5.1 chose visibility over locks: a deal already sitting in a
    stage it no longer satisfies must stay editable — including editable
    TOWARDS satisfying it."""
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "amount", "owner_email")
    deal = _seed_deal(
        db, stages["Proposal"], amount=None, owner_email=None,
    )

    result = await crm_records.patch_record(
        DEALS, str(deal.id), crm_core.DealIn(next_step="Send the quote"), USER,
    )

    assert result["next_step"] == "Send the quote"
    assert db.rows("crm_status_changes") == []


async def test_a_patch_restating_the_current_status_is_not_an_entry(
    db: FakeCrmDB,
) -> None:
    """`records.patch_record` only treats a body as a transition when the
    status actually MOVES, and the gate must inherit that — a card re-saved in
    place is not an entry."""
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "amount")
    deal = _seed_deal(db, stages["Proposal"], amount=None)

    result = await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )

    assert result["status_id"] == str(stages["Proposal"].id)
    assert db.rows("crm_status_changes") == []


async def test_a_zero_amount_satisfies_an_amount_requirement(
    db: FakeCrmDB,
) -> None:
    """0 is a number somebody typed, not a blank box. A plain falsiness test
    here would refuse a genuine ₹0 deal, which a pipeline really does hold."""
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "amount")
    deal = _seed_deal(db, stages["Qualification"], amount=0)

    result = await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )

    assert result["status_id"] == str(stages["Proposal"].id)


async def test_a_blank_string_does_not_satisfy_a_requirement(
    db: FakeCrmDB,
) -> None:
    """An empty text box is not a filled one — the opposite end of the same
    rule as the zero above."""
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "owner_email")
    deal = _seed_deal(db, stages["Qualification"], owner_email="   ")

    with pytest.raises(HTTPException) as exc:
        await crm_records.patch_record(
            DEALS, str(deal.id),
            crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
        )

    assert exc.value.status_code == 422
    assert "owner_email" in str(exc.value.detail)


async def test_clearing_a_field_in_the_same_patch_that_moves_is_refused(
    db: FakeCrmDB,
) -> None:
    """What matters is the state the write LEAVES, not what was stored a moment
    ago: a PATCH that nulls `amount` while entering a stage that requires it
    must not be waved through on the strength of the old value."""
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "amount")
    deal = _seed_deal(db, stages["Qualification"], amount=400000)

    with pytest.raises(HTTPException) as exc:
        await crm_records.patch_record(
            DEALS, str(deal.id),
            crm_core.DealIn(status_id=str(stages["Proposal"].id), amount=None),
            USER,
        )

    assert exc.value.status_code == 422
    assert db.rows("crm_status_changes") == []


async def test_an_ungated_stage_requires_nothing(db: FakeCrmDB) -> None:
    """Every stage until somebody sets a requirement — i.e. the whole live
    board on the day this ships."""
    stages = _deal_pipeline(db)
    deal = _seed_deal(
        db, stages["Qualification"],
        amount=None, expected_close_date=None, owner_email=None,
    )

    result = await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )

    assert result["status_id"] == str(stages["Proposal"].id)


async def test_leads_have_no_entry_requirements(db: FakeCrmDB) -> None:
    """`crm_lead_statuses` has no such column, so the gate must read absent as
    "nothing required" rather than raising an AttributeError on every lead
    move — the same asymmetry `probability` and `status_changed_at` have."""
    stages = _lead_pipeline(db)
    lead = db.seed(LEADS.table, lead_name="Asha", status_id=stages["New"].id)

    result = await crm_records.patch_record(
        LEADS, str(lead.id),
        crm_core.LeadIn(status_id=str(stages["Contacted"].id)), USER,
    )

    assert result["status_id"] == str(stages["Contacted"].id)


async def test_the_lost_gate_still_fires_first_on_a_gated_lost_stage(
    db: FakeCrmDB,
) -> None:
    """Both gates guard the same move. The lost reason is the more specific
    refusal and stays the one the caller is told about first, unchanged — the
    ticket says generalize the mechanism, not renumber the existing rule."""
    stages = _deal_pipeline(db)
    _gate(db, stages["Closed Lost"], "amount")
    deal = _seed_deal(db, stages["Qualification"], amount=None)

    with pytest.raises(HTTPException) as exc:
        await crm_records.patch_record(
            DEALS, str(deal.id),
            crm_core.DealIn(status_id=str(stages["Closed Lost"].id)), USER,
        )

    assert "lost_reason_id" in str(exc.value.detail)


# ── WS-26h · what the settings grid may write ───────────────────────────────

async def test_an_unknown_required_field_name_is_422(db: FakeCrmDB) -> None:
    """The allowlist is checked on the way IN. A name no deal can ever carry
    would make its lane refuse every move with a message about a field that
    does not exist — a lane bricked by a typo."""
    stages = _deal_pipeline(db)

    with pytest.raises(HTTPException) as exc:
        await crm_admin.patch_status(
            "deal", str(stages["Proposal"].id),
            crm_admin.StatusIn(required_fields=["amont"]), USER,
        )

    assert exc.value.status_code == 422
    assert "amont" in str(exc.value.detail)
    assert db.rows("crm_deal_statuses")[1].get("required_fields") is None


@pytest.mark.parametrize(
    "field", ["status_id", "probability", "name", "zoho_id", "id"],
)
async def test_only_requirable_columns_may_be_required(
    db: FakeCrmDB, field: str,
) -> None:
    """Real deal columns that are still not requirable: what the move sets,
    what the platform supplies, what is already NOT NULL, what is provenance."""
    stages = _deal_pipeline(db)

    with pytest.raises(HTTPException) as exc:
        await crm_admin.patch_status(
            "deal", str(stages["Proposal"].id),
            crm_admin.StatusIn(required_fields=[field]), USER,
        )

    assert exc.value.status_code == 422


async def test_a_repeated_required_field_is_422(db: FakeCrmDB) -> None:
    """The blocked-move 422 lists what is missing, and a duplicate would name
    the same field twice in it."""
    stages = _deal_pipeline(db)

    with pytest.raises(HTTPException) as exc:
        await crm_admin.patch_status(
            "deal", str(stages["Proposal"].id),
            crm_admin.StatusIn(required_fields=["amount", "amount"]), USER,
        )

    assert exc.value.status_code == 422


async def test_the_settings_grid_can_set_both_columns(db: FakeCrmDB) -> None:
    stages = _deal_pipeline(db)

    result = await crm_admin.patch_status(
        "deal", str(stages["Proposal"].id),
        crm_admin.StatusIn(
            required_fields=["amount", "expected_close_date"], max_dwell_days=14,
        ),
        USER,
    )

    assert result.required_fields == ["amount", "expected_close_date"]
    assert result.max_dwell_days == 14


async def test_the_requirements_can_be_cleared(db: FakeCrmDB) -> None:
    """An empty list is how a stage stops demanding things — and it must be a
    legal write, or a requirement set by mistake is permanent."""
    stages = _deal_pipeline(db)
    _gate(db, stages["Proposal"], "amount")

    result = await crm_admin.patch_status(
        "deal", str(stages["Proposal"].id),
        crm_admin.StatusIn(required_fields=[]), USER,
    )

    assert result.required_fields == []


@pytest.mark.parametrize("days", [0, -1, 40000])
async def test_a_rot_threshold_outside_the_column_is_422(
    db: FakeCrmDB, days: int,
) -> None:
    """0 would paint every card in the stage amber the moment it arrived, which
    reads as a bug rather than as a policy; NULL is how you say "never"."""
    stages = _deal_pipeline(db)

    with pytest.raises(HTTPException) as exc:
        await crm_admin.patch_status(
            "deal", str(stages["Proposal"].id),
            crm_admin.StatusIn(max_dwell_days=days), USER,
        )

    assert exc.value.status_code == 422


async def test_a_rot_threshold_may_be_cleared_to_never(db: FakeCrmDB) -> None:
    stages = _deal_pipeline(db)

    result = await crm_admin.patch_status(
        "deal", str(stages["Proposal"].id),
        crm_admin.StatusIn(max_dwell_days=None), USER,
    )

    assert result.max_dwell_days is None


@pytest.mark.parametrize(
    "payload",
    [
        {"required_fields": ["amount"]},
        {"max_dwell_days": 14},
    ],
)
async def test_a_lead_status_refuses_both_deal_only_columns(
    db: FakeCrmDB, payload: dict,
) -> None:
    """`crm_lead_statuses` has neither column, so an INSERT/UPDATE naming one
    would surface as a driver error rather than as the 422 this rule already
    knows how to say — WS-26c dw 3, one ticket later."""
    stages = _lead_pipeline(db)

    with pytest.raises(HTTPException) as exc:
        await crm_admin.patch_status(
            "lead", str(stages["New"].id), crm_admin.StatusIn(**payload), USER,
        )

    assert exc.value.status_code == 422
    assert "deal-only" in str(exc.value.detail)


async def test_a_position_only_patch_is_still_not_a_forecast_decision(
    db: FakeCrmDB,
) -> None:
    """The WS-26f regression, re-asserted because WS-26h adds two validators
    ABOVE the clamp's early return: a reorder must not start answering 422
    about a probability the caller never mentioned, or the settings grid's
    reorder loop aborts partway and leaves duplicate positions behind."""
    stages = _deal_pipeline(db)
    # A lane already contradicting D-CRM-10, the shape the Zoho importer mints.
    contradictory = db.seed(
        "crm_deal_statuses", name="Imported Won", type="won", position=70,
        probability=0,
    )

    result = await crm_admin.patch_status(
        "deal", str(contradictory.id), crm_admin.StatusIn(position=15), USER,
    )

    assert result.position == 15


# ── closed_at and probability ───────────────────────────────────────────────

@pytest.mark.parametrize("stage", ["Closed Won", "Closed Lost"])
async def test_entering_a_terminal_status_stamps_closed_at(
    db: FakeCrmDB, stage: str,
) -> None:
    stages = _deal_pipeline(db)
    reason = db.seed("crm_lost_reasons", label="Price", position=10)
    deal = _seed_deal(db, stages["Qualification"], lost_reason_id=str(reason.id))

    result = await crm_records.patch_record(
        DEALS, str(deal.id), crm_core.DealIn(status_id=str(stages[stage].id)), USER,
    )
    assert result["closed_at"] is not None


async def test_a_non_terminal_transition_leaves_closed_at_alone(
    db: FakeCrmDB,
) -> None:
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"])
    result = await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )
    assert result["closed_at"] is None


async def test_a_transition_fills_a_null_probability_from_the_stage(
    db: FakeCrmDB,
) -> None:
    """§3.4's auto-fill — a forecast column nobody types into stays empty."""
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"], probability=None)

    result = await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )
    assert result["probability"] == 50


async def test_a_transition_never_overwrites_a_stated_probability(
    db: FakeCrmDB,
) -> None:
    """"Auto-filled when NULL" is the whole rule; overwriting a number a human
    typed would make the field unusable."""
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"], probability=85)

    result = await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id)), USER,
    )
    assert result["probability"] == 85


async def test_a_probability_sent_with_the_move_wins(db: FakeCrmDB) -> None:
    stages = _deal_pipeline(db)
    deal = _seed_deal(db, stages["Qualification"], probability=None)

    result = await crm_records.patch_record(
        DEALS, str(deal.id),
        crm_core.DealIn(status_id=str(stages["Proposal"].id), probability=20), USER,
    )
    assert result["probability"] == 20


# ── Leads have no stage-age column ──────────────────────────────────────────

async def test_a_lead_transition_reads_dwell_from_the_change_log(
    db: FakeCrmDB,
) -> None:
    """Leads carry no `status_changed_at` by design (§3.3), so dwell comes from
    the log itself — falling back to `created_at` on the first move. Both mean
    time-in-status, not time-since-creation."""
    stages = _lead_pipeline(db)
    lead = db.seed(
        LEADS.table, lead_name="Anitha Kumar", status_id=stages["New"].id,
        created_at=datetime.now(UTC) - timedelta(days=5),
    )

    await crm_records.patch_record(
        LEADS, str(lead.id),
        crm_core.LeadIn(status_id=str(stages["Contacted"].id)), USER,
    )

    [entry] = db.rows("crm_status_changes")
    assert entry["entity_type"] == "lead"
    assert 5 * 86_400 - 60 <= entry["dwell_seconds"] <= 5 * 86_400 + 60
    assert any("max(changed_at)" in s for s in db.statements)


async def test_a_lead_transition_writes_no_stage_age_column(
    db: FakeCrmDB,
) -> None:
    """`crm_leads` has no `status_changed_at`; writing one would be a 500."""
    stages = _lead_pipeline(db)
    lead = db.seed(
        LEADS.table, lead_name="Anitha Kumar", status_id=stages["New"].id,
    )
    await crm_records.patch_record(
        LEADS, str(lead.id),
        crm_core.LeadIn(status_id=str(stages["Contacted"].id)), USER,
    )
    # The transition emits two UPDATEs on this table — the record write and
    # `bump_last_activity` — so name the one under test rather than assuming
    # there is only one.
    [update] = [
        s for s in db.statements_touching("UPDATE crm_leads SET")
        if "status_id" in s
    ]
    assert "status_changed_at" not in update


# ── The board ───────────────────────────────────────────────────────────────

async def test_the_pipeline_renders_every_lane_including_empty_ones(
    db: FakeCrmDB,
) -> None:
    """A kanban that hides its empty columns is a list."""
    stages = _deal_pipeline(db)
    _seed_deal(db, stages["Qualification"], amount=100_000.0)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=50, user=USER)

    assert [lane.status.name for lane in board.lanes] == [
        "Qualification", "Proposal", "Closed Won", "Closed Lost",
    ]
    assert board.lanes[1].rows == []
    assert board.lanes[1].count == 0


async def test_each_lane_carries_its_count_and_rupee_total(
    db: FakeCrmDB,
) -> None:
    stages = _deal_pipeline(db)
    _seed_deal(db, stages["Proposal"], amount=100_000.0)
    _seed_deal(db, stages["Proposal"], amount=250_000.0)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=50, user=USER)
    proposal = next(x for x in board.lanes if x.status.name == "Proposal")

    assert proposal.count == 2
    assert proposal.amount == 350_000.0


async def test_lane_totals_cover_the_whole_lane_not_the_returned_page(
    db: FakeCrmDB,
) -> None:
    """A header that counts only the page it returned lies about a busy lane —
    and the busy lane is the one somebody is looking at."""
    stages = _deal_pipeline(db)
    for _ in range(4):
        _seed_deal(db, stages["Proposal"], amount=50_000.0)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=2, user=USER)
    proposal = next(x for x in board.lanes if x.status.name == "Proposal")

    assert len(proposal.rows) == 2
    assert proposal.count == 4
    assert proposal.amount == 200_000.0


async def test_the_board_can_be_scoped_to_one_owner_case_insensitively(
    db: FakeCrmDB,
) -> None:
    stages = _deal_pipeline(db)
    _seed_deal(db, stages["Proposal"], owner_email="VJVarada@Fracktal.in")
    _seed_deal(db, stages["Proposal"], owner_email="someone@fracktal.in")

    board = await crm_pipeline.get_pipeline(
        owner="vjvarada@FRACKTAL.IN", per_lane=50, user=USER,
    )
    proposal = next(x for x in board.lanes if x.status.name == "Proposal")

    assert proposal.count == 1


# ── WS-26f f3 · weighted ₹ per lane (done-when 6, the SQL half) ────────────
#
# The lane number binds the SQL and `board.ts`'s pure function binds the same
# formula for the header rollup (C4). It cannot be derived from `rows`: those
# are capped at `per_lane` and the browser sends no cap at all, so a
# rows-derived total would under-report exactly the busy lane on screen.

async def test_a_lane_weights_by_the_deals_own_probability(
    db: FakeCrmDB,
) -> None:
    """D-CRM-10: forecast math reads the DEAL, never the stage. A rep who knows
    the champion just left marks a Proposal-stage deal at 20 without moving
    it, and the forecast has to believe them."""
    stages = _deal_pipeline(db)
    _seed_deal(db, stages["Proposal"], amount=100_000.0, probability=20)
    _seed_deal(db, stages["Proposal"], amount=200_000.0, probability=75)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=50, user=USER)
    proposal = next(x for x in board.lanes if x.status.name == "Proposal")

    assert proposal.amount == 300_000.0
    assert proposal.weighted == 20_000.0 + 150_000.0


async def test_a_null_probability_inherits_the_stage_default(
    db: FakeCrmDB,
) -> None:
    """The inheritance materializes on entry, so a NULL survives only on rows
    that predate a move — the imported ones, which is most of the board today.
    Reading them as 0% would zero the forecast on exactly those rows."""
    stages = _deal_pipeline(db)
    _seed_deal(db, stages["Proposal"], amount=100_000.0, probability=None)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=50, user=USER)
    proposal = next(x for x in board.lanes if x.status.name == "Proposal")

    assert proposal.status.probability == 50
    assert proposal.weighted == 50_000.0


async def test_a_zero_probability_is_a_measurement_not_a_missing_value(
    db: FakeCrmDB,
) -> None:
    stages = _deal_pipeline(db)
    _seed_deal(db, stages["Proposal"], amount=100_000.0, probability=0)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=50, user=USER)
    proposal = next(x for x in board.lanes if x.status.name == "Proposal")

    assert proposal.weighted == 0.0
    assert proposal.amount == 100_000.0


@pytest.mark.parametrize("lane", ["Closed Won", "Closed Lost"])
async def test_a_terminal_lane_forecasts_nothing(
    db: FakeCrmDB, lane: str,
) -> None:
    """Won revenue is CLOSED, not pipeline, and a lost deal forecasts nothing.
    Both lanes still carry their ₹ total — WS-26g's win/loss block reads it."""
    stages = _deal_pipeline(db)
    _seed_deal(db, stages[lane], amount=500_000.0, probability=100)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=50, user=USER)
    terminal = next(x for x in board.lanes if x.status.name == lane)

    assert terminal.amount == 500_000.0
    assert terminal.weighted == 0.0


async def test_an_on_hold_lane_is_excluded_from_the_weighted_total(
    db: FakeCrmDB,
) -> None:
    """``on_hold`` is a fifth status type §5.1's prose never mentions, and it
    is deliberately NOT weighted: a deal nobody is working is not a forecast,
    and counting it at its stage's prior is how a pipeline number stays high
    while the quarter empties."""
    parked = db.seed(
        "crm_deal_statuses", name="Parked", type="on_hold", position=40,
        probability=40, is_default=False,
    )
    _seed_deal(db, parked, amount=1_000_000.0, probability=40)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=50, user=USER)
    lane = next(x for x in board.lanes if x.status.name == "Parked")

    assert lane.amount == 1_000_000.0
    assert lane.weighted == 0.0
    assert set(crm_core.WEIGHTED_TYPES) == {"open", "ongoing"}


async def test_the_weighted_total_covers_the_whole_lane_not_the_page(
    db: FakeCrmDB,
) -> None:
    """The reason it is SQL and not `rows.reduce(...)`: the browser asks for no
    per-lane cap, and the gateway's default is 50."""
    stages = _deal_pipeline(db)
    for _ in range(4):
        _seed_deal(db, stages["Proposal"], amount=100_000.0, probability=50)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=2, user=USER)
    proposal = next(x for x in board.lanes if x.status.name == "Proposal")

    assert len(proposal.rows) == 2
    assert proposal.weighted == 200_000.0


async def test_the_weighted_aggregate_binds_the_stage_default(
    db: FakeCrmDB,
) -> None:
    """Structural: the fallback is the lane's OWN probability, bound like every
    other caller value in this package rather than interpolated — and dropping
    the COALESCE is what would silently read every pre-move NULL as 0%."""
    stages = _deal_pipeline(db)
    _seed_deal(db, stages["Proposal"], amount=100_000.0)

    await crm_pipeline.get_pipeline(owner=None, per_lane=50, user=USER)
    aggregates = db.statements_touching("AS weighted")

    assert aggregates, "the lane aggregate lost its weighted total"
    assert "COALESCE(probability, :stage_probability)" in aggregates[0]
    proposal_call = next(
        params for statement, params in db.calls
        if "AS weighted" in statement
        and params.get("status_id") == str(stages["Proposal"].id)
    )
    assert proposal_call["stage_probability"] == 50


# ── WS-26c · kanban cards carry the account name (done-when 2) ─────────────

async def test_a_board_card_carries_its_organization_name(
    db: FakeCrmDB,
) -> None:
    """The board is the surface that most needs it: a card shows
    name/org/amount/owner/stage-age, and the browser cannot client-side join
    the account list because that list is paged at 100."""
    stages = _deal_pipeline(db)
    org = db.seed("crm_organizations", name="Bosch India")
    _seed_deal(db, stages["Proposal"], amount=100_000.0, organization_id=org.id)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=50, user=USER)
    proposal = next(x for x in board.lanes if x.status.name == "Proposal")

    assert proposal.rows[0]["organization_name"] == "Bosch India"


async def test_a_board_card_without_an_organization_still_renders(
    db: FakeCrmDB,
) -> None:
    """LEFT, not INNER — a walk-in filament order has no account and must not
    disappear from the lane it is sitting in."""
    stages = _deal_pipeline(db)
    _seed_deal(db, stages["Proposal"], amount=8_000.0)

    board = await crm_pipeline.get_pipeline(owner=None, per_lane=50, user=USER)
    proposal = next(x for x in board.lanes if x.status.name == "Proposal")

    assert proposal.count == 1
    assert proposal.rows[0]["organization_name"] is None


async def test_the_lane_query_joins_after_its_own_limit(
    db: FakeCrmDB,
) -> None:
    """Structural: per_lane caps the rows the join runs over. A join outside
    the limit would resolve an account name for every deal in the stage to
    return the first fifty."""
    stages = _deal_pipeline(db)
    _seed_deal(db, stages["Proposal"], amount=1.0)

    await crm_pipeline.get_pipeline(owner=None, per_lane=2, user=USER)
    joined = db.statements_touching("LEFT JOIN crm_organizations")

    assert joined, "the board lost its organization-name projection"
    assert "LIMIT :limit) base LEFT JOIN" in joined[0]
    assert joined[0].rstrip().endswith("base.id DESC")


# ── Structural fences ───────────────────────────────────────────────────────

def test_the_entity_type_vocabulary_matches_the_migration_check() -> None:
    """`crm_status_changes.entity_type` has a CHECK; a slug this map invents
    would be an IntegrityError on the first transition of that kind."""
    from pathlib import Path

    migration = (
        Path(__file__).resolve().parents[2] / "infra" / "postgres" / "144_crm.sql"
    ).read_text(encoding="utf-8")

    assert "entity_type IN ('lead', 'deal')" in migration
    assert set(crm_pipeline.ENTITY_TYPES.values()) == {"lead", "deal"}
    # And every entity WITH a status pipeline has an entry, or its transitions
    # would raise a KeyError instead of logging.
    for entity in (LEADS, DEALS):
        assert entity.slug in crm_pipeline.ENTITY_TYPES


def test_the_transition_is_the_only_writer_of_status_change_rows() -> None:
    """One writer, so the three effects cannot be produced separately. If a
    second module starts inserting into crm_status_changes, the funnel can
    disagree with the timeline and nothing will say so."""
    from pathlib import Path

    package = Path(crm_core.__file__).parent
    writers = sorted(
        path.name for path in package.glob("*.py")
        if "crm_status_changes" in path.read_text(encoding="utf-8")
        and "INSERT" not in path.name
        and 'insert_row(db, "crm_status_changes"' in path.read_text(encoding="utf-8")
    )
    assert writers == ["pipeline.py"], writers


def test_the_zoho_pull_never_enters_the_stage_gate() -> None:
    """WS-26h — the importer and the sync engine must NOT route their status
    writes through :func:`apply_status_transition`.

    This is a live-system property, not a style preference. The sync loop is
    **enabled on production** and pulls every cycle; a pulled deal carries
    whatever stage Zoho has it in, and it carries no obligation to satisfy an
    entry requirement somebody set here afterwards. Routing the pull through
    the gate would make one settings-grid save start failing every cycle for a
    whole Zoho module — fail-closed in the wrong direction, on a loop nobody is
    watching.

    Asserted structurally rather than by example, because the refactor that
    would break it is a plausible one ("make the importer use the shared
    transition helper for consistency") and no example test would be looking.
    """
    from pathlib import Path

    package = Path(crm_core.__file__).parent
    callers = sorted(
        path.name for path in package.glob("*.py")
        if "apply_status_transition(" in path.read_text(encoding="utf-8")
    )
    # `pipeline.py` defines it; `records.py` is the one request path that moves
    # a status. Nothing else — in particular not import_zoho / sync_zoho /
    # broker_handlers / auto_lead, the four that run outside a member request.
    assert callers == ["pipeline.py", "records.py"], callers
