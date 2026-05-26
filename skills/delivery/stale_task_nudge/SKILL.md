---
name: stale_task_nudge
domain: delivery
description: Send a short WhatsApp nudge to the owner of a ClickUp task that has been in the same stage for >=14 days.
when_to_use: "Triggered by reconciler escalation kind=stale_task, or invoked manually by Delivery agent."
inputs:
  task_id: "uuid of acb_graph.Task"
outputs:
  nudge_text: "<= 280 chars, WhatsApp tone"
  cite: "[task:<uuid>] required"
allowed_tools:
  - graph.read.task_context
authority: suggest
cost_tier: 1
version: 0.1.0
provenance: "hand-authored, 2026-05-26, Phase 0.5 seed"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Stale Task Nudge

## Goal
A friendly, non-aggressive WhatsApp message to the task owner asking what is blocking them.

## Steps
1. Load task context (title, stage, days_in_stage, project, owner) via `graph.read.task_context(task_id)`.
2. Compose <= 280 chars:
   - Greet the owner by first name.
   - State the task title + stage + days_in_stage.
   - Ask one open question ("anything blocking?").
   - Offer one concrete unblock ("ping me / drop in the project channel").
3. Emit `[task:<uuid>]` citation.

## Constraints
- Never blame, never escalate to the owner's manager in the same message.
- If days_in_stage >= 45, also append "(flagged to PM)" — escalation broker will handle the rest.
- WhatsApp formatting only (`*bold*`, `_italics_`, no Markdown headers).

## Tests
See `evals/cases.yaml`.