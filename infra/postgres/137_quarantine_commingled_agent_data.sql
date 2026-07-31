-- ============================================================================
-- 139_quarantine_commingled_agent_data.sql — retire pre-instance file content
-- ============================================================================
-- Spec: ai-company-brain/specs/memory_architecture.md §5.3
--       ai-company-brain/specs/agent_platform_hardening_2026-07.md H4
--       docs/multiplayer/agent-kinds.md §6
--
-- WHY
-- ---
-- Before 134 the file store was keyed by agent_name alone, so every user of an
-- agent wrote into ONE agent-data/ workspace. For agents that are now declared
-- `personal`, those rows are commingled: they hold several people's notes with
-- no record of whose is whose. `agent_file_history.actor` says "agent" or
-- "user", not WHICH user.
--
-- Three options were considered:
--
--   attribute   — guess ownership from agent_run timestamps. REJECTED: a wrong
--                 guess moves one person's note into another person's PRIVATE
--                 partition, silently. That is worse than forgetting, and it is
--                 precisely the failure the partition exists to prevent.
--   copy-to-all — duplicate the shared rows into every user's instance.
--                 REJECTED: it preserves exactly the leak being removed — each
--                 instance would hold content learned in other people's
--                 sessions, now relabelled as theirs.
--   quarantine  — CHOSEN. Move the rows somewhere nothing reads.
--
-- Forgetting is visible and self-healing: these agents relearn from ordinary
-- use, and nothing here is a system of record (ClickUp/Zoho/Odoo are, and are
-- untouched). Mis-attribution is neither visible nor self-healing.
--
-- WHAT
-- ----
-- RENAME, NEVER DELETE. Rows move to instance='quarantine', which no reader
-- ever passes, so they are unreachable but fully recoverable with a single
-- UPDATE. Nothing is lost; an admin review UI is a later convenience, not a
-- precondition.
--
-- SCOPE: the two assistants only. Both carry the highest privacy stakes
-- (mailbox and message content) and the least accumulated value, so they are
-- the right place to prove the pattern. task-manager, app-builder and
-- orchestrator stay `shared` for now and are migrated in later, separate steps
-- — orchestrator last, since it is the default chat agent with the most
-- traffic and therefore the most visible if recall regresses.
--
-- Idempotent: re-running moves nothing, because the rows are already out of ''.
-- Depends on: 138_agent_blob_instance.sql.
-- ============================================================================

DO $$
DECLARE
    target TEXT;
    moved  INT;
BEGIN
    FOREACH target IN ARRAY ARRAY['email-assistant', 'whatsapp-assistant']
    LOOP
        -- Current content. A path may already exist under 'quarantine' from a
        -- previous partial run, so drop the loser rather than fail the migration.
        DELETE FROM agent_blob a
        WHERE a.agent_name = target
          AND a.instance = ''
          AND EXISTS (
              SELECT 1 FROM agent_blob q
              WHERE q.agent_name = target
                AND q.instance = 'quarantine'
                AND q.path = a.path
          );

        UPDATE agent_blob
        SET instance = 'quarantine'
        WHERE agent_name = target AND instance = '';
        GET DIAGNOSTICS moved = ROW_COUNT;

        IF moved > 0 THEN
            RAISE NOTICE 'quarantined % agent_blob row(s) for %', moved, target;
        END IF;

        -- Provenance follows the content, so history stays attached to the rows
        -- it describes rather than dangling against an empty shared partition.
        UPDATE agent_file_history
        SET instance = 'quarantine'
        WHERE agent_name = target
          AND instance = ''
          AND NOT EXISTS (
              SELECT 1 FROM agent_file_history q
              WHERE q.agent_name = agent_file_history.agent_name
                AND q.instance = 'quarantine'
                AND q.path = agent_file_history.path
                AND q.sha256 = agent_file_history.sha256
                AND q.action = agent_file_history.action
          );
    END LOOP;
END $$;
