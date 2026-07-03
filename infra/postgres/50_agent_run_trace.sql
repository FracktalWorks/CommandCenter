-- 50_agent_run_trace.sql — durable per-run observability store (E2)
--
-- What / why:
--   The full AG-UI event trace of a run lives only in Redis (cc:stream:*) with a
--   1-hour TTL, and only for the LATEST run per thread. An hour after "error X
--   happened with agent Y", the detail is gone; audit_event keeps only a
--   coarse start/complete/error row with the exception MESSAGE (no traceback).
--   This table is the durable, queryable record: one row per run with metadata
--   + status + full error/traceback for ALL runs, and the full folded trace
--   (content, tool results, reasoning) retained ONLY for errored/flagged runs
--   (privacy + storage: successful runs rarely need the body to debug).
--
-- Depends on: (none — standalone). Written idempotently (runner re-applies it
-- on every deploy). Follows the 08+ plural + idx_ convention.

CREATE TABLE IF NOT EXISTS agent_run (
    run_id        TEXT PRIMARY KEY,
    thread_id     TEXT,
    agent_name    TEXT NOT NULL,
    user_id       TEXT,
    model         TEXT,
    -- 'running' | 'completed' | 'error' | 'cancelled'
    status        TEXT NOT NULL DEFAULT 'running',
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at      TIMESTAMPTZ,
    duration_ms   BIGINT,
    -- Token accounting (best-effort; summed across the run's LLM calls).
    prompt_tokens      BIGINT,
    completion_tokens  BIGINT,
    total_tokens       BIGINT,
    tool_count    INTEGER NOT NULL DEFAULT 0,
    -- Lightweight tool sequence for ALL runs: [{"name","status"}...]. Cheap to
    -- store, enough to see "which tool was the run on when it failed".
    tool_summary  JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Error surface (populated on status='error').
    error_message TEXT,
    error_type    TEXT,
    error_traceback TEXT,
    -- Full folded trace (content + tool_events with results + reasoning +
    -- custom_events), persisted ONLY for errored/flagged runs; NULL otherwise.
    trace         JSONB,
    -- Operator/agent flag to force full-trace retention for an otherwise-OK run.
    flagged       BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Diagnostics queries: "recent runs", "failed runs for agent Y", "runs for user".
CREATE INDEX IF NOT EXISTS idx_agent_run_started ON agent_run (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_agent_started
    ON agent_run (agent_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_status_started
    ON agent_run (status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_thread ON agent_run (thread_id);
-- Partial index over the rows an engineer actually pages through when debugging.
CREATE INDEX IF NOT EXISTS idx_agent_run_failed
    ON agent_run (started_at DESC) WHERE status = 'error';
