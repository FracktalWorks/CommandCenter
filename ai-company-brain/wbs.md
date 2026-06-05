# Work Breakdown Structure — CommandCenter v2 (Distributed, Self-Mutating Agent Network)

> Project: CommandCenter v2 · Org: Fracktal Works · Date: 2026-06-02 · Version: 2.0
> Team: 2 engineers + AI assistance · Iterative, MVP-first, no hard deadline

This WBS is phase-decomposed by *capability slice*. Each phase delivers a deployed, working slice.

Effort uses **engineer-weeks (ew)** with PERT triple-point estimates: (O, M, P) and PERT = (O + 4M + P) / 6.

---

## Phase 0 — Core Engine Foundation (Capability: dynamic event routing + first agent running)

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 0.1 | Infrastructure baseline | Provision VM, Docker Compose, Postgres+pgvector (no AGE — Phase 2), **redis:7-alpine** Streams, secrets vault, CI | (1, 1.5, 3) | 1.7 |
| 0.2 | Graph schema v0 | DDL for PERSON, TASK, PROJECT, CUSTOMER, DEAL, MESSAGE, MEETING, ACTIONITEM, GOAL | (0.5, 1, 2) | 1.1 |
| 0.3 | ClickUp ingestor | Webhook receiver + REST poller + entity normaliser + canonical-key resolver | (1, 2, 4) | 2.2 |
| 0.4 | Agent repo scaffold (template) | GitHub repo template for `agent-<name>` with `config.json`, `agents.py`, `instructions.md`, `tests/`, `evals/`; `agents.py` exports `build_agents() → list[Agent]` (MAF agents, each backed by `GitHubCopilotAgent` with MCP server config); CI workflow that runs pytest + Promptfoo evals on every PR | (0.5, 1, 2) | 1.1 |
| 0.5 | Skill repo scaffold (template) | GitHub repo template for `skill-<name>` as a pip-installable Python package; entry function interface contract; CI workflow | (0.25, 0.5, 1) | 0.5 |
| 0.6 | Dynamic Agent Loader + AG-UI endpoint | FastAPI route controller: git clone agent + skill repos into persistent cache; `sys.path.append` + `importlib.import_module('agents')`; calls `build_agents()` → runs via MAF native workflow engine; lifecycle cleanup after run. **Also**: `add_agent_framework_fastapi_endpoint(app, agent, "/copilot/chat")` — replaces `copilot_chat.py` SSE path; Control Plane chat now uses AG-UI protocol over the same MAF agent. Remove `copilot_chat.py`. | (1, 2, 3) | 2.0 |
| 0.7 | MAF harness (⇐ replaces LangGraph + PostgresSaver; no DTS emulator) | Rewrite `apps/orchestrator/`: (a) remove `langgraph`, `langgraph-checkpoint-postgres`, `deepagents`, `langchain-core`; (b) add `agent-framework`, `agent-framework-github-copilot --pre`, `agent-framework-ag-ui`, `agent-framework-redis --pre` (**`agent-framework-mem0` deferred to Phase 2** — Postgres entity graph covers business memory for Phase 0); (c) rewrite `graph.py` → `agents.py` using `HandoffBuilder`/`ConcurrentBuilder`; (d) wire `RedisHistoryProvider` (conversation history, operator chat path only) in agent startup; background event-driven agents use in-memory `AgentSession` only; (e) call `configure_otel_providers()` with a generic `OTEL_EXPORTER_OTLP_ENDPOINT` — replaces all direct Langfuse SDK calls (Langfuse itself removed from the Phase-0 stack; OTLP backend TBD); (f) **no DTS emulator** — HITL uses Action Broker pattern (Postgres `approval_queue`); (g) update Dynamic Agent Loader to import `build_agents()` instead of `build_graph()`; audit log writer unchanged. **DurableTask + Mem0 both deferred to Phase 2** (WBS 2.x). | (1, 2, 4) | 2.2 |
| 0.8 | Gateway + auth | FastAPI + Google SSO restricted to fracktal.in domain | (0.5, 1, 2) | 1.1 |
| 0.9 | First agent: `agent-task-manager` + `skill-clickup-sync` | Single agent answering "status of project / person / task" with citations; deployed as decoupled repos; validates end-to-end clone → import → execute flow | (1, 2, 3) | 2.0 |
| 0.10 | Guardrails v0 | Schema-validated outputs, citation enforcement, unresolved-entity abort | (0.5, 1, 2) | 1.1 |
| 0.11 | Observability (MAF native OTel) | Configure MAF's built-in OTel via `configure_otel_providers(OTEL_EXPORTER_OTLP_ENDPOINT=...)` in orchestrator startup — **no separate openllmetry SDK or Langfuse Python SDK in agent code**; cost meter per tier (LiteLLM spend tracking); MCP trace propagation included in MAF OTel by default. **Self-hosted trace backend (e.g. Langfuse) removed from Phase-0 stack — wire an OTLP backend later if needed.** | (0.5, 1, 1.5) | 1.0 |
| 0.12 | LiteLLM gateway config | Cloud-only for Phase 0: LiteLLM model aliases (tier-1 = claude-haiku / gpt-4o-mini, tier-2 = claude-sonnet, tier-3 = claude-opus); prompt caching config; cost metering per alias. **vLLM + Qwen3-8B deferred to Phase 2** (requires GPU VM). No RouteLLM — simple alias-based tier selection. | (0.25, 0.5, 1) | 0.5 |
| 0.13 | Phase 0 review (mini-PDR) | Demo end-to-end clone → execute flow; retro; write Phase-1 backlog | (0.25, 0.5, 1) | 0.5 |
| 0.14 | Copilot SDK interactive chat runtime | `POST /copilot/chat` SSE endpoint; hook fixes; credential injection; `autopilot` mode; model picker UI; `GET /copilot/models`; `agent-sales-assistant` Copilot-native workspace | ✅ **Done** 2026-06-03 | — |
| **Phase 0 total** | | | | **~17.6 ew** (~9 calendar weeks with 2 engineers) |

