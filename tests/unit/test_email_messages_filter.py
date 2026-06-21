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
    with patch.object(m, "_get_db", AsyncMock(return_value=db)):
        resp = await m.list_messages(
            account_id="acc-1", folder="inbox", label=label,
            query=None, thread_id=None, page=1, page_size=50, user=user,
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
