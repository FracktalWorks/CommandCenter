# AGENTS.md — Planning Folder Navigation Guide

> **For AI agents:** Read this file first. It tells you what this project is, what has been built, and which file to read for each concern.
> **Organisation:** Fracktal Works · **Project:** CommandCenter · **Last updated:** 2026-07-07

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

## What Has Already Been Built (as of 2026-06-20)

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
| LLM routing + tiered models | ✅ Done | **In-process litellm SDK** via the gateway `/v1` endpoint (`apps/gateway/gateway/routes/v1_compat.py`, `packages/acb_llm/`). No proxy process; `infra/litellm/config.yaml` is vestigial (tier rows only, → BO-16). |
| GitHub Copilot model routes (`copilot/*`) | ✅ Done | Resolved in-process by `acb_llm` / the Copilot-SDK tier — not via a proxy config |
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
| **Memory: Mem0 episodic + Graphiti bi-temporal KG** | ✅ Done | M2.8 — pgvector backend, Neo4j `--profile memory`, `/memory/*` API, injected into orchestrator + Copilot agents. See [`reference.md`](reference.md) §3 |
| **Fire-and-forget chat + live stream reconnection** | ✅ Done | Redis Streams + Postgres; agent continues after tab close, resumes live on reopen. See [`specs/archive/stream_reconnection.md`](specs/archive/stream_reconnection.md) |
| **Chat session history (auto-title + last-turn preview)** | ✅ Done | M2.6 — `chat_sessions.title`/`last_preview`; session list UI |
| **Integration OAuth framework (authorize→callback→refresh)** | ✅ Done | M2.6 — `routes/oauth.py`, HMAC-signed state, zoho-crm/clickup/google |
| **VS Code Copilot tools in chat (HITL Q, errors, repo memory, history, GitHub search, images)** | 🔄 Mostly done | See [`specs/archive/vscode_tool_integration.md`](specs/archive/vscode_tool_integration.md) |
| **Email app — multi-account client (Gmail/Outlook/IMAP) + AI assistant** | 🔄 In progress | M2.9 — `workbench/control_plane/src/app/email/`, gateway `routes/email/` (layered pkg), `apps/services/email_ingestion/`. Consolidated plan + roadmap: [`specs/email_app_master_plan.md`](specs/email_app_master_plan.md) |
| **Task Manager app — GTD-philosophy client + `task-manager` agent (PM-agnostic: any tool via API or MCP)** | 🔄 capture/clarify live end-to-end | Frontend slices 1–2.5 + the capture/clarify **backend**: migration `48_task_manager_gtd.sql`, gateway `routes/tasks/` (20 endpoints), provider interface layer + **ClickUp connector** (multi-workspace `task_accounts`, encrypted tokens), `apps/skill-task-gtd/` + rewritten `apps/agent-task-manager/`, frontend wired live with mock fallback; **org-knowledge layer live** (`gtd_people` from agent-project-manager HR data → capability-aware delegation, §6.1). Resume: Slice 3 (Engage) · `/tasks/sync` pull. See [`specs/task_manager_app.md`](specs/task_manager_app.md) §9.1 |
| `agent-sales` + `skill-zoho-ingest` | 🔲 Phase 2 | Phase 2 (WBS 2.2) |
| `agent-triage` + `skill-gmail-capture` | 🔲 Phase 2 | Phase 2 (WBS 2.3) |
| Meeting bot (Vexa + WhisperX) | 🔲 Phase 3 | Phase 3 (WBS 3.1) |
| WhatsApp ingest + push | 🔲 Phase 3 | Phase 3 (WBS 3.3) |
| Action Broker (approval-gated writes) | 🔲 Phase 4 | Phase 4 (WBS 4.1) |
| Odoo ingestor + strategy agent | 🔲 Phase 5 | Phase 5 (WBS 5.1/5.2) |

**M1 milestone (Core Engine live) — PASSED 2026-05-25.**
Real cross-system cited Q&A over live Fracktal data confirmed. 22/22 tests green.

