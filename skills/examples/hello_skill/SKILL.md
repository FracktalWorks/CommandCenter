---
name: hello_skill
description: Sanity-check skill — proves the skill loader and SKILL.md parsing are wired correctly.
when_to_use: "Manual: invoked by the Phase-0 smoke test only."
allowed_tools: []
authority: read
cost_tier: 1
version: 0.0.1
provenance: "hand-authored, 2026-05-25, scaffolding"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# Hello Skill

A trivial skill used to validate the registry and Workbench plumbing.

## Steps
1. Echo back the input string, prefixed with `"hello, "`.
2. Return.

## Notes
- Replace this with a real skill once WBS 0.5 (Skill Workbench MVP) lands.
- See ai-company-brain/system_architecture.md §11 for the full skill lifecycle.
