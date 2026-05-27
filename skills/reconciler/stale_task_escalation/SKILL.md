---
name: stale_task_escalation
domain: reconciler
description: Compose a concise escalation record for a ClickUp task that has exceeded its per-stage staleness threshold, ready for the reconciler to write to the audit log and queue for the Delivery agent.
when_to_use: "Called by reconciler.stale_task_scan() when days_in_stage > threshold. Runs nightly."
inputs:
  task_id: "uuid of acb_graph.Task"
  days_in_stage: "integer"
outputs:
  escalation_text: "1-2 sentences with [task:<uuid>] and [person:<uuid>] (owner) citation"
  severity: "low | medium | high"
allowed_tools:
  - graph.read.task_context
authority: read
cost_tier: 1
version: 0.1.0
provenance: "hand-authored, 2026-05-27, Phase 1.9 seed"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Stale Task Escalation

## Goal
A concise, factual escalation record the reconciler can persist and the Delivery agent can act on.

## Steps
1. Load task context via `graph.read.task_context(task_id)`.
2. Determine severity: days_in_stage < 21 -> low; < 45 -> medium; >= 45 -> high.
3. Compose: "Task '{title}' (stage={stage}, {days_in_stage} days) owned by {owner} needs attention."
4. Cite `[task:<uuid>]` + `[person:<uuid>]`.

## Tests
See `evals/cases.yaml`.