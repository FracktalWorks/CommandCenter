# AGENTS.md — Planning Folder Navigation Guide

> **For AI agents:** Read this file first. It tells you what this project is, what has been built, and which file to read for each concern.
> **Organisation:** Fracktal Works · **Project:** CommandCenter · **Last updated:** 2026-06-05

---

## What CommandCenter Is

CommandCenter is a **headless, self-mutating agent orchestration platform** for running a company.

When a company event fires (webhook from ClickUp/Zoho/Odoo, cron schedule, or ambient signal), it:
1. Resolves the target specialist agent via a persistent local clone of that agent's GitHub repo.
2. Runs `git pull --ff-only` (< 0.5 s) to pick up any merged changes.
3. Injects credentials from the Integration Registry into the MAF orchestration context (via `mcp_servers=` config in `GitHubCopilotAgent`).
4. Executes the agent task (skills run as MAF tools or MCP servers inside `GitHubCopilotAgent`, with `HandoffBuilder` routing between specialist agents).
5. On failure: spawns an isolated Copilot SDK mutation container (`acb-mutation-runner`), applies a tested code fix to the live clone immediately, opens a GitHub PR as audit record.

Operators interact via a thin **Control Plane** (Next.js browser UI) with chat Q&A, HITL approvals, and observability. There is no in-app agent/skill editor — all authoring happens in VS Code + Git.

---

## What Has Already Been Built (as of 2026-06-05)

| Component | Status | Location |
|---|---|---|
| Core FastAPI gateway | ✅ Done | `apps/gateway/` |
| Ingestion workers (ClickUp, Zoho) | ✅ Done | `apps/ingestion/` |
| Entity graph (Postgres + pgvector) | ✅ Done | `infra/postgres/01_schema.sql` |
| Reconciler agent | ✅ Done | `apps/reconciler/` |
| Orchestrator (MAF `HandoffBuilder` + native workflow engine) | ✅ Done | `apps/orchestrator/` — LangGraph fully removed. DTS deferred to Phase 2; HITL via Action Broker (Postgres `approval_queue`). See ADR-026 in `system_architecture.md`, WBS 0.7. |
| Persistent clone cache + bot git identity | ✅ Done | `packages/acb_skills/acb_skills/loader.py` |
| Self-mutation node + Copilot SDK mutation container | ✅ Done | `apps/orchestrator/orchestrator/mutation.py`, `apps/orchestrator/mutation_runner.py`, `apps/orchestrator/Dockerfile.mutation` |
| Interactive operator chat (MAF AG-UI endpoint) | ✅ Done | `apps/gateway/gateway/main.py` — `add_agent_framework_fastapi_endpoint(app, agent, "/copilot/chat")`. The old `copilot_chat.py` SSE path and the Copilot SDK chat dispatch (`runtime: copilot`) have been **removed**. Copilot SDK is now mutation-container only. |
| Control Plane shell (Next.js, chat, SSO) | ✅ Done | `workbench/control_plane/` |
| Control Plane rich chat UI (SSE streaming, markdown, syntax highlight, tool-call blocks) | ✅ Done | `workbench/control_plane/src/components/MarkdownMessage.tsx`, `useAgentChat.ts`, `AgentChat.tsx`, `api/agent/chat/route.ts` |
| Control Plane model picker + agent switcher + stop-generation button | ✅ Done | `AgentChat.tsx` — VS Code Copilot-style UX |
| LiteLLM gateway + tiered routing | ✅ Done | `infra/litellm/config.yaml` |
| LiteLLM GitHub Copilot model routes (`copilot/gpt-4o`, `copilot/claude-sonnet`, `copilot/o3-mini`) | ✅ Done | `infra/litellm/config.yaml` |
| Skills monorepo + loader | ✅ Done | `skills/`, `packages/acb_skills/` |
| Self-mutation GitHub PR automation | 🔲 Next | Phase 1 (WBS 1.3) |
| Eval CI gate on agent/skill PRs | 🔲 Next | Phase 1 (WBS 1.4) |
| **Dynamic multi-agent orchestration (MAF `as_tool()` registry)** | ✅ Done | `apps/orchestrator/orchestrator/agents.py` — every registered agent auto-exposed as a MAF tool at startup; LLM routes by description alone; zero hard-coded routing tables |
| **`delegate_to_agent` + `spawn_copilot_agent` tools** | ✅ Done | Orchestrator tools: delegate to any named specialist; spawn Copilot SDK container for creation/mutation tasks from chat |
| **Agent auto-repair (incompatibility → direct commit)** | ✅ Done | `AgentLoadError` triggers Copilot SDK sandbox with researcher+editor pattern; generates `agents.py` and commits directly — no PR |
| **Proactive skill sync (auto-wire new scripts)** | ✅ Done | `packages/acb_skills/acb_skills/loader.py` — after every pull, scans `skills/*/scripts/` for new scripts, injects tool wrappers, commits+pushes |
| **Agent add/remove via Control Plane UI** | ✅ Done | `workbench/control_plane/src/app/agents/` — paste GitHub URL, auto-fetches `config.json`, registers; dynamic agents persisted in `agents.json` |
| **Integration configure/test UI** | ✅ Done | `workbench/control_plane/src/app/integrations/` — live test against real APIs; writes to root `.env`; hot-reload |
| **LLM settings UI (tier picker, Gemini/OpenAI key save)** | ✅ Done | `workbench/control_plane/src/app/settings/models/` — per-tier model assignment; provider key save; LiteLLM health |
| **AG-UI → SSE translation (chat properly streams tool calls)** | ✅ Done | `workbench/control_plane/src/app/api/agent/chat/route.ts` — translates AG-UI events to delta/tool_start/tool_end for the UI hook |
| `agent-sales` + `skill-zoho-ingest` | 🔲 Phase 2 | Phase 2 (WBS 2.2) |
| `agent-triage` + `skill-gmail-capture` | 🔲 Phase 2 | Phase 2 (WBS 2.3) |
| Meeting bot (Vexa + WhisperX) | 🔲 Phase 3 | Phase 3 (WBS 3.1) |
| WhatsApp ingest + push | 🔲 Phase 3 | Phase 3 (WBS 3.3) |
| Action Broker (approval-gated writes) | 🔲 Phase 4 | Phase 4 (WBS 4.1) |
| Odoo ingestor + strategy agent | 🔲 Phase 5 | Phase 5 (WBS 5.1/5.2) |

