# Project Plan — CommandCenter v2

> **Organisation:** Fracktal Works · **Date:** 2026-06-12 · **Version:** 2.7 — M2 closed; Mem0 + Graphiti memory active; all memory systems unified under LiteLLM tiers
> **For AI agents:** Read [`AGENTS.md`](AGENTS.md) first — it has current build status, file index, and glossary.
> This file covers: scope boundaries, milestones, resource allocation, constraints, and open questions.
> **Full detail lives in:** `wbs.md` (tasks + estimates) · `product_requirements.md` (what to build) · `system_architecture.md` (how it works)

---

## What We Are Building

A **headless, self-mutating agent orchestration platform** for running a company. Events (webhooks, cron, ambient) trigger specialist agents that are dynamically loaded from their own GitHub repos, executed inline by the **MAF (Microsoft Agent Framework) HandoffBuilder orchestrator** with DurableTask-backed durable state, and self-heal on failure by spawning an isolated Copilot SDK mutation container, applying a tested fix to the live clone, and opening a GitHub PR. Operators interact via a thin Control Plane browser UI with a unified VS Code Copilot-style chat window (CommandCenter + named agents on the same surface, grouped Copilot SDK + LiteLLM model picker, send / queue / steer controls, markdown/tool rendering, MCQ choices), HITL approvals, and observability. No in-app agent or skill editing — for now.

---

## Scope

### In Scope

- Core engine: FastAPI event router + Dynamic Agent Loader (persistent clone cache) + MAF orchestration (HandoffBuilder / ConcurrentBuilder / MagenticBuilder); Postgres unchanged for entity graph, memory, audit, Integration Registry. **No DTS emulator in Phase 0** (see Architecture Decision section).
- Self-mutation loop: `Self_Mutation_Node` + Copilot SDK mutation container (`acb-mutation-runner`) + GitHub PR automation + eval CI gate
- Distributed agent repos (`agent-task-manager`, `agent-sales`, `agent-triage`, `agent-reconciler`, `agent-delivery`, `agent-strategy`)
- Distributed skill repos (`skill-clickup-sync`, `skill-zoho-ingest`, `skill-gmail-capture`, `skill-whatsapp-send`, `skill-meeting-transcribe`, `skill-graph-write`, `skill-action-broker`)
- Ingest: ClickUp, Zoho CRM, Odoo ERP, Gmail, WhatsApp Business, meeting bots (Vexa)
- Pull (cited Q&A), push (notifications), and ambient (event-driven) interaction modes
- Approval-gated writes via Action Broker with per-action authority tiers
- Nightly reconciliation with escalation queue
- Integration Registry (encrypted credential store; no secrets in agent/skill repos)
- Control Plane (Next.js): chat, HITL queue, observability (audit log + spend)

### Out of Scope

- In-app editing of agents, skills, or workflows — all authoring is VS Code + Git
- Browser IDE of any kind (Theia, VS Code fork, etc.)
- Visual drag-and-drop workflow canvas
- n8n or any second workflow runtime
- Autonomous agent repo merges without human PR review
- Autonomous writes to source systems before Action Broker + authority tiers are live
- Customer-facing access
- Full RBAC beyond admin / operator / contributor

### Success Criteria (v2.0)

- Webhook fires → agent runs in ephemeral container + telemetry logged in < 30 s (warm < 5 s)
- Skill failure → `Self_Mutation_Node` opens GitHub PR with plausible fix in < 5 min; `max_mutation_attempts = 1` enforced
- Executive asks "status of customer X / project Y" → cited answer in < 10 s
- Zero silent drift over 30 consecutive days
- ≥ 3 agent repos have merged self-authored improvement PRs in production by M6

---

## Milestones

| ID | Name | Target | Status |
|---|---|---|---|
| **M1** | Core Engine live — ClickUp Q&A with citations | 2026-05-25 | ✅ PASSED |
| **M2** | Self-Mutation live — agents fix own code, open PRs | 2026-06-12 | ✅ PASSED — Mutation sandbox with foreground Docker container, timeout, sentinel parsing. Eval CI gate with auto-push on green / human-approval on red. Agent purpose context (instructions.md + skills). Local git tracking. Post-run commit detection. HITL queue with Approve/Reject/Remutate + diff review. `max_mutation_attempts=1` enforced. Full audit logging. Incompatibility auto-repair via `agent_repo_compatibility.md`. |
| **M2.5** | Interactive runtime unified — Tier 1.5 SDK streaming live; CopilotKit removed | ~2026-06-20 | ✅ PASSED — GitHub Copilot SDK Tier 1.5 streaming live: tool name / args / result visible in UI via `agent.run(stream=True)`; CopilotKit dependency dropped; badge routing (`agent_runtime`) correct from first render; `effectiveRuntime` forces SDK mode for all github-registered agents regardless of model picker. Remaining cleanup: legacy `/copilot/chat` route removal; MAF-only enforcement verified end-to-end. |
| **M2.6** | Foundation hardening — chat history, cloud sandbox, integration OAuth, AG-UI events | ~2026-07-15 | ✅ PASSED — (1) Chat session list auto-titles from the first message + shows a last-turn preview. (2) Cloud sandbox: `bootstrap.sh` installs pwsh+uv and validates `GITHUB_TOKEN`; `Dockerfile.mutation` adds git+pwsh; gateway `/health/runtime` + startup self-check (copilot SDK / pwsh / token). (3) Integration OAuth: `routes/oauth.py` authorize→callback→refresh for zoho-crm/clickup/google with HMAC-signed state. (4) AG-UI `STATE_SNAPSHOT`/`STATE_DELTA`/`CUSTOM` wired end-to-end → `GenerativeUIPanel` renders state tables + custom widgets inline. |
| **M2.7** | Universal tool injection — web search + full inter-agent wiring for MAF + Copilot agents | 2026-06-06 | ✅ PASSED |
| **M2.8** | Memory systems live — Mem0 episodic + Graphiti bi-temporal KG | 2026-06-12 | ✅ PASSED — Mem0 enabled with pgvector backend, semantic search, `/memory/*` CRUD API, Memory Manager UI. Graphiti enabled with Neo4j (`--profile memory`), `search_entity_timeline()` tool. All memory injected into both orchestrator (`enrich_instructions_with_memory()`) and Copilot SDK agents (`payload.memory_context` → `_default_options.system_message`). Post-run extraction fires after every chat. All embedding/LLM calls route through LiteLLM gateway tiers — zero hardcoded API keys. 61 tests pass. |
| **M3** | Full Agent Ecosystem — Sales + Email + Reconciler agents connected via UI | ~2026-08-26 | Not started — agents built as independent GitHub repos and registered through the Control Plane `/agents` UI. CommandCenter platform work: Zoho + Gmail ingestion pipelines, entity resolution, Action Broker hardening. |
| **M4** | Capture live — meetings + WhatsApp + ambient triggers | ~2026-10-14 | Not started |
| **M5** | Suggest+Apply live — approval-gated writes to ClickUp/Zoho | ~2026-12-09 | Not started |
| **M6** | v2.0 Release — Odoo + Strategy + Intelligence layer | ~2027-02-10 | Not started |

