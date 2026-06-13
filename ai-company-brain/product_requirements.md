# Product Requirements Document — CommandCenter

> **Organisation:** Fracktal Works · **Product:** CommandCenter · **Date:** 2026-06-05 · **Version:** 2.3
> Companion to [`project_plan.md`](project_plan.md). This PRD defines *what* the product must do; the plan defines *how/when* it is built.
> **For AI agents:** Read [`AGENTS.md`](AGENTS.md) first for current build status and navigation.

---

## 1. Product Vision

CommandCenter is a **headless, self-mutating, multi-agent orchestration platform** for running a company.

When a company event fires — a webhook from ClickUp, Zoho, or Odoo; a cron schedule; or an ambient signal from email, WhatsApp, or a meeting — CommandCenter resolves the correct specialist agent (or composes multiple agents in parallel), pulls the latest code from a persistent local clone, injects credentials from the Integration Registry, and executes via the Microsoft Agent Framework. If the agent fails, it uses a researcher+editor Copilot SDK mutation container to diagnose and fix the code, commits directly, and the next run picks up the fix automatically.

The orchestrator is the single entry point for all operator interaction. It dynamically discovers every registered specialist agent — loaded from individual GitHub repositories — and exposes each as a callable tool. The LLM routes to the right specialist (or calls multiple in parallel) based on each agent's description. Operators can ask cross-domain questions (“show stale deals and overdue tasks”), create new capabilities (“build a GeM tender monitor skill”), or fix broken agents — all from one chat interface.

Operators interact via a thin **Control Plane** (browser UI) that provides:
- Unified chat over all agents (multi-agent fan-out, streaming tool-call display).
- Agent management (add/remove GitHub repo agents with live status badges).
- Integration configuration (per-service credentials, live API test).
- LLM model/tier settings (provider key management, tier picker).
- HITL approval queue for agent-proposed writes.
- Observability (cost, eval scores; LLM traces via MAF native OTel, backend TBD).

**What CommandCenter is NOT:**
- A browser IDE or code editor. All agent/skill authoring is done in VS Code + Git.
- A platform for creating or editing agents or skills in-app.
- A replacement for ClickUp, Zoho, or Odoo. Those remain authoritative; CommandCenter mirrors and acts on them.
- An n8n-style workflow canvas. Orchestration is agent-native MAF only.

The product delivers value in **four levels**, each independently deployable:

| Level | Name | Core value delivered | Status |
|---|---|---|---|
| **L1** | Core Engine | Cited Q&A over live company data; any agent event runs end-to-end | ✅ Done |
| **L1.5** | Control Plane + Multi-Agent | Unified chat; dynamic specialist routing; agent add/remove; integrations UI; LLM settings | ✅ Done |
| **L2** | Self-Mutation + Agent Ecosystem | Agents auto-repair on failure; new capabilities created from chat; full domain coverage | 🔄 In progress |
| **L3** | Capture + Write Authority | All ingest channels; approval-gated writes to ClickUp/Zoho | 🔲 Planned |
| **L4** | Company Intelligence | Strategy, goals, Odoo ERP, full BI; system self-improves autonomously | 🔲 Planned |

---

## 2. Users & Personas

| Persona | Description | Primary interaction |
|---|---|---|
| **Operator** (founder / exec) | Runs the company through CommandCenter | Chat Q&A, HITL approvals, reviews self-mutation PRs |
| **Contributor** (team member) | Receives nudges, approvals, follow-ups | Email/WhatsApp HITL, task assignment, status pings |
| **Builder** (engineer) | Authors agents and skills; maintains the platform | VS Code + Git (never in-app); reviews CI eval results |
| **Admin** | Manages config, credentials, and security | Control Plane admin: Integration Registry, model policy, RBAC |

---

## 3. Platform-Wide Principles (Non-Negotiable)

