-- ============================================================================
-- 130_agent_blob_instance.sql — partition the agent file store by instance
-- ============================================================================
-- Spec: ai-company-brain/specs/memory_architecture.md §5.3, §6.1
--       ai-company-brain/specs/agent_architecture.md §2
--       docs/multiplayer/agent-kinds.md §4
--
-- WHY
-- ---
-- 71_agent_blob_store.sql keys every file by (agent_name, path) and its module
-- docstring is explicit: "agent_name is the only tenant key". So there is ONE
-- agent-data/NOTES.md per agent, shared by every user of it — and recall_notes()
-- with no query returns the whole file.
--
-- That is worse than the Mem0 agent bucket in one specific way: Mem0 surfaces
-- only what is semantically close to the query, whereas the file tier returns
-- everything it holds, in full, on every run that loads it. It is also NOT
-- gated behind MEM0_ENABLED, so unlike the vector-tier findings it applies to
-- any deployment where an agent has ever called save_note.
--
-- WHAT
-- ----
--   instance = ''            -> shared across all users of the agent (today's
--                               behaviour, and the behaviour every existing row
--                               keeps).
--   instance = 'u:<email>'   -> one partition per person   (personal agents)
--   instance = 't:<team>'    -> one partition per team     (team agents)
--   instance = 'quarantine'  -> commingled pre-migration content, readable by
--                               nobody, deleted by nobody (see 131).
--
-- The '' = shared convention is not invented here: app_data (114_custom_apps)
-- already keys rows by (table, key, user_scope) where "user_scope '' = shared
-- row, else a per-user partition". Same idea, same sentinel.
--
-- SAFETY
-- ------
-- Adding the column with DEFAULT '' and repointing the primary key is a pure
-- schema change: every existing row becomes an instance='' row, which is
-- exactly what it was. Readers that don't pass an instance keep resolving to ''
-- and see precisely what they saw before. Behaviour changes only when the run
-- path starts passing a non-empty instance, which is a separate, deliberate step.
--
-- Idempotent. Depends on: 71_agent_blob_store.sql.
-- ============================================================================

ALTER TABLE agent_blob
    ADD COLUMN IF NOT EXISTS instance TEXT NOT NULL DEFAULT '';

ALTER TABLE agent_file_history
    ADD COLUMN IF NOT EXISTS instance TEXT NOT NULL DEFAULT '';

-- Repoint the primary key: (agent_name, path) -> (agent_name, instance, path).
-- Two users of a personal agent must be able to hold the SAME path
-- (agent-data/NOTES.md) without colliding — which the old PK forbids.
DO $$
DECLARE
    pk_name TEXT;
BEGIN
    SELECT conname INTO pk_name
    FROM pg_constraint
    WHERE conrelid = 'agent_blob'::regclass AND contype = 'p';

    IF pk_name IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'agent_blob'::regclass
          AND c.contype = 'p'
          AND a.attname = 'instance'
    ) THEN
        EXECUTE format('ALTER TABLE agent_blob DROP CONSTRAINT %I', pk_name);
        ALTER TABLE agent_blob
            ADD CONSTRAINT agent_blob_pkey PRIMARY KEY (agent_name, instance, path);
    END IF;
END $$;

-- The history dedup key gains instance for the same reason: the same content at
-- the same path in two DIFFERENT instances is two distinct versions, not a
-- duplicate to be swallowed by ON CONFLICT DO NOTHING.
--
-- 71 created this as a unique INDEX (agent_file_history_unique_version_idx), not
-- a table constraint — so it must be dropped by that name. Leaving it in place
-- would keep deduping across instances: if two people wrote byte-identical
-- NOTES.md content, the second person's history row would vanish silently, and
-- the append-only provenance log would be quietly lying.
CREATE UNIQUE INDEX IF NOT EXISTS agent_file_history_dedup_idx
    ON agent_file_history (agent_name, instance, path, sha256, action);
DROP INDEX IF EXISTS agent_file_history_unique_version_idx;

-- "What's in this instance's workspace, newest first" — the file manager's
-- listing query after instance keying.
CREATE INDEX IF NOT EXISTS idx_agent_blob_instance
    ON agent_blob (agent_name, instance, folder, updated_at DESC);