**Critical path:** persistent clone cache ✅ → `Self_Mutation_Node` + Copilot SDK mutation container ✅ → GitHub PR automation ✅ → web tools + inter-agent wiring ✅ (M2.7) → eval CI gate ✅ → **M2 ✅ CLOSED** → Mem0/Graphiti memory ✅ (M2.8) → Zoho + Gmail ingestion pipelines → entity resolution → agent repos registered via UI → M3 → meeting bot + ambient triggers → M4 → Action Broker + Suggest+Apply → M5 → Odoo + strategy + goal model → M6.

**Estimated total from today: ~36 calendar weeks to M6 (2 engineers at ~80%). With 20% buffer → ~10 months.**

---

## Constraints (Hard)

| # | Constraint |
|---|---|
| C-01 | `max_mutation_attempts = 1` per failure event — no exceptions |
| C-02 | No credentials in agent or skill repos — Integration Registry only |
| C-03 | Action Broker is the only write path to source systems |
| C-04 | No autonomous writes until Action Broker + authority tiers are live (Phase 4) |
| C-05 | All agent/skill artefacts promoted via PR with eval CI gate |
| C-06 | DinD: Mutation container spawned by orchestrator requires the host Docker socket (`/var/run/docker.sock`) mapped into the orchestrator container |
| C-07 | Indian DPDP Act 2023 — written employee consent before ingesting email/WhatsApp |
| C-08 | All new interactive and autonomous execution features MUST be implemented on MAF runtime paths. No net-new raw Copilot SDK runtime entrypoints for business-agent execution. |

---

## Architecture Decision: MAF Overlap Analysis & Streamlined Stack (2026-06-04)

**Decision: LangGraph + deepagents → Microsoft Agent Framework (MAF). DurableTask deferred. Interactive chat unified under MAF AG-UI.** Effective 2026-06-04.

### What Changed and Why (MAF Adoption Rationale)

1. **Native multi-agent patterns**: MAF provides `HandoffBuilder` (triage → specialist routing), `ConcurrentBuilder` (fan-out), `GroupChatBuilder`, and `MagenticBuilder` — replacing LangGraph sub-graph boilerplate that had to be hand-written per agent.
2. **Single unified runtime — interactive + background**: `agent-framework-ag-ui` provides `add_agent_framework_fastapi_endpoint(app, agent, "/")` which serves the AG-UI streaming protocol from the same MAF agent used for background event runs. CopilotKit (the Control Plane frontend) natively supports AG-UI. This **eliminates the separate `copilot_chat.py` SSE path** and the raw Copilot SDK chat dispatch arm entirely. One runtime for all agent execution.
3. **MCP servers first-class**: `GitHubCopilotAgent` accepts `mcp_servers=` dict natively. `McpSkillsSource` enables automatic MCP skill discovery per agent repo.
4. **Observability without SDK overhead**: MAF has built-in OpenTelemetry instrumentation (`configure_otel_providers()`) that can export to any OTLP backend. No `langfuse` Python SDK or `openllmetry` in agent code. (Langfuse has been **removed** from the Phase-0 stack to save RAM; wire an OTLP backend here later if tracing is needed.)
5. **Simpler agent repos**: Each agent repo exports `build_agents() → list[Agent]` instead of a LangGraph `StateGraph`. MAF agents are simpler to test, compose, and read.

### Runtime Architecture — Unified MAF (as of 2026-06-10)

**Current state: Single unified MAF runtime.** The dual-runtime split has been retired. The `agent-framework-github-copilot` 1.0.0rc1 release (2026-06-05) relaxed the SDK dependency from `<0.1.33` to `<2,>=1.0.0`, enabling full re-integration.

| Package | Previous | Current |
|---|---|---|
| `agent-framework-core` | 1.7.0 | **1.8.0** |
| `agent-framework-github-copilot` | 1.0.0b260402 | **1.0.0rc1** |
| `github-copilot-sdk` | 0.1.32 | **1.0.0** |