| ID | Principle |
|---|---|
| PR-01 | **No in-app agent/skill authoring.** All development happens in VS Code + Git. The Control Plane is for operation (chat, HITL, observability), not editing. |
| PR-02 | **Decoupled repositories.** Each agent and each skill lives in its own GitHub repo. The Core engine contains no agent logic or skill files. |
| PR-03 | **Persistent runtime loading.** Agent/skill repos are cloned once into a persistent local cache; each event does `git pull --ff-only` (~0.5 s). No server redeploy to pick up new agent logic. |
| PR-04 | **Ephemeral sandboxed execution.** Self-mutation code fixes run inside short-lived Copilot SDK containers (`acb-mutation-runner`), destroyed after every mutation attempt. The MAF orchestrator itself is not sandboxed — it is the runtime host. |
| PR-05 | **Hot-patch self-mutation with an audit gate.** When an agent fails, `Self_Mutation_Node` applies a tested code fix to the live clone immediately (recovery in minutes) and opens a GitHub PR as the audit record. Closing the PR triggers automatic rollback. `max_mutation_attempts = 1` prevents feedback loops. |
| PR-06 | **Git is the source of truth** for every agent-editable artefact (agent definitions, skills, model-routing config). All persistent edits flow through PRs with eval gates. |
| PR-07 | **Platform-owned credentials; agent-declared dependencies.** All integration credentials are stored encrypted in the Core Integration Registry. Agent `config.json` declares integration names only — never credentials. The Dynamic Agent Loader resolves credentials from the registry and injects them into `GitHubCopilotAgent` `mcp_servers=` config at runtime (MAF agents) or via `_build_agent_env()` (Copilot-native agents, interim). |
| PR-08 | **Approval-gated writes.** The Action Broker is the only write path to source systems. Per-action authority tiers (read / suggest / suggest+apply / autonomous) are enforced. No autonomous writes in v1. |
| PR-09 | **Reuse core packages.** `acb_llm`/LiteLLM model routing, `acb_common`, `acb_schemas`, `acb_audit`, and `evals/` are reused, not rebuilt. |
| PR-10 | **Standards-first.** Obey `AGENTS.md` and Anthropic Agent Skills (`SKILL.md`); integrate external systems via MCP before bespoke connectors. |

---

## 4. Level 1 — Core Engine

**Goal:** A running FastAPI server that dynamically clones any agent repo, executes its task in an ephemeral sandbox, and returns a cited answer. A minimal Control Plane is live for chat and observability.

> **Status: COMPLETE.** M1 milestone passed 2026-05-25. See [`AGENTS.md`](AGENTS.md) for details.

