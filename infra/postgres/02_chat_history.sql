-- Chat history persistence — added in Phase 1.
-- Stores conversation sessions and their messages so history survives browser
-- cache clears, device switches, and server restarts.

-- chat_session: one row per conversation in the sidebar.
CREATE TABLE IF NOT EXISTS chat_session (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL DEFAULT 'default',   -- future multi-tenant
    agent_name      TEXT NOT NULL DEFAULT 'orchestrator',
    title           TEXT,
    last_preview    TEXT,
    message_count   INT  NOT NULL DEFAULT 0,
    workspace_path  TEXT,                              -- ST-AV-09: agent file workspace root
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_session_user_idx
    ON chat_session (user_id, updated_at DESC);

-- chat_message: one row per settled (non-streaming) message turn.
-- tool_events, progress_lines, custom_events stored as JSONB arrays.
-- agent_state stored as a JSONB object.
CREATE TABLE IF NOT EXISTS chat_message (
    id              TEXT        NOT NULL,
    session_id      TEXT        NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT        NOT NULL DEFAULT '',
    timestamp_ms    BIGINT      NOT NULL,
    tool_events     JSONB       NOT NULL DEFAULT '[]',
    progress_lines  JSONB       NOT NULL DEFAULT '[]',
    reasoning       TEXT,
    agent_state     JSONB,
    custom_events   JSONB       NOT NULL DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS chat_message_session_ts_idx
    ON chat_message (session_id, timestamp_ms ASC);
