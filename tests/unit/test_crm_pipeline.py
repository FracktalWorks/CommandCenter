"""CRM · pipeline — status transitions, the lost gate, and the kanban board.

Spec: ``ai-company-brain/specs/crm_app.md`` §3.6, §3.9, §4 · WS-26a done-when 4.

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
