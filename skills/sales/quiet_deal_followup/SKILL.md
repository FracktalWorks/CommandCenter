---
name: quiet_deal_followup
domain: sales
description: Draft a polite follow-up email/WhatsApp to re-engage a Zoho deal that has had no activity for >=14 days.
when_to_use: "Triggered by reconciler escalation kind=quiet_deal, or invoked manually by Sales agent."
inputs:
  deal_id: "uuid of acb_graph.Deal"
  channel: "email | whatsapp (default: email)"
outputs:
  draft_subject: "string (email only)"
  draft_body: "markdown"
  cite: "[deal:<uuid>] required"
allowed_tools:
  - graph.read.deal_360
authority: suggest
cost_tier: 2
version: 0.1.0
provenance: "hand-authored, 2026-05-26, Phase 0.5 seed"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Quiet Deal Follow-up

## Goal
Given a quiet deal (no activity >= 14d, not Closed Won/Lost), draft a short, warm follow-up
that the deal owner can review, edit, and send.

## Steps
1. Load the deal via `graph.read.deal_360(deal_id)`. Fail if not found.
2. Skip drafting when `stage` matches `^closed` (case-insensitive) — emit a `{ "skip": true, "reason": "stage_closed" }` payload instead.
3. Read the deal's last 3 messages (any channel) for tone calibration.
4. Draft:
   - Acknowledge the gap honestly ("just circling back").
   - Restate the value prop in one sentence.
   - Propose one concrete next step (call slot, sample doc, revised quote).
   - Sign off in the deal owner's name.
5. Emit `[deal:<uuid>]` citation. Without it, the guardrail will reject the output.

## Constraints
- <= 120 words (email) or <= 60 words (WhatsApp).
- No emojis unless the last 3 messages used emojis.
- Never invent a price or a delivery date — say "we will confirm" instead.

## Tests
See `evals/cases.yaml` (promptfoo) and `evals/scenarios.yaml` (Inspect AI).