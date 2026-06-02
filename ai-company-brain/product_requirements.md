# Product Requirements Document — Jannet.AI

> **Organisation:** Fracktal Works · **Product:** Jannet.AI · **Date:** 2026-05-31 · **Version:** 1.0
> Companion to [`project_plan.md`](project_plan.md). This PRD defines *what* the product must do; the plan defines *how/when* it is built.

---

## 1. Product vision

Jannet.AI is a **self-hosted, browser-accessible agent platform** for running and augmenting a company. It begins as a cloud IDE that feels like VS Code with copilots, and grows into a multi-agent workspace, an automation engine, and finally an agentic intelligence layer over company data.

**One-sentence vision:** a system where you can create new agents, talk to specialist agents that each do one thing well, wire agents together, run workflows autonomously, and put an agentic intelligence layer over company data — to organise projects, build plans, deploy to ClickUp, understand who is working on what, delegate by role and hierarchy, follow up on deadlines, escalate, and act as a sales/BI co-pilot for running the company.

The product is delivered in **four levels**, each independently valuable:

- **L1 — Cloud IDE + Copilot**
- **L2 — Multi-Agent Workspace**
- **L3 — Automation & Workflows**
- **L4 — Company Intelligence**

## 2. Users & personas

| Persona | Description | Primary needs |
|---|---|---|
| **Builder** (engineer) | Builds/extends the platform, authors agents, skills, and workflows | IDE, code exec/deploy, skill/agent authoring, eval gates |
| **Operator** (founder / lead) | Runs the company through Jannet.AI | Ask questions, prioritise day, delegate, approve actions, get BI/sales insight |
| **Contributor** (team member) | Receives nudges, approvals, follow-ups | Email/WhatsApp HITL, task assignment, status |
| **Admin** | Manages configuration and security | Config plane: keys, MCP, OAuth, model policy, RBAC |

## 3. Platform-wide principles (non-functional foundations)

| ID | Principle |
|---|---|
| PR-01 | **Self-hosted & browser-accessible.** The platform runs as a cloud instance reached via browser; data stays under company control or named processors. |
| PR-02 | **Own-the-source shell.** Built on a **forked Eclipse Theia**; customisations delivered as Theia **extensions**; core patched only when an extension cannot reach. Upgradeability is a tracked metric. |
| PR-03 | **Git is the source of truth** for every agent-editable artefact (agent definitions, skills, workflow specs, model-routing config). Promotion is via PR with an eval gate. |
| PR-04 | **One execution model.** Agents + skills (Anthropic `SKILL.md`) orchestrated by a single engine — including workflows. No second runtime (no n8n). |
| PR-05 | **Standards-first.** Obey `AGENTS.md` and Anthropic Agent Skills (`SKILL.md`); integrate external systems via **MCP** before bespoke connectors. |
| PR-06 | **Extension reach.** Support Open VSX extensions at high fidelity (MS Marketplace is unavailable to any fork; this is accepted). |
| PR-07 | **Approval-gating & anti-hallucination** are first-class wherever the system touches systems of record (L4). |
| PR-08 | **Reuse.** `acb_llm`/LiteLLM model routing, `acb_common`, `acb_schemas`, `acb_audit`, `skills/`, and `evals/` are reused, not rebuilt. |
| PR-09 | **Deferred, adapter-based agent runtime.** No external agent framework at L1; a multi-agent runtime (OpenClaw / CrewAI / LangGraph / AutoGen / Claude SDK) is adopted at L2 **behind a normalised adapter**, never as a foundation. Agent definitions stay framework-agnostic. |

---

## 4. Level 1 — Cloud IDE + Copilot

**Goal:** a browser IDE that feels like VS Code, with copilots, that can write/compile/deploy code, save chat sessions, and expose a configuration plane the AI consumes.

