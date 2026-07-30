# Workflows App — Project Plan (deterministic automation over the agent fleet)

> **Product:** CommandCenter · **Feature:** Workflows app (`/workflows`) · **Updated:** 2026-07-30 · **Version:** 0.2
> **Status:** 🔄 Slices 1+2 built — data model (migration 132) + gateway API + MAF compiler/engine + `/workflows` visual editor + Module Studio + **Workflow Copilot (F14)** + **keyword capability search (F15; semantic → BO‑22)** + **event triggers (F10)** + **approval node with pause/resume via the Action Broker inbox (F11)** + **workflows as agent tools (F13)** + **run-history drill-in (F9 complete: a history row replays its recorded node results onto the canvas)** + **F1/F6 complete (gallery search + duplicate/delete, version rollback via the status-badge popover)** + **F3's logic vocabulary complete (wait node — inline under a minute, durable pause above it; approval and wait now both in the catalog/palette)**. All five trigger kinds live: manual, api, webhook, schedule, event. Engine semantics are locked by a golden trajectory eval (`evals/trajectories/test_workflow_engine_trajectory.py`, CI-blocking); orphaned `running` rows are swept to `failed` at gateway startup (paused runs survive — resume rebuilds from the pause snapshot). **R2 is mitigated (migration 134):** a published workflow whose unattended runs fail `AUTO_DISABLE_AFTER` times consecutively disables itself with a recorded reason, and `POST /{id}/enable` is the one-click way back.
> **Parent RFC:** [`docs/workflow-editor/README.md`](../../docs/workflow-editor/README.md) — stack selection (React Flow), the compile-to-MAF-Workflows decision, data model, editor UX, trigger taxonomy. Read it for *how*; this doc is *what, why, and why now*. Interactive mockup: `docs/workflow-editor/mockup.html`.
> **Reference precedents:** [`task_manager_app.md`](task_manager_app.md) (app spec shape) · [`docs/app-workshop/README.md`](../../docs/app-workshop/README.md) §4.0 (the platform contract this app also enforces).
> **Policy amendment:** ADR-028 (see `system_architecture.md`) amends ADR-014 and `project_plan.md` C-09 / §2 non-goals — see §10.

---

## 0. One-paragraph thesis

CommandCenter has a fleet of specialist agents, a registry of integrations, and event plumbing (webhooks, schedules, streams) — but the only ways to make them act are a chat prompt or an engineer editing `agent_registry.json`. The Workflows app closes that gap: a visual, no-code builder in the Control Plane where an operations maker composes **deterministic automation graphs** — trigger → agents → integration tools → code modules → approvals — that run without anyone typing a prompt. Agents stay code-authored in Git (the platform philosophy is untouched); workflows are a **new artifact type, DB-persisted configuration** that *orchestrates* those agents as data, compiled at publish time to the Microsoft Agent Framework's native Workflows engine we already run. Where a step needs bespoke logic (clean this CSV, dedupe these CRM rows, reshape this payload), the maker doesn't write code — they describe the task in the **Module Studio** and get a validated, typed, reusable module generated conversationally.

**The one-sentence pitch:** *describe or draw the automation once, and the company's agents, integrations, and custom logic run it on every webhook, schedule, or event — deterministically, observably, and with a human gate on anything that writes out.*

---

## 1. Product definition

### 1.1 Why now (business context)

Fracktal Works runs sales, delivery, support, and finance across Zoho CRM, ClickUp, Gmail/Outlook, WhatsApp, and Odoo. Today, cross-system busywork is handled one of three ways:

1. **A human does it** — copy the lead from the email into Zoho, make the ClickUp task, chase the follow-up. Toil, error-prone, invisible.
2. **A chat prompt does it** — someone asks an agent in `/chat`. Powerful but *on-demand and non-deterministic*: it happens only when asked, and the LLM decides the steps each time.
3. **An engineer hard-wires it** — `webhook_routes` in `agent_registry.json`, the email automation rules engine, a bespoke scheduler loop. Deterministic but *developer-gated*, scattered across four mechanisms, and invisible to the people who own the process.

The missing quadrant is **deterministic + self-serve**: the ops owner defines the process once, the platform runs it every time, and the run history shows exactly what happened. That quadrant is where n8n/Zapier/Make live for generic SaaS — but none of them can invoke *our* agents, *our* integration credentials, *our* approval inbox, or *our* memory. The moat of this feature is that workflow nodes are thin adapters over capabilities CommandCenter already owns.

