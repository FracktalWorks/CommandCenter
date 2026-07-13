-- 66_pending_actions.sql — the Action Broker approval queue (audit BO-1 / A2).
--
-- What: one row per outward-write PROPOSAL the broker holds for a human, the
--       mirror of `03_pending_commits.sql` but for source-of-truth writes
--       (ClickUp / Zoho / email) rather than code commits.
-- Why:  non-negotiable #4 — no autonomous write to an external system without
--       authority-gating + human oversight. `decide_disposition` classifies a
--       proposal; a NEEDS_APPROVAL one lands here until an operator approves it,
--       at which point the broker's `execute()` runs the registered handler.
-- Depends on: 01_schema.sql (uuid-ossp extension).
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS; re-runs safely on every deploy.

CREATE TABLE IF NOT EXISTS pending_actions (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Who proposed it, e.g. "agent:sales".
    actor        TEXT        NOT NULL,
    -- The action name a handler is registered under, e.g. "clickup.comment".
    action       TEXT        NOT NULL,
    -- The target object, e.g. "task:<clickup_id>".
    target       TEXT        NOT NULL,
    -- Handler payload (the write body).
    payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- Proposer's authority tier: read | suggest | suggest+apply | autonomous.
    authority    TEXT        NOT NULL,
    -- Whether the action is destructive/outward-facing (defaults true = fail closed).
    destructive  BOOLEAN     NOT NULL DEFAULT true,
    -- Disposition computed by decide_disposition at propose time.
    disposition  TEXT        NOT NULL,
    -- Lifecycle: pending → approved → applied|failed, or → rejected.
    status       TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'failed')),
    -- Handler result (on applied) or error detail (on failed).
    result       JSONB,
    -- Who approved / rejected ('system' for automated dispositions).
    reviewed_by  TEXT,
    reviewed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inbox listing: pending first, newest first.
CREATE INDEX IF NOT EXISTS pending_actions_status_idx
    ON pending_actions (status, created_at DESC);

-- Per-actor audit lookups.
CREATE INDEX IF NOT EXISTS pending_actions_actor_idx
    ON pending_actions (actor, created_at DESC);
