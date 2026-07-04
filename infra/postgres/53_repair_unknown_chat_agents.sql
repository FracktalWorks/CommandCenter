-- 53_repair_unknown_chat_agents.sql — heal chat_session rows poisoned with
-- agent_name='unknown'.
--
-- What: for every chat_session whose agent_name is a placeholder sentinel
--       ('unknown'/''/'undefined'/'null'/'none'), recover the REAL agent from
--       the most recent agent_run trace for that thread and write it back.
-- Why:  a session persisted with agent_name='unknown' dispatches
--       /agent/run/stream with agent='unknown' -> 422 "Unknown agent 'unknown'"
--       (the error users hit in task-manager and other chats). The origin
--       placeholder is /chat/active-sessions' fallback for a Redis-active
--       thread with no chat_session row yet; it leaked into ~42 rows across
--       Jun 12 - Jul 4. The gateway now resolves the sentinel on dispatch and
--       the client never mints such a row, but existing rows still need a
--       one-time repair so the sidebar + dispatch are clean.
-- Depends on: 50_agent_run_trace.sql (agent_run), 01_schema.sql (chat_session).
-- Idempotent: only touches sentinel rows; re-running is a no-op once healed.
--             Rows with no usable trace are left as-is (the app's "else prompt"
--             picker resolves those interactively).

UPDATE chat_session cs
SET agent_name = latest.agent_name
FROM (
    SELECT DISTINCT ON (ar.thread_id)
           ar.thread_id,
           ar.agent_name
    FROM agent_run ar
    WHERE ar.agent_name IS NOT NULL
      AND lower(btrim(ar.agent_name)) NOT IN ('', 'unknown', 'undefined', 'null', 'none')
    ORDER BY ar.thread_id, ar.started_at DESC
) AS latest
WHERE cs.id = latest.thread_id
  AND lower(btrim(coalesce(cs.agent_name, ''))) IN ('', 'unknown', 'undefined', 'null', 'none');
