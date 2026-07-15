"""Email semantic search (Phase 2) — embed messages for hybrid vector ranking.

Runs in the same background sweep as the body backfill: after each account's
sync, a BOUNDED batch of not-yet-embedded messages is embedded via the LiteLLM
gateway (the same /v1/embeddings path mem0 uses — no OPENAI_API_KEY needed) and
stored in email_embeddings (migration 73). The /email/search hybrid path then
blends cosine similarity with the full-text rank.

Gated by ``email_semantic_search_enabled``: when off, this is a no-op and search
stays pure lexical (Phase 1, complete on its own). content_hash skips re-embedding
a message whose body hasn't changed since last time (embeddings cost tokens).
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from sqlalchemy import text

logger = logging.getLogger(__name__)

# Messages embedded per sweep tick — bounded so the extra embedding calls never
# dominate a sync cycle; the backlog drains over successive ticks.
DEFAULT_BATCH = 32

# Cap the text sent to the embedder. Embedding models truncate at their own token
# limit anyway; a hard char cap keeps the request small and cheap. Subject + the
# head of the body carries the semantic gist for search.
_MAX_EMBED_CHARS = 8000


def _embed_text(subject: str | None, body: str | None) -> str:
    """The text we embed for a message: subject + body head. Kept in one place so
    the content_hash and the embedded text can never diverge."""
    return (f"{(subject or '').strip()}\n\n{(body or '').strip()}"
            )[:_MAX_EMBED_CHARS]


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8", "replace")).hexdigest()


async def _embed_batch(texts: list[str], model: str) -> list[list[float]] | None:
    """Embed a batch through the LiteLLM gateway (same route mem0 uses). Returns
    one vector per input text, or None on any failure (caller skips this tick —
    never fails the sync)."""
    try:
        import litellm  # noqa: PLC0415
        from acb_common.settings import get_settings  # noqa: PLC0415
        litellm.drop_params = True
        settings = get_settings()
        resp = await litellm.aembedding(
            model=model,
            input=texts,
            api_base=settings.litellm_base_url.rstrip("/") + "/v1",
            api_key=settings.litellm_master_key,
            custom_llm_provider="openai",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("email_embed.batch_failed model=%s err=%s",
                       model, str(exc)[:160])
        return None
    # litellm returns {data: [{embedding: [...]}, ...]} preserving input order.
    try:
        data = resp["data"] if isinstance(resp, dict) else resp.data
        return [d["embedding"] if isinstance(d, dict) else d.embedding
                for d in data]
    except Exception as exc:  # noqa: BLE001
        logger.warning("email_embed.parse_failed err=%s", str(exc)[:160])
        return None


async def embed_query(query: str) -> list[float] | None:
    """Embed a single search query with the configured email embedding model, for
    the hybrid search path. Returns the vector, or None if semantic search is off
    or the embed fails (caller falls back to pure lexical)."""
    from acb_common.settings import get_settings  # noqa: PLC0415
    settings = get_settings()
    if not settings.email_semantic_search_enabled or not query.strip():
        return None
    vecs = await _embed_batch([query.strip()[:_MAX_EMBED_CHARS]],
                              settings.email_embedding_model)
    return vecs[0] if vecs else None


async def embed_pending_messages(
    db: Any, account_id: str, *, batch: int = DEFAULT_BATCH,
) -> int:
    """Embed up to ``batch`` of the account's messages that have no embedding yet
    (or whose body changed since last embed). Returns how many were embedded.
    No-op + returns 0 when semantic search is disabled. Caller owns the session;
    this commits its own writes so progress survives a later failure."""
    from acb_common.settings import get_settings  # noqa: PLC0415
    settings = get_settings()
    if not settings.email_semantic_search_enabled:
        return 0
    model = settings.email_embedding_model

    # Candidates: messages with a body but no current embedding, OR whose stored
    # embedding was made from a different content_hash (body edited/backfilled).
    rows = (await db.execute(text(
        """SELECT em.id, em.subject, em.body_text
             FROM email_messages em
             LEFT JOIN email_embeddings ee ON ee.message_id = em.id
            WHERE em.account_id = :aid
              AND em.body_text IS NOT NULL AND em.body_text <> ''
              AND (ee.message_id IS NULL
                   OR ee.content_hash <> encode(
                        sha256((coalesce(em.subject,'') || E'\\n\\n'
                                || coalesce(em.body_text,''))::bytea), 'hex'))
            ORDER BY em.received_at DESC NULLS LAST
            LIMIT :lim"""),
        {"aid": account_id, "lim": batch},
    )).fetchall()
    if not rows:
        return 0

    # content_hash MUST match the SQL candidate predicate above, which hashes the
    # FULL "subject\n\nbody" (uncapped) — otherwise a message whose capped head is
    # unchanged but full body differs would be re-selected every tick and never
    # settle. So hash the full text here, but embed only the capped head.
    full_texts = [f"{(r.subject or '').strip()}\n\n{(r.body_text or '').strip()}"
                  for r in rows]
    hashes = [_content_hash(t) for t in full_texts]
    texts = [_embed_text(r.subject, r.body_text) for r in rows]
    vectors = await _embed_batch(texts, model)
    if vectors is None or len(vectors) != len(rows):
        return 0

    embedded = 0
    for r, vec, h in zip(rows, vectors, hashes, strict=False):
        # pgvector accepts the '[..]' text form for a vector literal.
        vec_literal = "[" + ",".join(f"{x:.7f}" for x in vec) + "]"
        await db.execute(text(
            """INSERT INTO email_embeddings
                   (message_id, account_id, embedding, model, content_hash)
               VALUES (:mid, :aid, CAST(:emb AS vector), :model, :hash)
               ON CONFLICT (message_id) DO UPDATE
                   SET embedding = EXCLUDED.embedding,
                       model = EXCLUDED.model,
                       content_hash = EXCLUDED.content_hash,
                       updated_at = now()"""),
            {"mid": str(r.id), "aid": account_id, "emb": vec_literal,
             "model": model, "hash": h},
        )
        embedded += 1

    if embedded:
        await db.commit()
        logger.info("email_embed.done account=%s embedded=%d", account_id,
                    embedded)
    return embedded
