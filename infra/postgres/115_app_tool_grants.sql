-- ============================================================================
-- 115_app_tool_grants.sql — Custom Apps · per-user "always allow" tool grants
-- ============================================================================
-- Phase 2a (cc.tools, RFC: docs/app-workshop/README.md §4.4/§4.7). A destructive
-- app tool call (e.g. tool:clickup.create_task) normally needs a per-use human
-- confirm before it flows through the Action Broker. Checking "always allow
-- for this app" on that confirm remembers the choice here so future calls of
-- the SAME tool, BY THE SAME PERSON, on THIS app skip the confirm step.
--
-- This is a personal, per-user remembered confirm — NOT an admin grant and NOT
-- a scope grant: it never bypasses the manifest scope check
-- (gateway.routes.apps.tools.find_declared_tool_scope) or the Action Broker
-- gate itself, both of which still run on every call.
--
-- Idempotent. Depends on: 113_custom_apps.sql (apps).
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_tool_grants (
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    tool TEXT NOT NULL,
    granted_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (app_id, user_email, tool)
);
