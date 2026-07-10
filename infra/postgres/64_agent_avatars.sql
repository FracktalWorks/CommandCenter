-- ============================================================================
-- 64_agent_avatars.sql
-- ============================================================================
-- Per-agent avatar customization for the observability Office (E2 Phase 6.8).
--
-- The office renders each agent as a pixel-art character. `deriveAvatar(name)`
-- gives every agent a fitting look with zero config, and `sprites.generated.ts`
-- supplies a real Pixel Lab bust per role. This table is the OVERRIDE layer: the
-- Avatar Studio lets an operator pin a specific look (skin/hair/outfit/room/…)
-- or a custom-generated Pixel Lab sprite for any agent — including built-ins
-- like `orchestrator` that aren't in `dynamic_agents`. Keyed by agent name so it
-- covers the whole cast, not just user-registered agents.
--
--   config  — partial AvatarConfig (JSON): any subset of the frontend
--             AvatarConfig fields; merged over deriveAvatar() as `override`.
--   sprite  — optional data-URI PNG (a custom Pixel Lab generation) pinned as
--             this agent's character; wins over the role sprite.
--
-- /observability/roster merges these in so every viewer sees the same look.
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_avatars (
    agent_name  TEXT PRIMARY KEY,
    config      JSONB NOT NULL DEFAULT '{}'::jsonb,
    sprite      TEXT,                         -- data-URI PNG, nullable
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