**M1 milestone (Core Engine live) — PASSED 2026-05-25.**
Real cross-system cited Q&A over live Fracktal data confirmed. 22/22 tests green.

**M2 milestone (Self-Mutation + Multi-Agent) — IN PROGRESS as of 2026-06-05.**
`Self_Mutation_Node` + Copilot SDK mutation container ✅ done. Dynamic multi-agent (`as_tool()` registry) ✅ done. `spawn_copilot_agent` + `delegate_to_agent` tools ✅ done. Agent auto-repair (researcher+editor pattern) ✅ done. GitHub PR automation (WBS 1.3) and eval CI gate (WBS 1.4) remaining.

**Dynamic multi-agent orchestration — DONE.**
Every registered agent (static + GitHub-registered) is exposed as a MAF `FunctionTool` via `agent.as_tool()` at gateway startup. LLM routes to the right specialist by description alone — no hard-coded routing table. WorkflowBuilder available for explicit sequential/fan-out pipelines.

---

## File Index — What to Read for Each Concern

| Concern | File |
|---|---|
| **What the product must do (requirements)** | [`product_requirements.md`](product_requirements.md) |
| **How/when it will be built (phases, timeline)** | [`project_plan.md`](project_plan.md) |
| **Detailed engineering tasks with estimates** | [`wbs.md`](wbs.md) |
| **System design: containers, data model, ADRs** | [`system_architecture.md`](system_architecture.md) |
| **MCP & Plugin integration design** | [`spec_mcp_plugin_integration.md`](spec_mcp_plugin_integration.md) |
| **LLM prompt caching + memory system plan** | [`spec_llm_caching_memory.md`](spec_llm_caching_memory.md) |
| **Agent repo compatibility guide** | [`agent_repo_compatibility.md`](agent_repo_compatibility.md) |

---

## Non-Negotiable Constraints (AI Agents Must Respect These)

