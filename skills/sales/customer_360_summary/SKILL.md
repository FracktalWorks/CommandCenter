---
name: customer_360_summary
domain: sales
description: "Produce a one-paragraph customer 360 for a named account: open deal count, pipeline INR, last activity, owner."
when_to_use: "When a user asks 'how is Acme doing?' or 'tell me about customer X'."
inputs:
  customer_id: "uuid of acb_graph.Customer"
outputs:
  summary: "1-3 sentences with [customer:<uuid>] and relevant [deal:<uuid>] citations"
allowed_tools:
  - graph.read.customer_360
authority: read
cost_tier: 1
version: 0.1.0
provenance: "hand-authored, 2026-05-27, Phase 1.9 seed"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Customer 360 Summary

## Goal
One-paragraph view of a customer relationship health.

## Steps
1. Load customer 360 via `graph.read.customer_360(customer_id)`.
2. State: name, open_deal_count / deal_count, pipeline_value_inr, last_activity_at, owners.
3. Highlight any deal in negotiation or with days_quiet >= 14.
4. Cite `[customer:<uuid>]`; cite up to 2 `[deal:<uuid>]` tokens if specific deals are called out.

## Tests
See `evals/cases.yaml`.