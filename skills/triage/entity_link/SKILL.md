---
name: entity_link
domain: triage
description: Link a triage-classified email to the best-matching CRM entity (Customer, Deal, or Project) using the entity resolver.
when_to_use: "Second step of the email triage pipeline, after email_classify returns a non-unknown label."
inputs:
  email_id: "uuid of acb_graph.Message"
  label: "triage label from email_classify"
outputs:
  linked_entities: "list of {kind, id, confidence}"
  cite: "[message:<uuid>]"
allowed_tools:
  - graph.read.email_body
  - graph.read.person_by_email
  - graph.resolve.customer_or_deal
authority: read
cost_tier: 1
version: 0.1.0
provenance: "hand-authored, 2026-05-27, Phase 1.9 seed"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Entity Link

## Goal
Produce a ranked list of entity links so the orchestrator can attach the email to the right record in the graph.

## Steps
1. Extract company/project/deal name mentions from email body.
2. Run deterministic resolver for each mention (exact + fuzzy name match).
3. If deterministic confidence < 0.8 and multiple candidates exist, escalate to LLM tiebreaker.
4. Return top-3 linked entities with confidence scores.
5. Cite `[message:<uuid>]`.

## Tests
See `evals/cases.yaml`.