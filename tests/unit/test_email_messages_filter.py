"""Unit tests for the message-list label filter (Phase A — label UX).

Verifies `list_messages` adds the `= ANY(...)` membership clause and a bound
`label` param only when a label is supplied. The DB session is mocked, so the
SQL is inspected rather than executed.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes import email as m


async def _run_list(label):
    captured: list[tuple[str, dict]] = []

    async def fake_execute(stmt, params=None):
        captured.append((str(stmt), params or {}))
        r = MagicMock()
        r.scalar.return_value = 0     # count query
        r.fetchall.return_value = []  # page query → no rows
        return r

    db = AsyncMock()
    db.execute.side_effect = fake_execute
    user = SimpleNamespace(email="u@example.com")
    with patch.object(m.transport.messages, "_get_db", AsyncMock(return_value=db)):
        resp = await m.list_messages(
            account_id="acc-1", folder="inbox", label=label,
            query=None, thread_id=None,
            received_after=None, received_before=None, is_read=None,
            is_starred=None, has_attachments=None, importance=None,
            from_email=None, sender_category=None, sort="newest",
            page=1, page_size=50, user=user,
        )
    return resp, captured


async def test_label_filter_adds_any_clause_and_bound_param():
    resp, captured = await _run_list("Newsletter")
    sql = " ".join(s for s, _ in captured)
    assert "= ANY(em.categories)" in sql
    assert "ANY(COALESCE(em.labels" in sql
    assert any(p.get("label") == "Newsletter" for _, p in captured)
    assert resp["total"] == 0


async def test_no_label_means_no_label_clause():
    _, captured = await _run_list(None)
    sql = " ".join(s for s, _ in captured)
    assert "ANY(em.categories)" not in sql
    assert all("label" not in p for _, p in captured)


# ── Rich inbox-query filters (date / state / sender / category / sort) ────────

async def _run_list_full(**kw):
    captured: list[tuple[str, dict]] = []

    async def fake_execute(stmt, params=None):
        captured.append((str(stmt), params or {}))
        r = MagicMock()
        r.scalar.return_value = 0
        r.fetchall.return_value = []
        return r

    db = AsyncMock()
    db.execute.side_effect = fake_execute
    user = SimpleNamespace(email="u@example.com")
    args = dict(
        account_id="acc-1", folder="inbox", label=None, query=None,
        thread_id=None, received_after=None, received_before=None, is_read=None,
        is_starred=None, has_attachments=None, importance=None, from_email=None,
        sender_category=None, sort="newest", page=1, page_size=50, user=user,
    )
    args.update(kw)
    with patch.object(m.transport.messages, "_get_db", AsyncMock(return_value=db)):
        resp = await m.list_messages(**args)
    return resp, captured


async def test_no_filters_keeps_default_clauses():
    _resp, captured = await _run_list_full()
    sql = " ".join(s for s, _ in captured)
    assert "received_after" not in sql
    assert "is_read = :is_read" not in sql
    assert "email_senders se" not in sql
    assert "ORDER BY em.received_at DESC" in sql


async def test_date_state_and_sender_filters():
    from datetime import datetime
    _resp, captured = await _run_list_full(
        received_after="2026-05-01",
        received_before="2026-06-01T00:00:00Z",
        is_read=False, from_email="Acme.com", sender_category="Marketing",
        importance="high",
    )
    sql = " ".join(s for s, _ in captured)
    params: dict = {}
    for _s, p in captured:
        params.update(p)
    assert "em.received_at >= :received_after" in sql
    assert "em.received_at <= :received_before" in sql
    assert "em.is_read = :is_read" in sql
    assert "LOWER(em.from_address->>'email') LIKE :from_email" in sql
    assert "EXISTS (SELECT 1 FROM email_senders se" in sql
    assert "LOWER(em.importance) = LOWER(:importance)" in sql
    assert params["is_read"] is False
    assert params["from_email"] == "%acme.com%"     # lowercased + wrapped
    assert params["sender_category"] == "Marketing"
    assert isinstance(params["received_after"], datetime)


async def test_sort_importance_orders_by_priority_case():
    _resp, captured = await _run_list_full(sort="importance")
    sql = " ".join(s for s, _ in captured)
    assert "WHEN 'high' THEN 0" in sql
    assert "em.is_read ASC" in sql


# ── /email/priority ranked "important emails to check" ────────────────────────

async def test_priority_inbox_ranks_and_excludes_bulk():
    captured: list[tuple[str, dict]] = []

    async def fake_execute(stmt, params=None):
        captured.append((str(stmt), params or {}))
        r = MagicMock()
        r.fetchall.return_value = [SimpleNamespace(
            id="m1", thread_id="t1", subject="Contract review",
            from_address={"name": "Jo", "email": "jo@x.com"},
            received_at=None, is_read=False, importance="high",
            is_starred=False, reply_status="NEEDS_REPLY",
            sender_category="Personal", score=170)]
        return r

    db = AsyncMock()
    db.execute.side_effect = fake_execute
    user = SimpleNamespace(email="u@example.com")
    with patch.object(m.transport.messages, "_get_db",
                      AsyncMock(return_value=db)), \
            patch.object(m.transport.messages, "_assert_account_owner",
                         AsyncMock()):
        resp = await m.priority_inbox(
            account_id="acc-1", days=30, limit=20, user=user)

    sql = " ".join(s for s, _ in captured)
    assert "NEEDS_REPLY" in sql
    assert "NOT IN" in sql and "newsletter" in sql  # bulk senders excluded
    assert resp["count"] == 1
    e = resp["emails"][0]
    assert e["message_id"] == "m1"
    assert "needs reply" in e["reason"] and "unread" in e["reason"]
    assert e["score"] == 170
