-- Email semantic search (Phase 2) — per-message embeddings for hybrid
-- lexical+vector ranking. ADDITIVE and OPTIONAL: Phase 1 full-text search
-- (migration 72) is complete on its own; this only powers the `hybrid=true`
-- path on /email/search when email_semantic_search_enabled is on.
--
-- Model: one embedding model for all email (default text-embedding-3-small,
-- 1536-dim, served by the LiteLLM gateway). The vector column dimension is fixed
-- at DDL time, so switching embedding models means re-embedding — we store the
-- model name per row so a mismatch is detectable and a re-embed can target only
-- the stale rows. content_hash lets the sweeper skip a message whose body hasn't
-- changed since it was last embedded (embeddings cost tokens).
--
-- pgvector is already installed (migration 01 / the pgvector image) and already
-- used by mem0 (mem0_memories, ivfflat cosine) — no new infra. Idempotent.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS email_embeddings (
    -- One embedding per message; drop with the message.
    message_id   UUID PRIMARY KEY
                     REFERENCES email_messages(id) ON DELETE CASCADE,
    -- Denormalised so the hybrid query can scope by account without a join back
    -- to email_messages (the account scope is applied on the message table).
    account_id   UUID NOT NULL,
    -- 1536 = text-embedding-3-small. If a deployment standardises on a 768-dim
    -- model (e.g. gemini text-embedding-004) this column must be recreated at
    -- that dimension and all rows re-embedded — the model column below records
    -- which model produced each vector so that migration is scriptable.
    embedding    vector(1536) NOT NULL,
    -- Which embedding model produced this vector (detect drift / target re-embed).
    model        TEXT NOT NULL,
    -- sha256 of the exact text embedded (subject + body). Unchanged hash → skip
    -- re-embedding on the next sweep.
    content_hash TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_embeddings_account
    ON email_embeddings (account_id);

-- Approximate nearest-neighbour (cosine) — same access method mem0 uses. lists
-- is a coarse bucketing; 100 suits a single mailbox's scale and the ~4GB-RAM box
-- (matches mem0_memories_embedding_idx). Re-tune with ANALYZE + VACUUM as the
-- table grows. ivfflat needs data to build a good index; on an empty table this
-- still creates fine and the planner falls back to exact until it's populated.
CREATE INDEX IF NOT EXISTS idx_email_embeddings_vec
    ON email_embeddings USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Find messages that still need embedding (no row yet). A partial-style helper:
-- the sweeper joins email_messages LEFT JOIN email_embeddings and takes the
-- misses; this index on message_id makes the anti-join cheap.
-- (message_id is already the PK, so no extra index needed for the anti-join.)
