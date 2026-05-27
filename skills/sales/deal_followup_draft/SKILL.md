---
name: deal_followup_draft
domain: sales
description: Draft a short, personalised Zoho follow-up email for a deal that has gone quiet, using the deal stage and last activity as context.
when_to_use: "Triggered when days_quiet >= 14 on a non-closed deal. Sales agent or reconciler escalation invokes this."
inputs:
  deal_id: "uuid of acb_graph.Deal"
outputs:
  subject: "email subject line"
  body: "plain-text email body, <= 150 words, [deal:<uuid>] citation"
allowed_tools:
  - graph.read.deal_context
authority: suggest
cost_tier: 2
version: 0.1.0
provenance: "hand-authored, 2026-05-27, Phase 1.9 seed"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Deal Follow-up Draft

## Goal
A professional, concise follow-up email ready for the sales owner to send with one click.

## Steps
1. Load deal context via `graph.read.deal_context(deal_id)`.
2. Draft subject: "Following up on [deal name]".
3. Body (<=150 words):
   - Greeting by customer contact name if known.
   - Refer to last discussed stage / proposal.
   - Ask one open question about next steps.
   - Offer a specific timeslot or calendar link placeholder.
4. Cite `[deal:<uuid>]` at end of body.

## Constraints
- Never include internal deal value or pipeline data in external emails.

## Tests
See `evals/cases.yaml`.