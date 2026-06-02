# Project Plan — CommandCenter v2 (Distributed, Self-Mutating Agent Network)

> **Organisation:** Fracktal Works · **Project Slug:** `commandcenter` · **Author:** Technical Project Planner · **Date:** 2026-06-02 · **Version:** 2.0 — Distributed, self-mutating agent network architecture

---

## 1. Executive Summary

**CommandCenter** is a cloud-native agent orchestration platform for Fracktal Works. It runs completely decoupled, self-improving AI agents where every agent and every skill lives in its own individual GitHub repository. When a company event or cron schedule fires, CommandCenter provisions a central orchestrator, dynamically clones the target agent's repository, loads its skill dependencies, and executes the task inside an ephemeral sandbox. If errors, API changes, or logic failures occur during execution, the agent evaluates its own telemetry, spins up an isolated development sandbox, fixes its own source code, and opens a GitHub Pull Request against its own repository before cleanly terminating.

**Engineers do not author skills or agents inside CommandCenter itself.** All authoring happens in VS Code (locally or via GitHub Codespaces), committed to the relevant agent/skill repository, and merged through the normal PR flow. Agents themselves can also propose improvements by opening PRs — every such PR requires a human to click merge before the live system adopts the change.

Four architectural principles are non-negotiable:

1. **Decoupled repositories.** Each agent and each skill lives in its own GitHub repo. The Core engine (`CommandCenter-Core`) contains no agent logic or skill files.
2. **Dynamic runtime loading.** The Core FastAPI server clones agent and skill repos at runtime using `importlib`/`sys.path` — the running server never needs a redeploy to pick up new agent logic.
3. **Ephemeral sandboxed execution.** All agent task execution runs inside short-lived OpenHands containers. Workers are destroyed after every run.
4. **Self-mutation with a human gate.** Agents fix their own bugs in isolated sandboxes and open PRs. `max_mutation_attempts = 1` prevents feedback loops. A human must merge before the live system consumes any self-authored change.

---

## 2. Scope & Objectives

### 2.1 In Scope (v2.0)

- **Core Engine** (`CommandCenter-Core`): FastAPI event router, dynamic agent/skill repo cloning, LangGraph state orchestration, Postgres state + telemetry storage.
- **Distributed agent repos** (one per specialist): task-manager, billing, sales, delivery, triage, reconciler, strategy, etc. — each with `config.json`, `graph.py`, `instructions.md`.
- **Distributed skill repos** (one per atomic capability): jira-sync, slack-alert, zoho-ingest, gmail-capture, whatsapp-send, clickup-write, meeting-transcribe, etc. — each a Python package.
- **Self-mutation loop**: `Self_Mutation_Node` in LangGraph that provisions an OpenHands dev sandbox, checks out the failing agent's own repo, runs tests, and opens a PR with the fix.
- Ingestion from ClickUp, Zoho CRM, Odoo ERP, Gmail, WhatsApp Business, and meeting bots.
- Pull, push, and ambient interaction modes.
- Approval-gated write authority to source systems.
- Tiered LLM routing for cost control.
- Nightly reconciliation with escalation queue.

### 2.2 Out of Scope (v2.0)

- In-app skill/workflow editor (all authoring is done in VS Code + Git externally).
- Autonomous agent repo merges without human click — `max_mutation_attempts = 1` + mandatory human PR review.
- Customer-facing access.
- Full RBAC beyond executive vs employee (deferred).
- Autonomous Odoo writes (read-only in v2).

### 2.3 Success Criteria

- A webhook fires and the Core engine clones the target agent repo, runs the task in an ephemeral container, and logs telemetry — end-to-end in under 30 seconds.
- If a skill fails, the Self_Mutation_Node opens a GitHub PR against the agent's own repo within 5 minutes; the PR includes the failing telemetry and a code fix.
- The system never opens more than one self-mutation PR per failure event (`max_mutation_attempts = 1`).
- Executive can ask "status of customer X / project Y" and receive a cited answer in under 10 seconds.
- Zero silent drift over 30 consecutive days at v2.0.
- At least three agent repos have merged self-authored improvement PRs in production by M6.

---

## 3. Requirements Summary

### 3.1 Functional Requirements