| # | Constraint |
|---|---|
| 1 | **No in-app agent/skill editing.** The Control Plane is for chat, HITL, and observability only. All authoring is VS Code + Git. |
| 2 | **No credentials in agent or skill repos.** `config.json` declares integration names; Core Integration Registry holds the actual secrets. |
| 3 | **Self-mutation max_mutation_attempts = 1.** One PR per failure event, no exceptions. |
| 4 | **No autonomous writes** to ClickUp/Zoho/Odoo until Action Broker + authority tiers are live (Phase 4). |
| 5 | **Git is the single source of truth** for all agent artefacts. All changes flow through PRs with eval gates. |
| 6 | **MAF (Microsoft Agent Framework) is the sole agent execution runtime** — for all event-driven, webhook-triggered, multi-agent workflows, AND interactive operator chat (via AG-UI endpoint). The Copilot SDK is used only for self-mutation containers (`acb-mutation-runner`). No LangGraph. No deepagents. No n8n. No `copilot_chat.py` SSE path. |
| 7 | **No Theia / browser IDE.** That scope was explicitly cut. |
| 8 | **Source systems are authoritative.** CommandCenter is a read-mostly mirror with approval-gated writes. |

---

## Architecture Note: Single MAF Runtime (interactive + background unified)

CommandCenter uses **one execution runtime: MAF**. Interactive chat (via AG-UI endpoint) and background event-driven agents use the same MAF agents. The GitHub Copilot SDK is used only inside mutation containers.

| | MAF (unified runtime — background + interactive chat) | Copilot SDK (mutation container only) |
|---|---|---|
| **Triggered by** | Webhooks, cron, ambient events; interactive chat (AG-UI) | Self-mutation errors only (`Self_Mutation_Node` spawns container) |
| **Entry point** | `POST /agent/run`, `POST /agent/webhook/{source}`, `POST /copilot/chat` (AG-UI) | Spawned via `docker run --rm -d` by `Self_Mutation_Node` |
| **Agent definition** | `agents.py` + `config.json` in agent repo — exports `build_agents() → list[Agent]` | `AGENTS.md` in mounted repo clone + `mutation_runner.py` prompt |
| **Credentials** | Integration Registry → `mcp_servers=` config in `GitHubCopilotAgent` | BYOK via LiteLLM env var in container; no Integration Registry access |
| **LiteLLM path** | Always (all model calls + MAF LiteLLM client) | Yes (BYOK mode forced) |
| **Durable state** | MAF native workflow engine (in-process asyncio, Phase 0); DurableTask (Phase 2) — HITL via Action Broker (Postgres `approval_queue`) | None (container self-destroys after run) |
| **Multi-agent** | `HandoffBuilder` (triage→specialist), `ConcurrentBuilder` (fan-out), `GroupChatBuilder` | N/A |

### Resolved / Current State

1. **AG-UI wiring (WBS 0.6)** — ✅ Done. `add_agent_framework_fastapi_endpoint(app, agent, "/copilot/chat")` is wired in gateway startup (`apps/gateway/gateway/main.py`). Control Plane `CopilotKitProvider` points at the gateway AG-UI URL.

2. **Webhook → MAF dispatch (WBS 0.7)** — ✅ Done. `agent.py` dispatches webhook events to the MAF executor (`orchestrator.executor.run_agent`). The old Copilot-runtime dispatch arm (`runtime: copilot`) has been removed.

3. **Observability** — Langfuse has been **removed** from the stack (no container, no `langfuse` package, no OTel exporter). Re-introduce a self-hosted OTLP backend later if/when tracing is needed.

4. **Self_Mutation_Node** — implemented as a standalone async module (`apps/orchestrator/orchestrator/mutation.py`); no LangGraph. Formalising it as a MAF workflow step is pending (WBS 1.1).

---

## Key Terms Glossary