### 1.2 Business goals (the "automation goals")

| # | Goal | Measure (v1 target) |
|---|---|---|
| G1 | **Convert manual cross-system toil into governed automation.** | ≥ 5 live production workflows covering real Fracktal processes (lead intake, CRM hygiene, task escalation, report digests) within 30 days of GA. |
| G2 | **Make automation self-serve for non-engineers.** | An ops maker builds and publishes a 5-node workflow, unassisted, in < 30 minutes. Zero Git/IDE involvement. |
| G3 | **Make the agent fleet programmable, not just promptable.** | Every registered agent and every integration action is invocable as a typed workflow node — the same catalog the orchestrator sees. |
| G4 | **Keep outward writes governed.** | 100 % of workflow steps that write to source systems route through the approval / Action Broker path (non-negotiable #4); no workflow bypasses it. |
| G5 | **Consolidate the automation surfaces.** | New automations land in Workflows instead of new bespoke rule engines; the email automation rules engine is the named generalization precedent (RFC §3), and `webhook_routes` bindings become workflow triggers over time. |
| G6 | **Full auditability.** | Every run persists per-node inputs/outputs, status, timing, and cost attribution; run history is first-class UI, and runs surface in `/observability` like agent and app activity. |

### 1.3 Personas / situations to design for

- **The maker** (ops/sales/delivery manager; `workflows` feature grant): owns a business process, knows the systems involved, does not write code. Builds in the canvas, tests with sample payloads, publishes. The whole UX is designed for this person.
- **The approver** (executive or the maker's lead): sees approval-gated steps in the existing approvals inbox; approves/rejects with context (which workflow, which node, what payload).
- **The engineer** (platform team): authors agents and skills in Git exactly as today; adds integrations to the registry; audits generated modules. Never needs to touch the canvas for a workflow to exist — but can, and gets versioned, inspectable JSON artifacts rather than tribal automation.
- **The agent** (yes, an agent): the orchestrator can list and trigger published workflows as tools, so conversational requests ("run the lead-intake flow on this") reuse governed automations instead of improvising.

### 1.4 Explicit non-goals (v1)

- **Not an agent editor.** No editing of `agents.py`, instructions, or skills from the canvas — ADR-014's authoring rule stands for *code* artifacts.
- **Not a second runtime.** No n8n, no LangGraph, no embedded workflow engine — the graph compiles to MAF Workflows (ADR-028). If MAF can't express something, the platform grows; the app never routes around it.
- **Not a general-purpose code platform.** Modules are sandboxed, dependency-free, pure-transform Python; anything bigger belongs in a skill repo via PR (and Module Studio says so — the "builder refuses and redirects" rung of the platform contract ladder).
- **Not multi-tenant marketplace tooling.** Workflows are org-internal; sharing/templates beyond this org are Phase 4+.
- **No autonomous outward writes.** Same rule as everywhere else: write-class integration actions require the approval node / Action Broker disposition until BO‑1 lands fully.

---

## 2. Feature set (prioritized)

Feature IDs `F1..F13`; Must/Should/Could is for v1 (phases in §8).

| ID | Feature | Priority | Notes |
|---|---|---|---|
| F1 | **Workflow list + CRUD** — gallery at `/workflows` with status (draft/published/disabled), search/filter, create/duplicate/delete | Must | Feature-gated (`workflows` slug), default-deny like all panes |
| F2 | **Visual editor** — three-pane canvas (palette · canvas · inspector) + run console; React Flow; nodes color-coded by category (RFC §5.2) | Must | The priority surface; mockup is the reference |
| F3 | **Node catalog from the platform** — Agents (from the live registry), Integration actions (from `acb_skills` integrations), Logic (condition, set-variable, human approval, wait), Modules (F7), HTTP request, Output/notify | Must (shipped) | Catalog served by the gateway, not hard-coded in the UI (G3). The **wait** node is durable by design: ≤60s sleeps inline, anything longer pauses the run with a deadline in the pause snapshot and the schedule scanner resumes it — so a "wait 2 days, then follow up" survives a gateway restart without BO‑20 |
| F4 | **`{{…}}` data references** — any node's config can reference the trigger payload and upstream node outputs; picker + design-time validation of unresolved refs | Must | The state bus; RFC §6.4 bridge |
| F5 | **Test run + live node status** — run with sample trigger data; nodes pulse queued→running→ok/err; per-node output in the run console (SSE) | Must | Tightest feedback loop; reuses the SSE relay pattern |
| F6 | **Publish + immutable versions** — publishing compiles the draft to a versioned run-model; in-flight runs pin their version; rollback = republish an old version | Must | Sim's rule #1; editing never breaks live automations |
| F7 | **Module Studio — conversational code modules** — describe a task in chat ("dedupe these CRM rows by email, keep newest"), receive a generated, AST-validated, typed Python module; test it against sample input; save to the org module library; use as a node in any workflow | Must | The differentiator the RFC scoped as "transform (code)" — promoted to a first-class library with a conversational front end (§5) |
| F8 | **Triggers: manual + webhook + schedule** — Run button / `POST /workflows/{id}/run`; per-workflow tokened webhook URL; cron schedule with a scheduler loop | Must | RFC §7; all converge on one entrypoint |
| F9 | **Run history** — list of runs per workflow with status, duration, trigger kind; drill into per-node inputs/outputs | Must | G6 |
| F10 | **Event triggers** — bind a workflow to platform events the way `webhook_routes` binds agents today | Must (shipped) | Fed by `/agent/webhook/{source}` and the ClickUp receiver via the ingestion event-hook registry; empty event_type matches all events from a source; full durability still rides BO‑20 |
| F11 | **Approval node** — pause the run, surface in the approvals inbox, resume on approve / cancel on reject | Must (shipped) | Rides the Action Broker verbatim: the pause files a `workflow.resume_run` proposal into `pending_actions` (the /approvals inbox); resume replays completed nodes from stored outputs (no repeated side effects) — snapshot-based, no MAF checkpoint storage needed |
| F12 | **Describe → generate → refine** — prompt bar on an empty canvas emits a full graph JSON conforming to the node schema | Should | Superseded by F14, which delivers this conversationally inside the editor |
| F13 | **Workflows as tools** — published workflows callable by every agent via a `list_workflows`/`run_workflow`/`get_workflow_run` tool trio (`orchestrator/workflow_tools.py`, mirroring `app_tools.py`; same in-process entrypoints as the Run button, so approval gates bind identically); MCP exposure later | Must (shipped) | Three generic tools, not one per workflow — the catalog scales without bloating agent tool schemas |
| F14 | **Workflow Copilot** — a chat panel in the editor (Palette \| Copilot tabs): the maker describes a change, the copilot emits the full updated graph; **modules the graph needs that don't exist are generated, AST-validated, and saved automatically** (provenance `auto_created`, `generated_by: workflow-copilot`); graph applies to the canvas with one-click undo, and is never saved server-side without the maker | Must (shipped) | One named-issue repair round against the same validators as publish; the copilot never invents capabilities — it only wires what the catalog serves |
| F15 | **Capability search** — keyword-ranked search over the live catalog (agents/tools/integrations/modules/node types); powers BOTH the palette's search box and the copilot's shortlist, and the palette rolls tools up under their integration with counts | Must (shipped) | **Deliberately keyword-only** (owner decision 2026-07-30): semantic ranking belongs to the platform, not this app — see **BO‑22** (platform semantic-search service, `FOUNDATION_BUILDOUT_CHECKLIST.md`); `search.py` keeps the API shape so BO‑22 swaps in as a ranking backend. The palette and the copilot see the same ranking either way |

---

## 3. Architecture

### 3.1 Placement (what exists vs what's new)

The RFC §3 mapping table is the source of truth; summary of the seams this build reuses rather than reinvents:

- **Agent invocation** — `call_agent` / orchestrator executor (`apps/services/orchestrator/`). The agent node is a thin adapter; agents remain code-authored.
- **Integration actions** — the integrations registry in `packages/acb_skills` (13 registered services today: zoho-crm, clickup, gmail, gmail-send, smtp, google-sheets, apollo, serpapi, apify, instantly, anymailfinder, google-maps, litellm) resolves credentials at run time; nodes never see secrets (D4). Write-class actions dispatch through the Action Broker's handler registry so disposition/approval semantics are the broker's, not the engine's.
- **Trigger plumbing** — gateway webhook receivers, ingestion normalizers, Redis activity feed; the workflows scheduler is the platform's first real cron loop (D6).
- **HITL** — approvals inbox + `workflow_run_pause` snapshots; Action Broker disposition once BO‑1 wires the write path.
- **Streaming** — run events over the existing SSE relay pattern; runs appear in `/observability`.
- **New**: the `workflow*` tables, the graph→MAF compiler, the node handler set, the module library + generator, and the `/workflows` UI.

**Where the engine lives:** `gateway/routes/workflows/` — the same multi-file route-package shape as tasks/notes/apps (the four comparable apps all chose this), with the engine as a transport-free `engine/` subpackage inside it. Agent nodes call the orchestrator's batch executor (`orchestrator.executor.run_agent`, `source="workflow"`), honoring global constraint #9 (event-driven execution goes through MAF paths). The engine subpackage can move into the orchestrator process unchanged if run isolation later demands it (Q2).

### 3.2 The platform contract for workflow nodes

Mirroring App Workshop §4.0 — a workflow is CommandCenter-native **by construction**. For every need, there is exactly one way, and no second path:

| Workflow need | The CommandCenter way | Never |
|---|---|---|
| Call an LLM | An **agent node** (registered agent, gateway-routed `/v1` tiers) | Provider SDKs, embedded keys, raw HTTP to model APIs |
| Touch an external system | An **integration node** resolved through the Integration Registry at run time | Credentials in node config; raw `fetch` to authenticated APIs |
| Custom logic | A **module node** — AST-validated, import-free, time-boxed pure transform (§5) | Arbitrary subprocesses, network, filesystem, `import` |
| Long-running / retry / state | Engine-managed run state, MAF checkpointing | Nodes managing their own persistence |
| Outward write | Approval node upstream; Action Broker disposition (BO‑1) | Autonomous writes from any node |
| Secrets | Referenced by integration name, resolved server-side | Secret material in `workflow.graph`, ever |

Enforcement ladder (each rung independent): (1) the editor and Module Studio **refuse and redirect** — deviations are named and the platform equivalent is built instead; (2) **validation physics** — the module validator and graph validator reject forbidden constructs before anything persists; (3) **publish gate** — compile-time checks (unresolved refs, secret-shaped strings in config, write-class nodes without an approval ancestor) block publish; (4) **runtime gate** — handlers resolve capabilities server-side per call; an unknown agent/integration/module fails the node, is audited, and never falls back to raw access.

### 3.3 Trigger model

RFC §7 verbatim, plus one product rule: **all trigger kinds converge on one entrypoint** (`start_run`) that seeds `variables.trigger` with a typed payload and creates a `workflow_run`. Kinds: `manual`, `api`, `webhook` (per-workflow secret token URL), `schedule` (cron expression, croniter-driven asyncio loop), `event` (bindings against normalized ingestion events — the successor to `agent_registry.json.webhook_routes`). Durable queueing/backoff for high-volume event triggers is BO‑20's scope; v1 executes runs as supervised asyncio tasks in-process and says so honestly in run status.

### 3.4 Code modules — scope and the sandbox line

The v1 module runtime is **restricted-execution, not a sandbox**: AST-allowlisted (no imports, no attribute escapes, no dunder access), builtins-allowlisted, wall-clock-bounded, output-size-bounded, executed in-process. That is safe for its intended class — pure data transforms authored via the platform's own generator with human review — and is *documented as insufficient* for untrusted third-party code. Full process isolation is **BO‑7** (same gate as App Workshop T3); when it lands, module execution moves into it without API changes. Until then, module creation/editing is grantable separately from workflow authoring (`workflows.modules` vs `workflows`), and every saved module records its provenance (conversation, generator model, reviewer).

---

## 4. Data model

Migration `infra/postgres/132_workflows.sql` (next free number after `131_integration_memory_permissions.sql`). Tables per RFC §4 — `workflow`, `workflow_version`, `workflow_trigger`, `workflow_run` (+ `node_results`), `workflow_run_pause` — plus one addition:

```
workflow_module                  -- the org module library (Module Studio)
  id (uuid, pk)
  name (unique per org), description
  language          text         -- 'python' (only value in v1)
  code              text         -- the module source (validated)
  input_schema      jsonb        -- JSON-Schema-ish typed inputs
  output_schema     jsonb        -- declared outputs → {{…}} autocomplete
  provenance        jsonb        -- prompt, model, generated_at, reviewed_by
  status            enum(draft, ready, disabled)
  created_by / created_at / updated_at
```

`workflow.graph` is React-Flow-native JSON persisted verbatim (edit-model); `workflow_version.serialized` is the compiled flat DAG (run-model). Node schema and edge `sourceHandle` branching per RFC §4.

Migration `134_workflows_automation_health.sql` adds three columns to `workflow` for the R2 mitigation: `disabled_reason` / `disabled_at` (why it is off — written identically by a human hitting Disable and by the auto-disable policy) and `health_since` (the instant the failure streak is counted from; publish, rollback, and enable all stamp it). The streak itself is deliberately **not** a counter column — it is derived from `workflow_run` on demand, so it can never drift from the history a human reads, and one success breaks it with no bookkeeping.

---

## 5. Module Studio (conversational programmatic modules)

The user-facing loop:

1. **Describe** — a chat panel ("What should this module do?"): *"Take a list of CRM contact rows, drop rows without an email, dedupe by email keeping the most recently modified, and return the cleaned list plus a count of dropped rows."*
2. **Generate** — the gateway calls the LLM (existing `/v1` tier routing) with a constrained system prompt: emit a single `def run(inputs: dict) -> dict` body plus `input_schema`/`output_schema` JSON. No imports, no I/O — the prompt states the validator's rules so the model writes inside them.
3. **Validate** — the AST validator (rung 2) rejects forbidden constructs mechanically; failures loop back to the model once with the violation named, then to the user.
4. **Test** — the maker pastes/select sample input (e.g. the output of an upstream node from a previous run) and sees the module's output live.
5. **Refine** — follow-up messages patch the module ("also lowercase the emails") — same generate/validate/test loop.
6. **Save** — named, described, schema-typed, provenance-stamped → appears in the node palette under **Modules** for every workflow.

Modules are the "programmatic modules generated via a conversational interface" requirement: ready-to-use, typed, reusable units that slot between CRM reads and writes (or anywhere) — with the platform contract, not in spite of it.

---

## 6. API surface (gateway `routes/workflows/`)

- `GET/POST /workflows` · `GET/PUT/DELETE /workflows/{id}` — CRUD on the edit-model; `POST /workflows/{id}/duplicate` — copy into a fresh draft (graph/variables/triggers travel; the webhook hook token is regenerated — it is a credential, never cloned)
- `POST /workflows/{id}/publish` — compile + snapshot version; `GET /workflows/{id}/versions`; `POST /workflows/{id}/versions/{v}/rollback` — republish version *v* as a NEW version (F6: rollback never mutates history, and never gates on the current catalog — drift is returned as non-blocking `warnings`; the draft edit-model is untouched)
- `POST /workflows/{id}/run` — manual/API trigger (body = trigger payload); `POST /workflows/hooks/{hook_token}` — inbound webhook trigger (unauthenticated route, secret-token-addressed, per-workflow)
- `GET /workflows/{id}/runs` · `GET /workflows/runs/{run_id}` — history + per-node detail; `GET /workflows/runs/{run_id}/stream` — SSE live events
- `GET /workflows/catalog` — the node palette: agents (live registry), integration actions, modules, logic/trigger/output node types
- `GET/POST /workflows/modules` · `GET/PUT/DELETE /workflows/modules/{id}` · `POST /workflows/modules/generate` (conversational generate/refine) · `POST /workflows/modules/{id}/test`
- `GET /workflows/catalog/search?q=&kinds=` — keyword-ranked search over the live capability catalog (palette + copilot shortlist; semantic backend arrives with BO‑22)
- `POST /workflows/{id}/copilot` — chat-to-build: returns `{reply, graph, created_modules, issues, problems}`; generated modules persist, the graph is client-applied
- Triggers ride the workflow document (`PUT /workflows/{id}` persists trigger bindings; publish activates them)

- `POST /workflows/{id}/disable` · `POST /workflows/{id}/enable` — take a workflow off its triggers / put it back on the version it already has (R2). Enable is not publish: when the auto-disable policy trips on a transient outage the graph is fine, and minting a version would be noise. 409 if the workflow was never published; idempotent when it is already live

All under `require_authenticated` + the `workflows` feature check; the hook route is the one deliberate exemption (token *is* the credential), rate-limited and audited. **Publish, rollback, disable, and enable additionally require the `workflows:publish` capability** (Q3, migration 133) — everything else in the list is open to any member holding the feature.

---

## 7. Foundation dependencies

Deferred to `FOUNDATION_BUILDOUT_CHECKLIST.md` per planning rules — not re-described here: **BO‑20** (durable event-bus consumer/job queue — event triggers at volume, retries, dead-letter), **BO‑1** (Action Broker write path — until then write-class nodes are approval-gated or draft-only), **BO‑7** (real sandbox — module runtime graduates into it), **BO‑14** (permission/risk enforcement — node risk annotations), **BO‑6** (migration framework), **BO‑5** (tracing/cost — per-node cost attribution beyond the activity feed), **BO‑22** (platform semantic-search service — the catalog search's future ranking backend; this app deliberately ships keyword-only until it lands).

## 8. Implementation phases

Aligned to RFC §9, resequenced so each slice ships value:

- **Slice 1 (this build):** migration 131 · gateway `routes/workflows/` + `workflows/` engine package (compiler → MAF `WorkflowBuilder`, handlers: trigger/agent/tool/condition/transform-module/set-variable/http/output) · module validator + restricted runner + conversational generator · manual + webhook + schedule triggers (croniter loop) · `/workflows` UI: gallery, editor (palette/canvas/inspector/console), Module Studio, run history · catalog endpoint · feature slug + nav.
- **Slice 2 (shipped):** event triggers via `/agent/webhook/{source}` + the ClickUp receiver's event-hook sink; approval node via `workflow_run_pauses` snapshots + the Action Broker approvals inbox, with cached-replay resume. Also landed: the publish-gate write-class check (`write_without_approval`) and F13 workflow-as-tool. Remaining: streaming from the raw MAF event stream (engine-level per-node events stream today).
- **Slice 3:** describe→generate→refine full-graph authoring; loops/parallel fan-out in the compiler; workflow-as-tool for the orchestrator; template gallery.
- **Slice 4 (post-BO‑20/BO‑7):** durable queued runs; sandboxed module execution; MCP exposure; retention policies.

## 9. Key design decisions

- **D1 — Workflows are data, not code.** DB-persisted config orchestrating code-authored agents. This is the ADR-028 reconciliation with the no-in-app-editor philosophy.
- **D2 — Compile to MAF Workflows; never hand-roll a scheduler.** One executor per node *type*; conditional edges for branching; the engine is a compile target (RFC §6/§8.1, validated by spike: conditional-edge routing + shared-state bridge run green on the pinned `agent_framework`).
- **D3 — Edit-model ≠ run-model.** React Flow JSON verbatim for editing; compiled serialized DAG per published version; runs pin versions.
- **D4 — Nodes never hold secrets.** Integration resolution happens server-side at execution; graph JSON is safe to export/share by construction.
- **D5 — Modules are pure transforms.** Import-free, I/O-free, time-boxed; everything bigger is a skill repo. The generator enforces this at authoring time, the validator at save time, the runner at run time.
- **D6 — APScheduler's `CronTrigger` as a parser inside a supervised asyncio loop** (the canonical gateway scheduler shape — no APScheduler *process*). Already in the dependency tree via ingestion; due ticks are CAS-claimed on `last_fired_at` so multiple workers can't double-fire, and downtime collapses to one catch-up fire. Revisit under BO‑20.
- **D7 — The catalog is served, not hard-coded.** The palette's agents/integrations/modules come from the same registries the runtime uses, so the builder can never offer a capability the platform doesn't actually have (G3).

## 10. Policy reconciliation

- **ADR-028** (new, `system_architecture.md`): visual workflow composition as DB-persisted configuration compiled to MAF Workflows — amends **ADR-014** (whose VS-Code-only rule now applies to *code* artifacts: agents, skills, app code) and supersedes the "no visual workflow canvas / no n8n-style second runtime" non-goal as written in `project_plan.md` §2 and **C-09**, which are updated to say what they always meant: **no second runtime engine, no in-app *code* authoring** — both preserved by this design.
- Root `AGENTS.md` constraint #1 and `ai-company-brain/AGENTS.md` non-negotiable #1 gain the same carve-out sentence; #6 ("MAF is the sole runtime — no n8n") is *strengthened* by this feature, not weakened: the graph runs *on MAF*.

## 11. Risks & open questions

- **Q1** — MAF Workflows API stability at the pinned version: spike passed (build/run/conditional edges/fan-out), but checkpoint-storage backends for pause/resume (F11) need their own spike before Slice 2.
- **Q2** — Engine placement: gateway package now; move into orchestrator process if agent-node fan-out or isolation demands it. Transport-free module boundary keeps the move cheap.
- **Q3 — RESOLVED (implemented).** Any `workflows`-granted member may draft, validate, Test-run, and duplicate; **publish, rollback, and disable require `workflows:publish`** (`acb_auth` capability; migration 133 seeds it to owner/admin/manager — `member`/`guest` drop to draft-and-test, and an admin can hand it back per-user with an override). The line is drawn at *arming*: a draft fires no triggers and its writes are still broker-held, while publishing starts webhooks/cron/events running it unattended. `/auth/me` now returns resolved `capabilities` so the editor greys out Publish with an explanation instead of surfacing a bare 403. Still worth validating against real usage: whether `manager` is the right default tier.
- **Q4** — Event-trigger volume before BO‑20: in-process runs are honest-but-lossy on restart; cap per-workflow concurrency and surface "missed while down" in run history, or hold F10 GA until BO‑20?
- **Q5** — Module review policy: is generator + validator + test-before-save enough, or should `ready` status require a second human (approver) before a module is usable in published workflows? **Sharpened by F14:** copilot-created modules save as `ready` immediately (provenance `auto_created: true` makes them auditable and filterable); if review-before-ready is adopted, the copilot path should queue them as `draft` and say so in its reply.
- **R1** — *Scope creep toward n8n*: the catalog makes it tempting to add generic SaaS nodes. Rule: a node exists only if the Integration Registry has the integration — the registry is the roadmap.
- **R2 — MITIGATED (implemented).** *Silent automation drift*: published workflows keep running while the business changes. All three mitigations are in: run-history visibility (F9 + the gallery's last-run dot), per-workflow `owner_email`, and a **disabled-on-repeated-failure policy** — `AUTO_DISABLE_AFTER` (5) consecutive failed runs from *unattended* triggers (`schedule`/`webhook`/`event`) flips the workflow to `disabled` with the reason recorded. Three narrowings keep it from firing on a working system: manual/api runs never count (a maker debugging must not take production down, and one agent passing bad arguments must not take it from everyone else); the streak is consecutive, derived from run history, so any success breaks it; and only runs after `health_since` count, which is why re-enabling sticks instead of re-disabling on the next failure. Notification is in-product — persisted reason on the card and an editor banner, a `workflows.auto_disabled` warning log, and a `disabled` event on the activity feed (/observability). Outward notification (email the owner) is an outward write and belongs on the Action Broker path, not in the run's `finally` block. **Open:** whether 5 is the right threshold under real webhook volume, and whether a high-volume workflow should get a per-workflow opt-out — dropping events is not obviously better than failing them, and today the policy chooses to stop.

## 12. Success criteria (v1)

1. A maker builds, tests, and publishes the reference workflow — *webhook lead → triage agent classifies → module cleans/normalizes → Zoho contact draft staged for approval → notification* — entirely in the UI, in under 30 minutes, with zero engineering support.
2. The same workflow fires correctly from all three v1 trigger kinds (manual, webhook, schedule) and its runs show per-node inputs/outputs in history.
3. A module generated in Module Studio from a plain-English description passes validation, runs against sample data, and is reused in a second workflow unchanged.
4. Every agent in the live registry and every integration action in the registry appears in the catalog with typed config — nothing hard-coded in the frontend.
5. No workflow can be published with an unresolved `{{ref}}`, a secret-shaped string in node config, or a write-class node without a Human-approval ancestor (`write_without_approval` — enforced at publish/validate/copilot; draft Test runs stay permissive since the runtime broker still holds any real write).
6. All engine/validator/generator logic is covered by unit tests that run without Docker; `uv run pytest tests/unit` green.