**Phase 0 exit criteria:**
- Executive can ask "where are we on Project X?" and receive a cited answer.
- `agent-task-manager` + `skill-clickup-sync` are two separate GitHub repos; Core clones both at runtime, executes via MAF workflow engine, and cleans up.
- Reconciler flags drift between graph and ClickUp; zero silent divergence over 7 days.
- All LLM calls routed through LiteLLM tier aliases; per-tier cost tracked via LiteLLM spend metering.
- MAF native OTel instrumentation active (OTLP-ready; no per-agent Langfuse SDK).
- Interactive chat (Control Plane → AG-UI endpoint → MAF agent) responds correctly.
- HITL action submitted by agent appears in `approval_queue` table; gateway endpoint processes approval callback.

---

## Phase 1 — Self-Mutation Loop (Capability: agents fix their own code and open PRs)

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 1.1 | `Self_Mutation_Node` (MAF workflow step) | ✅ **Done** 2026-06-03 — Node spawns Copilot SDK mutation container (`acb-mutation-runner`); checks `mutation_attempts_this_run < 1`; injects failure telemetry; enforces max_mutation_attempts=1. **Pending**: refactor from LangGraph node → MAF workflow step in Phase 1 migration | (1, 2, 3) | 2.0 |
| 1.2 | Copilot SDK mutation sandbox | ✅ **Done** 2026-06-03 — `Dockerfile.mutation` + `mutation_runner.py`; host Docker socket mapped; no DinD required | (1, 2, 3) | 2.0 |
| 1.3 | GitHub PR automation | GitHub API: create branch → commit fix → open PR with failure telemetry summary + diff + test results; PR template; no self-merge permission | (0.5, 1, 2) | 1.1 |
| 1.4 | Eval CI gate on agent/skill PRs | Promptfoo (golden cases) + Inspect AI (scenario tests) run on every PR in any `agent-*` or `skill-*` repo; PR comment with results; merge blocked on fail | (0.5, 1, 2) | 1.1 |
| 1.5 | Mutation audit logging | Log mutation PRs to Postgres (agent, error_type, pr_url, timestamp, outcome); expose in Control Plane HITL queue | (0.25, 0.5, 1) | 0.5 |
| 1.6 | Webhook → MAF dispatch | ~~Copilot SDK `runtime: copilot` dispatch arm~~ **Superseded** — all webhook routes now dispatch to the MAF executor (`orchestrator.executor.run_agent`). The Copilot SDK is mutation-container only; the `runtime: copilot` chat/background path and `agent-sales-assistant` entry were removed. | (0.25, 0.5, 1) | 0.5 |
| 1.7 | LiteLLM BYOK forced for all sessions (cost metering) | Route all sessions through LiteLLM tier aliases regardless of GITHUB_TOKEN presence — enables consistent cost metering for interactive sessions | (0.1, 0.25, 0.5) | 0.25 |
| 1.8 | Phase 1 review (M2: Self-Mutation live) | Demo: force a skill error → confirm Self_Mutation_Node opens PR → confirm max_mutation_attempts respected; review audit log | (0.1, 0.25, 0.5) | 0.25 |
| **Phase 1 total** | | | | **~5 ew remaining** (WBS 1.1–1.2 done; WBS 1.3–1.8 remaining ~4.7 ew) |

