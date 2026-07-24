-- ============================================================================
-- 111_whatsapp_embeddings.sql — per-message embeddings for semantic search (W10)
-- ============================================================================
-- ADDITIVE and OPTIONAL, mirroring the email vertical's migration 73. Lexical
-- FTS (migration 102's idx_wa_messages_fts) is complete on its own; this only
-- powers the ``hybrid=true`` path on /whatsapp/search when
-- whatsapp_semantic_search_enabled is on.
--
-- The embedded text is the message BODY + its voice-note TRANSCRIPT, so a spoken
-- "kal AWB bhej dunga" is findable by meaning, not just the keyword it was
-- transcribed to. Model: one embedder for the whole app (reuses
-- email_embedding_model, default text-embedding-3-small, 1536-dim, served by the
-- LiteLLM gateway — the same /v1/embeddings path mem0 + email already use, so no
-- new infra). The vector dimension is fixed at DDL time; the model is stored per
-- row so a model swap is detectable and a re-embed can target only stale rows.
-- content_hash lets the sweeper skip a message whose text hasn't changed.
--
-- pgvector is already installed (migration 01). Idempotent.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS wa_message_embeddings (
    -- One embedding per message; drop with the message.
    message_id   UUID PRIMARY KEY
                     REFERENCES wa_messages(id) ON DELETE CASCADE,
    -- Denormalised so the hybrid query can scope by account without a join back.
    account_id   UUID NOT NULL,
    -- 1536 = text-embedding-3-small. A different-dimension model requires
    -- recreating this column + re-embedding; ``model`` records the producer.
    embedding    vector(1536) NOT NULL,
    model        TEXT NOT NULL,
    -- sha256 of the exact text embedded (body + transcript). Unchanged → skip.
    content_hash TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_message_embeddings_account
    ON wa_message_embeddings (account_id);

-- Approximate nearest-neighbour (cosine) — same access method mem0 + email use.
-- lists=100 suits a single number's scale; re-tune with ANALYZE as it grows.
-- ivfflat creates fine on an empty table; the planner falls back to exact until
-- it's populated.
CREATE INDEX IF NOT EXISTS idx_wa_message_embeddings_vec
    ON wa_message_embeddings USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
