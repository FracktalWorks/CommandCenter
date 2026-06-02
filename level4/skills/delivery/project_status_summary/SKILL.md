---
name: project_status_summary
domain: delivery
description: Produce a one-paragraph status summary for a ClickUp project, citing the most recent stale tasks and blocking items.
when_to_use: "When a user asks 'what is the status of project X?' or the Delivery agent needs a project context block."
inputs:
  project_id: "uuid of acb_graph.Project"
outputs:
  summary: "1-3 sentences with [project:<uuid>] and up to 3 [task:<uuid>] citations"
allowed_tools:
  - graph.read.project_context
  - graph.read.stale_tasks
authority: read
cost_tier: 1
version: 0.1.0
provenance: "hand-authored, 2026-05-27, Phase 1.9 seed"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Project Status Summary

## Goal
Return a concise status paragraph an executive can read in <10 seconds.

## Steps
1. Load project context via `graph.read.project_context(project_id)`.
2. Load top-3 stale tasks via `graph.read.stale_tasks(project_id, limit=3)`.
3. Emit a 1-3 sentence summary:
   - State project name, overall status, open/closed task counts.
   - Call out blocking or longest-stale task by name + days_in_stage.
   - End with owner or PM name if available.
4. Cite `[project:<uuid>]` and each cited `[task:<uuid>]`.

## Constraints
- Max 3 task citations per summary.
- Do not expose Zoho deal IDs unless asked.

## Tests
See `evals/cases.yaml`.