| ID | Requirement | Priority |
|---|---|---|
| L1-01 | Core FastAPI server listens for webhook and cron events; routes to the correct agent repo by name from event metadata. | Must |
| L1-02 | **Dynamic Agent Loader:** on each event, `git pull --ff-only` on the persistent local clone (~0.5 s warm path). First-ever event for an agent triggers a full `git clone` (one-time). Reads `config.json`; dynamically imports `agents.py` via `importlib` and calls `build_agents()`. Per-repo threading lock prevents clone/pull races. | Must |
| L1-03 | MAF workflow engine executes the agents returned by `build_agents()` from the cloned `agents.py`. **Phase 0:** in-process asyncio (no DTS emulator). HITL uses the Action Broker pattern (Postgres `approval_queue`). **Phase 2:** add `agent-framework-durabletask` + DTS emulator for multi-day HITL pauses. | Must |
| L1-04 | MAF orchestrator executes agent skills as workflow steps (via `GitHubCopilotAgent` tool calls or MCP server calls); outputs and error logs flow through the MAF workflow context. For self-mutation, a separate Copilot SDK container (`acb-mutation-runner`) is spawned; see L2-01. | Must |
| L1-05 | **Integration Registry:** Core stores all integration credentials (API keys, OAuth tokens, webhook secrets) encrypted in Postgres. Control Plane admin UI allows registration and rotation without code changes. | Must |
| L1-06 | **Credential injection:** Dynamic Agent Loader reads `config.json["integrations"]` and resolves only declared integration credentials from the Integration Registry; injects them into `GitHubCopilotAgent` `mcp_servers=` config so skills receive the correct tokens via MCP protocol (MAF agents) or as environment variables via `_build_agent_env()` (GitHub Copilot SDK Tier 1.5 agents). No credentials ever appear in agent or skill repos, `config.json`, LLM context, or logs. | Must |
| L1-07 | **First agent: `agent-task-manager` + `skill-clickup-sync`** — cited Q&A over ClickUp projects, tasks, and people. Validates the end-to-end clone → import → execute → cite flow. | Must |
| L1-08 | **Reconciler v0:** nightly diff of entity graph vs ClickUp; escalates drift to an audit queue. Zero silent divergence over 7 days is the target. | Must |
| L1-09 | **Guardrails v0:** schema-validated outputs, citation enforcement (every claim cites a graph node), unresolved-entity abort before any answer is returned. | Must |
| L1-10 | **Observability:** all LLM calls routed through the LiteLLM gateway with tiered routing; cost per tier tracked; eval scores published. MAF native OpenTelemetry is OTLP-ready; a self-hosted trace backend is deferred (Langfuse removed from the Phase-0 stack). | Must |
| L1-11 | **Control Plane shell:** Next.js browser UI with (a) unified chat interface to the gateway (MAF AG-UI + GitHub Copilot SDK Tier 1.5 streaming) for CommandCenter and named agents, (b) LiteLLM model picker, (c) VS Code-style send / queue / steer controls, (d) MCQ / choice-button rendering, (e) observability pane (audit log + spend), (f) Google SSO restricted to org domain. No skill or agent editing. | Must |
| L1-12 | **Infrastructure:** Docker Compose with Postgres+pgvector, Redis, LiteLLM gateway; self-hosted on a single Linux VM; reproducible and documented. | Must |
| L1-13 | **Local Tier-1 inference:** vLLM serving Qwen3-8B (Automatic Prefix Caching) behind LiteLLM. | Deferred to Phase 2 |
| L1-14 | **Integration OAuth exchange:** Control Plane Integration page hosts the OAuth redirect flow for each service (ClickUp, Zoho, Gmail, GitHub). Callback endpoint stores access + refresh tokens encrypted in the Integration Registry. A background refresh task renews tokens before expiry (5-minute pre-expiry window). Both MAF agents (via `mcp_servers=` bearer-token injection) and GitHub Copilot SDK agents (via `_build_agent_env()` env-var injection) receive credentials at run time; neither path ever exposes credentials in LLM context, logs, or agent/skill repos. | Must |

**L1 acceptance:** An executive asks "where are we on Project X?" via the Control Plane chat and receives a cited answer sourced from live ClickUp data, with all LLM calls routed through the tier router and cost visible in the Control Plane.

---

## 5. Level 2 — Self-Mutation + Multi-Agent Ecosystem

**Goal:** Agents fix their own code on failure (opening GitHub PRs as audit records); the full company domain is covered by specialist agents for sales, delivery, triage, and reconciliation.

> **Status: IN PROGRESS.** Mutation sandbox implementation complete (2026-06-03) — Copilot SDK container replaces OpenHands for the fix-and-test loop. GitHub PR automation wiring and eval CI gate are the immediate next steps.

### Self-Mutation Loop

| ID | Requirement | Priority |
|---|---|---|
| L2-01 | **`Self_Mutation_Node`** in MAF: on agent error, checks `mutation_attempts_this_run < 1`, spawns an isolated Copilot SDK container (`acb-mutation-runner`) via `docker run --rm -d`, injects failure telemetry and the mutation prompt as env vars, mounts the persistent local clone at `/workspace/repo`. BYOK via gateway /v1 (litellm SDK); `max_mutation_attempts = 1` enforced per run. | Must |
| L2-02 | If tests pass: commits fix to local clone main branch (fix is live immediately); pushes branch `auto-fix/{run_id}` to origin; opens GitHub PR with telemetry, diff, and test results. `max_mutation_attempts = 1` enforced per run. | Must |
| L2-03 | If tests fail: discards all changes (`git reset --hard HEAD`); destroys dev sandbox; logs failure. | Must |
| L2-04 | Core listens for `pull_request.closed` (unmerged) GitHub webhooks from agent repos. On unmerged close of an `auto-fix` PR: Core issues `git reset --hard origin/main` on the affected local clone (automatic rollback). | Must |
| L2-05 | **Eval CI gate** on all agent/skill PRs: Promptfoo golden cases + Inspect AI scenario tests run on every PR in any `agent-*` or `skill-*` repo; PR comment with results; merge blocked on regression. No `SKILL.md` or `agents.py` merges without at least one passing golden case. | Must |
| L2-06 | **Mutation audit log:** each self-mutation event (agent, error_type, pr_url, timestamp, outcome) logged to Postgres; surfaced in Control Plane HITL queue (Agent Inbox). | Must |

