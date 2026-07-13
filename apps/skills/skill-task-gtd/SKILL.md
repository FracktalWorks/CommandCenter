# skill-task-gtd

Provider-agnostic GTD tools for `agent-task-manager`. Every tool operates on
the canonical GTD store through the gateway `/tasks` API (internal token +
`X-User-Email`) — never on a PM tool's REST API directly; the gateway's
provider interface layer resolves the connector (ClickUp first).

| Tool | What it does |
|---|---|
| `gtd_capture(title, notes)` | one thought → INBOX (capture ≠ clarify) |
| `gtd_capture_many(lines)` | brain-dump → one item per line |
| `gtd_list(view, query, context)` | inbox / next / waiting / someday / reference / calendar / done |
| `gtd_list_projects()` | unified projects (LOCAL + synced) |
| `gtd_accounts()` | connected workspaces + their stages/members (fetched-beforehand schema) |
| `gtd_inbox_insights()` | bucket counts, oldest capture, stale waiting-fors, projects w/o next action |
| `gtd_clarify(item_id)` | structured proposal: disposition + next action + project match + destination + stage |
| `gtd_organize(item_id, kind, …)` | apply ONE user-confirmed decision (dest workspace → staged `pending`) |
| `gtd_update(item_id, …)` | rename / note / tickler snooze |

**Boundary (C-04):** no provider writes from the agent. Organizing toward a
connected workspace stages the item (`sync_state='pending'`); the **user**
pushes it from the UI. The Action Broker takes over gating in Phase 4.

Env: `GATEWAY_URL` (default `http://localhost:8080`), internal token via
settings/`LITELLM_MASTER_KEY`; acting user via ContextVar or
`ACB_AGENT_USER_EMAIL`.
