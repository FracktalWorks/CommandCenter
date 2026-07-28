"""Tests for preparing a meeting before it starts.

The app had surfaces for a meeting in progress and one that finished, but
nowhere to get ready — so the copilot walked in cold every time. These lock the
two decisions that make prep actually connect to the call: whether the copilot
runs, and whether a prepared meeting keeps its identity when capture begins.
"""
from __future__ import annotations

import pathlib

from gateway.routes.notes.core import CreateMeetingRequest, PatchMeetingRequest
from gateway.routes.notes.settings import copilot_should_run

_ROOT = pathlib.Path(__file__).resolve().parents[2]


# ── copilot precedence ───────────────────────────────────────────────────────

def test_undecided_meeting_follows_the_account_default() -> None:
    """A meeting that never expressed a preference defers — that's what makes
    the global 'turn the copilot on automatically' setting mean anything."""
    assert copilot_should_run(None, True) is True
    assert copilot_should_run(None, False) is False


def test_a_meeting_can_override_the_account_default_both_ways() -> None:
    assert copilot_should_run(True, False) is True
    assert copilot_should_run(False, True) is False


def test_off_for_one_meeting_is_not_undone_by_the_global_setting() -> None:
    """The case the tri-state exists for. If 'off' collapsed to 'unset', turning
    the copilot off for one sensitive conversation would be silently reversed by
    the account default — the opposite of what off means."""
    assert copilot_should_run(False, True) is False


# ── the wire contract ────────────────────────────────────────────────────────

def test_prep_fields_are_optional_so_a_patch_can_be_partial() -> None:
    """The prep screen saves one field at a time as you edit; a patch must not
    require sending the others back (which would race two edits against each
    other)."""
    p = PatchMeetingRequest()
    assert p.title is None
    assert p.scheduled_at is None
    assert p.copilot_enabled is None


def test_copilot_flag_survives_being_set_false() -> None:
    """Guards against `if body.copilot_enabled:` style truthiness bugs: False
    and None mean different things here."""
    assert PatchMeetingRequest(copilot_enabled=False).copilot_enabled is False
    assert PatchMeetingRequest(copilot_enabled=True).copilot_enabled is True


def test_a_meeting_can_be_created_already_scheduled() -> None:
    body = CreateMeetingRequest(scheduled_at="2026-08-01T10:00:00Z")
    assert body.scheduled_at == "2026-08-01T10:00:00Z"
    # Still optional — "record right now" creates one with no planned time.
    assert CreateMeetingRequest().scheduled_at is None


# ── schema ───────────────────────────────────────────────────────────────────

def test_migration_keeps_copilot_enabled_nullable() -> None:
    """Three states are needed, not two: on, off, and 'not decided — follow the
    account default'. A NOT NULL DEFAULT FALSE would pin every existing meeting
    to off and make the global setting unreachable."""
    sql = (_ROOT / "infra/postgres/127_meeting_prep.sql").read_text()
    assert "ADD COLUMN IF NOT EXISTS copilot_enabled BOOLEAN" in sql
    assert "copilot_enabled BOOLEAN NOT NULL" not in sql
    assert "copilot_enabled BOOLEAN DEFAULT" not in sql


def test_migration_is_additive_and_idempotent() -> None:
    """Migrations re-run on every deploy."""
    sql = (_ROOT / "infra/postgres/127_meeting_prep.sql").read_text()
    assert sql.count("IF NOT EXISTS") >= 3          # 2 columns + the index
    assert "DROP" not in sql.upper()


def test_scheduled_at_is_separate_from_start_at() -> None:
    """start_at is when capture began — the pipeline and library sort on it.
    Overloading it would make an unstarted meeting look like one that ran the
    instant it was created."""
    sql = (_ROOT / "infra/postgres/127_meeting_prep.sql").read_text()
    assert "scheduled_at TIMESTAMPTZ" in sql
    assert "start_at" not in sql.split("ALTER TABLE meeting")[1].split(";")[0]


# ── prepared meetings keep their identity ────────────────────────────────────

def test_bot_join_can_attach_to_an_existing_meeting() -> None:
    """Without this the bot creates a fresh meeting and the agenda, briefing,
    attendees and copilot decision you just set up are stranded on another row —
    which would make preparing a meeting pointless for the bot path."""
    from gateway.routes.notes.meeting_bot import BotJoinRequest

    assert BotJoinRequest(meeting_url="https://meet.google.com/x").meeting_id is None
    body = BotJoinRequest(meeting_url="https://meet.google.com/x", meeting_id="abc")
    assert body.meeting_id == "abc"


def test_session_start_consults_the_prepared_decision() -> None:
    """The seam that makes prep worth doing: the copilot is already listening
    when the call starts, rather than needing you to find the console and flip a
    switch mid-conversation."""
    src = (
        _ROOT / "apps/services/gateway/gateway/routes/notes/live_session.py"
    ).read_text()
    assert "_apply_prepared_copilot" in src
    assert "copilot_should_run" in src
    # Must not be able to take a recording down with it.
    block = src.split("async def _apply_prepared_copilot")[1]
    assert "except Exception" in block
