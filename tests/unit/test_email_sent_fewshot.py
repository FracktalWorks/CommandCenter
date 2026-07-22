"""Draft-in-my-voice: the semantic Sent few-shot (review 3.1).

_fetch_sent_fewshot embeds what's being replied to and cosine-matches the
account's OWN Sent mail (any recipient) so the drafter mirrors the owner's
register. It must be a true no-op (no DB, no cost) when semantic search is off,
and quote-strip the matched Sent bodies when it's on. These pin both.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import email_ingestion.email_embeddings as emb
from gateway.routes.email.automation import drafting as d


async def test_no_cost_no_query_when_semantic_search_is_off() -> None:
    # embed_query returns None when the flag is off — the helper must return ""
    # WITHOUT touching the DB (no vector query, no embedding spend).
    db = AsyncMock()
    with patch.object(emb, "embed_query", AsyncMock(return_value=None)):
        out = await d._fetch_sent_fewshot(db, "acc-1", "Subject", "Body")
    assert out == ""
    db.execute.assert_not_awaited()


async def test_matches_sent_mail_and_strips_quotes() -> None:
    rows = [
        SimpleNamespace(
            body_text="Happy to help — here's the plan.\n\nOn Mon X wrote:\n> old",
            snippet=""),
        SimpleNamespace(body_text="Sounds good, shipping today.", snippet=""),
    ]
    db = AsyncMock()
    db.execute.return_value = MagicMock(
        fetchall=MagicMock(return_value=rows))
    with patch.object(emb, "embed_query",
                      AsyncMock(return_value=[0.1] * 1536)):
        out = await d._fetch_sent_fewshot(
            db, "acc-1", "Re: plan", "what's the plan?",
            exclude_thread_id="t-current")
    # The vector query targets Sent mail, orders by cosine distance, and excludes
    # the current thread so a reply can't echo itself.
    sql = str(db.execute.await_args[0][0])
    params = db.execute.await_args[0][1]
    assert "email_embeddings ee" in sql
    assert "LOWER(COALESCE(em.folder, '')) = 'sent'" in sql
    assert "ee.embedding <=> CAST(:qv AS vector) ASC" in sql
    assert params["extid"] == "t-current"
    # Quoted chain stripped from each example; both included, ----separated.
    assert "here's the plan." in out
    assert "> old" not in out
    assert "shipping today." in out
    assert "---" in out


async def test_embedding_failure_is_swallowed() -> None:
    db = AsyncMock()
    with patch.object(emb, "embed_query",
                      AsyncMock(side_effect=RuntimeError("gateway down"))):
        out = await d._fetch_sent_fewshot(db, "acc-1", "s", "b")
    assert out == ""