| ID | Requirement | Priority |
|---|---|---|
| L1-01 | Browser-accessible IDE based on a forked Theia, served from a self-hosted cloud instance. | Must |
| L1-02 | VS Code-like UX: editor, tabs, file tree, integrated terminal, command palette, panels. | Must |
| L1-03 | Open VSX extension support; verify the common stack (Python, ESLint, GitLens, Docker, YAML, LSP-based language support) runs. | Must |
| L1-04 | Copilot/agent chat embedded in the IDE; assists with code in-context. | Must |
| L1-05 | Write, compile, run, and **deploy** code from within the IDE, executed safely via the **OpenHands** sandboxed backend. | Must |
| L1-06 | **Save and restore chat sessions**, including different session types (e.g. quick chat vs agent task). | Must |
| L1-07 | Load and obey `AGENTS.md` and `SKILL.md` from the active workspace (Anthropic Agent Skills format). | Must |
| L1-08 | **Config Plane** — a settings surface where the AI's operating configuration is managed: API keys, MCP servers, OAuth tokens, and model selection. | Must |
| L1-09 | Model selection routes through `acb_llm` → LiteLLM (tiered routing, prompt caching, cost metering). | Must |
| L1-10 | Authentication (SSO) and reverse-proxy hardening for safe public exposure; secrets encrypted at rest. | Must |
| L1-11 | Jannet.AI branding/shell delivered as a Theia extension (not a core fork). | Should |
| L1-12 | Self-host deploy is reproducible (containerised) and documented. | Must |
| L1-13 | **Cost / token tracking**: per-session and per-model token usage and spend, surfaced in the IDE. *(Mission Control prior art; cheap to add early.)* | Should |

**L1 acceptance:** a user opens Jannet.AI in a browser, authenticates, edits/compiles/runs/deploys code with copilot help, saves and reloads chat sessions, and configures models/MCP/keys/OAuth in the config plane — fully self-hosted.

---

## 5. Level 2 — Multi-Agent Workspace

**Goal:** organise many agents in one UI, switch between them like switching workspaces, create agents and skills, share skills across agents, give agents long-term memory, and make them self-healing.

| ID | Requirement | Priority |
|---|---|---|
| L2-01 | **Agent registry**: an agent = persona + assigned skills + memory + model policy, stored Git-backed. | Must |
| L2-02 | **Agent switcher**: selecting an agent switches the active workspace/context (tools, skills, memory). | Must |
| L2-03 | **Create new agents** through the UI; agent definition is a versioned artefact. | Must |
| L2-04 | **Create new skills** (`SKILL.md`) through the UI/IDE. | Must |
| L2-05 | **Skills are shareable across agents** — one skill can be attached to many agents. | Must |
| L2-06 | **Long-term memory**: a global store plus per-agent memory; agents read/write memory across sessions. | Must |
| L2-07 | **Self-healing**: an agent retries failed steps and can detect and repair a broken skill (e.g. re-draft, re-test) under guardrails. | Must |
| L2-08 | Specialist agents are first-class: an agent can be scoped to do one kind of task well. | Must |
| L2-09 | Agents may **invoke / hand off to** other agents. | Should |
| L2-10 | Per-agent observability: runs, tool calls, skill success rate visible. | Should |
| L2-11 | **Runtime adapter layer**: external agent frameworks (OpenClaw / CrewAI / LangGraph / AutoGen / Claude SDK) register, heartbeat, and report through one normalised interface; agent definitions remain framework-agnostic. *(Mission Control prior art.)* | Must |
| L2-12 | **Skills security scanner**: scan a `SKILL.md` for prompt injection, secret/credential leaks, data-exfiltration, and dangerous shell before it is installed/shared. *(Mission Control prior art.)* | Should |
| L2-13 | **Operator surface**: a task/agent board (Kanban) + activity feed for at-a-glance status across agents and tasks. *(Mission Control prior art.)* | Should |

**L2 acceptance:** a user creates a new named agent and a new skill, shares the skill with a second agent, switches between agents (each with its own context/memory), and an agent recovers from a failed skill run without manual repair.

---

## 6. Level 3 — Automation & Workflows

