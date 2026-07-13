---
name: skill_clickup_sync
description: "Retrieve task status and project task lists from ClickUp."
when_to_use: "When the user asks about task status, project progress, assignees, or due dates."
allowed_tools: []
authority: read
cost_tier: 1
version: 0.1.0
provenance: "hand-authored, 2026-06-05"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# skill-clickup-sync

Provides two read-only ClickUp tools for agent-task-manager:

| Function | Description |
|---|---|
| `get_task_status` | Fetch status, assignees, due date for a single task ID |
| `list_project_tasks` | List open tasks in a list matching a project name |

## Required Environment Variables
- `CLICKUP_API_TOKEN` — personal token from ClickUp settings
- `CLICKUP_WORKSPACE_ID` — workspace (team) ID