| Agent `agent_runtime` | Executor path | BYOK mechanism |
|---|---|---|
| `github-copilot` | `CommandCenterCopilotAgent` (MAF subclass) → `agent.run(stream=True)` | `provider` in `default_options` → forwarded to Copilot SDK via patched `_create_session()` |
| `maf` | MAF `Agent.run()` | `OpenAIChatCompletionClient` injection with BYOK `base_url` + `api_key` |

**How it works:** The `CommandCenterCopilotAgent` (at `apps/orchestrator/orchestrator/copilot_agent.py`) extends `GitHubCopilotAgent` with BYOK provider forwarding and rich event streaming (reasoning, tool progress, partial results, agent intent). At runtime, the executor monkey-patches these methods onto the loaded agent — zero changes required in agent repos. All Copilot SDK event types are captured and forwarded as AG-UI SSE events to the frontend.

**Previous dual-runtime split (historical):** The MAF wrapper had constrained `github-copilot-sdk` to `<0.1.33`, but BYOK required SDK >= 1.0.0. The executor worked around this by talking to the Copilot SDK directly for `github-copilot` agents. This workaround was removed when the upstream constraint was lifted.

### The Runtimes

- **MAF** (`agent-framework`, `agent-framework-github-copilot`, `agent-framework-ag-ui`) — ALL agent execution. `CommandCenterCopilotAgent` wraps Copilot SDK agents inside MAF for unified streaming, tool calling, and orchestration.
- **GitHub Copilot SDK** (`github-copilot-sdk >= 1.0.0`) — used ONLY inside `GitHubCopilotAgent` / `CommandCenterCopilotAgent` (MAF wrappers) and the mutation sandbox (`acb-mutation-runner` Docker container). Never called directly by application code.
- **LiteLLM** — unified model gateway for all MAF agent calls. Prompt caching, cost metering, model aliases.
- **No LangGraph. No deepagents. No langchain-core. No n8n.**

### Runtime And Tool-Calling Ownership Matrix (Authoritative)

| Scenario | Orchestration owner | Agent-turn runtime | Tool-calling owner | Build here | Do not build here |
|---|---|---|---|---|---|
| Operator chat — any agent | MAF (`agent-framework-ag-ui` for orchestrator; `/agent/run/stream` for named agents) | `CommandCenterCopilotAgent` (github-copilot) or MAF `Agent` (maf) | MAF agent turn with injected tools | `executor.py` MAF path + `copilot_agent.py` | Raw Copilot SDK paths |
| Webhook / cron / ambient autonomous runs | MAF workflow engine | MAF agent selected by router | Per-agent MAF tool calling | `orchestrator.executor` + MAF workflow routing | Raw Copilot SDK background runner |
| Multi-agent routing (triage/handoff/concurrent) | MAF orchestrators | Per-agent provider | Per-agent turn tool calls; cross-agent control in MAF | `HandoffBuilder` / concurrent workflows | Ad-hoc orchestration outside MAF |
| Self-mutation on failure | `Self_Mutation_Node` | Copilot SDK sandbox container | Copilot SDK inside isolated container | `acb-mutation-runner` only | General business-agent runtime |

### Implementation Reality (As Of 2026-06-10)

✅ **Unified MAF runtime achieved.** All agents — Copilot SDK and MAF — run through MAF.

- ✅ `CommandCenterCopilotAgent` wraps Copilot SDK agents in MAF with BYOK provider forwarding
- ✅ All Copilot SDK event types (reasoning, tool progress, partial results, agent intent) captured and forwarded to frontend as AG-UI SSE
- ✅ `agent-framework-github-copilot` 1.0.0rc1 relaxed SDK constraint — no override needed
- ✅ Copilot SDK direct path removed from `executor.py` (~200 lines → ~80 lines)
- ✅ Zero agent repo changes required — monkey-patching at runtime
- ✅ All injected tools (`call_agent`, `web_search`, `fetch_page`, `write_artifact`) work through MAF
- ✅ 154/154 tests pass with no regressions
- ✅ Full chat UI/UX preserved: text streaming, reasoning/thinking, tool calls, terminal output

### Mutation Layer Enhancements (2026-06-10)

- ✅ **Agent purpose context** — the mutation sandbox now receives the failing agent's `instructions.md`, skill descriptions, and trigger event (what the user asked). Previously it only got the error message.
- ✅ **Local git tracking for MAF agents** — agents registered via `local_path` get automatic local git initialisation in the cache directory. This enables version control, commit tracking, and rollback without a GitHub remote.
- ✅ **Local-only repo handling** — mutation approval for local-only repos keeps the commit (no push needed); rejection uses `git reset HEAD~1`.
- ✅ **Monorepo agent guard** — agents without a separate repo directory skip mutation gracefully with a clear log message.

### DurableTask (DTS Emulator) — Deferred to Phase 2

DurableTask is enterprise hosting infrastructure for **distributed**, long-running workflows (think Azure Durable Functions). Phase 0-1 agents are short-running (seconds to minutes) and event-triggered. The DTS emulator adds a new Docker service, new ports (8080/8082), and operational complexity that Phase 0 doesn't need.

**HITL for Phase 0-1** uses the **Action Broker pattern** (Postgres-backed, already in the stack):
1. Agent calls `submit_for_approval(action_type, data)` tool → stores in `approval_queue` table → workflow step completes normally.
2. Control Plane shows pending action in HITL queue.
3. Human approves → gateway endpoint → fresh MAF workflow run for the continuation.
No long-lived process. Postgres survives restarts. No DTS infrastructure needed.

