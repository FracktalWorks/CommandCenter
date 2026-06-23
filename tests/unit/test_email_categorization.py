"""Unit tests for sender auto-categorization (`_categorize_senders_job`).

This is the engine behind the just-in-time categorization hook (Phase 0 of the
inbox-zero parity plan): it categorizes only *uncategorized* senders and must
incur no LLM cost when there is nothing new. DB + LLM are mocked.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes import email as m


def _mock_db(fetchall_rows):
    db = AsyncMock()
    result = MagicMock()
    result.fetchall.return_value = fetchall_rows
    db.execute.return_value = result  # SELECT returns rows; INSERTs ignore it
    return db


async def test_categorizes_uncategorized_senders_and_commits() -> None:
    db = _mock_db([
        SimpleNamespace(email="news@a.com", name="A", subjects=["Weekly"]),
        SimpleNamespace(email="sales@b.com", name="B", subjects=["Demo?"]),
    ])
    llm = AsyncMock(return_value={"news@a.com": "Newsletter",
                                  "sales@b.com": "Marketing"})
    with patch.object(m.automation.senders, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m.automation.senders, "_llm_categorize_senders", llm):
        await m._categorize_senders_job("acc-1", 25)
    llm.assert_awaited_once()
    # 1 SELECT + 2 INSERTs.
    assert db.execute.await_count == 3
    db.commit.assert_awaited()


async def test_no_llm_cost_when_nothing_to_categorize() -> None:
    db = _mock_db([])
    llm = AsyncMock()
    with patch.object(m.automation.senders, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m.automation.senders, "_llm_categorize_senders", llm):
        await m._categorize_senders_job("acc-1", 25)
    llm.assert_not_awaited()        # no senders → no LLM call
    db.commit.assert_not_awaited()  # nothing written


async def test_failure_during_job_is_swallowed_and_cleans_up() -> None:
    # A failure mid-job (here the LLM) must not propagate, and the DB session
    # must still be closed. (A _get_db() failure is handled by the caller — the
    # sync loop wraps this call in its own try/except.)
    db = _mock_db([SimpleNamespace(email="x@a.com", name="X", subjects=[])])
    llm = AsyncMock(side_effect=RuntimeError("llm down"))
    with patch.object(m.automation.senders, "_get_db", AsyncMock(return_value=db)), \
            patch.object(m.automation.senders, "_llm_categorize_senders", llm):
        await m._categorize_senders_job("acc-1", 25)  # must not raise
    db.close.assert_awaited()
