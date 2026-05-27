---
name: action_item_from_meeting
domain: delivery
description: Extract discrete action items from a meeting transcript, resolve assignees against acb_graph.Person, and return structured JSON.
when_to_use: "After a meeting transcript is ingested (Phase 2). Delivery agent calls this to seed ClickUp task drafts."
inputs:
  transcript_id: "uuid of acb_graph.Meeting"
outputs:
  action_items: "list of {title, assignee_id, due_hint, project_hint, cite}"
allowed_tools:
  - graph.read.meeting_transcript
  - graph.read.person_by_name
authority: suggest
cost_tier: 2
version: 0.1.0
provenance: "hand-authored, 2026-05-27, Phase 1.9 seed"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Action Item Extraction from Meeting

## Goal
Turn free-form transcript text into structured, assignee-resolved action items ready for the Action Broker to draft as ClickUp tasks.

## Steps
1. Load transcript via `graph.read.meeting_transcript(transcript_id)`.
2. Identify sentences matching patterns: "X will Y", "X to Y", "action: Y for X", "X owns Y".
3. For each item:
   a. Resolve assignee name to `Person.id` via `graph.read.person_by_name(name)`.
   b. Extract a due hint if a date/day is mentioned.
   c. Suggest a project from context if name matches a known project.
4. Return JSON array of action items.
5. Cite `[meeting:<uuid>]` + each `[person:<uuid>]`.

## Constraints
- Assignee resolution accuracy target: >=90% (NFR-06).
- If a name cannot be resolved, set `assignee_id: null` and include the raw name in `assignee_hint`.

## Tests
See `evals/cases.yaml`.