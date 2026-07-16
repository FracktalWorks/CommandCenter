"""Unit tests for the search bar's query surface (`/email/search`).

Covers what the Outlook-style search bar composes onto a query: a folder SCOPE
(a real folder, `all`, or `starred`), closable tag pills, and from:/to: pills —
plus the filters-only case, where pills narrow the mail with no search text.

The DB session is mocked, so the generated SQL and its bound params are
inspected rather than executed.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from gateway.routes import email as m


async def _run_search(**kw):
    """Drive search_messages with a mocked DB; return (resp, sql, params)."""
    captured: list[tuple[str, dict]] = []

    async def fake_execute(stmt, params=None):
        captured.append((str(stmt), params or {}))
        r = MagicMock()
        r.scalar.return_value = 0     # count query
        r.fetchall.return_value = []  # page query → no rows
        return r

    db = AsyncMock()
    db.execute.side_effect = fake_execute
    args = dict(
        q=None, account_id="acc-1", folder=None, label=None, labels=None,
        from_addr=None, to_addr=None, received_after=None, received_before=None,
        is_read=None, is_starred=None, has_attachments=None,
        sender_category=None, hybrid=False, page=1, page_size=50,
        user=SimpleNamespace(email="u@example.com"),
    )
    args.update(kw)
    with patch.object(m.transport.search, "_get_db", AsyncMock(return_value=db)):
        resp = await m.search_messages(**args)
    sql = " ".join(s for s, _ in captured)
    params: dict = {}
    for _s, p in captured:
        params.update(p)
    return resp, sql, params


# ── Folder scope ──────────────────────────────────────────────────────────────


async def test_scope_all_excludes_junk_and_trash():
    # The "All folders" scope means every folder EXCEPT the mail the user threw
    # away — otherwise spam would bury real hits.
    _resp, sql, params = await _run_search(q="invoice", folder="all")
    assert "LOWER(em.folder) <> ALL(:folder_excludes)" in sql
    assert params["folder_excludes"] == ["junk", "trash"]
    assert "folder" not in params  # no equality predicate for a real folder


async def test_scope_real_folder_matches_case_insensitively():
    _resp, sql, params = await _run_search(q="invoice", folder="inbox")
    assert "LOWER(em.folder) = LOWER(:folder)" in sql
    assert params["folder"] == "inbox"
    assert "folder_excludes" not in params


async def test_scope_starred_is_a_flag_not_a_folder():
    _resp, sql, params = await _run_search(q="invoice", folder="starred")
    assert "em.is_starred = true" in sql
    assert "folder" not in params


async def test_no_scope_spans_every_folder():
    # `em.folder` is still SELECTed as a column — assert on the PREDICATES.
    _resp, sql, params = await _run_search(q="invoice")
    assert "LOWER(em.folder) = LOWER(:folder)" not in sql
    assert "LOWER(em.folder) <> ALL(:folder_excludes)" not in sql
    assert "folder" not in params and "folder_excludes" not in params


async def test_junk_stays_reachable_when_scoped_explicitly():
    # "all" hides junk, but selecting Junk as the scope must still search it.
    _resp, sql, params = await _run_search(q="invoice", folder="junk")
    assert "LOWER(em.folder) = LOWER(:folder)" in sql
    assert params["folder"] == "junk"


# ── Filters-only search (no text) ─────────────────────────────────────────────


async def test_filters_only_search_skips_fts_and_orders_by_recency():
    # Pills with no typed text is a first-class search ("everything tagged
    # Newsletter"). There is no relevance to rank by, so recency orders it, and
    # no headline is computed (an empty tsquery would yield an unmarked snippet
    # that the list would render as a match that matched nothing).
    _resp, sql, _params = await _run_search(q=None, labels=["Newsletter"])
    assert "websearch_to_tsquery" not in sql
    assert "ts_headline" not in sql
    assert "0.0 AS rank" in sql
    assert "'' AS highlight" in sql
    assert "ORDER BY em.received_at DESC" in sql


async def test_blank_text_is_treated_as_no_text():
    _resp, sql, _params = await _run_search(q="   ", labels=["Newsletter"])
    assert "websearch_to_tsquery" not in sql
    assert "ORDER BY em.received_at DESC" in sql


async def test_text_search_ranks_and_highlights():
    _resp, sql, params = await _run_search(q="invoice")
    assert "websearch_to_tsquery('english', :q)" in sql
    assert "ts_rank_cd" in sql
    assert "ts_headline" in sql
    assert "ORDER BY rank DESC, em.received_at DESC" in sql
    assert params["q"] == "invoice"


async def test_hybrid_without_text_does_not_embed():
    # Nothing to embed with no query — must not attempt a vector join.
    with patch("email_ingestion.email_embeddings.embed_query",
               AsyncMock(return_value=[0.1] * 1536)) as embed:
        resp, sql, _params = await _run_search(
            q=None, labels=["Newsletter"], hybrid=True)
    embed.assert_not_called()
    assert resp["hybrid"] is False
    assert "email_embeddings" not in sql


# ── Tag pills ─────────────────────────────────────────────────────────────────


async def test_tag_pills_and_together_over_labels_or_categories():
    # Rule-engine tags ("Reply", "Newsletter") live in categories; a user's own
    # labels live in labels. Both are searchable the same way, and stacked pills
    # narrow (AND), which is how a row of filter chips reads.
    _resp, sql, params = await _run_search(q=None, labels=["Reply", "Done"])
    assert ":tag_0 = ANY(COALESCE(em.labels, '{}'))" in sql
    assert ":tag_0 = ANY(COALESCE(em.categories, '{}'))" in sql
    assert ":tag_1 = ANY(COALESCE(em.labels, '{}'))" in sql
    assert params["tag_0"] == "Reply"
    assert params["tag_1"] == "Done"


async def test_legacy_single_label_still_applies_alongside_pills():
    _resp, _sql, params = await _run_search(q=None, label="Work", labels=["Reply"])
    assert params["tag_0"] == "Work"   # legacy single label first
    assert params["tag_1"] == "Reply"


async def test_blank_tags_are_ignored():
    _resp, sql, params = await _run_search(q="hi", labels=["", "   "])
    assert "tag_0" not in params
    assert "ANY(COALESCE(em.categories" not in sql


# ── from: / to: pills ─────────────────────────────────────────────────────────


async def test_from_pill_matches_address_or_display_name():
    _resp, sql, params = await _run_search(q=None, from_addr="Fracktal Finance")
    assert "LOWER(em.from_address->>'email') LIKE :from_addr" in sql
    assert "LOWER(em.from_address->>'name') LIKE :from_addr" in sql
    assert params["from_addr"] == "%fracktal finance%"


async def test_to_pill_matches_any_to_or_cc_recipient():
    _resp, sql, params = await _run_search(q=None, to_addr="Alice@X.com")
    assert "jsonb_array_elements" in sql
    assert "em.to_addresses" in sql and "em.cc_addresses" in sql
    assert params["to_addr"] == "%alice@x.com%"


async def test_no_address_pills_means_no_address_predicates():
    _resp, sql, params = await _run_search(q="hi")
    assert "from_addr" not in params and "to_addr" not in params
    assert "jsonb_array_elements" not in sql


# ── State filters still compose with everything above ─────────────────────────


async def test_state_filters_compose_with_scope_and_pills():
    from datetime import datetime
    _resp, sql, params = await _run_search(
        q="invoice", folder="all", labels=["Receipt"], from_addr="acme",
        is_read=False, has_attachments=True, sender_category="Marketing",
        received_after="2026-05-01",
    )
    assert "em.is_read = :is_read" in sql
    assert "em.has_attachments = :has_attachments" in sql
    assert "EXISTS (SELECT 1 FROM email_senders se" in sql
    assert "em.received_at >= :received_after" in sql
    assert params["is_read"] is False
    assert params["has_attachments"] is True
    assert isinstance(params["received_after"], datetime)
    # …and the scope + pills are still applied alongside them.
    assert params["folder_excludes"] == ["junk", "trash"]
    assert params["tag_0"] == "Receipt"
    assert params["from_addr"] == "%acme%"


# ── The All view and the All scope agree ──────────────────────────────────────


async def test_messages_list_all_folder_matches_search_all_scope():
    """The sidebar's All view (`/email/messages`) and the search bar's All scope
    (`/email/search`) must resolve to the SAME set of mail — both go through
    core.folder_scope, so "all" can't come to mean two different things."""
    captured: list[tuple[str, dict]] = []

    async def fake_execute(stmt, params=None):
        captured.append((str(stmt), params or {}))
        r = MagicMock()
        r.scalar.return_value = 0
        r.fetchall.return_value = []
        return r

    db = AsyncMock()
    db.execute.side_effect = fake_execute
    with patch.object(m.transport.messages, "_get_db", AsyncMock(return_value=db)):
        await m.list_messages(
            account_id="acc-1", folder="all", label=None, query=None,
            thread_id=None, received_after=None, received_before=None,
            is_read=None, is_starred=None, has_attachments=None,
            importance=None, from_email=None, sender_category=None,
            sort="newest", page=1, page_size=50,
            user=SimpleNamespace(email="u@example.com"),
        )
    sql = " ".join(s for s, _ in captured)
    params: dict = {}
    for _s, p in captured:
        params.update(p)
    assert "LOWER(em.folder) <> ALL(:folder_excludes)" in sql
    assert params["folder_excludes"] == ["junk", "trash"]
