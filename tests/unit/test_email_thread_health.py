"""The #110 invariant gets a permanent alarm, sharing ONE damage definition.

#112 was a one-off script that healed conversation threads the cleaner/runner
had re-damaged. A script no one remembers to run is not a regression alarm, so
the same damage definition is now also a counted health metric on the analytics
overview. These tests pin that:

  * the count is scoped like the overview (per-account, per-user, or unscoped),
  * the metric and the repair script share the SAME SQL constant — if the two
    definitions of "damaged" ever drift, the alarm lies about the fix.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.routes.email.automation import replyzero as rz


def _db(n: int = 0) -> AsyncMock:
    db = AsyncMock()
    db.execute.return_value = MagicMock(
        fetchone=MagicMock(return_value=SimpleNamespace(n=n)))
    return db


def _last_sql(db: AsyncMock) -> str:
    return str(db.execute.call_args[0][0])


def _last_params(db: AsyncMock) -> dict:
    return db.execute.call_args[0][1]


async def test_count_returns_the_row_count_as_int() -> None:
    db = _db(n=7)
    assert await rz.count_damaged_conversation_threads(db) == 7


async def test_unscoped_count_has_no_where_filter() -> None:
    db = _db()
    await rz.count_damaged_conversation_threads(db)
    sql = _last_sql(db)
    # Wraps the shared definition in a COUNT, no account/user filter.
    assert "COUNT(*)" in sql
    assert "d.account_id" not in sql
    assert _last_params(db) == {}


async def test_account_scoped_count_filters_by_account() -> None:
    db = _db()
    await rz.count_damaged_conversation_threads(db, account_id="acc-1")
    assert "d.account_id = :aid" in _last_sql(db)
    assert _last_params(db)["aid"] == "acc-1"


async def test_user_scoped_count_filters_by_owned_accounts() -> None:
    db = _db()
    await rz.count_damaged_conversation_threads(db, user_email="u@example.com")
    sql = _last_sql(db)
    assert "d.account_id IN (SELECT id FROM email_accounts WHERE user_id = :uid)" in sql
    assert _last_params(db)["uid"] == "u@example.com"


def test_the_damage_definition_lives_in_exactly_one_place() -> None:
    # The metric owns the canonical SQL; the repair script must import it, not
    # keep its own copy (the drift the alarm exists to prevent).
    assert "SELECT DISTINCT ts.account_id" in rz.DAMAGED_CONVERSATION_THREADS_SQL
    root = Path(__file__).resolve().parents[2]
    script = (root / "scripts/repair_conversation_threads.py").read_text(
        encoding="utf-8")
    assert "DAMAGED_CONVERSATION_THREADS_SQL" in script
    # No second inline copy of the SELECT hiding in the script.
    assert "SELECT DISTINCT ts.account_id" not in script


if __name__ == "__main__":  # pragma: no cover
    pytest.main([__file__, "-q"])
