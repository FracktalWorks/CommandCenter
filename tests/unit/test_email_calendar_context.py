"""Calendar-aware scheduling replies (review 3.10).

When an incoming email asks about timing, the drafter should see the owner's
upcoming hard-date commitments (the internal calendar) so it can offer clashing-
free slots and never double-book. Only then — an ordinary reply must not carry
the schedule. These pin the intent heuristic and the calendar fetch.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from gateway.routes.email.automation import drafting as d


def test_detects_scheduling_questions() -> None:
    assert d._asks_about_scheduling("Meeting next week?", "Are you available?")
    assert d._asks_about_scheduling("", "when are you free to hop on a call?")
    assert d._asks_about_scheduling("Re: reschedule", "")
    assert d._asks_about_scheduling("Quick sync", "let's meet to go over it")


def test_ignores_ordinary_mail() -> None:
    assert not d._asks_about_scheduling(
        "Invoice #42", "Please find the invoice attached, thanks.")
    assert not d._asks_about_scheduling("Hello", "just saying thanks!")


async def test_calendar_fetch_reads_upcoming_hard_dates() -> None:
    rows = [
        SimpleNamespace(whn="Wed Jul 24, 14:00", title="Board meeting"),
        SimpleNamespace(whn="Thu Jul 25, 09:30", title="Dentist"),
    ]
    db = AsyncMock()
    db.execute.return_value = MagicMock(
        fetchall=MagicMock(return_value=rows))
    out = await d._fetch_calendar_context(db, "acc-1")
    sql = str(db.execute.await_args[0][0])
    # Only hard-date, still-open items in the upcoming window, from THIS account's
    # user (the same "shows on the Calendar" predicate the tasks app uses).
    assert "is_hard_date = true" in sql
    assert "disposition NOT IN ('DONE', 'TRASH')" in sql
    assert "gi.due_at >= now()" in sql
    assert "gi.user_id = ea.user_id" in sql
    assert "Board meeting" in out and "Dentist" in out


async def test_calendar_fetch_is_best_effort() -> None:
    # The tasks feature may be absent; a draft must never fail on the calendar.
    db = AsyncMock()
    db.execute.side_effect = RuntimeError("relation gtd_items does not exist")
    assert await d._fetch_calendar_context(db, "acc-1") == ""


async def test_no_scheduled_items_returns_empty() -> None:
    db = AsyncMock()
    db.execute.return_value = MagicMock(fetchall=MagicMock(return_value=[]))
    assert await d._fetch_calendar_context(db, "acc-1") == ""