**DTS deferred to Phase 2** when workflows need to genuinely wait hours/days mid-execution (e.g., "send quote, wait 48h, follow up if no reply").

### Full MAF Overlap Analysis — What Each Component Now Provides

| Area | Previously planned | MAF capability | Decision |
|---|---|---|---|
| Background orchestration | LangGraph StateGraph | MAF workflow engine (`agent-framework`) | ✅ MAF replaces LangGraph |
| Interactive chat | Raw Copilot SDK SSE (`copilot_chat.py`) | `agent-framework-ag-ui` endpoint → AG-UI protocol | ✅ AG-UI replaces Copilot SDK chat path |
| Workflow durability | DTS emulator Docker service | Action Broker (Postgres queue) for HITL; short runs need no checkpoints | ✅ DTS deferred to Phase 2 |
| LLM observability | Langfuse Python SDK in each agent | MAF native OTel (any OTLP backend) | ✅ Langfuse removed from Phase-0 stack; OTel-ready, backend TBD |
| Episodic memory | Direct `mem0` Python SDK | `agent-framework-mem0` (`Mem0ContextProvider`) | ✅ Use MAF wrapper |
| Conversation history | Manual session management | `agent-framework-redis` (`RedisHistoryProvider`) | ✅ Use MAF Redis history provider |
| Skill discovery | Manual MCP server config per agent | `McpSkillsSource` (MAF native MCP registry) | ✅ Use McpSkillsSource |
| Semantic cache | GPTCache + redis-stack-server | LiteLLM built-in cache (when needed) | ✅ Defer; revert redis to vanilla alpine |
| Local inference (Tier-1) | vLLM + Qwen3-8B GPU VM | Cloud Tier-1 (Claude Haiku / GPT-4o-mini) | ✅ Defer vLLM to Phase 2 |
| Token compression | LLMLingua-2 (CPU) | Not needed until context costs are a real problem | ✅ Defer to Phase 2 |
| Graph DB | Apache AGE (planned) | Postgres + pgvector for Phase 0 | ✅ AGE already deferred (confirmed) |
| Bi-temporal KG | Graphiti | Mem0 only for Phase 0 | ✅ Graphiti deferred to Phase 2 |
| Meeting capture | Vexa + WhisperX + Pyannote | Not needed for Phase 0-1 agents | ✅ Deferred to Phase 2 |
| Smart LLM routing | RouteLLM (ML-based) | Simple LiteLLM aliases (tier-1/2/3) | ✅ Remove RouteLLM; aliases are sufficient |

### Revised Phase 0 Infrastructure (docker-compose)

**Services:**
1. `postgres` (pgvector) — entity store, Mem0, Integration Registry, Action Broker, audit log
2. `redis` (**vanilla redis:7-alpine**) — Redis Streams event bus + `agent-framework-redis` conversation history
3. `litellm` — unified LLM gateway, model aliases, prompt caching, cost metering

**Removed from Phase 0 (vs prior plan):**
- ❌ Langfuse observability service (`--profile obs`) → removed entirely for Phase 0 RAM savings; wire an OTLP backend later if tracing is needed
- ❌ DTS emulator (`mcr.microsoft.com/dts/dts-emulator:latest`, ports 8080/8082) → Action Broker pattern
- ❌ redis-stack-server → reverted to `redis:7-alpine` (redis-stack only needed for LiteLLM semantic cache, which is Phase 2)
- ❌ vLLM service → cloud LiteLLM Tier-1 (Haiku/GPT-4o-mini); local inference is Phase 2

### Revised Package Delta for `apps/orchestrator/pyproject.toml`

**Remove:**
- `langgraph>=0.2`, `langgraph-checkpoint-postgres>=2.0`, `deepagents>=0.6`, `langchain-core>=0.3`

**Add:**
- `agent-framework` (core + orchestrations + observability)
- `agent-framework-github-copilot` (GitHubCopilotAgent; `--pre` flag)
- `agent-framework-ag-ui` (AG-UI endpoint; unifies interactive + background chat)
- `agent-framework-mem0` (Mem0ContextProvider; wraps Mem0 as first-class context)
- `agent-framework-redis` (RedisHistoryProvider; conversation persistence via existing Redis)

**Not added (deferred):**
- `agent-framework-durabletask` → Phase 2
- `agent-framework-azure-cosmos` → Phase 2 (if Cosmos DB is chosen for workflow checkpoints)

---

### Chat Session History Enrichment

The session list in the Control Plane currently shows only timestamp. A richer history allows operators to resume context without re-reading the full thread.

- **Auto-title:** after the first assistant turn, the gateway derives a session title from the first user message (first 60 chars, truncated at a word boundary). No LLM call required — this is pure string truncation.
- **Last-turn preview:** the last 200 chars of the last assistant response are stored alongside the session record and displayed as a subtitle in the session list.
- **Implementation:** add `title TEXT` and `last_preview TEXT` columns to the `chat_sessions` Postgres table. The gateway updates them via `PATCH /thread/{id}/title` after each `RUN_FINISHED` event. The Control Plane `/api/agent/list-sessions` response includes these fields; the session list component renders them.
- **Cost:** zero — no additional LLM calls; relies on already-stored content.

---

### Cloud Deployment Sandbox — GitHub Copilot SDK Agent Runtime

For VPS/Hetzner cloud deployment every Tier 1.5 `copilot.exe` subprocess must find the following in the orchestrator process environment before the gateway starts. Missing any item causes silent runtime degradation.

