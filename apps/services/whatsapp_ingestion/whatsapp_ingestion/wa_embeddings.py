"""WhatsApp semantic search (W10) — embed messages for hybrid vector ranking.

Mirrors ``email_ingestion.email_embeddings``: a BOUNDED batch of not-yet-embedded
messages is embedded via the LiteLLM gateway (the same ``/v1/embeddings`` path
mem0 + email already use — no new infra, no ``OPENAI_API_KEY`` needed) and stored
in ``wa_message_embeddings`` (migration 111). The ``/whatsapp/search`` hybrid path
then blends cosine similarity with the full-text rank.

The embedded text is the message BODY + its voice-note TRANSCRIPT, so a spoken
message is findable by meaning. Gated by ``whatsapp_semantic_search_enabled``:
when off this is a no-op and search stays pure lexical. ``content_hash`` skips
re-embedding a message whose text hasn't changed since last time.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from sqlalchemy import text

logger = logging.getLogger(__name__)

# Messages embedded per sweep tick — bounded so the embedding calls never
# dominate a cycle; the backlog drains over successive ticks.
DEFAULT_BATCH = 32

# WhatsApp messages are short; a hard char cap keeps each request small + cheap.
_MAX_EMBED_CHARS = 4000


def _embed_text(body: str | None, transcript: str | None) -> str:
    """The text we embed for a message: body + voice-note transcript. Capped +
    stripped. Kept in one place so it can't drift from the content_hash source."""
    return (f"{(body or '').strip()}\n\n{(transcript or '').strip()}"
            ).strip()[:_MAX_EMBED_CHARS]


def _hash_source(body: str | None, transcript: str | None) -> str:
    """The EXACT text whose sha256 is stored as content_hash.

    MUST be byte-identical to the SQL candidate predicate in
    ``embed_pending_messages`` — the SQL coalesces the RAW, UNstripped columns:

        coalesce(body_text, '') || E'\\n\\n' || coalesce(transcript_text, '')

    so we mirror that here (uncapped, unstripped). Stripping here would make most
    messages hash differently on the two sides and thrash forever. The embedded
    text (``_embed_text``) is a separate capped+stripped string; only the *hash
    source* must agree with SQL.
    """
    return f"{body or ''}\n\n{transcript or ''}"


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8", "replace")).hexdigest()


async def _embed_batch(texts: list[str], model: str) -> list[list[float]] | None:
    """Embed a batch through the LiteLLM gateway (same route mem0 + email use).
    Returns one vector per input, or None on any failure (caller skips this
    tick — never fails the sweep)."""
    try:
        import litellm
        from acb_common.settings import get_settings
        litellm.drop_params = True
        settings = get_settings()
        resp = await litellm.aembedding(
            model=model,
            input=texts,
            api_base=settings.litellm_base_url.rstrip("/") + "/v1",
            api_key=settings.litellm_master_key,
            custom_llm_provider="openai",
        )
    except Exception as exc:
        logger.warning("wa_embed.batch_failed model=%s err=%s",
                       model, str(exc)[:160])
        return None
    try:
        data = resp["data"] if isinstance(resp, dict) else resp.data
        return [d["embedding"] if isinstance(d, dict) else d.embedding
                for d in data]
    except Exception as exc:
        logger.warning("wa_embed.parse_failed err=%s", str(exc)[:160])
        return None


async def embed_query(query: str) -> list[float] | None:
    """Embed a single search query, for the hybrid path. Returns the vector, or
    None when semantic search is off or the embed fails (caller falls back to
    pure lexical)."""
    from acb_common.settings import get_settings
    settings = get_settings()
    if not settings.whatsapp_semantic_search_enabled or not query.strip():
        return None
    vecs = await _embed_batch([query.strip()[:_MAX_EMBED_CHARS]],
                              settings.email_embedding_model)
    return vecs[0] if vecs else None


async def embed_pending_messages(
    db: Any, account_id: str, *, batch: int = DEFAULT_BATCH,
) -> int:
    """Embed up to ``batch`` of the account's messages that have no embedding yet
    (or whose text changed since last embed). Returns how many were embedded.
    No-op + returns 0 when semantic search is disabled. Commits its own writes so
    progress survives a later failure."""
    from acb_common.settings import get_settings
    settings = get_settings()
    if not settings.whatsapp_semantic_search_enabled:
        return 0
    model = settings.email_embedding_model

    # Candidates: messages with body OR transcript text, but no current embedding
    # (or a stale content_hash because the text changed — e.g. a voice note was
    # transcribed after it first landed).
    rows = (await db.execute(text(
        r"""SELECT m.id, m.body_text, m.transcript_text
              FROM wa_messages m
              LEFT JOIN wa_message_embeddings e ON e.message_id = m.id
             WHERE m.account_id = :aid
               AND (coalesce(m.body_text,'') <> ''
                    OR coalesce(m.transcript_text,'') <> '')
               AND (e.message_id IS NULL
                    OR e.content_hash <> encode(
                         sha256(convert_to(
                             coalesce(m.body_text,'') || E'\n\n'
                             || coalesce(m.transcript_text,''), 'UTF8')), 'hex'))
             ORDER BY m.sent_at DESC NULLS LAST
             LIMIT :lim"""),
        {"aid": account_id, "lim": batch},
    )).fetchall()
    if not rows:
        return 0

    hashes = [_content_hash(_hash_source(r.body_text, r.transcript_text))
              for r in rows]
    texts = [_embed_text(r.body_text, r.transcript_text) for r in rows]
    vectors = await _embed_batch(texts, model)
    if vectors is None or len(vectors) != len(rows):
        return 0

    embedded = 0
    for r, vec, h in zip(rows, vectors, hashes, strict=False):
        vec_literal = "[" + ",".join(f"{x:.7f}" for x in vec) + "]"
        await db.execute(text(
            """INSERT INTO wa_message_embeddings
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
        logger.info("wa_embed.done account=%s embedded=%d", account_id, embedded)
    return embedded