**Goal:** compose multiple agents and skills into workflows that run autonomously on triggers, with a strong visual editor and human-in-the-loop over email/WhatsApp. The engine is our own, agent-native — not n8n.

| ID | Requirement | Priority |
|---|---|---|
| L3-01 | **Workflow spec format**: declarative, Git-versioned, stored beside skills; references existing agents/skills. | Must |
| L3-02 | **Durable workflow engine** tightly integrated with the orchestrator (long-running, retryable, resumable). Engine choice (LangGraph / Temporal / Windmill) decided at the L3 design gate. | Must |
| L3-03 | **Triggers**: webhooks and schedules (cron); a workflow runs autonomously when fired. | Must |
| L3-04 | **Visual workflow editor** embedded in the Theia shell, built on **React Flow (`@xyflow`)**. | Must |
| L3-05 | Nodes on the canvas are **existing skills and agents** — drag to add, connect to sequence, configure inline. | Must |
| L3-06 | **Human-in-the-loop** steps: a workflow can pause and request approval/input from a human over **email** or **WhatsApp**, then **resume on reply**. | Must |
| L3-07 | Multiple agents can collaborate within one workflow run. | Must |
| L3-08 | Run history, status, and per-run observability (which node, which agent, inputs/outputs, failures). | Must |
| L3-09 | Editing a workflow on the canvas writes back to the Git-versioned spec. | Should |
| L3-10 | Integrations used inside workflows are provided via **MCP servers + skills** (no n8n node library). | Must |
| L3-11 | **Natural-language recurring tasks** (e.g. "every morning at 9am") parsed to cron schedules. *(Mission Control prior art.)* | Should |
| L3-12 | **Quality gate**: a workflow/task step can require human sign-off before it is marked done. *(Mission Control prior art; precursor to the L4 Action Broker.)* | Should |

**L3 acceptance:** a user composes a workflow by dropping existing skills/agents onto canvas nodes, sets a webhook/schedule trigger, runs it autonomously, and the workflow pauses for human approval via email/WhatsApp and resumes on reply.

---

## 7. Level 4 — Company Intelligence

**Goal:** an agentic intelligence layer over core company data — the company co-pilot. Reuses the prior company-brain design (entity graph, reconciler, action broker, memory layers).

| ID | Requirement | Priority |
|---|---|---|
| L4-01 | **Connectors (MCP-first)** to ClickUp, Zoho CRM, Odoo ERP, and other company systems; ingest into org memory/graph. | Must |
| L4-02 | **Org long-term memory + knowledge graph** of people, projects, tasks, deals, customers, goals (reuse `acb_graph` + Mem0/Graphiti research). | Must |
| L4-03 | **Cited Q&A** over company data ("status of project X / customer Y / person Z"). | Must |
| L4-04 | **Personal prioritisation**: suggest what the operator should focus on; help prioritise important tasks. | Must |
| L4-05 | **Project planning**: draft project plans and (approval-gated) **deploy tasks to ClickUp**. | Must |
| L4-06 | **Team awareness**: understand what each team member is currently working on. | Must |
| L4-07 | **Smart delegation**: assign tasks by company **hierarchy, roles, and responsibilities**. | Must |
| L4-08 | **Follow-up & escalation**: automatically follow up with people on deadlines and escalate to the operator or others depending on the task. | Must |
| L4-09 | **Sales intelligence & BI**: surface deal health, pipeline, and business-intelligence insights on demand. | Must |
| L4-10 | **Approval-gated writes** to systems of record via an **Action Broker**, with **authority tiers** (read / suggest / suggest+apply / autonomous) per agent × action. | Must |
| L4-11 | **Reconciliation**: periodic diff of org memory vs source systems with escalation on drift (no silent divergence). | Must |
| L4-12 | **Anti-hallucination guardrails**: outputs over company data cite their sources; schema-validated; second-pass verification. | Must |
| L4-13 | HITL for company actions reuses the L3 email/WhatsApp channel. | Must |

