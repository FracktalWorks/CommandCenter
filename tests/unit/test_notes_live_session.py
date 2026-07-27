"""Tests for the live-session registry (presence + copilot opt-in).

The route bodies need Postgres, so these cover what's checkable without it: the
row→model mapping the presence dock renders, the opt-in defaults, and the
migration contract that ``begin()``'s idempotent upsert depends on.
"""
from __future__ import annotations

import pathlib
import types

from gateway.routes.notes import live_session as lsess

_MIGRATION = (
    pathlib.Path(__file__).resolve().parents[2] / "infra/postgres/120_live_session.sql"
)


def _row(**over) -> types.SimpleNamespace:
    base = {
        "id": "sess-1",
        "meeting_id": "m-1",
        "source": "bot",
        "owner_email": "a@b.c",
        "status": "live",
        "copilot_enabled": False,
        "mode": "listening",
        "started_at": None,
        "ended_at": None,
        "title": "Acme call",
    }
    base.update(over)
    return types.SimpleNamespace(**base)


def test_row_maps_to_presence_model() -> None:
    m = lsess._row_to_session(_row())
    assert m.meeting_id == "m-1"
    assert m.source == "bot"
    assert m.title == "Acme call"       # denormalised so the dock needs no 2nd call
    assert m.status == "live"


def test_copilot_is_off_by_default() -> None:
    """The copilot must never run unless explicitly enabled for a session."""
    m = lsess._row_to_session(_row())
    assert m.copilot_enabled is False
    assert m.mode == "listening"        # least-stakes mode


def test_modes_escalate_in_stakes() -> None:
    assert lsess._MODES == ("listening", "interactive", "speaking")


def test_title_is_optional() -> None:
    row = _row()
    del row.title                        # rows from a query without the join
    assert lsess._row_to_session(row).title is None


# ── migration contract ───────────────────────────────────────────────────────

def test_migration_has_partial_unique_index() -> None:
    """begin() upserts via ON CONFLICT (meeting_id) WHERE status = 'live'; that
    inference REQUIRES this partial unique index. Without it a reconnect would
    fork presence into two live rows."""
    sql = _MIGRATION.read_text()
    assert "CREATE UNIQUE INDEX IF NOT EXISTS live_session_one_live_per_meeting" in sql
    assert "ON live_session (meeting_id) WHERE status = 'live'" in sql


def test_migration_is_idempotent_and_additive() -> None:
    sql = _MIGRATION.read_text()
    assert "CREATE TABLE IF NOT EXISTS live_session" in sql
    assert "DROP TABLE" not in sql.upper()
