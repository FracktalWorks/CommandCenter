-- Mem0 episodic memory schema (WBS 2.5)
--
-- Mem0 manages its own tables via the pgvector provider.  This migration
-- creates the pgvector extension (if not already present) and the collection
-- table that Mem0 will use.  Mem0 will populate it automatically on first use.
--
-- When MEM0_ENABLED=true, mem0ai reads from / writes to the 'mem0_memories'
-- collection below.  No manual inserts are needed.

-- Ensure pgvector is available (already enabled by 01_schema.sql in Phase 0)
CREATE EXTENSION IF NOT EXISTS vector;

-- Mem0 pgvector provider will create this table automatically, but we
-- pre-create it here for visibility and to allow setting the search path.
-- mem0ai >= 1.0 uses a table named after collection_name with these columns.
-- Safe to run on an existing DB — idempotent.
CREATE TABLE IF NOT EXISTS mem0_memories (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    memory       TEXT        NOT NULL,
    user_id      TEXT        NOT NULL,
    agent_id     TEXT,
    metadata     JSONB,
    embedding    VECTOR(1536),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mem0_memories_user_idx
    ON mem0_memories (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mem0_memories_embedding_idx
    ON mem0_memories USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100)
    WHERE embedding IS NOT NULL;