| Requirement | How to satisfy | Startup health-check |
|---|---|---|
| `GITHUB_TOKEN` (Copilot-enabled PAT or App installation token) | Injected from Integration Registry at container start; never baked into image | `gh auth status` → `isAuthenticated: true` |
| `pwsh` 7.x on `$PATH` | `apt-get install powershell` from Microsoft `.deb` feed; required by `copilot.exe` shell tool on Linux | `pwsh --version` |
| Python 3.11+ and `uv` | Installed system-wide; `uv` manages per-agent-repo venvs in the persistent clone cache | `uv --version` |
| `github-copilot-sdk` + bundled `copilot.exe` | Installed into the orchestrator venv at Docker image build time | `python -c "import copilot"` |
| Per-agent-repo Python deps | `uv sync` run by the Dynamic Agent Loader on first clone and after any `pyproject.toml`-changing `git pull` | loader logs `deps_synced=true` |
| Writable workspace directory | Persistent volume at `/data/agent-clones`; `copilot.exe` writes scripts here | `os.access(CLONE_DIR, os.W_OK)` |
| Egress to GitHub API and Copilot proxy | Open outbound HTTPS; no MITM proxy for `github.com`, `api.github.com`, `copilot-proxy.githubusercontent.com` | HTTP 200 from `https://api.github.com` |

**Action:** `deploy/hostinger/bootstrap.sh` must be extended to install `pwsh`, validate `GITHUB_TOKEN`, and run a smoke-test `copilot.exe` call before the gateway starts. Health-check failure must abort the container start (`exit 1`) rather than silently degrading to a broken Tier 1.5 path. The orchestrator's `Dockerfile` should install `pwsh` at build time so it is already present on VPS pull.

---

### AG-UI Generative UI — State Sync and Custom Events

The AG-UI protocol includes event types beyond text and tool calls that enable agents to push structured, interactive UI to the frontend without per-agent frontend code.

| AG-UI event | Purpose | CommandCenter use case |
|---|---|---|
| `STATE_SNAPSHOT` | Full agent-state object sent to frontend; rendered as a table, form, or widget | Live deal pipeline table from agent-sales; approval form for HITL writes |
| `STATE_DELTA` (JSON Patch RFC 6902) | Incremental state updates without re-sending the full snapshot | Row-by-row deal updates during a reconciliation run |
| `CUSTOM` | Application-defined events with `name` + `value` payload | Agent-specific rich widgets: `clickup_task_card`, `zoho_deal_chip`, `approval_request` |
| `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` | Structured plan/search activity panels (already rendered in ThinkingContainer) | Real-time search plan while agent queries Zoho |

**Implementation plan:**
1. **M2.6:** Wire `STATE_SNAPSHOT` and `CUSTOM` pass-through in `/api/agent/chat` Next.js route. `useAgentChat.ts` accumulates state into an `agentState` field. `AgentChat.tsx` renders `agentState` as a generic prettified-JSON panel until typed renderers exist.
2. **M3:** Agent repos emit typed `CUSTOM` events (`clickup_task_card`, `zoho_deal_chip`); Control Plane registers a renderer map keyed by `name` — zero per-agent UI code in the Control Plane repo.
3. **M4+:** HITL approval flows use `STATE_SNAPSHOT` + a `CUSTOM` `approval_request` event; the operator approves/rejects inline in the chat panel without navigating to a separate HITL queue page.