**Phase 1 exit criteria (M2 — Self-Mutation live):**
- A deliberate error injected into `skill-clickup-sync` causes `Self_Mutation_Node` to open a GitHub PR with a plausible fix within 5 minutes.
- A second deliberate error in the same run does NOT open a second PR (max_mutation_attempts enforced).
- Human merges the PR → CI evals pass → Core uses updated skill on next event.
- Mutation PRs visible in Control Plane HITL queue.
- All sessions routed through LiteLLM tier aliases produce per-tier cost metering (WBS 1.7 done).

---

## Phase 1.5 — Dynamic Multi-Agent Orchestration ✅ Done 2026-06-05

> **Goal:** MAF orchestrator discovers and routes to all specialist agents automatically; operator can create new capabilities from chat; Copilot SDK used as nested execution units under MAF.

| WBS | Work Package | Activities | Status |
|---|---|---|---|
| 1.5.1 | Dynamic capability registry (`as_tool()`) | Every registered agent loaded at gateway startup and exposed as a `FunctionTool` via `agent.as_tool()`. Description from `config.json` is the routing signal — LLM routes to the right specialist with zero hard-coded rules. New agents registered in UI appear as tools on next restart. | ✅ Done |
| 1.5.2 | `delegate_to_agent` fallback tool | Explicit delegation tool for when `as_tool()` specialist isn't matched by the LLM. Calls `run_agent()` for any named agent and relays its full response. | ✅ Done |
| 1.5.3 | `spawn_copilot_agent` tool | Orchestrator tool that spins up a Copilot SDK mutation container for any creation/build/fix task requested in chat. Commits + pushes directly; next run picks up the change. | ✅ Done |
| 1.5.4 | Agent auto-repair on `AgentLoadError` | `AgentLoadError` (missing `agents.py`, incompatible structure) triggers Copilot SDK sandbox with researcher+editor two-phase prompt. Generates compliant `agents.py`, commits directly. | ✅ Done |
| 1.5.5 | Proactive skill sync | After every `git pull`, loader scans `skills/*/scripts/` for new scripts not yet in `agents.py`. Injects async subprocess wrappers, commits+pushes. Agent repos self-update as new skills are added. | ✅ Done |
| 1.5.6 | Control Plane agent management UI | `/agents` page: add GitHub repo (auto-fetches `config.json`), remove dynamic agents, integration status badges, config.json preview. | ✅ Done |
| 1.5.7 | Control Plane integration UI | `/integrations` page: per-service configure/test/status with live API verification; writes to root `.env`; hot-reload. | ✅ Done |
| 1.5.8 | LLM settings UI | `/settings/models` page: per-tier model picker, provider key save (Gemini, OpenAI, Anthropic), LiteLLM health status. | ✅ Done |
| 1.5.9 | AG-UI → SSE translation fix | Chat route correctly translates AG-UI protocol events (`TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, `RUN_FINISHED`) to delta/tool_start/tool_end SSE events the frontend hook understands. Named agent chat works end-to-end. | ✅ Done |
| 1.5.10 | WorkflowBuilder integration (Phase 2 ready) | `WorkflowBuilder` imported in orchestrator. Infrastructure ready for sequential/fan-out/fan-in explicit pipelines via `add_chain()`, `add_fan_out_edges()`, `add_fan_in_edges()`. | ✅ Done (infra) |

**Phase 1.5 exit criteria (all met):**
- Orchestrator auto-discovers all registered agents as MAF tools at startup; LLM routes by description.
- Operator can ask a cross-domain question (tasks + deals) in one chat message; orchestrator fans out and synthesises.
- Operator can say "build a LinkedIn scraper skill" → Copilot SDK container creates code, commits, live on next run.
- Any incompatible agent repo auto-generates `agents.py` using researcher+editor pattern on first run.
- All Control Plane pages (agents, integrations, settings) wired end-to-end with working backend API.

--- (Capability: full domain coverage with specialist agents)

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 2.1 | `agent-reconciler` + `skill-graph-write` | Nightly diff agent as independent repo; reconciler escalation queue wired to Control Plane | (1, 1.5, 3) | 1.7 |
| 2.2 | `agent-sales` + `skill-zoho-ingest` | Zoho CRM webhooks + REST + MCP; deal status, pipeline, customer 360 | (1, 2, 3) | 2.0 |
| 2.3 | `agent-triage` + `skill-gmail-capture` | Gmail Pub/Sub; email triage classifier; link to deals/projects | (1, 2, 3) | 2.0 |
| 2.4 | Customer/Person entity resolution | Deterministic + LLM fallback; cross-source canonical key deduplication | (1, 2, 4) | 2.2 |
| 2.5 | `skill-action-broker` | Approval queue write + audit logging; RBAC scaffold (exec / employee roles) | (0.5, 1, 2) | 1.1 |
| 2.6 | Semantic cache + token compression | GPTCache in front of LiteLLM (1h TTL); LLMLingua-2 on tool outputs >1k tokens | (0.5, 1, 2) | 1.1 |
| 2.7 | Mem0 + Graphiti memory integration | Episodic memory per user/account; bi-temporal entity KG; both on existing Postgres | (1, 1.5, 3) | 1.7 |
| 2.8 | Phase 2 review | (0.25, 0.5, 1) | 0.5 |
| **Phase 2 total** | | | | **~12.3 ew** (~6 calendar weeks with 2 engineers) |

---

## Phase 3 — Capture Expansion (Capability: WhatsApp + meetings + ambient triggers + push)

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 3.1 | Meeting bot (`skill-meeting-transcribe`) | Vexa self-hosted on dedicated VM; `skill-meeting-transcribe` wraps WhisperX + Pyannote; calendar auto-accept | (1, 2, 3) | 2.0 |
| 3.2 | Transcript pipeline → graph | Diarised transcript → entity graph; action-item extraction (Tier-2) | (1, 2, 3) | 2.0 |
| 3.3 | `skill-whatsapp-send` + WhatsApp ingest agent | WhatsApp Business API provisioning; `agent-triage` extension for WA community; Meta webhook | (1, 2, 4) | 2.2 |
| 3.4 | Ambient trigger engine | Event bus → rule evaluator → agent dispatch | (1, 2, 4) | 2.2 |
| 3.5 | `agent-delivery` (push + stale-task detection) | Stale-task detection, ping, escalate; WhatsApp/email push channel | (1, 2, 3) | 2.0 |
| 3.6 | Phase 3 review | (0.25, 0.5, 1) | 0.5 |
| **Phase 3 total** | | | | **~11 ew** (~5.5 calendar weeks with 2 engineers) |

---

## Phase 4 — Write Authority + Approval UX

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 4.1 | Action Broker full build | Approval queue, approval UI (Control Plane), audit log, rollback, per-action authority tier config system | (2, 3, 5) | 3.2 |
| 4.2 | Suggest+Apply: ClickUp task creation from meetings | From `agent-triage` → action-item → ClickUp task; confirm draft → write | (1, 2, 3) | 2.0 |
| 4.3 | Suggest+Apply: Zoho follow-up drafts | From `agent-sales` → stale deal → Gmail draft; suggest → approve → send | (1, 2, 3) | 2.0 |
| 4.4 | Phase 4 review | (0.25, 0.5, 1) | 0.5 |
| **Phase 4 total** | | | | **~7.7 ew** (~4 calendar weeks with 2 engineers) |

---

## Phase 5 — Intelligence Layer + Hardening

| WBS | Work Package | Activities | (O, M, P) ew | PERT ew |
|---|---|---|---|---|
| 5.1 | `agent-strategy` | Weekly digest + hiring/firing signals; LightRAG over internal docs/SOPs | (2, 3, 4) | 3.0 |
| 5.2 | Odoo RPC ingestor | MO, PO, inventory, finance (read-only); delivery-risk model | (1, 2, 4) | 2.2 |
| 5.3 | RouteLLM training pass | Export labelled call log from the LiteLLM gateway / OTLP traces; fine-tune RouteLLM binary classifier | (0.5, 1, 2) | 1.1 |
| 5.4 | Self-mutation quality review | Review all self-authored PRs to date; catalogue error patterns; seed golden evals from resolved mutations | (0.5, 1, 2) | 1.1 |
| 5.5 | Hardening pass | Cost optimisation, latency, retry/idempotency, security audit | (1, 2, 3) | 2.0 |
| 5.6 | v2.0 release review | Demo full lifecycle; retro; publish runbook | (0.5, 1, 2) | 1.1 |
| **Phase 5 total** | | | | **~10.5 ew** (~5.5 calendar weeks with 2 engineers) |

---

## Cross-Phase Continuous Work (not in critical path)

| WBS | Activity | Allocation |
|---|---|---|
| X.1 | VS Code + Git: authoring new agent/skill repos | Ongoing — engineers work in VS Code, commit to respective repos, open PRs |
| X.2 | PR review for self-mutation PRs | ~2 hrs/wk when agents are in active self-mutation |
| X.3 | Prompt engineering / agent instruction tuning | ~15% of each phase |
| X.4 | Documentation + instructions.md updates | ~10% of each phase |
| X.5 | Security review + secrets hygiene | Quarterly, 1 ew per review |
| X.6 | Cost monitoring + LiteLLM tier-policy tuning | Continuous, ~2 hrs/wk |

---

## Summary

| Phase | Capability | PERT ew | Calendar (2 eng) | Cumulative |
|---|---|---|---|---|
| 0 | Core Engine: dynamic clone + first agent | 17.6 ew | 9 cw | 9 cw |
| 1 | Self-Mutation Loop + GitHub PR automation | 7 ew | 3.5 cw | 12.5 cw |
| 2 | Agent & Skill repos: sales, triage, reconciler | 12.3 ew | 6 cw | 18.5 cw |
| 3 | Capture: WhatsApp + meetings + ambient + push | 11 ew | 5.5 cw | 24 cw |
| 4 | Write authority + Action Broker + Approval UX | 7.7 ew | 4 cw | 28 cw |
| 5 | Strategy + Odoo + RouteLLM + hardening + v2.0 | 10.5 ew | 5.5 cw | 33.5 cw |

**Total: ~66 engineer-weeks ≈ 33 calendar weeks ≈ ~8 months** with 2 engineers at ~80% utilization. Buffer of +20% recommended → **~10 months to v2.0**.

MVP (end of Phase 0) lands at ~2 months. **Self-Mutation live (M2)** at ~3 months. First domain-wide agent coverage (Phase 2) at ~4.5 months.

> **Note on authoring:** No WBS phase exists for "Skill Workbench" or "in-app editor" — agents and skills are authored in VS Code + Git. The Control Plane (Next.js workbench) covers chat, observability, and HITL approvals only. This is a deliberate reduction in scope vs v0.4 and removes ~6.5 ew of UI build effort while improving authoring quality (VS Code + GitHub Copilot > Monaco + iframe).

