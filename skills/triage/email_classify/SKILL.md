---
name: email_classify
domain: triage
description: Classify an inbound internal email into one of the standard triage labels and extract key entities.
when_to_use: "Called by the email triage pipeline (WBS 1.4) for every new Gmail message captured via Pub/Sub."
inputs:
  email_id: "uuid of acb_graph.Message (email)"
outputs:
  label: "one of: sales_lead | sales_followup | delivery_issue | hr_query | finance | internal | spam | unknown"
  entities: "list of {kind, id, name} for resolved Person/Customer/Deal/Project entities"
  confidence: "float 0..1"
  cite: "[message:<uuid>]"
allowed_tools:
  - graph.read.email_body
  - graph.read.person_by_email
  - graph.read.customer_by_name
authority: read
cost_tier: 1
version: 0.1.0
provenance: "hand-authored, 2026-05-27, Phase 1.9 seed"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Email Classify

## Goal
Fast Tier-1 classification so higher-tier agents only process relevant emails.

## Steps
1. Load email body via `graph.read.email_body(email_id)`.
2. Apply rule-based pre-filters (regex for invoice numbers, stage keywords).
3. Classify with Tier-1 LLM using a short-form system prompt.
4. Resolve sender/CC to `Person` and subject mentions to `Customer`/`Deal`/`Project`.
5. Return structured JSON.

## Constraints
- Tier-1 only; total tokens <500 per call.
- If confidence < 0.6, set label to "unknown" and escalate to Tier-2.

## Tests
See `evals/cases.yaml`.