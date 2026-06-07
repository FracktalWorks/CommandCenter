-- Artifact Viewer (ST-AV-09): persist the agent workspace directory per session.
-- Run this migration once against an existing database.
-- The column is already included in 02_chat_history.sql for fresh installs (see below).

ALTER TABLE chat_session
    ADD COLUMN IF NOT EXISTS workspace_path TEXT;