| ID | Requirement |
|---|---|
| FR-01 | Core FastAPI server listens for webhook and cron events; routes to the correct agent repo. |
| FR-02 | On event: Core clones the target agent repo + all listed skill repos into a transient volume; dynamically imports `graph.py` via `importlib`. |
| FR-03 | LangGraph initialises a `StateGraph` from the cloned `graph.py`; persists state via `PostgresSaver`. |
| FR-04 | OpenHands SDK spawns an ephemeral worker container; agent executes its skills; outputs and error logs are piped back to LangGraph state. |
| FR-05 | On error: LangGraph routes to `Self_Mutation_Node`; a fresh OpenHands dev sandbox is provisioned; the agent reads its own telemetry and fixes its own source code. |
| FR-06 | Self_Mutation_Node opens a GitHub PR against the agent's own repo; enforces `max_mutation_attempts = 1`; all containers are destroyed post-PR. |
| FR-07 | Merged PRs trigger CI; on pass, the Core pulls the updated agent/skill on next run (no redeploy). |
| FR-08 | Mirror ClickUp, Zoho CRM, Odoo ERP into a unified entity graph. |
| FR-09 | Ingest Gmail, WhatsApp, and meetings via specialist skill repos. |
| FR-10 | Pull mode: cited Q&A over the entity graph. |
| FR-11 | Push mode: notifications via WhatsApp/email on ambient triggers. |
| FR-12 | Nightly reconciler diffs graph vs each source; escalates ambiguities. |
| FR-13 | Per-action authority tier: read / suggest / suggest+apply / autonomous. |

### 3.2 Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Event → agent execution latency (cold clone) | < 30 s |
| NFR-02 | Pull query p95 | < 15 s |
| NFR-03 | Ambient trigger → push delivery | < 5 min |
| NFR-04 | Self-mutation PR open time after failure | < 5 min |
| NFR-05 | Max self-mutation PRs per failure event | 1 |
| NFR-06 | Hallucination rate | < 1% |
| NFR-07 | System availability (business hours IST) | ≥ 99% |
| NFR-08 | Monthly LLM cost | within budget set at PDR |
| NFR-09 | Audit log retention | ≥ 1 year |

### 3.3 Constraints

- Team: 2 engineers + AI assistance.
- **No in-app editing** of skills or agents — all development happens in VS Code + Git. Agents open PRs; humans merge.
- Internal use only; data stays within company control or named third-party processors.
- Source systems (ClickUp, Zoho, Odoo) remain authoritative; all writes are approval-gated.
- **Git is the single source of truth** for every agent-editable artefact (agent `instructions.md`, `graph.py`, skill packages, LiteLLM router config, Langfuse dataset definitions). All edits flow through PRs. No live-editing of running agents.
- Docker-in-Docker: Core container maps `/var/run/docker.sock` from the host so OpenHands can command child containers.
- Dynamic importing: agent repos are loaded at runtime via Python `importlib` + `sys.path.append()` inside FastAPI route controllers — never at server startup.

### 3.4 Regulatory & Compliance

- Indian DPDP Act (Digital Personal Data Protection Act, 2023) for employee data handling.
- Written employee consent required before Phase 1 ingestion of email/WhatsApp.
- Quarterly access audit; encryption at rest and in transit; retention policy enforced.

---

## 4. System Architecture

Full detail in `system_architecture.md`. Summary:

```
[ TRIGGER: Webhook / Cron Event ]
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│     1. CORE ENGINE: FastAPI Server (CommandCenter-Core) │
│  • Listens for events.                                  │
│  • Dynamically clones Agent repo + Skill repos via API. │
│  • Imports graph.py via importlib at runtime.           │
└────────────────────────┬────────────────────────────────┘
                         │ Compiles StateGraph
                         ▼
┌─────────────────────────────────────────────────────────┐
│     2. ORCHESTRATION: LangGraph (State Control)         │
│  • Runs the agent's graph.py workflow.                  │
│  • PostgresSaver for durable state + error telemetry.   │
│  • Routes to Self_Mutation_Node on failure.             │
└────────────────────────┬────────────────────────────────┘
                         │ Launches Actions
                         ▼
┌─────────────────────────────────────────────────────────┐
│     3. RUNTIME & MUTATION: OpenHands SDK (Sandboxes)    │
│  • Worker Container: Executes task skills ephemerally.  │
│  • Dev Sandbox Container: Agent reads own telemetry,    │
│    fixes code, commits, opens GitHub PR, self-destroys. │
└─────────────────────────────────────────────────────────┘
```

### Repository Layout (Distributed)

