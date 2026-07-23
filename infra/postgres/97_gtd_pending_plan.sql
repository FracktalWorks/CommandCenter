-- 97_gtd_pending_plan.sql — the AI planner's reviewed-plan token (spec:
-- calendar_ai_review.md; review finding R1/S1).
--
-- What: a per-(user, LOCAL day) stash of the plan the agent last PROPOSED via
--   the chat tools (gtd_plan_day / gtd_replan_day / gtd_rollover). The agent
--   endpoints now separate propose from apply structurally:
--     • propose (apply=false) computes a plan and writes it here;
--     • apply   (apply=true)  replays THIS stored plan verbatim, then clears it.
--   So "apply" can only ever commit the exact plan the user reviewed — not a
--   freshly-recomputed one they never saw — and an apply with nothing pending
--   degrades to a propose instead of a surprise write. The confirmation gate is
--   enforced by the server, not just by the model's persona.
-- Shape: {"kind": "plan|replan|rollover", "at": <iso8601>, "plan": <DayPlan>}.
-- Why: closes the gap where the calendar could be mutated on a caller-supplied
--   boolean with no tie to a reviewed proposal.
-- Depends on: 92_gtd_day_state.sql. ADDITIVE + idempotent.

ALTER TABLE gtd_day_state
    ADD COLUMN IF NOT EXISTS pending_plan JSONB;