### Multi-Agent Ecosystem

| ID | Requirement | Priority |
|---|---|---|
| L2-07 | **`agent-reconciler` + `skill-graph-write`:** nightly cross-source diff deployed as its own repo; escalation queue wired to Control Plane. | Must |
| L2-08 | **`agent-sales` + `skill-zoho-ingest`:** Zoho CRM webhooks + REST + MCP; deal status, pipeline, customer 360 cited Q&A. | Must |
| L2-09 | **`agent-triage` + `skill-gmail-capture`:** Gmail Pub/Sub ingest; email triage classifier; emails linked to deals and projects in entity graph. | Must |
| L2-10 | **Entity resolution** across sources: deterministic rules (external system IDs as canonical keys) first; LLM fallback for ambiguous merges; manual review queue for low-confidence cases. | Must |

### Memory + Intelligence Infrastructure

| ID | Requirement | Priority |
|---|---|---|
| L2-11 | **Automatic memory extraction:** after each agent run, a background job extracts durable facts (max ~2 per turn, categorised) into long-term memory via Mem0 + Graphiti. Dedup via vector → exact → fuzzy fallback. Deterministic regex fallback if LLM extractor fails. Non-blocking — never delays the response path. | Must |
| L2-12 | **Memory dedup + audit loop:** new memories deduplicated on ingestion; periodic LLM audit consolidates near-duplicates; ≥50%-deletion refusal safety net; fingerprint short-circuit skips the audit when nothing has changed. | Must |
| L2-13 | **Skill crystallisation from success:** when an agent run takes ≥ 2 reasoning rounds or ≥ 2 tool calls and succeeds, a background job proposes a reusable skill (confidence ≥ 0.6 only); submitted as a `skill-<name>` PR for human review. | Should |

### Reliability Infrastructure

| ID | Requirement | Priority |
|---|---|---|
| L2-14 | **Durable dispatch queue:** triggers (webhook, cron, agent-to-agent) enqueue a durable `Task` in Postgres; dispatcher drains with bounded worker concurrency, retry-with-backoff, dead-letter sink for crashed runs, per-trigger idempotency key (no double-spawn on redelivered webhooks). | Must |
| L2-15 | **Long-run supervisor:** each in-flight run emits heartbeats; watchdog enforces max-runtime ceiling and reaps/escalates hung runs; loop/non-convergence detector kills agents making no state progress; `execution_budget` in `config.json` enforced as a hard mid-run abort. | Must |
| L2-16 | **Semantic cache + token compression:** GPTCache (1h TTL) in front of LiteLLM; LLMLingua-2 on tool outputs > 1k tokens. | Should |
| L2-17 | **Control Plane HITL queue:** self-mutation PRs and pending write approvals surfaced to operators in a single view. | Must |

**L2 acceptance:** A deliberate error injected into a skill causes `Self_Mutation_Node` to open a GitHub PR with a plausible fix within 5 minutes; a second error in the same run does NOT open a second PR; human merges → CI evals pass → Core uses the updated skill on the next event. Customer 360 query over joined ClickUp + Zoho data returns a cited answer.

---

## 6. Level 3 — Capture + Write Authority

**Goal:** All company data sources are ingested (WhatsApp, meetings, ambient signals); agents can suggest and apply writes to ClickUp/Zoho through the approval-gated Action Broker.

