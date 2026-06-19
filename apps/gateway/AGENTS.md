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
10. agents.json -- Dynamic agent registry (persisted alongside pyproject.toml)

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
- Workspace files: GET /agent/workspace/{id} lists files; only inputs/, outputs/, and agent-data/ are visible to the frontend user (agent source code is hidden)
- File download: GET /agent/workspace/{id}/file?path= serves raw bytes (50 MB cap)
- Global artifacts: GET /agent/artifacts?agent=&category= lists all files from all agent workspaces; GET /agent/artifacts/file?agent=&path= serves raw bytes
- All endpoints require auth (Bearer token + optional X-User-Email/X-User-Role)
- Identity chain: Next.js → Bearer + user headers → deps.py resolves real UserContext
- Chat sessions scoped by user.email; fallback to "default" for anonymous/internal calls

## Child DOX Index

None -- leaf directory.
