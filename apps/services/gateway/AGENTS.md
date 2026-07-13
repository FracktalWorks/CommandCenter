# Gateway -- FastAPI Entry Point

## Purpose

The gateway is the HTTP/WS entry point for all external interaction with
CommandCenter. It hosts the MAF AG-UI chat endpoint, agent run/stream endpoints,
webhook receivers, OAuth callbacks, and the Control Plane API.

## Ownership

- Owner: CommandCenter Core team
- Path: apps/gateway/

## Local Contracts

1. main.py -- FastAPI app factory, lifespan (key loading, model cache warmup, aiosmtpd inbound SMTP startup, background email sync scheduler), /copilot/chat AG-UI endpoint (relayed through stream_relay.run_detached when thread_id present)
2. routes/agent.py -- /agent/run, /agent/run/stream (detached: agent survives client disconnect), /agent/run/{thread_id}/reconnect (replay + live follow), /agent/webhook, agent CRUD, mutation inbox (approve/reject)
3. routes/chat.py -- Chat history CRUD (Postgres-backed sessions and messages) + GET /chat/active-sessions (Redis cc:active:* scan for running agents)
4. routes/oauth.py -- OAuth authorize->callback->refresh for Zoho/ClickUp/Google
5. routes/integrations.py — Integration Registry management, MCP server CRUD, Plugin install/remove
6. routes/memory.py -- Memory search and management endpoints
7. routes/settings.py -- LLM settings, model config
8. routes/email.py -- Email account CRUD, message listing/search, send, sync, AI chat, OAuth flow for Gmail/Microsoft/IMAP. Background sync scheduler hooks (refresh/remove) on account PATCH/DELETE.
9. routes/v1_compat.py -- OpenAI-compatible /v1/chat/completions endpoint (used by Copilot SDK BYOK provider and MAF OpenAIChatCompletionClient). Includes message sanitization for providers with strict validation (e.g. DeepSeek rejects assistant messages with neither content nor tool_calls).
10. routes/debug.py -- E2 post-hoc diagnostics over the agent_run trace store (GET /debug/runs, /debug/runs/{id}, POST .../flag). EXECUTIVE/AGENT-gated.
11. routes/observability.py -- E2 LIVE observability over the global activity bus (cc:activity): GET /observability/activity/recent (backfill), /observability/activity/stream (SSE, agent+model activations across chat and ALL apps), /observability/active (runs in flight), /observability/roster (all agents + working/idle status for the office view), /observability/cost (daily LLM $ rollup by model/app). EXECUTIVE/AGENT-gated. Publish side: acb_common.activity + the executor run boundary + acb_llm._emit_usage (which also prices each call via litellm). App attribution is automatic — acb_llm.context._infer_app_source() reads the caller's gateway.routes.<app> module, so any new app is observable with zero wiring.
12. agents.json -- Dynamic agent registry (persisted alongside pyproject.toml)

## Work Guidance

### Adding a new endpoint
1. Create or extend a route file in routes/
2. Register the router in main.py
3. Use acb_auth.get_current_user for authentication
4. Follow FastAPI patterns: Pydantic models, dependency injection
5. Audit all write operations via acb_audit.record()

### Mutation inbox flow
1. Pending commits listed via GET /agent/mutations/pending
2. Approve: POST /agent/mutations/pending/{id}/approve -> git push (GitHub) or keep (local)
3. Reject: POST /agent/mutations/pending/{id}/reject -> git reset HEAD~1
4. Local-only repos detected via git remote get-url origin check

### Agent registration
1. POST /agent with repo_url or local_path
2. Auto-fetches config.json to populate metadata
3. Persisted to agents.json at project root
4. agent_runtime auto-detected: repo_url -> github-copilot, local_path -> maf

## Verification

- Gateway health: GET /health returns {status: ok}
- Chat endpoint: POST /copilot/chat streams AG-UI events
- Agent stream: POST /agent/run/stream returns SSE stream with model
- Detached runs: disconnect mid-stream, cc:active:{tid} stays "1" and
  cc:stream:{tid} keeps growing; reconnect endpoint replays to RUN_FINISHED
  (E2E: uv run python scripts/_test_reconnect_e2e.py <agent> "<prompt>")
- Active sessions: GET /chat/active-sessions lists running thread IDs
- Live activity: GET /observability/active lists agent runs in flight; GET
  /observability/activity/stream is an SSE feed of every agent/model activation
  (start a chat or trigger an app → events appear); backfill via
  /observability/activity/recent. GET /observability/roster = all agents +
  status; GET /observability/cost?days=N = daily $ rollup. EXECUTIVE/AGENT-gated.
  Cross-app check: trigger an email/tasks LLM call and confirm it appears with
  the right `source` and a non-null `cost_usd`.
- Workspace files: GET /agent/workspace/{id} lists files; only inputs/, outputs/, and agent-data/ are visible to the frontend user (agent source code is hidden)
- File download: GET /agent/workspace/{id}/file?path= serves raw bytes (50 MB cap)
- Global artifacts: GET /agent/artifacts?agent=&category= lists all files from all agent workspaces; GET /agent/artifacts/file?agent=&path= serves raw bytes
- All endpoints require auth (Bearer token + optional X-User-Email/X-User-Role)
- Identity chain: Next.js → Bearer + user headers → deps.py resolves real UserContext
- Chat sessions scoped by user.email; fallback to "default" for anonymous/internal calls

## Child DOX Index

None -- leaf directory.
