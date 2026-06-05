# Project Plan — CommandCenter v2

> **Organisation:** Fracktal Works · **Date:** 2026-06-05 · **Version:** 2.4 — runtime ownership clarified (MAF vs Copilot SDK)
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
| **M2** | Self-Mutation live — agents fix own code, open PRs | ~2026-07-01 | 🔄 In progress — mutation sandbox ✅ (2026-06-03); GitHub PR automation (WBS 1.3) + eval CI gate (WBS 1.4) remaining |
| **M2.5** | Interactive runtime unified under MAF AG-UI (deprecate raw Copilot SDK chat path) | ~2026-06-20 | 🔄 In progress — unified chat UX is live, but legacy `copilot` runtime dispatch and `/copilot/chat` path still exist for compatibility; migration completion requires MAF-only routing |
| **M3** | Full Agent Ecosystem — Sales + Email + Reconciler | ~2026-08-26 | Not started |
| **M4** | Capture live — meetings + WhatsApp + ambient triggers | ~2026-10-14 | Not started |
| **M5** | Suggest+Apply live — approval-gated writes to ClickUp/Zoho | ~2026-12-09 | Not started |
| **M6** | v2.0 Release — Odoo + Strategy + Intelligence layer | ~2027-02-10 | Not started |

**Critical path:** persistent clone cache (done) → `Self_Mutation_Node` + Copilot SDK mutation container (done) → GitHub PR automation → eval CI gate → M2 → agent-sales + Zoho ingest → entity resolution → Mem0/Graphiti → M3 → meeting bot + ambient triggers → M4 → Action Broker + Suggest+Apply → M5 → Odoo + strategy + goal model → M6.

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

### The Single Runtime Going Forward

**MAF is the only agent execution runtime.** The GitHub Copilot SDK is used only for the mutation container subprocess. There are no "two runtimes".

- **MAF** (`agent-framework`, `agent-framework-github-copilot`, `agent-framework-ag-ui`) — all agent execution: background event-driven runs (webhook/cron), interactive operator chat (AG-UI protocol via Control Plane), and multi-agent orchestration.
- **GitHub Copilot SDK** — mutation container ONLY (`acb-mutation-runner` Docker image spawned by `Self_Mutation_Node`). Not a runtime for agent logic.
- **LiteLLM** — unified model gateway for all MAF agent calls. Prompt caching, cost metering, model aliases. WBS 1.7 (force BYOK for all sessions) gives consistent cost metering.
- **No LangGraph. No deepagents. No langchain-core. No n8n. No raw Copilot SDK chat path.**

### Runtime And Tool-Calling Ownership Matrix (Authoritative)

Use this table to decide where new work belongs.

| Scenario | Orchestration owner | Agent-turn runtime | Tool-calling owner | Build here | Do not build here |
|---|---|---|---|---|---|
| Operator chat in Control Plane | MAF (`agent-framework-ag-ui`) | MAF `GitHubCopilotAgent` (Copilot provider inside MAF) | Copilot-backed MAF agent turn; governed by MAF endpoint/session context | MAF AG-UI endpoint + MAF agent definitions (`build_agents()`) | New standalone `/copilot/chat` business-agent logic |
| Webhook / cron / ambient autonomous runs | MAF workflow engine | MAF agent selected by router | Agent provider for that agent turn; routing/retries/handoffs by MAF | `orchestrator.executor` + MAF workflow routing | Raw Copilot SDK background runner for new autonomous flows |
| Multi-agent routing (triage/handoff/concurrent) | MAF orchestrators | Per-agent provider (Copilot/OpenAI/etc.) | Per-agent turn tool calls; cross-agent control in MAF | `HandoffBuilder` / concurrent workflows | Ad-hoc orchestration outside MAF |
| Self-mutation on failure | `Self_Mutation_Node` (or MAF step once migrated) | Copilot SDK sandbox container | Copilot SDK inside isolated container | `acb-mutation-runner` only | General business-agent runtime |

### Implementation Reality (As Of 2026-06-05)

Target architecture is MAF-only for agent execution, but implementation is still in transition:

- Legacy compatibility branch remains in gateway webhook dispatch for agents marked `"runtime": "copilot"`.
- Legacy `/copilot/chat` path still exists and must be treated as transitional.
- Default and required direction for all new capability work is MAF routing and MAF AG-UI.

Migration-complete definition for runtime unification:

1. No webhook/event route dispatches to raw Copilot SDK background runner for business-agent execution.
2. Interactive Control Plane chat routes only through MAF AG-UI for CommandCenter/named-agent runs.
3. Copilot SDK remains only in mutation sidecar execution (`acb-mutation-runner`).

Build-policy summary for engineers:

1. If the feature is user-facing chat, event-triggered automation, or multi-agent orchestration: implement in MAF.
2. If the feature is failure-repair code mutation in isolated sandbox: implement in Copilot SDK mutation runner.
3. If a change introduces new raw Copilot SDK runtime paths for business-agent execution, treat it as architecture regression.

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

## Open Questions

1. **Monthly LLM cost ceiling** — confirm budget envelope; drives tier thresholds
2. **Retention policy** — exact windows for raw transcripts, message bodies, derived facts; needs legal sign-off
3. **Autonomous promotion threshold** — what success rate per agent justifies suggest+apply → autonomous?
4. **WhatsApp community read posture** — confirm Meta TOS for agent reading group messages as a participant
5. **Meeting policy** — which meetings does the bot join? Default-in or default-out? Consent UI?
6. **DurableTask hosting (Phase 2)** — when agents need to genuinely wait hours/days mid-workflow, choose between (a) DTS emulator (dev/MVP) or (b) Azure Durable Task Scheduler cloud service. Postgres is NOT the DTS backend — DTS is a separate store. Decision deferred until Phase 2 scope is locked.