### Capture Expansion

| ID | Requirement | Priority |
|---|---|---|
| L3-01 | **`skill-meeting-transcribe`:** Vexa self-hosted meeting bot (Apache-2.0); WhisperX + Pyannote for STT + diarization; calendar auto-accept for invited meetings. | Must |
| L3-02 | Transcript pipeline to entity graph: action-item extraction (Tier-2 LLM); ACTIONITEM → TASK write via Action Broker (Suggest+Apply only). | Must |
| L3-03 | **`skill-whatsapp-send` + WhatsApp ingest:** WhatsApp Business Cloud API; push notifications to operators/contributors; community/group message ingest for triage. | Must |
| L3-04 | **Ambient trigger engine:** Redis Streams event bus → rule evaluator → agent dispatch; natural-language schedules parsed to cron; stale-task and quiet-deal detectors fire as ambient triggers. | Must |
| L3-05 | **`agent-delivery`:** stale-task detection, contributor ping, deadline escalation; push delivery via WhatsApp and email. | Must |

### Write Authority

| ID | Requirement | Priority |
|---|---|---|
| L3-06 | **Action Broker full build:** approval queue; approval UI in Control Plane; per-action authority tier config; audit log with rollback; kill switch (env-flag instantly disables all writes). | Must |
| L3-07 | **Suggest+Apply — ClickUp:** from `agent-triage` → extracted action-item → ClickUp task creation draft; human confirms in Control Plane before write. | Must |
| L3-08 | **Suggest+Apply — Zoho:** from `agent-sales` → stale deal → Gmail follow-up draft; human approves → send. | Must |
| L3-09 | **Authority tier enforcement:** read / suggest / suggest+apply / autonomous per agent × action type. No autonomous writes in v1. Enforced as a hard code gate in the Action Broker, not a policy config. | Must |
| L3-10 | **Out-of-band HITL:** when operator is not at the Control Plane, approval requests are delivered via email or WhatsApp with a reply-to-approve flow. | Must |
| L3-11 | Recurring schedules stored as immutable templates; each schedule fire spawns a dated child task (clean per-run history; template never mutated). | Should |
| L3-12 | **Skills security scanner:** scan any new or modified skill for prompt injection, secret/credential leaks, data-exfiltration patterns, and dangerous shell before it is installed or shared. | Should |

**L3 acceptance:** A meeting ends; within 10 minutes extracted action items appear as Suggest+Apply tasks in the Control Plane; operator approves; tasks are created in ClickUp. Stale-task pings reach contributors via WhatsApp. Zero unintended writes over a 14-day monitored period.

---

## 7. Level 4 — Company Intelligence

**Goal:** Full agentic intelligence layer over company data — strategy, goals, Odoo ERP, BI on demand, and a system that demonstrably improves itself over time.

| ID | Requirement | Priority |
|---|---|---|
| L4-01 | **Odoo ERP ingestor:** MO, PO, inventory, finance (read-only v1); delivery-risk model from manufacturing data. | Must |
| L4-02 | **`agent-strategy`:** weekly digest synthesis + planning signals; LightRAG over internal documents and SOPs. | Must |
| L4-03 | **Goal model:** GOAL entity in entity graph; project roll-up to goals; goal-progress tracking surfaced in Control Plane. | Must |
| L4-04 | **Sales intelligence & BI:** pipeline health, deal velocity, segment insights; surfaced on demand via chat Q&A or dashboard. | Must |
| L4-05 | **Personal prioritisation:** "what should I focus on today?" — hierarchy-aware, deadline-weighted, role-aware answer with citations. | Must |
| L4-06 | **Smart delegation:** assign tasks by company hierarchy, roles, and current load; understood from entity graph. | Must |
| L4-07 | **RouteLLM training pass:** export labelled call log from the LiteLLM gateway / OTLP traces; fine-tune binary classifier for tier routing. | Should |
| L4-08 | **Annealing loop:** Annealer sub-agent mines successful run patterns; proposes new reusable skills as `skill-<name>` PRs; humans review and merge; shadow (10%) → canary (50%) → full rollout pipeline with auto-deprecation below success threshold. | Should |
| L4-09 | Per-skill success rate tracking; skills below threshold auto-flagged for Annealer review; maintainer review log retained. | Should |
| L4-10 | **Memory feedback loop:** facts extracted by L2-11/L2-12 feed the org entity graph; every agent queries accumulated knowledge at run-start; measurably improves cited-answer quality over time. | Must |
| L4-11 | **Anti-hallucination guardrails:** every output cites its source graph node; schema-validated; second-pass verification pass on high-stakes answers. Hallucination rate < 1%. | Must |
| L4-12 | **Nightly reconciler v2:** cross-source (ClickUp + Zoho + Odoo + Gmail) diff; escalation queue; < 30 min runtime. | Must |

