# Workflows App — Project Plan (deterministic automation over the agent fleet)

> **Product:** CommandCenter · **Feature:** Workflows app (`/workflows`) · **Updated:** 2026-08-03 · **Version:** 0.3 · **verified against code on 2026-08-03**
> **Status:** 🔄 Slices 1+2 built — data model (migration 132) + gateway API + MAF compiler/engine + `/workflows` visual editor + Module Studio + **Workflow Copilot (F14)** + **keyword capability search (F15; semantic → BO‑22)** + **event triggers (F10)** + **approval node with pause/resume via the Action Broker inbox (F11)** + **workflows as agent tools (F13)** + **run-history drill-in (F9 complete: a history row replays its recorded node results onto the canvas)** + **F1/F6 complete (gallery search + duplicate/delete, version rollback via the status-badge popover)** + **F3's logic vocabulary complete (wait node — inline under a minute, durable pause above it; approval and wait now both in the catalog/palette)**. All five trigger kinds live: manual, api, webhook, schedule, event. Engine semantics are locked by a golden trajectory eval (`evals/trajectories/test_workflow_engine_trajectory.py`, CI-blocking); orphaned `running` rows are swept to `failed` at gateway startup (paused runs survive — resume rebuilds from the pause snapshot). **R2 is mitigated (migration 134):** a published workflow whose unattended runs fail `AUTO_DISABLE_AFTER` times consecutively disables itself with a recorded reason, and `POST /{id}/enable` is the one-click way back.
> **Slice 3 re-scoped 2026-08-03 (truth pass, §8.3).** The one-line Slice 3 asked for three things and **one of them is already shipped**: describe→generate→refine full-graph authoring landed as F14 (`39b1e17a`) and is **struck**. "Parallel fan-out" is also shipped (`engine/graph.py:17`; MAF's superstep scheduler routes it) — the unbuilt half is **fan-in/join**, restated as such. What genuinely remains is **fan-in/join (8.3b), loops (8.3c), and a template gallery (8.3a — nothing exists)**. Two owner decisions recorded the same day: Command Center is an **internal Fracktal tool** (§1.4) and **loops are approved** despite §11 R1 (§8.3c).
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
- **Not multi-tenant marketplace tooling.** Workflows are org-internal; sharing/templates beyond this org are Phase 4+. *(Clarification 2026-08-01: the org-internal template gallery is Slice 3 — this non-goal refers to cross-org marketplace sharing, not in-org templates.)*
- **No autonomous outward writes.** Same rule as everywhere else: write-class integration actions require the approval node / Action Broker disposition until BO‑1 lands fully.

**OWNER DECISION 2026-08-03 — Command Center is an internal Fracktal tool.** The team uses it; there are no external tenants and none are planned in this app's horizon. Scope is weighed accordingly: features whose only justification is *someone else's org* (template marketplaces, per-tenant template stores, sharing permissions on content) are out, and "one org, engineers in the room, ships with the code" is a legitimate answer to a storage or distribution question — see the §8.3a decision, which is decided on exactly that basis. This does **not** relax the platform contract (§3.2), the approval gates (G4), or capability checks (Q3): internal does not mean unguarded, it means un-multi-tenanted.

---

## 2. Feature set (prioritized)

Feature IDs `F1..F15`; Must/Should/Could is for v1 (phases in §8).

| ID | Feature | Priority | Notes |
|---|---|---|---|
| F1 | **Workflow list + CRUD** — gallery at `/workflows` with status (draft/published/disabled), search/filter, create/duplicate/delete | Must | Feature-gated (`workflows` slug), default-deny like all panes |
| F2 | **Visual editor** — three-pane canvas (palette · canvas · inspector) + run console; React Flow; nodes color-coded by category (RFC §5.2) | Must | The priority surface; mockup is the reference |
| F3a | **Typed tool arguments** — each integration action declares its parameters (`type[?][\|description]`); the inspector renders a field per argument, publish refuses a node missing a required one, and the runtime re-checks before dispatching | Must (shipped) | Parsed once server-side (`engine/tool_args.py`) and served pre-parsed, so the browser never re-implements the grammar. `{{refs}}` satisfy required checks and skip type checks — they resolve at run time. A raw-JSON escape hatch remains for arguments a form cannot express. Prior art: n8n's typed node parameters / Sim's `subBlocks` |
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
- **HITL** — approvals inbox + `workflow_run_pauses` snapshots; Action Broker disposition once BO‑1 wires the write path.
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

### 3.3a Trigger durability (what survives a restart, and what does not)

There is **no OS cron and no scheduler process**. A schedule is a `workflow_triggers` row (`config.cron`, `config.timezone`, `last_fired_at`); the *scanner* is one supervised asyncio loop in the gateway (30s). APScheduler's `CronTrigger` is used purely as an expression **parser** — importing a scheduler daemon would be the "second runtime" this design exists to avoid. Durability therefore comes from the row, not the loop: **the schedule is a database fact, the scanner is a stateless reader of it.**

| Situation | Behaviour |
|---|---|
| Gateway restarts while idle | Next scan re-reads triggers from the DB — nothing to recover |
| Gateway down across one or more ticks | `compute_due_fire` anchors on the most recent tick ≤ now → **one** catch-up fire, never a storm |
| A schedule that has never fired | **Armed, not fired**, on first sight (`_claim_baseline`): a cron says *when*, not *how far back*. This step is load-bearing, not defensive — the maths only looks forward, so without a baseline a new schedule produced no tick, never got a `last_fired_at`, and therefore never ran at all |
| Down > 366 days / absurdly stale | Re-armed from now; no attempt to replay a year |
| Several gateway workers or replicas | CAS on `last_fired_at` — exactly one worker wins each tick, clock skew included |
| The workflow is saved | `last_fired_at` is carried across the trigger rewrite for **unchanged** schedules; editing the cron or timezone deliberately re-arms |
| Tick due but the workflow is at its concurrency cap | Claimed ticks always leave a trace: a `cancelled` run row with the reason (`record_skipped_run`), never silence |
| Tick due but the published version is missing | Same — a `cancelled` run row saying to republish |
| Run in flight | Killed; the startup sweep marks it `failed` ("interrupted by a platform restart") |
| Run in an inline wait (≤60s) | Same as any in-flight run — failed and visible. This is the honest cost of the 60s inline cut-off |
| Run in a long wait (>60s) | **Survives** — durable pause with `resume_at`; the scanner resumes it |
| Run paused at an approval | **Survives** — the snapshot carries everything resume needs |
| Bad cron or unknown timezone | Rejected at save with a 422, never discovered at fire time |

Timezones are IANA wall clocks (`Asia/Kolkata`), not offsets, so a 9am schedule stays 9am across daylight-saving changes.

### 3.3b The inbound webhook URL

An external caller must be given the **gateway's own** origin (`public_api_base_url` + `/workflows/hooks/{token}`), which is what the editor now shows — the gateway names the URL rather than the browser assembling one from its own origin. The control-plane `/api` proxy parses and re-serialises JSON, which changes the bytes and makes any HMAC the sender computed unverifiable, and it drops non-JSON bodies entirely. `/api/workflows/hooks/[token]` exists as a raw-passthrough safety net for a URL someone copied off the control plane: it forwards the body byte-for-byte with the caller's own headers and attaches **no** platform credentials — the token in the path is the whole credential.

### 3.3 Trigger model

RFC §7 verbatim, plus one product rule: **all trigger kinds converge on one entrypoint** (`start_run`) that seeds `variables.trigger` with a typed payload and creates a `workflow_runs` row. Kinds: `manual`, `api`, `webhook` (per-workflow secret token URL), `schedule` (cron expression parsed by APScheduler's `CronTrigger` inside the gateway's supervised asyncio scan loop — **not croniter**, which is not a dependency of this repo; see §3.3a and D6), `event` (bindings against normalized ingestion events — the successor to `agent_registry.json.webhook_routes`). Durable queueing/backoff for high-volume event triggers is BO‑20's scope; v1 executes runs as supervised asyncio tasks in-process and says so honestly in run status.

### 3.4 Code modules — scope and the sandbox line

The v1 module runtime is **restricted-execution, not a sandbox**: AST-allowlisted (no imports, no attribute escapes, no dunder access), builtins-allowlisted, wall-clock-bounded, output-size-bounded, executed in-process. That is safe for its intended class — pure data transforms authored via the platform's own generator with human review — and is *documented as insufficient* for untrusted third-party code. Full process isolation is **BO‑7** (same gate as App Workshop T3); when it lands, module execution moves into it without API changes. Until then, module creation/editing is grantable separately from workflow authoring (`workflows.modules` vs `workflows`), and every saved module records its provenance (conversation, generator model, reviewer).

---

## 4. Data model

Migration `infra/postgres/132_workflows.sql` (next free number after `131_integration_memory_permissions.sql`). **Table names are plural** — corrected 2026-08-03 against `132_workflows.sql:27/45/56/70/94/107`, which is the authority; every singular form previously written here (`workflow`, `workflow_version`, `workflow_trigger`, `workflow_run`, `workflow_run_pause`, `workflow_module`) was wrong and would send a reader to a table that does not exist. The real set is `workflows`, `workflow_versions`, `workflow_triggers`, `workflow_runs` (whose per-node history is the `node_results` JSONB **column**, `:81` — not a table), `workflow_run_pauses` — plus one addition:

```
workflow_modules                 -- the org module library (Module Studio)
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

`workflows.graph` is React-Flow-native JSON persisted verbatim (edit-model); `workflow_versions.serialized` is the compiled flat DAG (run-model). Node schema and edge `sourceHandle` branching per RFC §4.

Migration `134_workflows_automation_health.sql` adds three columns to `workflows` for the R2 mitigation: `disabled_reason` / `disabled_at` (why it is off — written identically by a human hitting Disable and by the auto-disable policy) and `health_since` (the instant the failure streak is counted from; publish, rollback, and enable all stamp it). The streak itself is deliberately **not** a counter column — it is derived from `workflow_runs` on demand, so it can never drift from the history a human reads, and one success breaks it with no bookkeeping.

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

- **Slice 1 (this build):** migration 132 · gateway `routes/workflows/` + `workflows/` engine package (compiler → MAF `WorkflowBuilder`, handlers: trigger/agent/tool/condition/transform-module/set-variable/http/output) · module validator + restricted runner + conversational generator · manual + webhook + schedule triggers (APScheduler `CronTrigger` as an expression parser inside one supervised asyncio scan loop — **not croniter**; `scheduler.py:57-61`, dependency at `apps/services/gateway/pyproject.toml:37`) · `/workflows` UI: gallery, editor (palette/canvas/inspector/console), Module Studio, run history · catalog endpoint · feature slug + nav.
- **Slice 2 (shipped):** event triggers via `/agent/webhook/{source}` + the ClickUp receiver's event-hook sink; approval node via `workflow_run_pauses` snapshots + the Action Broker approvals inbox, with cached-replay resume. Also landed: the publish-gate write-class check (`write_without_approval`) and F13 workflow-as-tool. Remaining: streaming from the raw MAF event stream (engine-level per-node events stream today).
- **Slice 3:** three items — **8.3a templates**, **8.3b fan-in/join**, **8.3c loops**. Fully specified with per-item acceptance, gate labels and verification in **§8.3**; the old one-line version was 16 words and asked for one thing that already shipped. (Workflow-as-tool for the orchestrator shipped early — F13, Slice 2.)
- **Slice 4:** blocked. Named dependencies and the reason in **§8.4** — it is *not* "post-BO‑20" in the vague sense.

### 8.3 Slice 3 — specified (truth pass, verified against code 2026-08-03)

**What was struck.** *"Describe→generate→refine full-graph authoring"* is **DONE — delivered by F14 in commit `39b1e17a`** ("feat(workflows): Workflow Copilot + semantic capability search"). `POST /workflows/{id}/copilot` (`copilot.py:1-12`) emits the **FULL updated graph** — the system prompt says so literally at `copilot.py:51` (`"graph": {...} // FULL updated graph, or null if no change`) — with a named-issue repair round against the same validators publish uses, and auto-creates the modules the graph needs. §2 already records this twice (F12 *"Superseded by F14"*, F14 *"Must (shipped)"*). Dispatching it would have sent an implementer to rebuild a live endpoint. **Do not re-open it.**

**What "loops/parallel fan-out" actually meant.** **Fan-out already ships** — `engine/graph.py:17`: *"Fan-out from a node is allowed (parallel branches)"*, and `runner.py:7` records that MAF's superstep scheduler does the routing, fan-out and completion detection. The unbuilt halves are the two things the validator still rejects: **fan-in** (`graph.py:303-311`, `"a node may have only one incoming edge (v1)"`) and **cycles** (`graph.py:326-329`, comment *"loops arrive in a later slice"*). They are split into 8.3b and 8.3c because they are different problems with different risks.

**The acceptance standard for all three items — the F14 lesson, stated once.** F14's acceptance is **mechanical, not vibes**: the emitted graph must pass `validate_graph`, and generated module code must pass `validate_module_code` (`copilot.py:30-31` imports exactly those two). The LLM's output is judged by a deterministic validator, never by an eyeball. Every done-when below is written to the same standard — an assertion a test can make, on a validator or a status code, not a screenshot. **Corollary, and the specific failure mode to design against:** 8.3b and 8.3c both *relax a rejection that is currently pinned by a passing test*. A ticket that adds a join executor or a loop bound but leaves `test_fan_in_rejected_v1` / `test_cycle_rejected` asserting rejection closes **green while delivering nothing**. Each done-when therefore names the test that must **invert**.

**Verification (all three items, and never `tests/unit/` as a directory — the full directory hangs on Windows):**

```
uv run pytest tests/unit/test_workflows_engine.py tests/unit/test_workflows_slice2.py \
  tests/unit/test_workflows_trigger_reliability.py \
  evals/trajectories/test_workflow_engine_trajectory.py -q
```

Baseline on this branch, run 2026-08-03: **`4 failed, 69 passed, 2 warnings in 17.70s`** on Windows. ⚠️ **All four failures are the same known Windows-only defect and are green in CI** — `engine/modules.py:296` passes `preexec_fn=_limit_resources` to the module subprocess, and CPython raises `ValueError: preexec_fn is not supported on Windows platforms`, so every test whose graph contains a **module node** fails locally: `test_workflows_engine.py::test_module_node_runs_generated_code` plus, in the golden eval, `test_high_priority_run_pauses_at_the_gate`, `test_resume_replays_without_repeating_side_effects` and `test_tool_failure_surfaces_the_node_and_skips_downstream`. CI runs `tests/unit/` on `ubuntu-latest` (`pr-check.yml:84,101`) and `evals/trajectories/` on `ubuntu-latest` (`skill-eval.yml:29,47`, triggered by the `apps/services/gateway/gateway/routes/workflows/**` path filter), where `preexec_fn` is supported. **Do not report these four as a regression, and do not "fix" them by removing the rlimits.** On Windows the honest local signal is **69 passed / 4 known-Windows-fail** (73 in CI); a fifth failure is yours.

#### 8.3a — Template gallery ✅ **AGENT-SAFE**

**State: nothing exists.** No `workflow_template` table in migrations `132`/`133`/`134`, and zero `template` matches under `workbench/control_plane/src/app/workflows/`. This is a greenfield item, unlike the rest of Slice 3.

**DECISION (agent-proposed, owner may overrule) — templates are repo JSON fixtures, not a DB table.** A template ships as a versioned file in the gateway route package (proposed home: `apps/services/gateway/gateway/routes/workflows/templates/<slug>.json` + a `templates.py` loader beside `catalog.py`, which is the module that already answers "what can the palette offer"). Rationale, resting directly on the 2026-08-03 owner decision in §1.4: templates are **product content that ships with the code**, not user data. Fixtures are reviewed in the PR that adds them, cannot drift between dev and prod, need no migration, no seeding path and no admin CRUD screen. A table would need all four — plus a migration whose number must be found by listing `infra/postgres/` at build time, never written in advance — to buy one capability nobody has asked for: **in-app "save as template" authoring**, which is also the direction §1.4 rules out as marketplace tooling. *Accepted cost, stated plainly:* adding a template is an engineer's PR, not a maker's button. If the owner wants maker-authored templates, this decision inverts and the table comes back — but then the ticket is a different, larger ticket and should be re-scoped, not stretched.

**DECISION (agent-proposed, owner may overrule) — instantiation is a body field on `POST /workflows`, not a new route.** `WorkflowCreate` (`crud.py:35-37`) today carries only `name` + `description`; the field is `template: str | None = None`. The seam already exists: `duplicate_workflow` (`crud.py:141-202`) is *exactly* "insert a new draft carrying a graph + variables + triggers, regenerating the hook token because it is a credential" — instantiating a template is duplicating from a fixture instead of from a row. A third near-identical INSERT under a new route would be a parallel seam for no gain. Same rule applies: **the hook token is regenerated, never carried in a fixture** — a template file must not contain one, and the loader should refuse a fixture that does.

**Done when:**
1. `POST /workflows` with `{"name": "...", "template": "lead-intake"}` returns **201** with a graph that `validate_graph` accepts with **zero issues**, and `POST /workflows/{id}/publish` on that new workflow **succeeds**.
2. An unknown `template` slug returns **422** naming the slug (not a 500, not a silent empty draft).
3. `POST /workflows` **without** `template` behaves byte-identically to today (the field is additive and optional) — pinned, because `create_workflow` currently has **no covering test at all**.
4. Every shipped fixture passes `validate_graph` in a parametrized test that walks the templates directory — so a broken template is caught at CI time, not at maker time. A fixture containing a `hook_token` fails the same test.
5. All of the above pinned in a new **`tests/unit/test_workflows_templates.py`**.

**Template *content* is an owner input, not an implementer's guess.** Which Fracktal processes deserve a starter graph is a business question; the engineer can ship the mechanism against one throwaway fixture and the real set lands after. ⚠️ **A report/weekly-digest template is NOT this row's artifact** — `work_plan.md` §4 assigns digest workflows to **WS-15** (where they double as this spec's G1 launch metric). Building one here duplicates WS-15's deliverable under a second owner; leave it to WS-15 and consume it.

#### 8.3b — Fan-in / join ✅ **AGENT-SAFE**

**Prescribe the state-bus semantics before an agent touches the compiler.** The engine's shared state bus keys **one slot per node**: `state[node_id] = output` (`runner.py:135` on replay, `:179` on live execution), and `node_results[node_id]` is likewise a single slot that becomes the run's persisted per-node history (`workflow_runs.node_results`, `132_workflows.sql:81`). The message routed along edges, `_Token` (`runner.py:55-59`), carries **only** `branch: str | None` — data never travels on the edge, only the permission to proceed. And the compiler adds one MAF edge per connection (`_build_maf_workflow`, `runner.py:236-246`). Consequence, and the reason this is not a one-line validator change: **wire two edges into one node today and MAF delivers two messages, so the executor body runs twice** — the second pass overwrites both `state[node_id]` and `node_results[node_id]`, and the run history silently shows only the last pass. A join therefore needs a *defined merge shape*, not a relaxed check.

The merge shape must be recorded in the spec (here) before implementation, and must answer all three of:
- **Where merged inputs live.** Proposed: the join node's own slot holds a dict keyed by **incoming source node id** — `state[join_id] = {src_a: out_a, src_b: out_b}` — so existing `{{join.src_a.field}}` reference resolution keeps working unchanged and nothing about `templating.py` has to learn a new shape. (Ordered-list-by-edge is the rejected alternative: edge order is not stable in the edit-model, so refs would silently re-bind when a maker re-draws an edge.)
- **Quorum.** *Which* branches must arrive. "All incoming edges" is **wrong on its face** — a condition sends down exactly one of `true`/`false` (`_branch_condition`, `runner.py:241-244`), so a join downstream of a condition would wait forever on an edge that is structurally dead for that run. The rule must be expressed in terms of branches that can still arrive, and the deadlock case must be a **named run failure with the waiting node id**, never a hang to `RUN_TIMEOUT_SECS`.
- **Interaction with pause/replay.** `_mark_unrun` currently marks never-run nodes `pending` while paused and `skipped` on a finished run (`runner.py:200-202`). A half-arrived join is neither; the resume path (`precomputed`, `runner.py:133-139`) must be able to rebuild a partial merge from the pause snapshot, or approval-under-a-join must be explicitly refused at publish.

**Done when:**
1. **`test_fan_in_rejected_v1` (`tests/unit/test_workflows_engine.py:155`) inverts** — the graph it feeds now validates, and the `fan_in` `GraphIssue` (`graph.py:303-311`) is either deleted or narrowed to the shapes still refused. *An un-inverted pinned test is how this ticket closes green while doing nothing.*
2. A two-branch fan-out→join graph executes and `state[join_id]` contains **both** branch outputs under their source node ids; `node_results` records the join **once**, not twice.
3. A join whose second branch is unreachable (condition false) resolves per the quorum rule and does **not** hang — asserted against a bounded `run_timeout`, so a regression fails fast rather than sleeping 15 minutes.
4. A join that can never satisfy quorum fails the **publish gate** with a named issue, not at run time.
5. The golden eval (`evals/trajectories/test_workflow_engine_trajectory.py`) gains a fan-out→join trajectory; the six existing trajectories stay green unchanged.

#### 8.3c — Loops ✅ **AGENT-SAFE** · **APPROVED BY THE OWNER 2026-08-03**

**Owner decision, recorded against §11 R1.** §11's standing risk R1 warns against *"scope creep toward n8n"*. **The owner has explicitly decided that loops are worth the engine complexity** — real automations iterate ("for each row in this sheet…", "retry until the CRM accepts it"), and an automation platform that cannot iterate pushes makers back to the toil quadrant §1.2 exists to close. **R1 is not a blocker on this item and must not be cited as one.** R1 keeps its original and unchanged meaning: *a node exists only if the Integration Registry has the integration* — it governs the **node catalog**, not the **control-flow vocabulary**. This is a deliberate call, dated, not drift.

**The cost the owner accepted, stated honestly.** Today the engine's simplicity *is* its correctness argument: a DAG with one slot per node terminates by construction, and MAF's completion detection needs no help. Loops give that up. The run model acquires iteration state, run history acquires cardinality, `RUN_TIMEOUT_SECS` stops being the only bound that matters, and the graph validator loses "no cycles" as a cheap universal safety net — every later engine change must now reason about non-terminating graphs. That is real, permanent complexity in the one subsystem that is CI-locked by a golden eval, and it was accepted with open eyes.

**What must be designed, not discovered:**
- **Iteration state.** `state[node_id]` is a single slot overwritten on every pass (`runner.py:179`), and so is `node_results[node_id]` — which *is* the run history a human reads (`132_workflows.sql:81`). Unmodified, a 50-pass loop persists one pass and silently discards 49. The model must say what a node's slot means inside a loop (current pass? accumulated list?), what `{{node.field}}` resolves to for a node inside vs outside the loop body, and what run history records per pass. This is the load-bearing decision of the item.
- **A max-iteration bound.** Mandatory, a **literal in code**, enforced by the engine (not only by the wall clock), and exceeded ⇒ a **named run failure**, not a timeout. Whether it is also per-workflow configurable is secondary; the unconditional ceiling is not.
- **`foreach`-over-a-list vs true cyclic edges — DECISION required, and the two docs currently disagree.** The parent RFC §6 promises MAF handles cycles; `graph.py:326-329` forbids them outright. Both cannot stand. A `foreach` **body-scoped node** (bounded by the list, no cycle in the graph, `validate_graph`'s cycle check survives untouched, the golden eval's termination argument survives) is the smaller change and covers the "for each row" case that motivates the feature; true cyclic edges additionally cover "retry until", at the cost of the validator's cycle rejection and of every termination guarantee resting on the iteration bound alone. **Whichever is chosen, record it here with its rejected alternative before writing code** — and reconcile the RFC §6 sentence in the same change, because leaving it is how the next auditor finds a fourteenth contradiction.

**Done when:**
1. **`test_cycle_rejected` (`tests/unit/test_workflows_engine.py:148`) inverts** for the shape the chosen design admits, and stays red for the shapes still refused. *Same trap as 8.3b: leave it asserting rejection and the ticket closes green having built nothing.*
2. A loop over an N-element list executes the body **exactly N times**, and the run's `node_results` accounts for **all N passes** (not one) in whatever shape the iteration-state model prescribes.
3. Exceeding the max-iteration bound produces a **named** failure (the message identifies the loop node and the bound) — asserted, not inferred from a timeout.
4. Publish refuses an unbounded / non-terminating loop shape with a named `GraphIssue`, so the failure lands at design time.
5. **The golden eval gains a bounded-loop trajectory** — the eval is the engine's semantic lock (`skill-eval.yml`'s path filter fires it on every `routes/workflows/**` edit, blocking, on `ubuntu-latest`), and after this item it is the *only* CI artifact asserting that a workflow with a cycle still terminates. Without that trajectory the termination guarantee is untested; the six existing trajectories must stay green unchanged, proving loops cost nothing on the loop-free path.

### 8.4 Slice 4 — durable queued runs; sandboxed module execution; MCP exposure; retention policies. **BLOCKED — do not absorb any of it into Slice 3.**

Gate labels: the build work is ✅ **AGENT-SAFE**, but Slice 4 cannot be *activated* by an agent — 🔴 **OWNER-GATE** on the `INGESTION_CONSUMER=1` flip (registered in `work_plan.md` §6) that the durable path rides.

The old anchor read "post-BO‑20/BO‑7", which is too vague to sequence against. Precisely, Slice 4 needs:

- **BO‑20b slice 2 → BO‑20c → (BO‑20d, BO‑20e)** — retry via PEL reclaim + an honest `XACK` + DLQ hand-off, a drainable/visible DLQ, per-source rate limiting, bounded concurrency. BO‑20a (the drain loop) and BO‑20f (Gmail/Zoho receiver parity) are built; **BO‑20b slice 1 (the `emit_event` strict mode) is built**; slice 2 and c–e are open. Until BO‑20b lands, **a failed dispatch is `XACK`ed and lost** — BO‑20a's deliberate interim. "Durable queued runs" on that substrate would be a lie in the status field.
- **The consumer is inert everywhere.** `INGESTION_CONSUMER` is unset in every environment, so the drain loop never starts and the receivers still emit inline. Flipping it is an owner gate and is not merely "start a loop": the same flag cuts all three provider receivers over to enqueue-only, so **Redis down = provider events dropped**.
- **BO‑7** — still ☐ (`FOUNDATION_BUILDOUT_CHECKLIST.md:110`). Sandboxed module execution graduates into it; §3.4's restricted-execution runtime is documented as insufficient for untrusted code until then.

Anything in Slice 4 that looks reachable today is reachable only because its dependency is being skipped.

## 9. Key design decisions

- **D1 — Workflows are data, not code.** DB-persisted config orchestrating code-authored agents. This is the ADR-028 reconciliation with the no-in-app-editor philosophy.
- **D2 — Compile to MAF Workflows; never hand-roll a scheduler.** One executor per node *type*; conditional edges for branching; the engine is a compile target (RFC §6/§8.1, validated by spike: conditional-edge routing + shared-state bridge run green on the pinned `agent_framework`).
- **D3 — Edit-model ≠ run-model.** React Flow JSON verbatim for editing; compiled serialized DAG per published version; runs pin versions.
- **D4 — Nodes never hold secrets.** Integration resolution happens server-side at execution; graph JSON is safe to export/share by construction.
- **D5 — Modules are pure transforms.** Import-free, I/O-free, time-boxed; everything bigger is a skill repo. The generator enforces this at authoring time, the validator at save time, the runner at run time.
- **D6 — APScheduler's `CronTrigger` as a parser inside a supervised asyncio loop** (the canonical gateway scheduler shape — no APScheduler *process*). Already in the dependency tree via ingestion; due ticks are CAS-claimed on `last_fired_at` so multiple workers can't double-fire, and downtime collapses to one catch-up fire. Revisit under BO‑20 — **still correct and still unspent as of 2026-08-03**: `scheduler.py:57-61` imports `apscheduler.triggers.cron.CronTrigger` inside `compute_due_fire()` purely as an expression parser, and the one supervised `_scheduler_loop()` (`:270-284`) drives it via `_scan_once()`. The dependency is declared for exactly that and says so: `apps/services/gateway/pyproject.toml:35-37`.
  **The house style now has two independent subsystems.** BO‑20a's ingestion drain (`apps/services/ingestion/ingestion/consumer.py`) shipped the identical shape — a supervised asyncio loop in the gateway lifespan rather than a scheduler/worker *process* — which strengthens D6 rather than dating it. **D6 needs no edit.**
  ⚠️ **ID collision, flagged not resolved:** `work_plan.md` §3 also defines a **D6** — *"The Workflows app won"* (which names this spec as the winner over `multi_agent_orchestration.md` Phases 2–3). Two different live D6s are reachable from this row, so "D6" is ambiguous in any cross-doc sentence. Same class of defect `work_plan.md` §2 **R2** forbids for phase IDs (no ID reuse across docs), applied to decision IDs. Renaming either is a cross-doc edit that touches `work_plan.md` and is **not** in this spec's gift; until an owner picks, always qualify — *"D6 (`workflows_app.md` §9)"* vs *"D6 (`work_plan.md` §3)"*.
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
- **R1** — *Scope creep toward n8n*: the catalog makes it tempting to add generic SaaS nodes. Rule: a node exists only if the Integration Registry has the integration — the registry is the roadmap. **Scope clarified by owner decision 2026-08-03 (§8.3c): R1 governs the node *catalog*, not the control-flow *vocabulary*.** Loops are approved and R1 is not a blocker on them; the engine-complexity cost was stated and accepted in §8.3c. R1 continues to bind unchanged everywhere else — a generic-SaaS node with no registry entry is still refused.
- **R2 — MITIGATED (implemented).** *Silent automation drift*: published workflows keep running while the business changes. All three mitigations are in: run-history visibility (F9 + the gallery's last-run dot), per-workflow `owner_email`, and a **disabled-on-repeated-failure policy** — `AUTO_DISABLE_AFTER` (5) consecutive failed runs from *unattended* triggers (`schedule`/`webhook`/`event`) flips the workflow to `disabled` with the reason recorded. Three narrowings keep it from firing on a working system: manual/api runs never count (a maker debugging must not take production down, and one agent passing bad arguments must not take it from everyone else); the streak is consecutive, derived from run history, so any success breaks it; and only runs after `health_since` count, which is why re-enabling sticks instead of re-disabling on the next failure. Notification is in-product — persisted reason on the card and an editor banner, a `workflows.auto_disabled` warning log, and a `disabled` event on the activity feed (/observability). Outward notification (email the owner) is an outward write and belongs on the Action Broker path, not in the run's `finally` block. **Open:** whether 5 is the right threshold under real webhook volume, and whether a high-volume workflow should get a per-workflow opt-out — dropping events is not obviously better than failing them, and today the policy chooses to stop.

## 12. Success criteria (v1)

1. A maker builds, tests, and publishes the reference workflow — *webhook lead → triage agent classifies → module cleans/normalizes → Zoho contact draft staged for approval → notification* — entirely in the UI, in under 30 minutes, with zero engineering support.
2. The same workflow fires correctly from all three v1 trigger kinds (manual, webhook, schedule) and its runs show per-node inputs/outputs in history.
3. A module generated in Module Studio from a plain-English description passes validation, runs against sample data, and is reused in a second workflow unchanged.
4. Every agent in the live registry and every integration action in the registry appears in the catalog with typed config — nothing hard-coded in the frontend.
5. No workflow can be published with an unresolved `{{ref}}`, a secret-shaped string in node config, or a write-class node without a Human-approval ancestor (`write_without_approval` — enforced at publish/validate/copilot; draft Test runs stay permissive since the runtime broker still holds any real write).
6. All engine/validator/generator logic is covered by unit tests that run without Docker. **Verification is the named four-file command, never `tests/unit/` as a directory** (the whole directory hangs on a Windows dev box and is not a usable signal):

   ```
   uv run pytest tests/unit/test_workflows_engine.py tests/unit/test_workflows_slice2.py \
     tests/unit/test_workflows_trigger_reliability.py \
     evals/trajectories/test_workflow_engine_trajectory.py -q
   ```

   Green means **73 passed** in CI (`ubuntu-latest`). On Windows the honest expectation is **69 passed / 4 failed**, all four being the `preexec_fn` module-sandbox defect catalogued in §8.3 — see that section before reporting a regression. Items 1–5 above are Slice-1/2 criteria and are met; Slice 3's criteria are per-item in §8.3a/b/c, not here.
