"""Per-message audit timeline (review 3.9).

Reply Zero's History is a global feed of what the rules engine did across the
mailbox; this endpoint is its per-message inverse — open one email and read its
whole story, oldest first. These pin the assembly (received anchor + one event
per executed-rule row, chronological), the ownership 404, and that a SKIPPED run
reads as "no rule matched" rather than an applied action.
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from gateway.routes.email.automation import runner as r

_MID = "msg-1"


class _User:
    email = "u@example.com"


def _dt(day: int) -> datetime:
    return datetime(2026, 7, day, 9, 0, tzinfo=timezone.utc)


def _db_returning(msg, rows):
    """An AsyncMock db whose two execute() calls yield the message row then the
    executed-rule rows."""
    db = AsyncMock()
    first = MagicMock(fetchone=MagicMock(return_value=msg))
    second = MagicMock(fetchall=MagicMock(return_value=rows))
    db.execute.side_effect = [first, second]
    return db


async def test_timeline_assembles_received_then_events_oldest_first() -> None:
    msg = SimpleNamespace(
        id=_MID, subject="Q3 numbers", received_at=_dt(20),
        folder="inbox", from_email="cfo@acme.com", from_name="Dana")
    rows = [
        SimpleNamespace(
            id="e1", rule_id="r1", rule_name="Finance", status="APPLIED",
            automated=True, actions_taken=["LABEL"], reason="from CFO",
            action_errors=None, match_source="ai", created_at=_dt(21)),
        SimpleNamespace(
            id="e2", rule_id=None, rule_name=None, status="SKIPPED",
            automated=True, actions_taken=[], reason=None,
            action_errors=None, match_source=None, created_at=_dt(22)),
    ]
    db = _db_returning(msg, rows)
    with patch.object(r, "_get_db", AsyncMock(return_value=db)):
        out = await r.message_timeline(_MID, user=_User())

    kinds = [e["kind"] for e in out["events"]]
    assert kinds == ["received", "rule", "skipped"]
    assert out["subject"] == "Q3 numbers"
    assert out["events"][0]["from"] == "Dana"
    assert out["events"][1]["actions"] == ["LABEL"]
    # Chronological — the received anchor leads, then by timestamp.
    stamps = [e["at"] for e in out["events"]]
    assert stamps == sorted(stamps)


async def test_unowned_or_unknown_message_is_404() -> None:
    db = _db_returning(None, [])
    with patch.object(r, "_get_db", AsyncMock(return_value=db)):
        with pytest.raises(HTTPException) as ei:
            await r.message_timeline(_MID, user=_User())
    assert ei.value.status_code == 404


async def test_failed_run_carries_its_action_errors() -> None:
    msg = SimpleNamespace(
        id=_MID, subject="s", received_at=_dt(20), folder="inbox",
        from_email="a@b.com", from_name=None)
    rows = [SimpleNamespace(
        id="e1", rule_id="r1", rule_name="Archive newsletters",
        status="FAILED", automated=True, actions_taken=["ARCHIVE"],
        reason="matched", match_source="pattern", created_at=_dt(21),
        action_errors=[{"type": "ARCHIVE", "error": "provider refused"}])]
    db = _db_returning(msg, rows)
    with patch.object(r, "_get_db", AsyncMock(return_value=db)):
        out = await r.message_timeline(_MID, user=_User())

    ev = out["events"][-1]
    assert ev["status"] == "FAILED"
    assert ev["action_errors"][0]["error"] == "provider refused"