**L4 acceptance:** Operator asks "what should I focus on today, status of project X, and how is the sales pipeline?" and receives a single cited, hierarchy-aware answer across ClickUp + Zoho + Odoo. System has merged ≥ 3 self-mutation or Annealer PRs in production. Strategy agent produces a weekly digest autonomously.

---

## 8. Control Plane — Cross-Cutting Browser UI

The Control Plane is a thin Next.js browser UI. It grows with each level but is **never** an editing surface for agents or skills.

| Level | Capability added to Control Plane |
|---|---|
| L1 | Chat interface to gateway (MAF AG-UI + GitHub Copilot SDK Tier 1.5); observability pane (audit log + spend); Google SSO auth (org domain restricted); **rich chat** (streaming, markdown + syntax highlight rendering, collapsible tool-call blocks with args + result, copy buttons, reasoning/thinking block); **chat session list** with auto-generated title (from first user message) and last-turn preview — not just timestamp |
| L2 | HITL Agent Inbox (self-mutation PRs + pending approvals in one queue); **AG-UI generative UI** — `STATE_SNAPSHOT` and `CUSTOM` events rendered inline in chat: agent state displayed as a structured table; custom event renderers keyed by `name` (e.g. `clickup_task_card`, `zoho_deal_chip`) |
| L3 | Full Action Broker approval UI; push notification config; authority tier management; **inline HITL approvals** — `CUSTOM` `approval_request` events render approve/reject directly in the chat panel (no navigation to separate queue page); Integration page with OAuth connect flow per service |
| L4 | Strategy dashboard; goal roll-up view; BI panels; per-skill success metrics |

> **Current state (2026-06-05):** L1 Control Plane live at `workbench/control_plane/` (Next.js 15, SSO, routing complete). Chat interface fully unified across CommandCenter and named agents: token streaming, GFM markdown rendering, syntax-highlighted code blocks, collapsible tool-call accordion (tool name + full args + result visible), LiteLLM model picker, send / queue / steer controls, MCQ choice buttons, reasoning/thinking block, streaming cursor. GitHub-registered agents run via the **GitHub Copilot SDK Tier 1.5 path** (`agent.run(stream=True)`) — Copilot CLI is the orchestrator; tool calls including file writes and shell execution stream live with args and results. Built-in agents run via **MAF AG-UI**. `@copilotkit/react-*` has been removed (586 packages); the chat runs on a custom SSE stack (`AgentChat.tsx` + `/api/agent/chat`). Chat session list currently shows timestamp only — title and preview enrichment is planned for M2.6.

---