Reference: [AG-UI Events spec](https://docs.ag-ui.com/sdk/python/core/events) — `STATE_SNAPSHOT`, `STATE_DELTA`, `CUSTOM`, `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA`.

---

### Integration OAuth Token Exchange Framework

All integrations (ClickUp, Zoho CRM, Gmail, WhatsApp, GitHub) require credentials at agent runtime. The framework must be fully implemented before any real agent can query live company data.

**Credential storage (already partially exists):** Postgres `integrations` table, columns: `service`, `credential_type` (api_key | oauth2_access | oauth2_refresh | webhook_secret), `encrypted_value`, `expires_at`, `scopes`.

**OAuth flow:**
1. Control Plane Integration page shows "Connect" button per service.
2. Click redirects to the provider's OAuth consent screen (ClickUp OAuth 2.0, Zoho OAuth 2.0, Google OAuth 2.0, etc.).
3. Callback endpoint `POST /api/integrations/oauth/callback/{service}` receives the auth code, exchanges it for access + refresh tokens, encrypts and stores both in the Integration Registry.
4. Background task in the gateway (`/apps/gateway`) checks `expires_at < now() + 5min` before each agent run and refreshes automatically using the stored refresh token. The fresh access token replaces the stored one atomically.

**Injection — two paths, same registry:**
- **MAF agents** (`agent_runtime = "maf"`)**: credentials resolved from registry → passed as `mcp_servers=` bearer tokens in `GitHubCopilotAgent` config at `build_agents()` time. Agent code never reads the registry.
- **GitHub Copilot SDK agents (Tier 1.5)** (`agent_runtime = "github-copilot"`): credentials resolved from registry → written as environment variables into `_build_agent_env()` before `agent.start()`. The agent's `config.json["integrations"]` declares which services it needs; the loader injects only declared ones (principle of least privilege).

**Security constraints (non-negotiable):**
- No credential in agent/skill repos, `config.json`, logs, or LLM context at any time.
- Credential values exist only in memory between registry read and agent start, and inside the subprocess environment.
- The Control Plane Integration page is admin-only (RBAC gate).

---


## Resource Plan

| Resource | Allocation | Phase focus |
|---|---|---|
| Engineer A | ~80% | Orchestration, self-mutation, Action Broker, Annealer |
| Engineer B | ~80% | Ingestion, entity graph, agent repos |
| Founder | ~2 h/week | Phase gate reviews, policy decisions |
| Ops lead | ~1 h/day (from Phase 2) | Reconciler escalation queue |
| Infrastructure | Hetzner ~€25/mo (2 VMs); Vexa ~€0.05–0.15/meeting; WA 1K conv/mo free | — |

---

## Top Risks

| ID | Risk | Score | Mitigation |
|---|---|---|---|
| R-04 | Unauthorised write to ClickUp/Zoho/Odoo | 12 | Action Broker; authority tiers; kill switch |
| R-01 | Entity resolution failures (duplicate nodes) | 9 | Deterministic rules first; LLM fallback; human review queue |
| R-02 | Agent hallucinations on company data | 9 | Citation enforcement; schema validation; second-pass verify |
| R-05 | WhatsApp Business API verification delay | 9 | Start early; OpenBSP/Whapi fallback |

---

## Quality Gates

- **Per-PR:** Promptfoo golden cases + Inspect AI scenario tests; merge blocked on regression; no `agents.py` or `SKILL.md` merges without a passing golden case
- **Per-PR (Control Plane chat):** Playwright regression suite must pass for the unified chat window: default-session render, named-agent render, Copilot SDK / LiteLLM model switching, send / queue / steer controls, tool blocks, markdown code rendering, and MCQ answer flows
- **Per-phase exit:** Demo against milestone acceptance criteria; reconciler stable ≥ 7 days; cost within budget
- **Continuous:** citation-coverage and per-tier cost tracked; per-skill success rate monitored
- **Quarterly:** Security review, secrets rotation, access audit, DPDP compliance check

---

---

## Feature: Artifact Viewer — Agent File Browser + Document Viewer

> **Status:** Planning · **Target milestone:** M2.8 (between current hardening and M3)
> **Motivation:** Agents that write files (sales docs, PDFs, Markdown reports, skill scripts, self-mutation patches) produce artefacts the operator cannot currently inspect without SSH. The artifact viewer closes this gap with a collapsible file-tree sidebar and an inline document viewer pop-up, all inside the existing chat layout.

---

### Design Overview

```
┌─────────────┬──────────────────────────────────┬────────────────────┐
│ CommandCenter│          Chat Panel               │  Artifact Sidebar  │
│ Nav Sidebar  │  (AgentChat.tsx + messages)       │  (collapsible, ◀▶) │
│ (collapsible)│                                   │                    │
│             │                                   │  📁 /workspace     │
│             │                                   │   ├─ report.md     │
│             │                                   │   ├─ deal.pdf      │
│             │                                   │   └─ skill.py      │
│             │                                   │                    │
│             │   [Document Viewer Modal]         │  [double-click     │
│             │   renders file content            │   to open]         │
└─────────────┴──────────────────────────────────┴────────────────────┘
```

**Rendering matrix:**

| File type | Renderer |
|---|---|
| `.md` | `react-markdown` + `remark-gfm` (already in stack) |
| `.py` `.ts` `.js` `.sh` `.yaml` `.json` `.toml` `.sql` | `shiki` syntax highlighter (theme: github-dark) |
| `.pdf` | `react-pdf` (`pdfjs-dist`) |
| `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` | Native `<img>` with zoom |
| `.csv` | Plain text table (100-row cap, "load more" toggle) |
| `.txt` `.log` | Plain pre-wrapped text |
| Other / binary | Hex-dump excerpt + "Download" button |

---

### Subtasks

#### ST-AV-01 · Gateway: agent workspace API  *(backend)*

**Goal:** expose the agent's working directory over HTTP so the frontend can browse and fetch files.

- `GET  /agent/workspace/{session_id}`  → JSON tree of files (path, size, modified_at, mime_type)
- `GET  /agent/workspace/{session_id}/file?path=<rel_path>` → raw file bytes (streamed, 50 MB cap)
- The session's workspace root is resolved from the dynamic agent loader's clone cache (`/data/agent-clones/{session_id}/workspace/` or a temp dir created per run). If no workspace exists for the session, return an empty tree (`{files: []}`).
- Add a `workspace_path` field to the `chat_sessions` Postgres table so the gateway can locate the workspace after the agent exits.
- Security: path traversal prevention (resolve + assert path starts with workspace root); no symlink escapes; rate-limit file fetch to 10 req/s per session.
- **Estimate:** 1 day

#### ST-AV-02 · Gateway: push file-tree updates as SSE events  *(backend)*

**Goal:** agents should be able to notify the frontend when they create/modify a file, so the sidebar updates live without polling.

- Emit a new AG-UI `CUSTOM` event type `artifact_created` / `artifact_updated` with payload `{path, size, mime_type}` from any agent that calls `write_artifact(path, content)`.
- Add `write_artifact` as a new injected tool (alongside `web_search`, `call_agent`) — wraps `pathlib.Path.write_text/write_bytes`, then emits the AG-UI event.
- The Control Plane `/api/agent/chat` SSE route already forwards `CUSTOM` events; wire `useAgentChat.ts` to append to an `artifacts` list in chat state.
- **Estimate:** 1 day

#### ST-AV-03 · Frontend: Next.js API proxy for workspace  *(frontend)*

**Goal:** forward workspace requests from browser to gateway without CORS issues, and proxy file bytes through Next.js so the gateway URL never leaks to the browser.

- `GET /api/agent/workspace/[sessionId]` → proxy to `GET {GATEWAY}/agent/workspace/{sessionId}`
- `GET /api/agent/workspace/[sessionId]/file` → proxy byte stream to `GET {GATEWAY}/agent/workspace/{sessionId}/file`
- These follow the same pattern as existing `/api/chat/sessions/[sessionId]/messages`.
- **Estimate:** 0.5 day

#### ST-AV-04 · Frontend: `ArtifactSidebar` component  *(frontend)*

**Goal:** collapsible right sidebar showing a tree of agent-generated files for the active session.

- Sits to the right of the chat panel inside `ChatPageInner` — mirrors the existing left session sidebar (same `w-72` / `w-10` collapsed state pattern already built).
- Toggle button: `»` / `«` chevron at the top-right of the chat panel header.
- State: `artifactPanelOpen: boolean` (default `false`; expands automatically when the first artifact is received via SSE).
- File tree rendered with shadcn `Collapsible` for nested folders; file icons from `lucide-react` keyed by extension.
- On mount (or when `activeSessionId` changes), fetch `GET /api/agent/workspace/{sessionId}` and populate the tree.
- Subsequent updates driven by `artifacts` SSE events (ST-AV-02) — merge new/updated entries into the tree without a full refetch.
- Each file row has: icon + filename + size badge. Double-click → opens `ArtifactViewerModal` (ST-AV-05).
- Right-click context menu (shadcn `DropdownMenu`): "Open", "Download".
- Empty state: "No artifacts yet. Artifacts will appear here as the agent creates files."
- **Dependencies:** shadcn `Collapsible`, `DropdownMenu`, `ScrollArea` (install if not present).
- **Estimate:** 1.5 days

#### ST-AV-05 · Frontend: `ArtifactViewerModal` component  *(frontend)*

**Goal:** pop-up document viewer that renders agent files with appropriate fidelity by type.

- shadcn `Dialog` (full-screen on mobile, `max-w-4xl` centred on desktop) with a close `×` button.
- Header: filename + breadcrumb path + "Download" button.
- Body renders based on MIME / extension:
  - **Markdown** → `react-markdown` + `remark-gfm` (already used in `MarkdownMessage.tsx`).
  - **Code** → `shiki` (install `shiki`; auto-detect language from extension; theme `github-dark`); wrap in a `<pre>` with horizontal scroll.
  - **PDF** → `react-pdf` (install `react-pdf` + `pdfjs-dist`); paginated, page count shown, scroll within modal.
  - **Image** → `<img>` with `object-contain`, click-to-zoom via CSS transform.
  - **CSV / plain text / log** → `<pre>` with `whitespace-pre-wrap`, line numbers for code-like files.
  - **Binary / unknown** → first 256 bytes as hex dump, "Download file" CTA.
- File content fetched from `GET /api/agent/workspace/{sessionId}/file?path=<path>` on modal open (lazy — never pre-fetched).
- Loading state: shadcn `Skeleton` placeholder while fetching.
- Error state: toast via shadcn `Sonner` if fetch fails.
- **Dependencies:** `shiki`, `react-pdf`, `pdfjs-dist` (install). `react-markdown` + `remark-gfm` already present.
- **Estimate:** 2 days

#### ST-AV-06 · Frontend: wire artifacts into `AgentChat` + `useAgentChat`  *(frontend)*

**Goal:** connect the SSE pipeline to the sidebar without prop-drilling.

- Add `artifacts: ArtifactEntry[]` and `onArtifact: (a: ArtifactEntry) => void` to `useAgentChat` return type.
- SSE handler: when event `type === "custom"` and `name === "artifact_created" | "artifact_updated"`, append/merge into the `artifacts` array.
- `AgentChat.tsx` passes `artifacts` and an `onArtifactOpen` callback down; `ChatPageInner` lifts the open-modal state up.
- The `ArtifactSidebar` auto-expands (`setArtifactPanelOpen(true)`) on the first received artifact.
- **Estimate:** 0.5 day

#### ST-AV-07 · Frontend: install shadcn components  *(frontend setup)*

**Goal:** ensure required shadcn components are present before ST-AV-04/05 build work.

Components needed (run `npx shadcn@latest add <component>`):
- `dialog` — modal shell for the viewer
- `collapsible` — folder expand/collapse in the file tree
- `dropdown-menu` — right-click context menu
- `scroll-area` — scrollable file list and PDF pages
- `skeleton` — loading placeholder in viewer
- `sonner` — toast for file-fetch errors (check if already present)

Also install npm packages: `shiki`, `react-pdf`, `pdfjs-dist`.
- **Estimate:** 0.5 day

#### ST-AV-08 · Agent: `write_artifact` tool in acb_skills  *(backend)*

**Goal:** give all MAF + Copilot SDK agents a first-class, observable way to write files.

- Add `write_artifact(path: str, content: str | bytes, *, encoding: str = "utf-8") -> dict` to `packages/acb_skills/`.
- Tool registers the file under `session_workspace_root / path`; returns `{path, size, sha256}`.
- After writing, emits the AG-UI `CUSTOM` event if an event emitter is in context (injected by the gateway at run time).
- Wire into `_inject_agent_tools` alongside `web_search` and `call_agent`.
- Unit test: `tests/unit/test_write_artifact.py`.
- **Estimate:** 1 day

#### ST-AV-09 · Postgres: `workspace_path` column on `chat_sessions`  *(backend)*

**Goal:** persist the workspace directory path so the gateway can serve files after the agent exits.

- Migration: `ALTER TABLE chat_sessions ADD COLUMN workspace_path TEXT;`
- Add to `infra/postgres/01_schema.sql` and create `05_workspace_path.sql` migration script.
- Gateway sets `workspace_path` when a session's agent first calls `write_artifact`.
- **Estimate:** 0.5 day

---

### Sequencing & Dependencies

```
ST-AV-07 (shadcn + npm install)
    │
    ├──▶ ST-AV-04 (ArtifactSidebar)
    │        └──▶ ST-AV-05 (ArtifactViewerModal)
    │                └──▶ ST-AV-06 (wire into AgentChat)
    │
ST-AV-09 (DB migration)
    └──▶ ST-AV-01 (Gateway workspace API)
             └──▶ ST-AV-03 (Next.js proxy)
                      └──▶ ST-AV-04 (consumes proxy)

ST-AV-02 (push SSE events)
    └──▶ ST-AV-08 (write_artifact tool)
             └──▶ ST-AV-06 (consume in useAgentChat)
```

**Minimum viable slice (can ship independently):**
ST-AV-09 → ST-AV-01 → ST-AV-03 → ST-AV-07 → ST-AV-04 → ST-AV-05

This gives a working file browser + viewer for files already on disk, without the live SSE push. ST-AV-02 + ST-AV-08 add real-time auto-discovery in a second pass.

**Total estimate:** ~8 days (1 engineer) across ~2 sprints.

---

### Open Questions for Artifact Viewer

1. **Workspace lifetime** — how long do per-session workspaces persist? Tie to session TTL or always-retain? (Affects disk usage on VPS.)
2. **Size cap** — 50 MB per file fetch seems safe; should there be a total workspace cap per session (e.g. 500 MB)?
3. **Security boundary** — the workspace API is currently admin-only (same as the rest of the Control Plane). If multiple operators eventually share a Control Plane, should workspace access be scoped per session owner?
4. **PDF worker path** — `pdfjs-dist` requires a service worker file to be served from `/public`; confirm this is handled in the Next.js `public/` folder during ST-AV-07.

---

## Open Questions

1. **Monthly LLM cost ceiling** — confirm budget envelope; drives tier thresholds
2. **Retention policy** — exact windows for raw transcripts, message bodies, derived facts; needs legal sign-off
3. **Autonomous promotion threshold** — what success rate per agent justifies suggest+apply → autonomous?
4. **WhatsApp community read posture** — confirm Meta TOS for agent reading group messages as a participant
5. **Meeting policy** — which meetings does the bot join? Default-in or default-out? Consent UI?
6. **DurableTask hosting (Phase 2)** — when agents need to genuinely wait hours/days mid-workflow, choose between (a) DTS emulator (dev/MVP) or (b) Azure Durable Task Scheduler cloud service. Postgres is NOT the DTS backend — DTS is a separate store. Decision deferred until Phase 2 scope is locked.
7. **OAuth provider registration** — ClickUp, Zoho, and Google OAuth apps must be registered with `redirect_uri` pointing to the VPS hostname. Decide: one shared OAuth app per service (org-level) or per-operator? Affects credential scope and token isolation.
8. **Cloud sandbox GitHub token model** — use a single org-level GitHub App installation token (rotated every hour automatically) or per-operator fine-grained PAT? The former is simpler operationally; the latter gives per-user audit trails for agent actions.
9. ~~**Copilot SDK within MAF with BYOK**~~ — **RESOLVED (2026-06-10).** `agent-framework-github-copilot` 1.0.0rc1 relaxed the SDK dependency to `<2,>=1.0.0`. The Copilot SDK direct path has been removed from `executor.py`. All `github-copilot` agents now run through `CommandCenterCopilotAgent` (MAF subclass) with BYOK via `default_options["provider"]`. Copilot SDK features (shell, file r/w, MCP servers) are available for BYOK sessions through the unified MAF abstraction. All Copilot SDK event types (reasoning, tool progress, partial results) flow through MAF to the frontend. See `system_architecture.md` §13.3.
10. **MAF agent local git tracking** — pure MAF agents without GitHub repos now get automatic local git initialisation in the cache directory. Enables version control, commit tracking, mutation sandbox compatibility, and rollback without external dependencies. See `system_architecture.md` §13.4.
11. **Mutation layer agent context** — the mutation sandbox now receives the failing agent's purpose (`instructions.md`), skill descriptions, and trigger event context, not just the error message. This enables smarter, context-aware fixes that preserve the agent's persona and domain behaviour.

---

## Nice to Have / Future

These features are acknowledged as valuable but are not currently scheduled.

### 1. AI-Powered Integration Code Generation (apis-config agent upgrade)

The `apis-config` agent currently discovers API credentials and auto-generates credential schemas. A future upgrade would extend it to **generate full integration code**:
- **Ingestion client** — async HTTP client with auth, rate limiting, and pagination (e.g. `ingestion/sources/notion/client.py`)
- **Normaliser** — maps API objects to the entity graph (`person`, `task`, `project`, etc.)
- **Sync script** — scheduled data pull job (e.g. `scripts/notion_sync.py`)
- **Webhook receiver** — real-time event ingestion
- **Agent tools** — MAF-callable functions exposed to specialist agents (e.g. `search_notion_pages()`)
- **Settings fields** — typed config entries in `acb_common/settings.py`

The agent would use web search to fetch API docs, generate boilerplate via LLM, commit to a new skill repo (`skill-{name}-sync`), and wire the tools into the agent ecosystem. Credentials would continue to flow through the encrypted Integration Registry — no secrets in generated code.

**Prerequisites:** robust code-generation quality from the underlying LLM; automated eval gate for generated repos; human review before enabling in production.
