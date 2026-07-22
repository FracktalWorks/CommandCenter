"""Unit tests for the inbox digest generator.

The DB session is mocked, so the SQL and bound params are inspected rather than
executed. Focus: the two honesty fixes — the "awaiting your reply" count reads
the Reply Zero status table (not an all-time inbox heuristic), and the category
filter normalises the user's selections to canonical cleanup categories.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from gateway.routes import email as m


def _fake_db(captured: list[tuple[str, dict]]):
    async def fake_execute(stmt, params=None):
        sql = str(stmt)
        captured.append((sql, params or {}))
        r = MagicMock()
        if "FROM email_accounts" in sql:
            r.fetchone.return_value = SimpleNamespace(self="me@fracktal.in")
        elif "COUNT(*) AS total" in sql:
            r.fetchone.return_value = SimpleNamespace(
                total=10, unread=3, inbox=8, attachments=2)
        elif "email_thread_status" in sql:
            r.scalar.return_value = 4
        else:
            r.fetchall.return_value = []
            r.fetchone.return_value = None
            r.scalar.return_value = 0
        return r

    db = AsyncMock()
    db.execute.side_effect = fake_execute
    return db


async def test_needs_reply_reads_thread_status_not_inbox_heuristic() -> None:
    captured: list[tuple[str, dict]] = []
    out = await m.digest._generate_digest(_fake_db(captured), "acc-1", 7)
    sql = " ".join(s for s, _ in captured)
    # Reads the Reply Zero status table for NEEDS_REPLY …
    assert "email_thread_status" in sql
    assert "NEEDS_REPLY" in sql
    # … and NOT the old all-time "latest message in inbox" heuristic.
    assert "WITH latest AS" not in sql
    assert out["totals"]["needs_reply"] == 4


async def test_category_filter_normalises_and_drops_non_categories() -> None:
    captured: list[tuple[str, dict]] = []
    db = _fake_db(captured)
    await m.digest._generate_digest(
        db, "acc-1", 7,
        # rule-name variants: plural alias, wrong casing/whitespace, and a name
        # that isn't a category at all.
        ["Cold Emails", " newsletter ", "My weekly roundup"],
    )
    # The category-breakdown query binds the normalised, de-junked set.
    cat_params = [p for s, p in captured if "GROUP BY 1 ORDER BY 2 DESC" in s
                  and "cats" in p]
    assert cat_params, "category-breakdown query should bind :cats"
    assert cat_params[0]["cats"] == ["Cold Email", "Newsletter"]
