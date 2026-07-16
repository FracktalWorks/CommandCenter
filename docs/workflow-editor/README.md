# Visual Workflow Editor — Analysis & Implementation Plan

**Status:** Draft / RFC · **Date:** 2026-07-16 · **Owner:** vjvarada

A no-code, node-based builder that lets makers compose **automated workflows** from
CommandCenter's existing agents, tools, and integrations — triggered on command, by
schedule, by webhook, or by an inbound event (email, CRM change, etc.). Conceptually
modelled on Microsoft Copilot Studio, with implementation patterns borrowed from
[Sim](https://github.com/simstudioai/sim) and
[open-agent-builder](https://github.com/firecrawl/open-agent-builder).

---

## 1. TL;DR / Recommendation

Build a **"Workflows" surface** in the control plane: a three-pane visual editor
(palette · canvas · inspector) on top of a new persistence model and a graph
execution engine that reuses CommandCenter's existing primitives — `call_agent`,
the integrations registry, the ingestion/webhook pipeline, and the orchestrator's
tier dispatch.

The single most important architectural rule (validated by both Sim and
open-agent-builder): **separate the edit-model from the run-model.** Persist an
editable graph; compile it to a flat, versioned execution DAG at run time. Never
execute your database rows directly.

Recommended stack for the new pieces:

| Concern | Choice | Why |
|---|---|---|
| Canvas / node editor | **React Flow (`@xyflow/react`)** | Both reference apps use it; de-facto standard; fits Next.js 16 / React 19 |
| Graph persistence | New Postgres tables via SQLAlchemy + a migration in `infra/postgres/` | No workflow tables exist today |
| Execution engine | **New Python DAG executor** in a `workflow-engine` service, dispatching to existing `call_agent` / integrations | Keep the engine in the same runtime as the agents it drives |
| Triggers | Extend the **existing ingestion pipeline + `webhook_routes`** with a user-configurable binding table | Reuse HMAC receivers, Redis Streams, asyncio schedulers |
| State bus | Single merged `variables` channel + `{{...}}` templating | Copied from open-agent-builder; powers autocomplete + validation |
| Streaming run view | Reuse **AG-UI SSE + Redis stream-relay** | Already streams multi-agent runs live |

This is **mostly green-field on the graph/UI side, but heavily reuses the runtime.**

---

## 2. How the three reference systems work

### 2.1 Microsoft Copilot Studio — the *conceptual & UX* model to emulate

Copilot Studio is the product paradigm to copy (not the implementation). Its power
comes from a small set of composable primitives and two authoring modes:

- **Three primitives under one container.** An **Agent** orchestrates **Topics**
  (deterministic conversational node-graphs), **Flows** (deterministic automation:
  trigger → actions → loops → approvals, no conversation), and **Tools** (single
  typed external capabilities). Knowledge sources add RAG grounding.
- **Two vertical canvases.** A topic canvas reads top-to-bottom like a transcript;
  nodes are added via a **"+" button between nodes**; each node is an inline-editable
  card. A separate flow designer handles non-conversational automation.
- **Dual orchestration.** *Classic* = deterministic routing by trigger phrases.
  *Generative* = an LLM builds a plan on the fly from the **name + description +
  typed I/O** of every available capability. The maker "programs" the orchestrator
  by writing good descriptions — **descriptions-as-programming**. This is the
  mechanism that makes it no-code.
- **Unified trigger abstraction.** User-message, schedule, and external event all
  emit a **typed payload**. Event triggers (file created, email received, row
  changed, recurrence) are what make agents *autonomous* (no human in the loop).
- **Normalized connector registry.** Every integration — prebuilt connector, custom
  connector, REST/OpenAPI, sub-flow, another agent, MCP — is reduced to
  `{inputs, outputs, actions, triggers, auth}` and consumed uniformly.
- **Scoped variables.** topic-local (default) → global (session) → system (ambient
  context) → environment (config/secrets), with typed in/out contracts between blocks.
- **Describe → generate → refine.** Describe intent in plain English, the system
  generates the graph, the maker tweaks nodes visually. The biggest single reducer
  of the blank-canvas barrier.

**What we copy:** the primitive hierarchy (agent = container; workflow = automation
graph; tool = typed capability), dual orchestration as a *user choice*,
descriptions-as-programming, the unified trigger + typed payload, the scoped variable
model, and describe→generate→refine authoring.

### 2.2 Sim (`simstudioai/sim`) — the *execution engine* blueprint

Sim is the most mature open reference for the runtime. Apache-2.0. Key takeaways:

1. **Two representations.** A **normalized editable graph** in Postgres
   (`workflow_blocks`, `workflow_edges`, `workflow_subflows`, with jsonb `subBlocks`
   holding the UI form values) is compiled to a flat **`SerializedWorkflow`** JSON
   `{ version, blocks[], connections[], loops{}, parallels{} }` purely for execution.
2. **Compile to a DAG; expand control flow into sentinel nodes.** Loops and parallels
   become start/end sentinel + branch-indexed nodes so a single topological scheduler
   handles everything and gets **native parallelism** for free.
3. **Ready-queue async scheduler.** A node runs when all incoming edges are satisfied;
   independent nodes run concurrently. Router/Condition blocks **prune/activate
   outgoing edges at runtime** so only relevant branches execute.
4. **Handler registry + one generic tool block.** ~16 first-class handlers (Trigger,
   Function, Api, Condition, Router, Agent, Human-in-the-Loop, Wait, Workflow…) plus a
   **Generic** handler that dispatches to a data-driven catalog of 280+ `ToolConfig`
   integrations. New integrations are **config, not engine code.**
5. **Snapshot-based pause/resume** for human-in-the-loop / waits — persisted to a
   `paused_executions` table and resumed from a serialized execution state.
   *Design this in early; retrofitting is painful.*
6. **Async execution on a job queue** (Trigger.dev) with per-queue concurrency limits +
   Redis pub/sub for cancellation. Sync path only for interactive runs.
7. **Unified trigger config** (`webhook | polling | schedule | manual/API | chat`) with
   an `outputs` schema feeding one execution entrypoint. **Bidirectional MCP** —
   consume MCP servers as tools *and* expose a workflow as an MCP server.

### 2.3 open-agent-builder (Firecrawl) — the *lightweight compile-to-LangGraph* pattern

MIT. Smaller and simpler; useful if we want to lean on an existing orchestration lib.

- **Persist the editor's native React Flow JSON directly** (`nodes/edges` as untyped
  arrays); enforce structure only in app-layer types. Zero serialization glue.
- **Compile the visual graph into a real orchestration engine** (LangGraph
  `StateGraph`) at run time instead of hand-rolling a walker — inherits conditional
  routing, loops, parallel fan-out, and checkpointing for free.
- **One merged `variables` state channel** (spread-merge reducer) + a **`{{...}}`
  templating resolver** with graceful fallback (keep-original-on-miss). Any node reads
  any upstream output by path; the same path metadata powers editor autocomplete and
  design-time validation.
- **Branching via React Flow `sourceHandle`** mapped to conditional routers — the
  handle you drag from *is* the routing key.
- **Checkpointer-based human-in-the-loop** (approvals, OAuth) = pause + a DB record.
- **Tools as MCP, not bespoke integrations** — even Firecrawl is "just another MCP
  server" in a registry.
- **Server-only execution + SSE per-node callback** — the client only renders the
  graph and consumes the stream; the engine never ships to the browser.

**11 node types:** `start, agent, mcp, arcade, transform, set-state, if-else, while,
guardrails, user-approval, end`.

### 2.4 Convergence

Both open implementations independently landed on the same shape, which is what we
should build:

> **normalized editable graph (DB) → compile to flat DAG/serialized JSON → topological
> async scheduler → per-node handlers → merged `variables` state bus with `{{...}}`
> templating → SSE streaming → snapshot pause/resume for human-in-the-loop.**

The only real fork is *hand-rolled DAG scheduler (Sim)* vs *compile-to-LangGraph
(open-agent-builder)*. See §8 for the recommendation.

---

## 3. Mapping onto CommandCenter

CommandCenter already has most of the *runtime* a workflow engine needs. The gap is
the **graph model, the editor, and a user-configurable trigger binding.**

| Workflow concept | Already exists in CommandCenter | Gap to build |
|---|---|---|
| **Agent node** | `call_agent` / `call_agents_parallel` / `call_agent_background` (`packages/acb_skills/acb_skills/agent_tools.py`); orchestrator tier dispatch (`orchestrator/executor.py`) | A node handler that invokes these declaratively |
| **Tool / integration node** | Integrations registry (`acb_skills/integrations.py::_REGISTRY` — zoho-crm, gmail, clickup, google-sheets, apollo, serpapi, …); injected tool modules (web/github/memory/todo…) | Expose each as a typed, catalog-driven node |
| **Trigger** | HMAC webhook receivers (`ingestion/sources/{clickup,zoho,gmail}/webhook.py`), Redis Streams (`ingestion/queue.py`), asyncio schedulers, `agent_registry.json.webhook_routes` | A **user-editable** trigger→workflow binding table + schedule/cron/API-key triggers |
| **Condition / branch / loop** | — | New engine control-flow (borrow Sim's sentinel-node expansion) |
| **Human-in-the-loop** | Approval inbox (`action_broker`, `actions.py`, `/actions/pending`) | A `user-approval` node that pauses on a snapshot and resumes from the inbox |
| **State / variables** | Per-run `state` dict passed through the orchestrator | Merged `variables` channel + `{{...}}` templating layer |
| **Live run view** | AG-UI SSE events + Redis stream-relay (`orchestrator/stream_relay.py`) | Wire per-node execution events onto the canvas |
| **Rules-engine precedent** | Email automation (`gateway/routes/email/automation/{rules,engine,runner}.py`) | Generalize its "trigger → condition → action" shape into the graph model |
| **Persistence** | Postgres 16 + pgvector, SQLAlchemy 2.0 (`packages/acb_graph`) | New `workflow*` tables + migration |
| **Editor UI** | Next.js 16 / React 19 / Tailwind v4 / zustand; Monaco already a dep | New `/workflows` route + React Flow canvas |

**Product tension to resolve first:** the repo's stated philosophy is **"No in-app
editor"** — agents are authored in VS Code and shipped via PR. A visual workflow
builder deliberately reverses that *for workflow composition*. The clean reconciliation:
**workflows are a new artifact type (DB-persisted config), not generated agent code.**
Agents stay code-authored; workflows *orchestrate* those agents as data. Get explicit
buy-in on this framing before building.

---

## 4. Proposed data model

Separate edit-model from run-model (Sim's rule #1). New tables (migration in
`infra/postgres/`, ORM in `acb_graph` or a new `acb_workflow` package):

```
workflow                         -- the editable definition
  id (uuid, pk)
  workspace_id / owner_email
  name, description
  status            enum(draft, published, disabled)
  graph             jsonb        -- React Flow-native { nodes[], edges[] } (edit-model)
  variables         jsonb        -- declared workflow inputs + defaults
  latest_version    int
  created_at / updated_at

workflow_version                 -- immutable published snapshots (run-model source)
  id (uuid, pk)
  workflow_id (fk)
  version           int
  serialized        jsonb        -- compiled flat DAG { blocks[], connections[], loops{}, parallels{} }
  published_by / published_at

workflow_trigger                 -- user-configurable bindings (the "unified trigger")
  id (uuid, pk)
  workflow_id (fk)
  kind              enum(manual, api, schedule, webhook, event)
  config            jsonb        -- cron expr | source+event_type | api-key ref | filter
  enabled           bool

workflow_run                     -- execution instances
  id (uuid, pk)
  workflow_id / version
  trigger_kind, trigger_payload  jsonb
  status            enum(queued, running, paused, succeeded, failed, cancelled)
  variables         jsonb        -- final merged state
  node_results      jsonb        -- { node_id: output } (also streamed live)
  started_at / finished_at

workflow_run_pause               -- snapshot for human-in-the-loop / wait (Sim rule #5)
  id (uuid, pk)
  run_id (fk)
  node_id
  snapshot          jsonb        -- serializable execution state to resume from
  reason            enum(approval, wait, oauth)
  status            enum(pending, resolved, rejected)
```

**Edit-model** (`workflow.graph`) is the React Flow JSON, persisted verbatim
(open-agent-builder rule #1 — zero glue). **Run-model** (`workflow_version.serialized`)
is compiled at *publish* time. Runs execute the version, never the live draft — so
editing never breaks in-flight automations.

### Node (block) schema (edit-model)

```jsonc
{
  "id": "node_3",
  "type": "agent",                    // trigger | agent | tool | condition | loop
                                      // | approval | transform | set-state | output
  "position": { "x": 480, "y": 200 },
  "data": {
    "label": "Email Triage Agent",
    "config": { "agent": "email-assistant", "message": "Classify: {{trigger.body}}" },
    "outputs": { "intent": "string", "confidence": "number" }  // typed → autocomplete
  }
}
```

Edges carry `sourceHandle` for branching (open-agent-builder rule #4):
`{ id, source, target, sourceHandle?: "true"|"false", label? }`.

---

## 5. Editor UX (the priority)

The authoring experience is what makes or breaks a no-code tool. Design goals, in
priority order: **legible at a glance · fast to build · hard to break · reads like
CommandCenter.** Full interactive mockup lives alongside this doc
(`docs/workflow-editor/mockup.html`) and is published as an Artifact.

### 5.1 Layout — three panes + a run console

```
┌───────────────────────────────────────────────────────────────────────┐
│ Topbar:  ‹ Workflow name   [trigger chip]        [Test ▸] [Publish]     │
├──────────┬──────────────────────────────────────────────┬──────────────┤
│ PALETTE  │                  CANVAS                       │  INSPECTOR   │
│          │  ┌ trigger ┐                                  │  (selected   │
│ Triggers │  └────┬────┘   node cards + bezier edges,     │   node's     │
│ Agents   │   ┌───▼───┐    pan/zoom, "+" between nodes,    │   typed      │
│ Tools    │   │ agent │    branch handles, live status     │   config     │
│ Logic    │   └───┬───┘    pulse during a test run         │   fields)    │
│ Output   │      ...                                       │              │
├──────────┴──────────────────────────────────────────────┴──────────────┤
│ RUN CONSOLE: streaming per-node events (queued→running→ok), variables    │
└───────────────────────────────────────────────────────────────────────┘
```

### 5.2 The node palette (categories, color-coded)

Color is a **functional encoding**, not decoration — each category has a fixed hue so
the graph is readable at a glance:

- **Triggers** (amber) — Manual / On command · Schedule (cron) · Webhook · Inbound
  email · CRM change (Zoho) · Task change (ClickUp) · Incoming API call.
- **Agents** (violet) — any registered CommandCenter agent (task-manager,
  email-assistant, orchestrator, …) plus "Ask a question" (elicitation) and a generic
  "Run agent" with free-form instructions.
- **Tools / Integrations** (teal) — one node per registered integration action:
  Zoho CRM (create/update lead), Gmail (send), ClickUp (create task), Google Sheets,
  Apollo, SerpAPI, HTTP request, MCP tool call.
- **Logic** (slate) — Condition (if/else) · Switch/Router · Loop (for-each / while) ·
  Wait/Delay · Set variable · Transform (code) · Human approval.
- **Output** (green) — End / Return · Send notification · Post result.

### 5.3 Core interactions

1. **Add a node** — drag from palette, or click the **"+" on any edge** to insert
   inline (Copilot Studio's transcript-style flow). New node auto-connects.
2. **Connect** — drag from a node's output handle to another node's input. Condition
   nodes expose labelled **true/false handles**; the handle *is* the routing key.
3. **Configure** — select a node → the **inspector** shows typed fields for that node
   type. Fields that accept upstream data show a **`{{ }}` variable picker** with
   autocomplete populated from every upstream node's declared outputs.
4. **Reference data** — `{{trigger.body}}`, `{{node_3.intent}}`, shorthand
   `{{intent}}`. Unresolved refs are flagged at design time (not at run time).
5. **Test run** — **"Test ▸"** runs the workflow with sample trigger data; nodes pulse
   `queued → running → ok/err` and the run console streams each node's output live
   (reusing AG-UI SSE). This is the tightest feedback loop and should feel instant.
6. **Publish** — compiles the draft to an immutable `workflow_version` and activates
   its triggers. Editing afterwards creates a new draft; in-flight runs keep using the
   published version.

### 5.4 Describe → generate → refine (the differentiator)

A prompt bar at the top of an empty canvas: *"Describe what you want to automate."*
The maker types "When a sales email comes in, classify it, and if it's a lead create
a Zoho contact and draft a reply for approval." An LLM (via the gateway `/v1`) emits a
**graph JSON** conforming to the node schema, which is dropped onto the canvas for the
maker to refine. This directly reuses the agents' structured-output capability and is
the biggest reducer of the blank-canvas barrier. Ship it in v1, not v0 — but design
the node schema to be LLM-emittable from day one (flat, typed, documented).

### 5.5 Guardrails that keep it no-code

- **Design-time validation:** unresolved `{{refs}}`, disconnected nodes, a trigger-less
  graph, type mismatches — all surfaced as inline node badges before publish.
- **Typed I/O everywhere:** every node declares output types so the variable picker and
  validator can work; this is what makes descriptions-as-programming safe.
- **Human-approval node** as a first-class, one-click gate for any risky/irreversible
  action (send email, write to CRM) — wired to the existing approval inbox.
- **Read-only run history** with per-node inputs/outputs for debugging.

---

## 6. Execution engine

A new engine (a service under `apps/services/`, e.g. `workflow-engine`, or a module in
the orchestrator) that:

1. **Loads** the target `workflow_version.serialized`.
2. **Builds a DAG**, expanding loops/parallels into sentinel nodes (Sim rule #2).
3. **Schedules** with a ready-queue: a node runs when all incoming edges are satisfied;
   independent nodes run concurrently (Sim rule #3).
4. **Executes** each node via a **handler registry** keyed by node `type`:
   - `trigger` → seeds `variables` from the trigger payload.
   - `agent` → `call_agent(name, rendered_message)` / `call_agents_parallel(...)`.
   - `tool` → resolve the integration from `acb_skills/integrations.py` and invoke it.
   - `condition`/`router` → evaluate expression, activate the matching out-edge.
   - `loop` → iterate a sub-region.
   - `approval`/`wait` → **snapshot to `workflow_run_pause`** and suspend; resume from
     the approval inbox.
   - `transform`/`set-state` → compute values into `variables` (sandbox untrusted code).
   - `output` → collect the return payload.
5. **Passes state** through one merged `variables` channel; each node's output is stored
   under its id and referenced by other nodes via `{{...}}` templating.
6. **Streams** per-node events over SSE (reuse AG-UI + Redis stream-relay) so the canvas
   lights up live.
7. **Runs async** for real triggers (a queue/worker like the existing Redis-Streams
   consumers), sync for interactive "Test" runs. Redis pub/sub for cancellation.

**Reuse, don't reinvent:** node handlers are thin adapters over `call_agent`, the
integrations registry, and the approval broker that already exist.

---

## 7. Triggers

Generalize the existing event plumbing into a **user-configurable** binding
(`workflow_trigger` table), reusing the ingestion pipeline:

- **Manual / On command** — a "Run" button + `POST /workflows/{id}/run`.
- **Incoming API call / webhook** — per-workflow API key (like open-agent-builder's
  `apiKeys`) and/or an inbound webhook URL. Reuse the HMAC receivers.
- **Schedule (cron)** — a cron field; a scheduler loop (extend the existing asyncio
  schedulers, or introduce APScheduler) enqueues runs. *No cron library exists today —
  a small decision point.*
- **Inbound email** — subscribe to the email-ingestion stream; the email automation
  rules engine (`email/automation/`) is the precedent to generalize.
- **External event** — CRM/task changes already arrive via `ingestion/sources/*`;
  today they bind to agents through `agent_registry.json.webhook_routes`. Extend that
  binding so an event can target a **workflow** and pass its normalized payload as the
  trigger's typed variables.

All trigger kinds converge on **one entrypoint** that seeds `variables` with a typed
payload and enqueues a `workflow_run` (Copilot Studio's unified-trigger idea, Sim's
`TriggerConfig`).

---

## 8. Key decisions & open questions

1. **Engine: hand-rolled DAG (Sim) vs compile-to-LangGraph (open-agent-builder).**
   Recommendation: **hand-rolled Python DAG executor.** LangGraph would add a heavy
   dependency and a second orchestration paradigm alongside the Microsoft Agent
   Framework already in use; a focused ready-queue scheduler is a few hundred lines and
   keeps node handlers as thin adapters over `call_agent`. Revisit only if we need
   LangGraph-specific features.
2. **Where the engine lives.** New `apps/services/workflow-engine` (clean separation,
   its own worker) vs a module inside the orchestrator (closer to `call_agent`).
   Leaning **new service** for isolation and independent scaling.
3. **"No in-app editor" philosophy.** Confirm workflows are DB-config artifacts that
   *orchestrate* code-authored agents — not generated agent code. (§3.)
4. **Cron/scheduling.** Adopt APScheduler vs extend the hand-rolled asyncio loops.
   A real cron parser is worth it once schedule triggers exist.
5. **Multi-tenant scoping.** Workflows are workspace-scoped; reuse the header-trust
   SSO + RBAC (`acb_auth`). Who can publish (executive vs employee)?
6. **Secrets in nodes.** Nodes must never read raw credentials — resolve through the
   integrations registry at run time, exactly as agents do today.
7. **MCP.** Both references treat integrations as MCP. CommandCenter already has MCP
   (`.mcp.json`, per-agent `mcp_servers`). An "MCP tool" node is a natural fit and
   future-proofs the tool catalog.
8. **Versioning & rollback.** Immutable `workflow_version` gives free rollback; decide
   retention and whether draft autosave is separate from published versions.

---

## 9. Phased roadmap

**Phase 0 — Spike (1–2 wks).** React Flow canvas in a new `/workflows` route;
node/edge schema in TypeScript; persist `workflow.graph` jsonb via a new gateway route.
No execution yet. *Goal: prove the editor UX on the real stack.* (This is what the
mockup previews.)

**Phase 1 — MVP linear execution (2–4 wks).** Data model + migration; Python DAG
engine for **linear** graphs (trigger → agent → tool → output); `agent` and `tool`
handlers over `call_agent` + integrations registry; **manual trigger** + **Test run**
with SSE streaming onto the canvas; the `{{...}}` templating + variable picker.

**Phase 2 — Control flow + triggers (3–5 wks).** Condition/router/loop nodes with
sentinel-node DAG expansion; **schedule + webhook + inbound-email triggers** via the
`workflow_trigger` table and the ingestion pipeline; async run queue; run history UI.

**Phase 3 — Human-in-the-loop + polish (3–4 wks).** `user-approval` / `wait` nodes with
snapshot pause/resume wired to the approval inbox; design-time validation badges;
publish/version/rollback; per-node run inspector.

**Phase 4 — Generative authoring + reach (ongoing).** Describe→generate→refine;
MCP-tool node; expose a workflow as an API/MCP server; template gallery; connected/
multi-agent workflow nodes.

---

## 10. References

- Microsoft Copilot Studio docs — [Overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/fundamentals-what-is-copilot-studio),
  [Topics](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-create-edit-topics),
  [Agent flows](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-overview),
  [Generative orchestration](https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-generative-actions),
  [Event triggers](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-triggers-about),
  [Variables](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-variables-about).
- Sim — <https://github.com/simstudioai/sim> (Apache-2.0).
- open-agent-builder — <https://github.com/firecrawl/open-agent-builder> (MIT).
- CommandCenter internals: `apps/services/orchestrator/orchestrator/executor.py`,
  `packages/acb_skills/acb_skills/agent_tools.py`,
  `packages/acb_skills/acb_skills/integrations.py`,
  `apps/services/gateway/gateway/routes/email/automation/engine.py`,
  `agent_registry.json`.