**M2 milestone (Self-Mutation + Multi-Agent) — PASSED 2026-06-12.**
`Self_Mutation_Node` + Copilot SDK mutation container, dynamic multi-agent (`as_tool()` registry), `spawn_copilot_agent` + `delegate_to_agent`, agent auto-repair, and the inline eval gate are all ✅ done. Remaining Phase-1 cleanup: GitHub PR automation (WBS 1.3) and BYOK-forced metering (WBS 1.7).

**Since M2 (all ✅):** M2.5 unified Copilot SDK Tier 1.5 streaming (CopilotKit removed) · M2.6 foundation hardening (chat history, cloud sandbox, integration OAuth, AG-UI generative events) · M2.7 universal tool injection · M2.8 Mem0 + Graphiti memory.
**M2.9 (🔄 in progress):** email app — multi-account client + AI assistant; Outlook end-to-end fixed (PR #4).

**Dynamic multi-agent orchestration — DONE.**
Every registered agent (static + GitHub-registered) is exposed as a MAF `FunctionTool` via `agent.as_tool()` at gateway startup. LLM routes to the right specialist by description alone — no hard-coded routing table. WorkflowBuilder available for explicit sequential/fan-out pipelines.

---

## File Index — What to Read for Each Concern

The planning folder was consolidated on 2026-06-20 (15 files → 5 + `specs/`).

| Concern | File |
|---|---|
| **Requirements + roadmap + WBS** (what / when / how much — single source) | [`project_plan.md`](project_plan.md) |
| **System design: containers, data model, ADRs** | [`system_architecture.md`](system_architecture.md) |
| **How to build a compatible agent repo** | [`agent_repo_compatibility.md`](agent_repo_compatibility.md) |
| **Library notes: MAF, Copilot SDK, memory** | [`reference.md`](reference.md) |
| **Per-feature specs** | [`specs/`](specs/) — see the status index below |

### Per-feature specs (`specs/`)

Status: 🟢 live/shipped · 🔄 in progress · 🔲 planned/not started. *(Index reconciled against code 2026-07-13.)*

**Only forward-looking / living specs are listed here.** 13 shipped-or-historical specs were moved to
[`specs/archive/`](specs/archive/README.md) (each verified live in code, with residual open work carried
forward). Foundation status of record is `FOUNDATION_BUILDOUT_CHECKLIST.md` (BO-*) — the specs below defer
to it and to `competitive_hardening_2026-07.md` (CH-*) rather than re-describe those gaps.

| Spec | Concern | Status |
|---|---|---|
| [`core_module_map.md`](specs/core_module_map.md) | **Living architecture hub** — orchestrator module→file map, the parent of the (now-archived) core-loop/context zoom-ins | 🟢 living reference |
| [`competitive_hardening_2026-07.md`](specs/competitive_hardening_2026-07.md) | **Competitive hardening** — Hermes/OpenClaw learnings (`CH-*`) annealed onto BO-1/5/7/12/14 + new BO-20/BO-21; Phase-5 Annealer = self-improving-skills home. Source `/COMPETITIVE_COMPARISON.md` | 🔲 planned (annealed, no code) |
| [`harness_hardening_2026-07.md`](specs/harness_hardening_2026-07.md) | **Harness gap queue** (HH-1..8) vs awesome-harness-engineering | 🔄 HH-1/4/5 shipped; HH-2/HH-3 mechanism-only, **not enforced** (audit M5/H9); HH-6/7 deferred |
| [`permissions_sandbox_b6.md`](specs/permissions_sandbox_b6.md) | Permission policy + sandbox design | 🔄 policy layer shipped but audit gate is a name-only **no-op (M5)**; sandbox not started → **BO-7 / BO-14** |
| [`observability_e2.md`](specs/observability_e2.md) | Observability — activity feed, cost, agent office | 🔄 Redis activity/cost feed **shipped**; distributed/OTel tracing **dead** → **BO-5** |
| [`chat_ux.md`](specs/chat_ux.md) | **Chat master** — thinking/progress/tool rendering (absorbed the two archived chat audits) | 🔄 Phase 1 shipped; §12 AG-UI event backlog open |
| [`email_app_master_plan.md`](specs/email_app_master_plan.md) | **Email master** — consolidated state + prioritized completion roadmap (absorbed the inventory, parity plan, tool plan; evidence in `email_feature_review_2026-07.md`) | 🔄 Phase 1 "stop the lying" open; #113 sweep armistice done |
| [`task_manager_app.md`](specs/task_manager_app.md) | **Task Manager (GTD)** — client + `task-manager` agent + provider layer | 🔄 capture/clarify/organize + provider **sync-pull live**; Engage "Now" + Action-Broker-gated push open |
| [`task_manager_harness_2026-07.md`](specs/task_manager_harness_2026-07.md) | Task-manager × harness engineering (app-layer sibling) | 🔄 Tier 1 shipped (2026-07-03); Tier 2 planned |
| [`llm_caching_memory.md`](specs/llm_caching_memory.md) | Prompt caching (ADR-008) + session memory | 🔄 caching **shipped & wired**; session-memory shipped but **inert by default** (→ BO-21); Phase 7 open |
| [`mcp_plugin_integration.md`](specs/mcp_plugin_integration.md) | MCP servers vs Claude plugins vs REST | 🔄 MCP half **built** (`_inject_mcp_servers`); plugin store not started |
| [`multi_user_organization_research.md`](specs/multi_user_organization_research.md) | Multi-user / org account research — identity, roles, tenancy | 🔲 research done, not implemented |
| [`chat_agent_framework_review_2026-07.md`](specs/chat_agent_framework_review_2026-07.md) | **Chat + agent framework review** — dual-runtime verdict (MAF framework, Copilot as coding engine), orchestration/memory/artifact/HITL/co-authoring gaps, prioritized plan | 🟢 review complete |
| [`single_agent_chat_bug_audit_2026-07.md`](specs/single_agent_chat_bug_audit_2026-07.md) | **Single-agent chat bug audit** — past issues verified fixed; 7 confirmed live bugs (Tier-1 loop-trip crash, Copilot retry duplication, unbounded resumed-session context, relay truncation/ack holes) + fix plan | 🟢 audit complete |
| [`generative_ui_2.md`](specs/generative_ui_2.md) | **Generative UI 2.0** — immersive HITL UI: surface(panel)/hitl(blocking) on emit_generative_ui, 11-template library (recipe/flight/train/form/optionPicker…), side-panel genUI tabs, scenario→element map | 🔄 Phase 1 shipped |
| [`drawio_integration.md`](specs/drawio_integration.md) | **draw.io** — architecture, tickets ST-DRW-01…13 (master) | 🔲 proposed — **genuinely unbuilt** |
| [`drawio_diagram_svc_contract.md`](specs/drawio_diagram_svc_contract.md) | draw.io — `diagram-svc` wire contract (sub-doc of the master) | 🔲 proposed — unbuilt |
| [`note_taker_app.md`](specs/note_taker_app.md) | **AI Note Taker (`/notes`)** — browser record (mic + Chromium tab audio) → pluggable STT (`acb_stt`: BYOK cloud + self-host faster-whisper/WhisperX + open diarization) → grounded notes via `acb_llm` template compiler → HITL action-items→`/tasks`, recap→`/email`, share→`/chat`; activates the dormant `meeting`/`action_item` tables | 🔄 slice 0 built (migration 94, `acb_stt`, gateway `routes/notes/`, upload→transcribe→segments UI); slice 1 (recorder + SSE + notes generation) next |
| [`note_taker_research_2026-07.md`](specs/note_taker_research_2026-07.md) | Note Taker — research appendix (sub-doc): Meetily deep dive, 18-project landscape survey, mid-2026 ASR/diarization SOTA, browser-capture constraints, license watch-list | 🟢 research complete |

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

1. **AG-UI wiring (WBS 0.6)** — ✅ Done. `add_agent_framework_fastapi_endpoint(app, agent, "/copilot/chat")` is wired in gateway startup (`apps/gateway/gateway/main.py`). (CopilotKit was removed in M2.5; the Control Plane chat now consumes AG-UI over SSE via `api/agent/chat/route.ts`.)

2. **Webhook → MAF dispatch (WBS 0.7)** — ✅ Done. `agent.py` dispatches webhook events to the MAF executor (`orchestrator.executor.run_agent`). The old Copilot-runtime dispatch arm (`runtime: copilot`) has been removed.

3. **Observability** — the `langfuse` Python package is not installed and no OTLP exporter is wired; a Langfuse **container** exists in `infra/docker-compose.yml` but is **opt-in behind `--profile obs` and dormant**. Real telemetry today is the bespoke Redis activity/cost feed (`acb_common/activity.py`). Standing up distributed tracing is tracked as **BO-5** (audit H9).

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
| **Action Broker** | The *intended* single write path to source systems (ClickUp/Zoho/Odoo), enforcing per-action authority tiers. Lives at `apps/action_broker/`. **Current reality:** the authority-tier decision core exists but ships with **zero handlers and is not yet wired into the write path** — real ClickUp/email writes bypass it today. Wiring it is **BO-1** (P0). |
| **Reconciler** | Nightly agent that diffs entity graph vs source systems and escalates drift. Lives at `apps/reconciler/`. |
| **HITL** | Human-in-the-loop. Approval requests delivered via Control Plane or email/WhatsApp when operator is not at the UI. |
| **authority tier** | read / suggest / suggest+apply / autonomous — the allowed scope of an agent's action on a specific resource type. |
| **Annealer** | Phase 5 sub-agent that mines successful run patterns, proposes new reusable skills as PRs, and manages shadow → canary → full rollout. **Reference implementation:** Hermes Agent's "Curator" (auto-authors + prunes skills on a cycle) — see CH-7 in [`specs/competitive_hardening_2026-07.md`](specs/competitive_hardening_2026-07.md). Our differentiator is that skill proposals go through the human PR/approval gate; self-improvement *plus* enterprise HITL is something neither Hermes nor OpenClaw offers. |

---

## Current Phase

Phases 0, 1, 1.5, 1.6 are complete and **M2 is closed**. A **foundation architecture audit (2026-07)** is now the active workstream — it found the platform's documented guarantees are materially ahead of what the code enforces, and its P0 items gate the feature roadmap. **Two backlogs, read both:**
- **Foundation hardening (do first):** [`/FOUNDATION_BUILDOUT_CHECKLIST.md`](../FOUNDATION_BUILDOUT_CHECKLIST.md) — `BO-1..21` (+ `CH-*` in `specs/competitive_hardening_2026-07.md`, `HH-*` in `specs/harness_hardening_2026-07.md`).
- **Feature roadmap:** [`project_plan.md`](project_plan.md) §6 — M2.9 email → M3 agent ecosystem → M4 capture → M5 write authority → M6 intelligence.

**Immediate priorities (P0 foundation first):**
- **BO-8** rotate/purge committed secrets · **BO-2** enforce auth (never-reject → require) · **BO-1** wire the Action Broker into the write path (non-negotiable #4 is currently false) · **BO-3** mutation governance residuals.
- **SEC-1 / R-06** — lock down public Postgres/Redis (5432/6379) on the VPS (bind `127.0.0.1`).
- Then P1: **BO-7** sandbox, **BO-5** observability+cost, **BO-20** event-bus consumer + job queue, **BO-6** migrations.
- Feature track (in parallel where unblocked): M2.9 email residuals; Phase 2 Zoho/Gmail ingestion (2.1/2.2) + entity resolution (2.3); Phase 1 cleanup (PR automation 1.3, BYOK metering 1.7).
