"""KB relevance ranking + keeping it out of the classifier (review 3.5).

The knowledge base used to fill the drafting budget by RECENCY first-fit, so the
newest entries won — even when an older one actually answered the email. And the
same enriched `about` (KB included) fed the thread-status classifier, where
drafting facts are pure noise. These pin: relevance ranking, recency fallback,
and include_kb=False dropping the block without even querying the table.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from gateway.routes.email.automation import assistant as a


def _kb(title: str, content: str) -> SimpleNamespace:
    return SimpleNamespace(title=title, content=content)


def test_ranking_puts_the_most_relevant_entry_first() -> None:
    rows = [
        _kb("Refund policy", "how to issue a refund for an order"),
        _kb("Shipping", "carriers, tracking and delivery windows"),
        _kb("Onboarding", "welcome sequence for new customers"),
    ]
    ranked = a._rank_kb_by_relevance(
        rows, "a customer is asking about a refund on their order")
    assert ranked[0].title == "Refund policy"


def test_no_query_keeps_recency_order() -> None:
    rows = [_kb("A", "x"), _kb("B", "y")]
    assert a._rank_kb_by_relevance(rows, None) == rows
    assert a._rank_kb_by_relevance(rows, "   ") == rows


def test_ties_keep_incoming_order_stable() -> None:
    # Neither matches "zzz" → all score 0 → order preserved (recency).
    rows = [_kb("A", "one"), _kb("B", "two"), _kb("C", "three")]
    assert [k.title for k in a._rank_kb_by_relevance(rows, "zzz qqq")] == \
        ["A", "B", "C"]


def _fake_db(kb_rows: list):
    """Routes _load_assistant_about's queries; records whether KB was selected."""
    seen = {"kb_queried": False}

    async def fake_execute(stmt, params=None):
        sql = str(stmt)
        r = MagicMock()
        if "FROM email_assistant_settings" in sql:
            r.fetchone.return_value = SimpleNamespace(
                about="I run Fracktal.", signature="— V",
                personal_instructions=None, writing_style=None,
                learned_writing_style=None)
        elif "FROM email_knowledge" in sql:
            seen["kb_queried"] = True
            r.fetchall.return_value = kb_rows
        else:  # learned_patterns
            r.fetchall.return_value = []
        return r

    db = AsyncMock()
    db.execute.side_effect = fake_execute
    return db, seen


async def test_include_kb_false_drops_the_block_and_skips_the_query() -> None:
    db, seen = _fake_db([_kb("Refund", "refund steps")])
    about, _sig = await a._load_assistant_about(
        db, "acc-1", include_kb=False)
    assert "<knowledge_base>" not in about
    assert seen["kb_queried"] is False, "must not even query KB when excluded"


async def test_default_includes_kb_ranked_by_query() -> None:
    db, seen = _fake_db([
        _kb("Shipping", "delivery windows"),
        _kb("Refund policy", "how to issue a refund"),
    ])
    about, _sig = await a._load_assistant_about(
        db, "acc-1", query="refund please")
    assert seen["kb_queried"] is True
    assert "<knowledge_base>" in about
    # The refund entry (relevant) leads the block, ahead of the newer Shipping.
    assert about.index("Refund policy") < about.index("Shipping")
