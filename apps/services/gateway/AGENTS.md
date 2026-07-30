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
2. routes/agent.py -- /agent/run, /agent/run/stream (detached: agent survives client disconnect), /agent/run/{thread_id}/reconnect (replay + live follow), /agent/webhook, agent CRUD, mutation inbox (approve/reject). Org access control: `GET /agent` filters the registry to agents the caller may run (unless they hold `agents:manage`, who see everything); all THREE run endpoints (`/run`, `/run/stream`, `/run/async`) call `assert_can_run_agent` — the filtered picker is UX, the endpoint check is the boundary of record. Registry writes (register/patch/delete/pull) need `agents:manage`. `/agent/webhook/{source}` is the fourth run path and is authenticated by HMAC-SHA256 over the raw body (`X-CC-Signature`; per-source `AGENT_WEBHOOK_SECRET_<SOURCE>` overrides the global one) — it FAILS CLOSED with 503 when no secret is configured, because it starts an agent run and is internet-reachable. The same events also fan out to workflow event triggers (`routes/workflows/triggers.dispatch_event`, best-effort) — an event can route to an agent, to workflows, or both
3. routes/chat.py -- Chat history CRUD (Postgres-backed sessions and messages) + GET /chat/active-sessions (Redis cc:active:* scan for running agents)
4. routes/oauth.py -- OAuth authorize->callback->refresh for Zoho/ClickUp/Google
5. routes/integrations.py — Integration Registry management, MCP server CRUD, Plugin install/remove
6. routes/memory.py -- Memory search and management endpoints
7. routes/settings.py -- LLM settings, model config
8. routes/email.py -- Email account CRUD, message listing/search, send, sync, AI chat, OAuth flow for Gmail/Microsoft/IMAP. Background sync scheduler hooks (refresh/remove) on account PATCH/DELETE. transport/contacts.py serves GET /email/contacts/card — the people card behind a sender's name/avatar (identity, correspondence stats, last N messages, plus phone/title/company parsed out of the sender's own signature). Read side is derived entirely from mail already in the caller's own accounts (every query goes through core._account_scope); no directory lookup, no provider call. Write side: each open upserts what the parse learned into `email_contacts` (mig 119) via `_remember_contact`, so the mailbox accumulates a people directory for the planned Contacts view — see ai-company-brain/specs/email_app_master_plan.md §3.14 before extending it. Invariants that must not be weakened: `manual_fields[]` columns are never overwritten by a parse; an empty parse never blanks a stored value; derived facts (counts, last-seen) are never stored; the domain→company guess is display-only and applied AFTER the write.
9. routes/v1_compat.py -- OpenAI-compatible /v1/chat/completions endpoint (used by Copilot SDK BYOK provider and MAF OpenAIChatCompletionClient). Includes message sanitization for providers with strict validation (e.g. DeepSeek rejects assistant messages with neither content nor tool_calls).
10. routes/debug.py -- E2 post-hoc diagnostics over the agent_run trace store (GET /debug/runs, /debug/runs/{id}, POST .../flag). EXECUTIVE/AGENT-gated.
11. routes/observability.py -- E2 LIVE observability over the global activity bus (cc:activity): GET /observability/activity/recent (backfill), /observability/activity/stream (SSE, agent+model activations across chat and ALL apps), /observability/active (runs in flight), /observability/roster (all agents + working/idle status for the office view), /observability/cost (daily LLM $ rollup by model/app). EXECUTIVE/AGENT-gated. Publish side: acb_common.activity + the executor run boundary + acb_llm._emit_usage (which also prices each call via litellm). App attribution is automatic — acb_llm.context._infer_app_source() reads the caller's gateway.routes.<app> module, so any new app is observable with zero wiring.
12. routes/notes/ -- AI Note Taker /notes API (spec: ai-company-brain/specs/note_taker_app.md): meeting CRUD + library search, recording upload (multipart -> NOTES_MEDIA_DIR) + audio playback, background transcription pipeline over the pluggable acb_stt provider layer (BYOK Groq/OpenAI/Deepgram; summary_run rows carry per-stage status/errors), notes generation on acb_llm (templates.py prompt compiler + summaries.py grounded map-reduce -> meeting_note + draft action_item; auto-chained after transcription), and a per-meeting SSE progress stream (events.py). Same core/feature-module layout as routes/tasks.
13. routes/apps/ -- Custom Apps / App Workshop `/apps` API (RFC: docs/app-workshop/README.md, Phase 0+2a): app CRUD + workspace scaffold (apps_root() = CUSTOM_APPS_ROOT or {agents_clone_dir}/custom_apps, git-inited, app.json manifest per RFC §4.1), edit-gated workspace file passthrough (containment-guarded), publish → immutable app_versions rows + rollback + sandbox-CSP bundle serving, and the App Runtime API the `cc` bridge calls (/me, /data app-scoped JSON storage with shared/per-user partitions, /ai/complete on acb_llm tier aliases with a monthly per-app token budget from app_audit, /usage). Phase 1 draft durability (durability.py): eligible workspace text files mirror into `app_files` (write-through on file PUT, full sync on create/publish/POST /{slug}/sync) and a missing workspace lazily rehydrates from the store via `ensure_workspace` (the read-path choke point in files._edit_workspace + publish's draft reads); per-edit git checkpoints on the workspace repo (POST /{slug}/sync, GET /{slug}/checkpoints, POST /{slug}/restore — additive `checkout <sha> -- .` + restore commit, best-effort/never-500). Phase 2a `cc.tools` (tools.py): POST /{slug}/tools/{tool} — a small local `_TOOL_REGISTRY` (currently just `clickup.create_task`) checked against the LIVE manifest's `tool:<name>?constraints` scopes (`parse_tool_scope`/`find_declared_tool_scope`; request args can never override a frozen constraint, `merge_tool_args`); read-only tools execute inline, destructive ones need a per-use confirm or a remembered `app_tool_grants` row ("always allow for this app") and then flow through the Action Broker (`action_broker.propose/submit`, namespaced action names `app.<tool_with_underscores>` to avoid colliding with `routes/tasks/broker_handlers.py`'s bare `clickup.create_task` registration — same flat `_HANDLERS` dict, different owners). Publish-time admin review (publish.py): an org-visibility publish declaring a non-read-only tool scope queues an `app.publish_review` proposal (SUGGEST → always NEEDS_APPROVAL) instead of going live, unless the same `scope_set_hash` was already approved on a prior version; approval flips `app_versions.review_status` and repoints `apps.live_version` (tools.py's `_apply_publish_review`, the registered handler). A rejected review has no reconciliation path — republish a new version. Phase 2a manifest `actions` (actions.py): POST /{slug}/actions/{name} + in-process `execute_app_action(slug, action_name, args, user)` (the orchestrator's agent-tool wrapper calls this directly, no HTTP loopback) — the reverse direction from `cc.tools`: named, typed capabilities OTHER callers (API clients, platform agents with `UserContext(role=AGENT)`) invoke INTO an app, checked against the LIVE manifest's `actions` array (four kinds: `storage.list`/`storage.get`/`storage.set` over `app_data`'s shared partition, `tool.call` wrapping a tool the app already declared a `tool:<name>` scope for — reuses tools.py's `find_declared_tool_scope`/`merge_tool_args`/`_TOOL_REGISTRY`/`_broker_action_name`/`propose`/`submit` wholesale). `readonly` is derived, never manifest-trusted (hardcoded for the three storage kinds; `_TOOL_REGISTRY[...].read_only` for `tool.call`). Readonly actions and `storage.set` auto-apply for any viewer (person or agent) — `storage.set` only touches the app's own already-publish-reviewed storage; non-readonly `tool.call` auto-applies via the broker (`AuthorityTier.AUTONOMOUS`) only for a person who can also edit the app, else unconditionally `AuthorityTier.SUGGEST` (`NEEDS_APPROVAL`, no bypass — no confirm-toast is possible for an unattended API/agent caller). Tables: infra/postgres/114_custom_apps.sql + 115_app_files.sql + 116_app_tool_grants.sql. Same core/feature-module layout as routes/tasks (`_common.py` is the leaf).
14. routes/admin/ -- Org access control `/admin` API + `/auth/me` (spec: ai-company-brain/specs/org_access_control.md, Phase 1): member roster and lifecycle (invite/suspend/remove — soft, because ~every user-scoped table keys people by email), role assignment, custom role CRUD, per-user allow/deny overrides, and the feature catalog the admin UI renders from. `GET /auth/me` is deliberately NOT admin-gated — every signed-in member calls it to resolve their own feature/agent access, and it returns resolved OUTCOMES (allowed feature slugs, runnable agent names) rather than raw permission patterns, so the matching rule has exactly one implementation. `GET /admin/members/{email}/access` returns each decision WITH its provenance (which role granted it, which override took it away) — the admin UI shows that verbatim rather than re-deriving it. Invariants enforced in `_common.py`: the org always keeps an owner, nobody assigns a role above their own rank, and system roles are immutable. Every write calls `invalidate_access` so a change lands immediately instead of after the resolver's 60s TTL. Tables: infra/postgres/130_org_access_control.sql. Same `_common.py`-is-the-leaf layout as routes/apps and routes/tasks.
15. routes/workflows/ -- Workflows app `/workflows` API (spec: ai-company-brain/specs/workflows_app.md; RFC: docs/workflow-editor/README.md): workflow CRUD over the React-Flow-native edit-model (`workflows.graph` jsonb, persisted verbatim), publish → compile to an immutable `workflow_versions.serialized` run-model (edit-model ≠ run-model; runs pin versions), run start/history/detail + a per-run SSE event stream (in-process hub in service.py; runs are supervised asyncio tasks — durable queueing is BO‑20), the served node catalog (agents from the live registry, integrations from acb_skills with availability probe, workflow tool registry, ready modules — the palette is never hard-coded, spec D7), Module Studio (workflow_modules CRUD + conversational generate on acb_llm tier routing + AST validate + subprocess test/run), the inbound webhook trigger `POST /workflows/hooks/{hook_token}` (public by token — in PUBLIC_ROUTES + the router's exempt list; optional HMAC `X-CC-Signature`; rate-limited; fires only published workflows with an enabled webhook trigger), and the cron schedule scanner (scheduler.py — apscheduler CronTrigger parsing inside a supervised asyncio loop with CAS claims on `last_fired_at`; started/stopped from main.py lifespan). The engine subpackage (engine/: templating, graph compile/validate, node handlers over injected NodeServices, MAF WorkflowBuilder runner, module AST validator + restricted subprocess runner) is transport-free — no FastAPI/DB imports — so it is unit-testable alone and movable into the orchestrator if isolation later demands. Agent nodes call `orchestrator.executor.run_agent` (source="workflow", MAF batch path — constraint #9); write-class tool nodes dispatch through `action_broker.propose/submit` (fail closed, constraint #4); module code is import-free/pure-transform only (real sandbox is BO‑7). Capability search (search.py): **keyword-only by explicit owner decision** — deterministic token/substring ranking over the live registries (no index table, no embeddings; an embedding-backed variant was built and deliberately removed in favour of BO‑22, the platform-wide semantic-search service, whose ranking backend will swap in behind the same API shape) — `GET /workflows/catalog/search` serves the palette's search box AND the copilot's shortlist from the same ranking. Workflow Copilot (copilot.py): `POST /workflows/{id}/copilot` — chat-to-build; the LLM emits `{reply, graph, new_modules}`; **missing modules are auto-created** (Module Studio AST validation, saved `ready` with `auto_created` provenance, name→id rewired), the graph is validated with one named-issue repair round against the same validators as publish, and the result is returned for CLIENT-side apply — the copilot never writes the workflow row. `_call_copilot` is the stubbing seam for tests. Tables: infra/postgres/132_workflows.sql. Slice 2: **approval node** — an `approval` node pauses the run (engine returns status `paused`; downstream marked `pending`), `service._hold_for_approval` files a `workflow.resume_run` proposal into the EXISTING Action Broker inbox (`pending_actions` → /approvals UI) with everything a resume needs in the `workflow_run_pauses.snapshot`; approving fires `broker_handlers._resume_run_handler` which replays the run with completed nodes' stored outputs (`precomputed` — no repeated side effects) and the gate resolved; a rejected proposal is reconciled lazily on run read (run → `cancelled`). **Event triggers** — `triggers.dispatch_event` starts runs for published workflows whose `kind='event'` binding matches `(source, event_type)` (empty type = all); fed by BOTH `/agent/webhook/{source}` (routes/agent.py calls it after agent routing; response carries `workflow_runs`) and the native ClickUp receiver via `ingestion.event_hooks` (a `post_sync.py`-style sink registry — ingestion never imports upward; main.py registers the dispatcher at startup). Same core-is-the-leaf layout as routes/tasks; ⚠️ `__init__.py` import order is load-bearing (static paths before crud's `/{workflow_id}`; a regression test pins it). Startup: main.py lifespan calls `service.reconcile_orphaned_runs()` BEFORE starting the scheduler — rows still `running` belong to a dead process and are swept to `failed` ("interrupted by a platform restart"); `paused` rows are deliberately untouched (resume rebuilds everything from the pause snapshot), and `runs.py` keeps the per-read lazy patch for reads that race the sweep. Run-history drill-in (spec F9): clicking a history row in the editor's RunConsole fetches the run detail and paints its recorded `node_results` onto the canvas (cleared when a live test run starts). Engine semantics are locked by a CI-blocking golden trajectory eval — `evals/trajectories/test_workflow_engine_trajectory.py`; `skill-eval.yml` triggers on `routes/workflows/**` so engine edits re-run the gate. **Publish authority** (spec Q3, migration 133): `POST /{id}/publish`, `/versions/{v}/rollback`, and `/disable` require the `workflows:publish` capability on top of the router's `feature:workflows` gate — they are the acts that ARM triggers to run unattended. Drafting, validate, Test runs, duplicate, and the copilot stay open to the feature (a draft fires no triggers and its writes are still broker-held). `/auth/me` returns a resolved `capabilities` list so the editor can grey out Publish with a reason instead of a bare 403 — the browser must never re-derive wildcard matching (`permissions` holds raw patterns; an owner has `*`). **Wait node** (F3 logic vocabulary): `{"seconds": N}`, ≤`WAIT_INLINE_MAX_SECONDS` (60) sleeps inline inside the run; longer pauses the run exactly like an approval but with `reason='wait'` + a `resume_at` deadline in the pause snapshot and NO broker proposal (nobody decides anything) — `scheduler.scan_due_waits()` runs in the same loop as cron triggers and hands matured pauses to the SAME `service.resume_run`, which routes by pause reason (`elapsed_waits` vs `resolved_approvals`, so an elapsed wait can never clear an approval downstream). A resumed wait must never sleep again: the handler only sleeps when the duration is inline-short. Lifecycle extras: `POST /{id}/duplicate` (crud.py — copies graph/variables/triggers into a fresh DRAFT; the hook token is ALWAYS regenerated, it is a credential) and `POST /{id}/versions/{v}/rollback` (publish.py — republishes version v's immutable snapshot as a NEW version; deliberately does not re-validate as a gate since rollback is incident response — catalog drift comes back as non-blocking `warnings`, and the draft edit-model is never clobbered).
16. agents.json -- Dynamic agent registry (persisted alongside pyproject.toml)

## Work Guidance

### Authentication posture (BO-2)

Authentication is **default-deny, applied app-wide**: `main.py` attaches
`require_authenticated(public=PUBLIC_ROUTES)` at `FastAPI(dependencies=[...])`,
so every route — including one added tomorrow — requires a valid internal
bearer token or a domain-verified `X-User-Email`. You do NOT add an auth
dependency for that; you add an *authorization* one.

A genuinely public endpoint (provider webhook, OAuth callback, liveness probe)
goes in `main.PUBLIC_ROUTES` **by route template**, and must authenticate
itself some other way. `tests/unit/test_default_deny_auth.py` fails if any
route escapes the guard, or if a PUBLIC_ROUTES entry matches no live route.

Swagger/ReDoc/openapi.json are dev-only (`docs_enabled`): FastAPI mounts them
without a dependency chain, so they cannot be guarded, and they publish the
whole API surface.

### Adding a new endpoint
1. Create or extend a route file in routes/
2. Register the router in main.py
3. Use acb_auth.get_current_user for authentication; gate access with
   `require_permission("feature:<slug>")` (preferred for new routes) or the
   legacy `require_role(...)`. `get_current_user` already resolves the caller's
   org roles + overrides onto `UserContext.access`, so no second lookup is needed.
   A whole feature surface is gated at the router with
   `require_feature_router("<slug>", exempt=[...])`, so a new endpoint under
   that prefix is covered by default.
   ⚠️ **Adding a machine entrypoint** (provider webhook, OAuth callback, worker
   callback) under a gated prefix: add its route TEMPLATE to that router's
   `exempt` list, or the feature gate will 401 it and silently stop ingestion.
   `tests/unit/test_org_access_enforcement.py` fails on any route that takes no
   `UserContext` and is not exempt — do not silence it without checking which
   kind of route you added
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
