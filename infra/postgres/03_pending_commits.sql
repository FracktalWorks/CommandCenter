-- Pending commit approvals — Phase 1.6 (M2.7 self-mutation simplification).
--
-- Design: agents commit locally (no push, no PR) and register a row here.
-- The operator reviews the diff in the inbox and clicks Approve.
-- Approval triggers `git push origin HEAD` from the authenticated local clone.
-- Rejection runs `git reset HEAD~1` to drop the staged commit.
--
-- This replaces the PR-first flow for routine self-improvement commits while
-- keeping `max_mutation_attempts = 1` and the human-gating invariant.

CREATE TABLE IF NOT EXISTS pending_commit (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_name      TEXT        NOT NULL,
    run_id          TEXT        NOT NULL,
    -- Local clone path — used by the approve endpoint to push
    local_clone_dir TEXT        NOT NULL,
    -- The commit SHA produced by the sandbox (git rev-parse HEAD inside the clone)
    commit_sha      TEXT        NOT NULL,
    commit_message  TEXT        NOT NULL,
    -- Unified diff (git diff HEAD~1 HEAD) — stored for inline review in the inbox
    diff_text       TEXT        NOT NULL DEFAULT '',
    -- Summary of pytest / eval results from the sandbox
    test_summary    TEXT        NOT NULL DEFAULT '',
    -- 'pending' | 'approved' | 'rejected' | 'eval_failed'
    -- eval_failed: sandbox committed but tests failed — requires human decision
    -- (Push Anyway / Reject / Re-mutate) before the commit is pushed.
    status          TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'rejected', 'eval_failed')),
    -- Who approved / rejected (future RBAC; 'system' for automated approvals)
    reviewed_by     TEXT,
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_commit_agent_status_idx
    ON pending_commit (agent_name, status, created_at DESC);

CREATE INDEX IF NOT EXISTS pending_commit_run_idx
    ON pending_commit (run_id);
