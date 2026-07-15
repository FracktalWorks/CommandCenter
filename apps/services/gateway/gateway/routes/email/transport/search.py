"""Transport · search — reliable, ranked full-text search across ALL email.

This is the dedicated search surface (``GET /email/search``), distinct from the
folder-oriented ``/email/messages`` list:

  • It searches the WHOLE message — subject + body_text + sender name + email —
    over an FTS index whose expression matches the query exactly (migration 72),
    so body matches are found via the GIN index, not a sequential scan.
  • It ranks by relevance (``ts_rank_cd``), not just recency, so the best match
    surfaces first — with recency as the tie-break.
  • It searches ACROSS folders and (optionally) across all of the user's
    accounts by default — "search all emails" means all of them, not just the
    open inbox.
  • It returns a highlighted snippet (``ts_headline``) so the UI can show WHY a
    message matched.
  • It accepts ``websearch_to_tsquery`` syntax: bare words are AND-ed, "quoted
    phrases" match adjacency, ``OR`` unions, and a leading ``-`` excludes — the
    grammar users already expect from web search.

The additive filters (folder, date range, read/starred/attachments, sender
category) mirror ``/email/messages`` so search composes with filtering.

Phase 2 (semantic re-ranking over pgvector embeddings) layers ON TOP of this via
``hybrid=true`` — see ``semantic.py``. With semantics off, this endpoint is a
complete, reliable lexical search on its own.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, Query
from gateway.routes.email.core import (
    _account_scope,
    _get_db,
    _row_to_message,
    router,
)
from sqlalchemy import text

# The tsvector expression — MUST stay byte-for-byte identical to the GIN index
# in migration 72 (idx_email_messages_fts_body) so the planner uses the index
# instead of recomputing per row. One constant, referenced everywhere it's
# needed (WHERE match, rank, headline), so they can never drift apart.
_FTS_VECTOR = (
    "to_tsvector('english', "
    "coalesce(em.subject,'') || ' ' || "
    "coalesce(em.body_text,'') || ' ' || "
    "coalesce(em.from_address->>'name','') || ' ' || "
    "coalesce(em.from_address->>'email',''))"
)

# What the highlighter runs over — subject + body only (sender is shown
# separately on the card, no need to highlight it inside the snippet).
_HEADLINE_SOURCE = (
    "coalesce(em.subject,'') || ' — ' || coalesce(em.body_text, em.snippet, '')"
)


def _parse_dt(value: str | None) -> Any:
    if not value:
        return None
    try:
        from datetime import datetime  # noqa: PLC0415
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return None


@router.get("/search")
async def search_messages(
    q: str = Query(..., min_length=1, description="Search query (websearch syntax)"),
    account_id: str | None = Query(None, description="Limit to one account"),
    folder: str | None = Query(None, description="Limit to one folder"),
    label: str | None = Query(None),
    received_after: str | None = Query(None),
    received_before: str | None = Query(None),
    is_read: bool | None = Query(None),
    is_starred: bool | None = Query(None),
    has_attachments: bool | None = Query(None),
    sender_category: str | None = Query(None),
    hybrid: bool = Query(
        False, description="Blend semantic (vector) similarity into the ranking"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: UserContext = Depends(get_current_user),
):
    """Ranked full-text search over all of the user's email (all folders, all
    accounts unless narrowed). Returns messages ordered by relevance, each with a
    ``rank`` and a highlighted ``highlight`` snippet, plus ``total`` for paging.

    An empty/whitespace query yields no results (rather than every email) — the
    caller decides whether to fall back to the plain folder list."""
    db = await _get_db()
    try:
        uid = user.email or "anonymous"
        params: dict[str, Any] = {"uid": uid, "q": q}

        where = [_account_scope(account_id, params),
                 f"{_FTS_VECTOR} @@ websearch_to_tsquery('english', :q)"]

        if folder:
            where.append("em.folder = :folder")
            params["folder"] = folder
        if label:
            where.append("(:label = ANY(COALESCE(em.labels, '{}'))"
                         " OR :label = ANY(em.categories))")
            params["label"] = label
        dt_after, dt_before = _parse_dt(received_after), _parse_dt(received_before)
        if dt_after is not None:
            where.append("em.received_at >= :received_after")
            params["received_after"] = dt_after
        if dt_before is not None:
            where.append("em.received_at <= :received_before")
            params["received_before"] = dt_before
        if is_read is not None:
            where.append("em.is_read = :is_read")
            params["is_read"] = is_read
        if is_starred is not None:
            where.append("em.is_starred = :is_starred")
            params["is_starred"] = is_starred
        if has_attachments is not None:
            where.append("em.has_attachments = :has_attachments")
            params["has_attachments"] = has_attachments
        if sender_category:
            where.append(
                "EXISTS (SELECT 1 FROM email_senders se "
                "WHERE se.account_id = em.account_id "
                "AND LOWER(se.email) = LOWER(em.from_address->>'email') "
                "AND LOWER(se.category) = LOWER(:sender_category))")
            params["sender_category"] = sender_category

        where_sql = " AND ".join(where)

        total = (await db.execute(text(
            f"SELECT COUNT(*) FROM email_messages em WHERE {where_sql}"
        ), params)).scalar() or 0

        params["limit"] = page_size
        params["offset"] = (page - 1) * page_size

        # Hybrid re-ranking (Phase 2, opt-in): when requested AND semantic search
        # is enabled AND the query embeds, blend the lexical rank with cosine
        # similarity to the query vector. Recall stays LEXICAL — every FTS match
        # is still returned; hybrid only re-ORDERS them by semantic closeness, so
        # a reliability-first search never drops a keyword hit. If the query can't
        # be embedded (flag off, embed error), we fall through to pure lexical.
        semantic_select = "0.0 AS sim"
        order_sql = "rank DESC, em.received_at DESC"
        join_sql = ""
        if hybrid:
            qvec = None
            try:
                from email_ingestion.email_embeddings import embed_query
                qvec = await embed_query(q)
            except Exception:  # noqa: BLE001
                qvec = None
            if qvec is not None:
                params["qvec"] = "[" + ",".join(f"{x:.7f}" for x in qvec) + "]"
                # 0.5·lexical (capped to 1) + 0.5·cosine-similarity. A message
                # with no embedding yet (sim NULL → 0) still ranks on its lexical
                # score, so unembedded mail is never hidden.
                join_sql = ("LEFT JOIN email_embeddings ee "
                            "ON ee.message_id = em.id")
                semantic_select = (
                    "COALESCE(1 - (ee.embedding <=> CAST(:qvec AS vector)), 0)"
                    " AS sim")
                order_sql = (
                    "(LEAST(ts_rank_cd(" + _FTS_VECTOR +
                    ", websearch_to_tsquery('english', :q)), 1.0) * 0.5"
                    " + COALESCE(1 - (ee.embedding <=> CAST(:qvec AS vector)),"
                    " 0) * 0.5) DESC, em.received_at DESC")

        # ts_rank_cd rewards cover density (matches close together rank higher);
        # recency breaks ties so equally-relevant hits surface newest-first.
        rows = (await db.execute(text(
            f"""SELECT em.id, em.provider_message_id, em.thread_id,
                       em.account_id, em.folder, em.labels,
                       em.from_address, em.to_addresses,
                       em.cc_addresses, em.bcc_addresses,
                       em.subject, em.body_text, em.body_html,
                       em.snippet, em.has_attachments,
                       em.is_read, em.is_starred, em.is_flagged,
                       em.importance, em.categories,
                       em.received_at, em.synced_at,
                       ts_rank_cd({_FTS_VECTOR},
                           websearch_to_tsquery('english', :q)) AS rank,
                       {semantic_select},
                       ts_headline('english', {_HEADLINE_SOURCE},
                           websearch_to_tsquery('english', :q),
                           'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, '
                           'MaxWords=18, MinWords=5, FragmentDelimiter=" … "'
                       ) AS highlight
                  FROM email_messages em
                  {join_sql}
                 WHERE {where_sql}
                 ORDER BY {order_sql}
                 LIMIT :limit OFFSET :offset"""
        ), params)).fetchall()

        emails_out = []
        for row in rows:
            m = _row_to_message(row)
            d = m.model_dump()
            d["rank"] = float(getattr(row, "rank", 0.0) or 0.0)
            d["sim"] = float(getattr(row, "sim", 0.0) or 0.0)
            d["highlight"] = getattr(row, "highlight", "") or ""
            d["thread_count"] = 1
            emails_out.append(d)

        return {
            "emails": emails_out,
            "total": total,
            "page": page,
            "page_size": page_size,
            "query": q,
            "hybrid": bool(join_sql),
        }
    finally:
        await db.close()
