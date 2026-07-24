"""Transport · messages — a conversation's thread + full-text search (read-only)."""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends, HTTPException, Query
from gateway.routes.whatsapp.core import WhatsAppMessageModel, _get_db, router
from sqlalchemy import text


def _message_model(row: Any) -> WhatsAppMessageModel:
    sender = row.sender or {}
    if isinstance(sender, str):
        import json
        try:
            sender = json.loads(sender)
        except ValueError:
            sender = {}
    return WhatsAppMessageModel(
        id=str(row.id),
        chat_id=str(row.chat_id),
        wa_message_id=row.wa_message_id,
        direction=row.direction or "in",
        kind=row.kind or "text",
        sender_name=(sender or {}).get("name", "") or "",
        body_text=row.body_text or "",
        transcript_text=getattr(row, "transcript_text", None),
        quoted_wa_message_id=row.quoted_wa_message_id,
        categories=list(row.categories or []),
        intent=row.intent,
        send_regime=row.send_regime,
        sent_at=row.sent_at.isoformat() if row.sent_at else None,
    )


async def _assert_chat_owned(db: Any, chat_id: str, user_email: str) -> None:
    owned = (await db.execute(
        text("""SELECT 1 FROM wa_chats c
                JOIN wa_accounts a ON a.id = c.account_id
                WHERE c.id = :cid AND a.user_id = :uid"""),
        {"cid": chat_id, "uid": user_email},
    )).fetchone()
    if not owned:
        raise HTTPException(status_code=404, detail="Chat not found")


@router.get("/chats/{chat_id}/messages", response_model=list[WhatsAppMessageModel])
async def list_messages(
    chat_id: str,
    limit: int = Query(100, le=500),
    user: UserContext = Depends(get_current_user),
):
    """Return a conversation's messages oldest-first (thread reading order)."""
    db = await _get_db()
    try:
        await _assert_chat_owned(db, chat_id, user.email or "anonymous")
        rows = (await db.execute(
            text("""SELECT id, chat_id, wa_message_id, direction, kind, sender,
                           body_text, transcript_text, quoted_wa_message_id,
                           categories, intent, send_regime, sent_at
                    FROM wa_messages
                    WHERE chat_id = :cid
                    ORDER BY sent_at ASC NULLS FIRST
                    LIMIT :limit"""),
            {"cid": chat_id, "limit": limit},
        )).fetchall()
        return [_message_model(r) for r in rows]
    finally:
        await db.close()


# The tsvector expression — byte-for-byte identical to migration 102's
# ``idx_wa_messages_fts`` (simple config, body + transcript + sender name) so the
# GIN index is used, not a seq scan. Kept in one place: match + rank share it.
_WA_FTS = (
    "to_tsvector('simple', "
    "coalesce(m.body_text, '') || ' ' || "
    "coalesce(m.transcript_text, '') || ' ' || "
    "coalesce(m.sender->>'name', ''))"
)


@router.get("/search", response_model=list[WhatsAppMessageModel])
async def search_messages(
    q: str = Query(..., min_length=1),
    account_id: str | None = None,
    limit: int = Query(50, le=200),
    hybrid: bool = Query(
        False, description="Blend semantic (vector) similarity into the ranking"),
    user: UserContext = Depends(get_current_user),
):
    """Full-text search across the user's WhatsApp history.

    Recall is always LEXICAL (every FTS match is returned). ``hybrid=true``
    re-ORDERS the matches by blending the lexical rank with cosine similarity to
    the query's embedding (W10) — so a keyword hit is never dropped, and semantic
    closeness only re-ranks. Requires ``whatsapp_semantic_search_enabled``; if the
    query can't be embedded (flag off / embed error), it falls through to lexical.
    """
    db = await _get_db()
    try:
        params: dict[str, Any] = {
            "uid": user.email or "anonymous", "q": q, "limit": limit,
        }
        scope = "m.account_id IN (SELECT id FROM wa_accounts WHERE user_id = :uid"
        if account_id:
            scope += " AND id = :aid"
            params["aid"] = account_id
        scope += ")"

        join_sql = ""
        order_sql = "m.sent_at DESC NULLS LAST"
        if hybrid:
            qvec = None
            try:
                from whatsapp_ingestion.wa_embeddings import embed_query
                qvec = await embed_query(q)
            except Exception:
                qvec = None
            if qvec is not None:
                params["qvec"] = "[" + ",".join(f"{x:.7f}" for x in qvec) + "]"
                # 0.5·lexical (capped to 1) + 0.5·cosine. A message with no
                # embedding yet (sim NULL → 0) still ranks on its lexical score,
                # so unembedded history is never hidden.
                join_sql = ("LEFT JOIN wa_message_embeddings e "
                            "ON e.message_id = m.id")
                order_sql = (
                    f"(LEAST(ts_rank_cd({_WA_FTS}, "
                    "plainto_tsquery('simple', :q)), 1.0) * 0.5"
                    " + COALESCE(1 - (e.embedding <=> CAST(:qvec AS vector)), 0)"
                    " * 0.5) DESC, m.sent_at DESC NULLS LAST")

        rows = (await db.execute(
            text(f"""SELECT m.id, m.chat_id, m.wa_message_id, m.direction, m.kind,
                            m.sender, m.body_text, m.transcript_text,
                            m.quoted_wa_message_id, m.categories, m.intent,
                            m.send_regime, m.sent_at
                     FROM wa_messages m
                     {join_sql}
                     WHERE {scope}
                       AND {_WA_FTS} @@ plainto_tsquery('simple', :q)
                     ORDER BY {order_sql}
                     LIMIT :limit"""),
            params,
        )).fetchall()
        return [_message_model(r) for r in rows]
    finally:
        await db.close()
