---
name: quiet_deal_escalation
domain: reconciler
description: Compose a concise escalation record for a Zoho deal that has had no activity for N days, ready for the Sales agent to draft a follow-up.
when_to_use: "Called by reconciler.quiet_deal_scan() when days_quiet > threshold. Runs nightly."
inputs:
  deal_id: "uuid of acb_graph.Deal"
  days_quiet: "integer"
outputs:
  escalation_text: "1-2 sentences with [deal:<uuid>] citation"
  severity: "low | medium | high"
allowed_tools:
  - graph.read.deal_context
authority: read
cost_tier: 1
version: 0.1.0
provenance: "hand-authored, 2026-05-27, Phase 1.9 seed"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Quiet Deal Escalation

## Goal
A factual escalation record the reconciler persists; the Sales agent drafts a follow-up next.

## Steps
1. Load deal context via `graph.read.deal_context(deal_id)`.
2. Severity: days_quiet < 21 -> low; < 45 -> medium; >= 45 -> high.
3. Compose: "Deal '{name}' (stage={stage}, {days_quiet} days quiet) needs follow-up from {owner}."
4. Cite `[deal:<uuid>]`.

## Tests
See `evals/cases.yaml`.