**L4 acceptance:** the operator asks "what should I focus on today / status of project X / who can take this task" and gets a cited, hierarchy-aware answer; the system drafts a project plan and (approval-gated) deploys tasks to ClickUp; follow-ups and escalations fire per deadline; sales/BI insight is available on demand.

---

## 8. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-01 | Browser IDE interactive latency (keystroke/UI) | Comparable to VS Code Web |
| NFR-02 | Copilot first-token latency (cached/Tier-1 path) | < 3 s typical |
| NFR-03 | L4 cited-answer latency p50 / p95 | < 5 s / < 15 s |
| NFR-04 | Workflow trigger → first action | < 1 min |
| NFR-05 | Org-memory staleness vs source (event-driven) | < 60 s |
| NFR-06 | Reconciler runtime (nightly, L4) | < 30 min |
| NFR-07 | Delegation/assignee-resolution accuracy (L4) | ≥ 90% |
| NFR-08 | Hallucination rate over company data (claims without valid citation) | < 1% |
| NFR-09 | Availability (business hours IST) | ≥ 99% |
| NFR-10 | Monthly LLM cost | within budget set at L1 gate |
| NFR-11 | Audit log retention | ≥ 1 year |
| NFR-12 | Secret/token storage | encrypted at rest; access-audited |
| NFR-13 | Theia core-patch count | tracked; minimised in favour of extensions |

## 9. Security, privacy & compliance

- Self-hosted; company data stays under company control or named third-party processors (LLM providers, Meta for WhatsApp).
- **Config plane secrets** (API keys, OAuth tokens, MCP credentials) encrypted at rest; least-privilege access; never exposed to untrusted skill code.
- RBAC: at minimum admin vs operator vs contributor; finer roles for L4 actions.
- Indian **DPDP Act 2023** compliance for employee data at L4; written consent before ingesting email/WhatsApp.
- Quarterly access audit; encryption in transit and at rest; configurable retention for raw messages/transcripts (default 90 days) and audit logs (≥ 1 year).
- Prompt-injection vigilance: tool/skill outputs are untrusted input; guardrails at L4 boundaries.

## 10. Explicit non-goals

- Rebuilding the VS Code/Theia editor from scratch.
- Using the Microsoft VS Code Marketplace (legally unavailable to forks).
- Running n8n or maintaining a second workflow runtime.
- Customer-facing or external-party access in v1.
- Autonomous writes to systems of record before authority tiers + Action Broker exist.

## 11. Dependencies

| Dependency | Used for | Level |
|---|---|---|
| Eclipse Theia (forked) | IDE shell | L1 |
| OpenHands (self-hosted) | Sandboxed code exec/deploy | L1 |
| `acb_llm` + LiteLLM | Model routing, caching, cost | L1–L4 |
| Open VSX | Code extensions | L1 |
| Anthropic `SKILL.md` + `skills/` registry | Skills | L1–L4 |
| React Flow (`@xyflow`) | Workflow canvas | L3 |
| Durable engine (LangGraph / Temporal / Windmill — TBD) | Workflow execution | L3 |
| MCP servers (ClickUp/Zoho/Odoo/…) | Company integrations | L4 |
| `acb_graph`, Mem0/Graphiti | Org memory/graph | L4 |
| `apps/reconciler`, `apps/action_broker` (un-shelved) | Reconciliation, approval-gated writes | L4 |
| Langfuse (self-hosted) | Observability | L1–L4 |
| Promptfoo + Inspect AI | Eval gate | L2–L4 |

## 12. Open questions

1. Theia fork layout (subtree vs submodule) and extension directory structure.
2. Config-plane secret storage backend and the safe path for AI consumption.
3. L3 durable-engine selection: LangGraph vs Temporal vs Windmill.
4. Whether `workbench/control_plane` becomes the config/admin plane or is rebuilt as a Theia view.
5. Timing of physically moving shelved L4 components under a `level4/` area.
6. Monthly LLM cost ceiling (drives routing tiers).