```
FracktalWorks/CommandCenter-Core        ← Core FastAPI engine + infra (this repo)
FracktalWorks/agent-task-manager        ← Agent: ClickUp task management
FracktalWorks/agent-billing             ← Agent: billing & invoicing workflows
FracktalWorks/agent-sales               ← Agent: Zoho CRM sales workflows
FracktalWorks/agent-delivery            ← Agent: project delivery monitoring
FracktalWorks/agent-triage              ← Agent: email/WhatsApp/meeting triage
FracktalWorks/agent-reconciler          ← Agent: nightly source-of-truth diff
FracktalWorks/agent-strategy            ← Agent: weekly digest + planning
FracktalWorks/skill-clickup-sync        ← Skill: ClickUp read/write via MCP
FracktalWorks/skill-zoho-ingest         ← Skill: Zoho CRM webhooks + REST
FracktalWorks/skill-gmail-capture       ← Skill: Gmail Pub/Sub ingest
FracktalWorks/skill-whatsapp-send       ← Skill: WhatsApp Meta Cloud API
FracktalWorks/skill-meeting-transcribe  ← Skill: Vexa bot + WhisperX
FracktalWorks/skill-graph-write         ← Skill: entity graph upsert
FracktalWorks/skill-action-broker       ← Skill: approval queue + audit writes
```