## 9. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Event → agent execution latency (warm clone, `git pull`) | < 5 s |
| NFR-02 | Event → agent execution latency (cold clone, first-ever event) | < 30 s |
| NFR-03 | Pull query p95 | < 15 s |
| NFR-04 | Ambient trigger → push delivery | < 5 min |
| NFR-05 | Self-mutation PR open time after failure | < 5 min |
| NFR-06 | Max self-mutation PRs per failure event | 1 |
| NFR-07 | Hallucination rate over company data | < 1% |
| NFR-08 | System availability (business hours IST) | ≥ 99% |
| NFR-09 | Monthly LLM cost | within budget set at L1 gate |
| NFR-10 | Audit log retention | ≥ 1 year |
| NFR-11 | Memory extraction | non-blocking; never delays response path |
| NFR-12 | Memory audit safety | never deletes > 50% of owner's memories in one pass |
| NFR-13 | Skill crystallisation confidence floor | ≥ 0.6 |
| NFR-14 | Trigger dispatch under at-least-once webhook delivery | idempotent; no double-spawn |
| NFR-15 | Concurrent agent runs | bounded by worker-pool ceiling; no unbounded container spawn |
| NFR-16 | Secret/token storage | encrypted at rest; access-audited |
| NFR-17 | Org-memory staleness vs source (event-driven path) | < 60 s |
| NFR-18 | Nightly reconciler runtime | < 30 min |
| NFR-19 | Delegation / assignee-resolution accuracy | ≥ 90% |

---

## 10. Security, Privacy & Compliance

- **Self-hosted.** Company data stays under company control or named third-party processors (LLM providers, Meta for WhatsApp).
- **Integration Registry is the single credential store.** No credentials in agent or skill repos. `config.json` declares integration names only; the Dynamic Agent Loader resolves credentials at runtime and injects them via MAF `mcp_servers=` config (MAF agents) or `_build_agent_env()` (Copilot-native agents, interim).
- **Self-mutation hot-patch model:** auto-fix PRs tagged `auto-fix`; PR Event Handler reverts the live clone on unmerged-close. Human oversight preserved through audit + rollback, not a pre-merge gate.
- **RBAC:** admin vs operator vs contributor at minimum; finer per-action authority tiers for L3/L4 writes.
- **Indian DPDP Act 2023** compliance for employee data at L3/L4; written consent required before ingesting email/WhatsApp messages.
- **Prompt-injection vigilance:** tool/skill outputs are untrusted input; guardrails enforced at every agent boundary.
- Quarterly access audit; encryption in transit and at rest; configurable retention (raw messages: default 90 days; derived facts: configurable; audit logs: ≥ 1 year).

---

## 11. Explicit Non-Goals

- Building or maintaining a browser IDE (Theia, VS Code fork, or any equivalent). All code authoring is in VS Code + Git locally or via Codespaces.
- In-app creation or editing of agents, skills, or workflow specifications.
- Running n8n or any second workflow runtime. Orchestration is MAF (Microsoft Agent Framework) only.
- A visual drag-and-drop workflow canvas. Workflows are `agents.py` files authored in VS Code.
- Customer-facing or external-party access in v1.
- Autonomous writes to systems of record before the Action Broker and authority tiers are in place (L3).
- Full RBAC beyond admin / operator / contributor (deferred past v1).
- Autonomous agent repo merges — `max_mutation_attempts = 1` and human PR review are mandatory.

---

## 12. Dependencies

