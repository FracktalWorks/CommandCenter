-- Add service_session_id column to chat_session for Copilot SDK session resumption.
-- When set, the executor passes this to agent.run() so MAF's _get_or_create_session
-- calls resume_session() instead of create_session(), maintaining server-side
-- conversation state across browser restarts and disconnects.
ALTER TABLE chat_session
    ADD COLUMN IF NOT EXISTS service_session_id TEXT;