**Each agent repo contains:**
- `config.json` — model tier, execution budget, schedule/trigger, required skill repos
- `graph.py` — LangGraph `StateGraph` definition (the agent's business logic)
- `instructions.md` — agent persona and operating context

**Each skill repo is a Python package** with a single well-typed entry function, installable via `pip install git+https://...`.

### Operational Lifecycle

**Step 1 — Event Routing:** Webhook/cron → Core FastAPI → identifies target agent from payload → clones agent repo + declared skill repos into transient volume → `importlib`-imports `graph.py`.

**Step 2 — Stateful Execution:** LangGraph initialises `StateGraph` from cloned `graph.py` → `PostgresSaver` connects to persistent Postgres → orchestration loop routes actions to OpenHands worker nodes.

**Step 3 — Sandboxed Action:** OpenHands SDK spins ephemeral worker container → agent executes skills → outputs/errors piped back to LangGraph state → container destroyed.

**Step 4 — Self-Mutation (on error):**
1. LangGraph routes to `Self_Mutation_Node`.
2. Fresh OpenHands dev sandbox provisioned.
3. Agent's own repo checked out inside sandbox.
4. Agent reads failure telemetry → modifies incorrect code → runs tests → commits fix to new branch.
5. GitHub API opens PR: _"Fix: [error description]"_
6. `max_mutation_attempts = 1` enforced — no further mutation until a human merges the PR.
7. All containers destroyed; event logged.

**Human gate:** The live system will not adopt any self-authored change until a human clicks **Merge** on the PR. CI runs evals on the PR branch before it is mergeable.

### Key Architecture Decisions (ADRs)

- **ADR-001** LangGraph as orchestration substrate; `PostgresSaver` for durable state.
- **ADR-002** Postgres + pgvector for entity graph + vectors.
- **ADR-003** External systems = source of truth; Core = read-mostly mirror with approval-gated writes.
- **ADR-004** Vexa (Apache-2.0, self-hosted) as meeting bot.
- **ADR-005** Tiered LLM routing via LiteLLM + RouteLLM.
- **ADR-006** Self-mutation requires human PR merge gate; `max_mutation_attempts = 1`.
- **ADR-007** WhatsApp via Meta Cloud API + dedicated agent number.
- **ADR-008** LiteLLM gateway + RouteLLM + Anthropic/OpenAI prompt caching.
- **ADR-009** Langfuse (MIT, self-hosted) for LLM observability.
- **ADR-010** vLLM + Qwen3-8B as Tier-1 local inference.
- **ADR-011** Mem0 + Graphiti for agent memory layers.
- **ADR-012** GPTCache semantic cache + LLMLingua-2 output compression.
- **ADR-013** Skill repos are Python packages; agent repos contain `config.json` + `graph.py` + `instructions.md`.
- **ADR-014** No in-app skill/workflow editor. All development is in VS Code + Git. Agents open PRs; humans merge.
- **ADR-015** Git is the single source of truth for all agent-editable artefacts; PR + eval gate required for promotion.
- **ADR-016** OpenHands SDK (Apache-2.0, self-hosted) for both worker execution and self-mutation dev sandboxes.
- **ADR-017** Promptfoo + Inspect AI for skill regression evals; CI-gated on every skill/agent PR.
- **ADR-018** Dynamic importing: `importlib` + `sys.path.append()` inside FastAPI route controllers. Agent repos never baked into the Core image.
- **ADR-019** DinD: Core container maps host `/var/run/docker.sock`; OpenHands commands child containers through the host daemon.

---

## 5. Work Breakdown Structure

Full detail in `wbs.md`. Phase totals (PERT engineer-weeks):

| Phase | Capability slice | PERT (ew) | Calendar (2 eng) |
|---|---|---|---|
| 0 | Core Engine: FastAPI + dynamic clone + LangGraph harness + Postgres state + first agent (ClickUp Q&A) | 16 | 8 weeks |
| 1 | Self-Mutation Loop: Self_Mutation_Node + OpenHands dev sandbox + GitHub PR automation + CI eval gate | 8 | 4 weeks |
| 2 | Agent & Skill Repos: task-manager, sales, delivery, triage + core skill repos (ClickUp, Zoho, Gmail) | 14 | 7 weeks |
| 3 | Capture expansion: WhatsApp ingest + meeting bot (Vexa) + ambient triggers + push notifications | 15 | 7.5 weeks |
| 4 | Write authority: Action Broker + approval UX + Suggest+Apply for ClickUp/Zoho | 10 | 5 weeks |
| 5 | Intelligence layer: Mem0 + Graphiti memory + RouteLLM training + strategy agent + LightRAG | 10 | 5 weeks |
| 6 | Odoo + v2.0 hardening + security audit + performance tuning | 8 | 4 weeks |
| **Total** | | **~81 ew** | **~40 weeks → ~12 months with buffer** |

---

## 7. Project Schedule

Full detail in `gantt_chart.md`. Milestones:

| ID | Name | Target |
|---|---|---|
| M1 | MVP — Internal ClickUp Q&A | ~2026-08-05 |
| **M1.5** | **Skill Workbench live (4 panes + pervasive chat + first hand-authored skill)** | **~2026-09-01** |
| M2 | First exec value (Sales + Email) | ~2026-10-14 |
| M3 | Proactive (push + ambient) | ~2026-12-02 |
| M4 | Suggest+Apply live (writes) | ~2027-01-26 |
| M5 | Annealing loop active (Annealer drafts skills into Workbench) | ~2027-03-02 |
| M6 | v1.0 Release | ~2027-04-26 |

Critical path runs through ingestion → graph → reconciliation → Pull agent → **Skill Workbench (parallel)** → write authority → annealer (now writes PRs into the Workbench) → strategy/Odoo.

---

## 8. Resource Plan

| Resource | Allocation |
|---|---|
| Engineer A | ~80% on this project; primary focus on orchestration, action broker, annealer |
| Engineer B | ~80% on this project; primary focus on ingestion, graph, agents |
| Founder / sponsor | ~2 hours/week for reviews, phase gates, policy decisions |
| Ops lead | ~1 hour/day on reconciler escalation queue (from Phase 1 onward) |
| External | Anthropic + OpenAI API spend (within monthly cap; prompt caching applied); Hetzner VMs (~€25/month total for 2 VMs, +€6/mo for the Workbench VM); Vexa compute ~€0.05–0.15/meeting; WhatsApp 1K conv/mo free on Meta Cloud API; GitHub Team (existing) for repo hosting + CI |
| GitHub repos | `ai-company-brain` (infra, scripts, prompts, configs) and `ai-company-brain-skills` (skill registry, Anthropic-format `SKILL.md`); both private under the org; weekly upstream-sync workflow from `anthropics/skills` and `VoltAgent/awesome-agent-skills` |

Cross-pair on each phase; rotate ownership; documentation is a phase deliverable. Skill authoring is a *shared* activity from M1.5 onwards — both engineers, founder, and (eventually) ops can author skills through the Workbench UI without touching the repo directly.

---

## 9. Risk Register (Top 5)

Full detail in `risk_register.md`.

| ID | Risk | P×I | Strategy |
|---|---|---|---|
| R-04 | Agent makes unauthorized writes to source systems | 3×4=12 | Mitigate via Action Broker, per-action authority, rollback, kill switch |
| R-01 | Entity resolution failures (duplicate nodes per person/customer) | 3×3=9 | Mitigate via deterministic rules + LLM fallback + human review queue |
| R-02 | Agent hallucinations | 3×3=9 | Mitigate via citation enforcement + schema validation + second-pass verify |
| R-05 | WhatsApp Business API verification delay | 3×3=9 | Start in parallel; OpenBSP/Whapi as fallback |
| R-11 | Privacy/compliance breach | 2×4=8 | Mitigate via consent policy, retention limits, RBAC, audit |

---

## 10. Quality Plan (V&V)

- **Per-PR (skills repo):** Promptfoo golden-case suite + Inspect AI scenario tests for the changed skill must pass; eval scores published as PR check; merge blocked on regression. No `SKILL.md` may merge without at least one golden case.
- **Per-PR (main repo):** Lint, type check, unit tests for deterministic code, prompt regression suite for agent outputs.
- **Per-phase exit:** Demo against acceptance criteria; reconciler stable for 7+ days; cost within budget for the phase.
- **Continuous:** Langfuse traces (self-hosted, OTel-instrumented via openllmetry) sampled and reviewed weekly; failed actions logged and triaged; citation-coverage metric and per-tier token cost tracked; semantic cache hit-rate monitored. **Per-skill success rate** surfaced in the Skill Studio dashboard; auto-flagged skills below threshold are queued back to the Annealer.
- **Quarterly:** Security review, secrets rotation, access audit, privacy compliance review.
- **Annealing-specific:** Every newly-registered skill enters at 10% **shadow** (runs but doesn't return), then 50% canary, then 100%; auto-deprecate below threshold; maintainer review log retained. Annealer-drafted skills appear as PRs in the Workbench Agent Inbox — humans review, edit in-browser, approve.

---

## 11. Communication Plan

| Cadence | Audience | Format |
|---|---|---|
| Daily | Engineering pair | Async standup (text) |
| Weekly | Founder + engineers | 30-min review + demo of week's work |
| Per phase gate | Founder + engineers + ops | Demo + retro + sign-off |
| Monthly | Whole company | Brief update + invite to use new capabilities |
| Ad-hoc | Affected parties | Incident notifications per privacy/compliance policy |

Directives in `directives/` are updated continuously by the engineering team as learnings accrue (DOE Framework annealing principle).

---

## 12. Open Questions / Items for Next Discussion

These should be settled before or at the M1 PDR-equivalent review:

1. **Monthly LLM cost ceiling** — confirm budget envelope; informs tier thresholds.
2. **Retention policy specifics** — exact retention windows for raw transcripts, message bodies, derived facts; need legal sign-off.
3. **Confidence thresholds for autonomous promotion** — what success rate per agent justifies promoting from Suggest+Apply to autonomous?
4. **WhatsApp community read posture** — confirm Meta TOS interpretation for the agent reading group messages as a participant.
5. **Meeting policy** — which meetings is the bot invited to? Default-in or default-out? Consent UI?
6. **Killer use case for M1** — the *one* thing that proves value to executives in the MVP. (Recommended: customer-360 query with deal + project + open tasks.)

---

## 13. References

See `references.md` (60 entries). Key starting points:

- Hermes Agent (Nous Research): [github.com/nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent)
- OpenHands: [openhands.dev](https://openhands.dev/)
- LangGraph: [langchain-ai.github.io/langgraph](https://langchain-ai.github.io/langgraph/)
- Vexa: [github.com/Vexa-ai/vexa](https://github.com/Vexa-ai/vexa)
- Recall.ai: [recall.ai/product/meeting-bot-api](https://www.recall.ai/product/meeting-bot-api)
- Zep on agent memory: [blog.getzep.com/stop-using-rag-for-agent-memory](https://blog.getzep.com/stop-using-rag-for-agent-memory/)
- Meta WhatsApp Cloud API: [developers.facebook.com/.../whatsapp/webhooks/overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/)

---

## Companion Deliverables

| File | Purpose |
|---|---|
| `system_architecture.md` | Full architecture: containers, sequences, data model, ADRs |
| `wbs.md` | Detailed work breakdown with PERT estimates |
| `gantt_chart.md` | Mermaid Gantt + milestones + critical path |
| `risk_register.md` | Risk register with heat map, mitigations, contingencies |
| `research_summary.md` | State-of-the-art research synthesis with citations |
| `references.md` | Full bibliography |

All under `outputs/ai-company-brain/`.