| Dependency | Used for | Level |
|---|---|---|
| FastAPI | Event gateway, webhook router | L1–L4 |
| MAF (`agent-framework` + `agent-framework-ag-ui`) | Agent execution runtime (background + interactive), multi-agent orchestration, AG-UI streaming | L1–L4 |
| `agent-framework-github-copilot` (pre-release) | `GitHubCopilotAgent` — Copilot SDK as first-class MAF agent | L1–L4 |
| `agent-framework-mem0` (pre-release) | `Mem0ContextProvider` — episodic memory context | L1–L4 |
| `agent-framework-redis` (pre-release) | `RedisHistoryProvider` — conversation history persistence | L1–L4 |
| `github-copilot-sdk` (Python) | Self-mutation container (`acb-mutation-runner`) only | L2–L4 |
| Postgres + pgvector | Entity graph, Integration Registry, Action Broker queue, audit log, Mem0 | L1–L4 |
| Apache AGE | Graph DB extensions | L3–L4 (Phase 2) |
| `acb_llm` + LiteLLM | Model gateway, cost metering, model aliases (tier-1/2/3) | L1–L4 |
| vLLM + Qwen3-8B | Tier-1 local inference | L2–L4 (Phase 2) |
| Anthropic `SKILL.md` + `skills/` registry | Skill format and monorepo | L1–L4 |
| OTLP observability backend (TBD) | LLM traces via MAF native OTel; Langfuse removed from Phase-0 stack | L2–L4 (deferred) |
| GitHub (agent repos + skill repos) | Distributed repo layout; PR audit gate for self-mutation | L1–L4 |
| Next.js (Control Plane) | Browser UI: chat (AG-UI + Tier 1.5 SSE streaming), HITL, observability; `@copilotkit/react-*` removed | L1–L4 |
| `ag-ui-protocol` (Python + JS) | AG-UI event types, streaming protocol, `STATE_SNAPSHOT` / `CUSTOM` events for generative UI | L1–L4 |
| `pwsh` 7.x (PowerShell Core) | Required by `copilot.exe` shell tool on Linux/Windows for Tier 1.5 sandbox execution | L1–L4 |
| Redis (vanilla redis:7-alpine, Phase 0) | Event bus (Redis Streams), RedisHistoryProvider | L1–L4 |
| Promptfoo + Inspect AI | Eval CI gate on every agent/skill PR | L2–L4 |
| Mem0 | Episodic + semantic memory (via agent-framework-mem0) | L1–L4 |
| Graphiti | Bi-temporal entity knowledge graph | L3–L4 (Phase 2) |
| GPTCache + LLMLingua-2 | Semantic cache + token compression | L2–L4 (Phase 2) |
| MCP servers (ClickUp/Zoho/Odoo/...) | Company system integrations | L1–L4 |
| `apps/reconciler`, `apps/action_broker` | Reconciliation, approval-gated writes | L2–L4 |
| Vexa (Apache-2.0, self-hosted) | Meeting bot | L3–L4 |
| WhisperX + Pyannote | STT + diarization | L3–L4 |

---

## 13. Open Questions

1. **Monthly LLM cost ceiling** — confirm budget envelope; drives tier thresholds and caching aggressiveness.
2. **Retention policy specifics** — exact retention windows for raw transcripts, message bodies, derived facts; need legal sign-off.
3. **Confidence threshold for autonomous promotion** — what success rate per agent justifies suggest+apply → autonomous?
4. **WhatsApp community read posture** — confirm Meta TOS interpretation for the agent reading group messages as a participant.
7. **OAuth provider registration** — ClickUp, Zoho, and Google OAuth apps must be registered with `redirect_uri` pointing to the production VPS hostname. Decide: one shared OAuth app per service (org-level) or per-operator fine-grained tokens? Affects credential scope, token isolation, and audit granularity.
8. **Cloud sandbox GitHub token model** — use a single org-level GitHub App installation token (auto-rotated every hour) or per-operator fine-grained PAT? The former is simpler operationally; the latter gives per-user audit trails for every agent action taken.

---

## 14. Future Enhancements (Nice to Have)

### 14.1 AI-Powered Integration Code Generation

The `apis-config` agent (L2) handles credential discovery today. A future upgrade would enable it to **generate full integration code** — the 6-file stack needed to fully integrate any REST API into CommandCenter:

| File | Purpose |
|---|---|
| `ingestion/sources/{name}/client.py` | Async HTTP client with auth, pagination, rate limiting |
| `ingestion/sources/{name}/normaliser.py` | Maps API objects → entity graph (`person`, `task`, `customer`, etc.) |
| `scripts/{name}_sync.py` | Scheduled data pull / reconciliation job |
| `ingestion/sources/{name}/webhook.py` | Real-time event receiver |
| `skills/{name}-sync/skills.py` | MAF-callable tools for specialist agents |
| Settings fields in `acb_common/settings.py` | Typed credential config |

The flow: operator says *"integrate Notion"* → agent web-searches docs → LLM generates all 6 files → commits to `skill-notion-sync` repo → runs eval CI gate → registers tools in the agent ecosystem. All credentials continue through the encrypted Integration Registry — zero secrets in generated code.

**Dependencies:** LLM code-generation fidelity; automated eval gate for generated repos; human approval before production activation. Not scheduled — deferred until L3+ (post agent ecosystem maturity).