| Term | Meaning |
|---|---|
| **Core Engine** | The CommandCenter FastAPI server + MAF workflow engine + Dynamic Agent Loader. Lives in `CommandCenter-Core`. |
| **Dynamic Agent Loader** | Python module that `git pull`s the target agent repo and `importlib`-imports `agents.py` at runtime, calling `build_agents()` to get MAF `Agent` instances. See `packages/acb_skills/acb_skills/loader.py`. |
| **Agent repo** | A GitHub repo named `agent-<name>` containing `config.json`, `agents.py`, `instructions.md`. No credentials, no skill implementations. `agents.py` exports `build_agents() → list[Agent]` where each `Agent` is a MAF `GitHubCopilotAgent` (or other MAF provider) with tools and MCP server config declared. |
| **Skill repo** | A GitHub repo named `skill-<name>`, a pip-installable Python package with one well-typed entry function. Surfaced to agents either as a Python tool function or as an MCP server. |
| **Integration Registry** | Core's encrypted Postgres store of all integration credentials. Admin-managed via Control Plane. |
| **AgentContext** | The MAF orchestration context; agents read credentials from MCP server config resolved from the Integration Registry. Replaces the former LangGraph `state["integrations"]` pattern. |
| **Self_Mutation_Node** | Implemented as a standalone async module (`apps/orchestrator/orchestrator/mutation.py`); no LangGraph. Formalisation as a MAF workflow step is pending (WBS 1.1). Spawns an isolated Copilot SDK mutation container (`acb-mutation-runner` Docker image), reads failure telemetry, applies a code fix to the live clone, and opens a GitHub PR. The container receives the mutation prompt and LiteLLM BYOK credentials via env vars; the agent repo is mounted at `/workspace/repo`. |
| **Hot-patch model** | Fix is applied to the live persistent clone immediately (recovery in minutes). The PR is the audit record + rollback trigger (close = auto rollback). |
| **Control Plane** | Next.js browser UI at `workbench/control_plane/`. Provides chat and HITL approval queue. Not an editor. |
| **Action Broker** | The only write path to source systems (ClickUp/Zoho/Odoo). Enforces per-action authority tiers. Lives at `apps/action_broker/`. |
| **Reconciler** | Nightly agent that diffs entity graph vs source systems and escalates drift. Lives at `apps/reconciler/` and `level4/apps/reconciler/`. |
| **HITL** | Human-in-the-loop. Approval requests delivered via Control Plane or email/WhatsApp when operator is not at the UI. |
| **authority tier** | read / suggest / suggest+apply / autonomous — the allowed scope of an agent's action on a specific resource type. |
| **Annealer** | Phase 5 sub-agent that mines successful run patterns, proposes new reusable skills as PRs, and manages shadow → canary → full rollout. |

---

## Current Phase: Phase 1 — Self-Mutation Loop

Phase 0 (Core Engine) is complete. The team is now in **Phase 1: Self-Mutation Loop**.

**Remaining Phase 1 work (from WBS):**
- ~~WBS 1.1 `Self_Mutation_Node`~~ ✅ **Done** — `mutation.py` fully wired; Copilot SDK container spawned via `docker run --rm -d`. (Migration to MAF DurableTask activity is WBS 0.7 work, tracked separately.)
- ~~WBS 1.2 Mutation sandbox integration~~ ✅ **Done** — `Dockerfile.mutation` + `mutation_runner.py`; host Docker socket mapped; no DinD required.
- WBS 1.3 GitHub PR automation: GitHub API create branch → commit fix → open PR with telemetry body; no self-merge permission. **NEXT.**
- WBS 1.4 Eval CI gate: Promptfoo + Inspect AI on every `agent-*` / `skill-*` PR; merge blocked on regression.
- WBS 1.5 Mutation audit log: log to Postgres; surface in Control Plane HITL queue.
- ~~WBS 1.6 Webhook → MAF dispatch~~ ✅ **Done** — `agent.py` dispatches webhook events to the MAF executor (`orchestrator.executor.run_agent`); the old Copilot-runtime arm was removed.
- WBS 1.7 LiteLLM BYOK forced for mutation Copilot SDK sessions: route all SDK sessions through the LiteLLM `copilot/claude-sonnet` alias for consistent cost metering.

**Phase 1 exit milestone (M2 — Self-Mutation live):** A deliberate error in `skill-clickup-sync` causes `Self_Mutation_Node` to open a GitHub PR with a plausible fix within 5 minutes; `max_mutation_attempts = 1` enforced; human merges → CI passes → live.
