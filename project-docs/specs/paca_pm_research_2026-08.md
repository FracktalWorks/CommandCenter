# Paca PM-platform research — what to adopt, adapt, and refuse (2026-08)

> ⚠️ **RESEARCH — REFERENCE-ONLY (2026-08-10 consolidation, D26).** No work dispatches from
> this document; owns no work by its own declaration. The active plan is `project-docs/work_plan.md` §2;
> the classification of record is `project-docs/INDEX.md`.


> **Product:** CommandCenter · **Concern:** research appendix for the native project-management
> app (WS-27) · **Created:** 2026-08-05 · **Status:** 🟢 research complete — **reference-only,
> owns no work and no status**; every adaptation verdict below is annealed into
> `specs/project_management_app.md`, which is the owning spec · **Owner:** vjvarada
>
> **Research provenance (2026-08-05):**
> - `Paca-AI/paca` @ master (v0.11.0) — **Apache-2.0: code may be copied with attribution**,
>   but the stack (Go/chi + sqlx, React/TanStack Start, Node/Socket.IO, OpenHands sandboxes)
>   does not survive translation into our Python/FastAPI + Next.js + MAF platform. We take
>   **design patterns and schema shapes, not code.** Facts below were verified against a
>   shallow clone of the actual tree, not the README.
> - ⚠️ Paca's own docs (`docs/architecture/repository-structure.md`) claim "Go + Gin"; the
>   API is actually **chi v5** (`services/api/internal/transport/http/router/router.go`).
>   And `docs/architecture/automation-workflows.md` documents a **dropped** v0.10 design
>   (migration `000027` `DROP TABLE … CASCADE`d it). Anyone re-deriving from Paca's docs
>   instead of its migrations will copy two things that no longer exist.

---

## 1. What Paca is, and why it maps onto us

Paca is a self-hosted project-management platform (Jira/ClickUp/Monday alternative) whose
central bet is that **AI agents are first-class project members** — assignable, mentionable,
permission-checked — not chatbots bolted on the side. Surfaces: `services/api` (Go/chi,
system of record), `services/realtime` (Socket.IO fan-out), `services/ai-agent`
(Python/FastAPI + OpenHands sandboxes), `apps/web`, `apps/mcp` (`@paca-ai/paca-mcp`),
`apps/acp-bridge` (local Claude Code / Codex / Gemini CLI bridge). Postgres + Valkey
(cache, pub/sub, and durable streams).

Why it maps onto CommandCenter: it is the same architectural species — an event-driven
platform where humans and agents share one store, one API, and one activity stream. Its
task/project data model, its automation graph, and its assignment→agent dispatch chain are
exactly the three things WS-27 needs. Its multi-service split is the part we **don't** need:
CommandCenter already owns realtime (AG-UI/SSE), agent runtime (MAF), and an automation app
(`/workflows`), so the adaptation is "absorb the data model and the patterns into the
existing platform", never "stand up sibling services".

## 2. Data model — the part to study hardest

Source of truth: `services/api/migrations/000001_init.sql` (695-line baseline) +
`docs/architecture/database-schema.md` (narrative + DBML). Migrations are embedded and
**re-run on every API boot**, so every statement is idempotent — same discipline as our
`infra/postgres/README.md` `02+` rule, independently converged.

### 2.1 Containers: no workspace, just projects

Paca is single-tenant per install; the top-level scope is `projects` (name, description,
`task_id_prefix`, `settings jsonb`, `is_public`, soft-delete). There is **no**
Space→Folder→List container zoo — ClickUp's is widely disliked and Paca deliberately has one
container. "Workspace" exists only as a computed aggregate endpoint. Departments don't exist
either; that concern is ours alone (we have `org_group`/Centers for it).

### 2.2 Hierarchy: one self-FK, types are semantics

**There is no epic/story/subtask table and no depth column.** `tasks.parent_task_id` is a
single adjacency-list self-FK (`ON DELETE SET NULL`) of arbitrary depth; "Epic" vs "Story"
vs "Subtask" is purely `task_type_id` semantics (types are per-project rows: name, icon,
color, `is_system`). Exactly two hard rules, both in `task_service.go`:

1. A task whose type is the system **Epic** type cannot have a parent (`ErrEpicCannotHaveParent`)
   — Epic is structurally the root level. `Subtask` was once a system type and was demoted
   to an ordinary editable type (`000012`) — the hierarchy needed no help from the type system.
2. `wouldCreateCycle()` — a depth-bounded (50) ancestor walk at write time. No closure table.

Human-readable IDs: `task_counters(project_id, last_value)` + `tasks.task_number`
`UNIQUE(project_id, task_number)` → `PACA-42`.

**Verdict: adopt wholesale.** This is the strongest single lesson: multi-level
department→project→subproject→task→subtask hierarchy needs exactly two self-FKs (one on
projects, one on tasks) plus types-as-data — not per-level tables.

### 2.3 Statuses, types, custom fields: rows, not enums

`task_statuses` are per-project rows — name, color, `position` (lane order), and a
**`category` CHECK** (`backlog|refinement|ready|todo|inprogress|done`) that carries the
machine-readable semantic while name/color/position stay free. `category='done'` is what
drives sprint completion and the `predecessor_done` automation trigger — no transition-chain
table. Partial unique `ON (project_id) WHERE is_default` guarantees one default. This is the
same shape our CRM already chose (D-CRM-2, `crm_deal_statuses.type`), independently.

Custom fields: `custom_field_definitions` (`field_key`, `field_type ∈
{text,number,date,select,multi_select,boolean,url}`, `options jsonb`) with values
denormalized into `tasks.custom_fields jsonb` keyed by `field_key`. Deleting a definition
does not clean task data — accepted cost.

Tags: a bare `jsonb` string array on tasks. No registry, no colors, no rename/merge —
**the weakest part of Paca's model**; don't copy it as-is.

### 2.4 Ordering: per-view fractional indexing, no rank column

**There is no position/rank column on `tasks`.** Ordering is per-view, in a side table:
`view_task_positions(view_id, task_id, position DOUBLE PRECISION, group_key,
UNIQUE(view_id, task_id))`. Fractional indexing on float64
(`docs/architecture/manual-sort-algorithm.md`): between → `(prev+next)/2`; append →
`(prev+MAX_SAFE_INTEGER)/2`; prepend → `next/2`. One row written per drag. Tasks with no
row sort to the bottom by `created_at`; the first drag into that zone bulk-materialises
positions for the group. `group_key` records the board column, so a cross-column drag is
one upsert. Renormalisation is documented and deliberately unimplemented (~52 halvings per
gap makes it moot).

**Verdict: adopt.** The same task can sit in the People-Center master board and in a
Sales-Center slice with *different manual orders* without the two views fighting over one
rank column — this is precisely the "slices per Center" requirement, solved structurally.

### 2.5 Members: one actor table for humans and agents

`project_members(project_id, user_id NULL, member_type 'human'|'agent', agent_id NULL,
project_role_id, deleted_at)` — and **`project_members.id` is the actor identity
everywhere**: assignee (`task_assignees` M:N), reporter, comment author, activity actor,
notification actor. Removing a member soft-deletes; re-adding **restores the same row**, so
actor FKs stay stable. An AI agent becomes assignable by getting a member row — zero
special-casing downstream.

**Verdict: adapt.** We don't need the member table (identity is `app_user` + `org_group`),
but the *principle* — assignee/actor is one vocabulary that admits both humans and agents —
maps directly onto our existing `email | agent:<name>` actor-string convention
(`crm_activities.created_by`, `pending_actions.actor`). Adopt the principle, not the table.

### 2.6 Activity spine: comments and system events are one table

`task_activities(task_id, actor_id NULL, activity_type, content jsonb, deleted_at)` —
`comment`, `task.updated` (with `{"changes":[{field,old,new}]}` powering **diff & revert**),
attachment/link events, `agent.session.started`, `automation.applied`. `actor_id` nil =
system. Activities are written **asynchronously** (handlers append to a Valkey stream; a
consumer writes the row). Same single-spine shape as our `crm_activities` (trycompai
lineage) — three tools have now converged on it.

### 2.7 The rest, briefly

Sprints (`planned|active|completed`, multiple active allowed); `task_links`
(`blocks|relates_to|duplicates`, `CHECK(source<>target)`); central `files` registry + thin
`task_attachments` join (S3/MinIO presigned upload); `notifications` keyed to recipient
user + actor member; `api_keys` (SHA-256 hash, `paca_` prefix, shown once). Checklists,
GitHub integration, BDD, and time tracking were all **migrated out of core into plugins** —
the growth path is subtraction.

## 3. Views and boards

One `sprint_views` table serves all interactions: `view_context ∈
{sprint,backlog,timeline}` × `view_type ∈ {table,board,roadmap,plugin}`, project-level when
`sprint_id IS NULL`. The `config` JSONB splits **presentation** (top level: `fields`,
`column_by`, `swimlanes`, `sort_by`, `field_sum`) from **query constraints**
(`config.filters`: sprint/status/assignee/type id arrays). One task-list endpoint
(`GET /projects/:pid/tasks`) serves every page; passing `view_id` enriches each task with
its `view_position`/`view_group_key`. Board columns come from `column_by` generically —
dragging into a column patches *whatever field the view groups by*, not hard-coded status.
Filters support **virtual group keys** ("every non-system type") expanded at query time so
stored views don't go stale when new types are created.

**Verdict: adopt the shape** (one view resource + one list endpoint + config JSONB), skip
sprint-context in v1 (sprints are a WS-27 non-goal).

## 4. Automation engine (v0.11) — trigger/condition/action graphs

Schema (`000027_add_automation_graph.sql`): `automations` (`draft|active|archived`) +
`automation_nodes(kind ∈ trigger|condition|action, type, config jsonb, pos_x, pos_y)` +
`automation_edges(source_handle NULL …)` + `automation_runs` + `automation_run_steps`
(per-node `input_snapshot`/`output_snapshot`/`error`) + at-most-once bookkeeping tables for
due-date and cron fires + hashed webhook tokens (`pacahk_` prefix, rotation revokes prior).
**One JSONB `config` per node** serves 9 trigger types + conditions + 3 actions + unbounded
plugin types with no wide null-column set.

- **9 triggers:** `status_changed`, `task_created`, `assignee_changed`, `priority_changed`,
  `tag_added`, `due_date_reached` (offset minutes, polled), `predecessor_done`
  (AND-join over watched tasks — **stateless**: re-derives every watched task's live status
  category, no persisted counter, so it's idempotent under at-least-once redelivery),
  `cron` (5-field UTC), `api_trigger` (inbound webhook).
- **Condition:** an N-branch switch — ordered branches, first-true-wins, reserved `else`
  handle; each branch is a **flat single comparison** (field × operator), no AND/OR nesting.
  A `validOperatorsByField` table rejects unimplemented combos at validation time instead of
  silently evaluating false at runtime.
- **3 actions:** `update_task` (merged five prior single-field actions into one multi-field
  patch — an explicit consolidation lesson), `trigger_ai_agent` (`{message, member_id}`),
  `call_api` (outbound HTTP; its stored headers are visible to project readers — a known,
  commented gap; don't reproduce it).
- **Task retargeting:** a condition or action can aim at `self | parent | children |
  blocks | is_blocked_by | relates_to | duplicates | other(id)`; multi-valued targets
  fan out (action per task; condition combines via all/any).
- **Execution** (`worker/automation_consumer.go`, 1602 lines): consumes the *ordinary*
  activity stream — the engine is "a sibling reader, not a special case wired into the HTTP
  handler". Maps field changes → candidate trigger types (zero candidates ⇒ cheap ack),
  re-fetches the authoritative task, walks the graph with a `visited` set, records a step
  row per node, and **mutates through the ordinary task service** so automation edits get
  identical validation and an `automation.applied` activity with nil actor. Every action
  checks "already in target state" before writing, which is what makes a crashed walk safe
  to retry.
- **Run history + dependency map:** `automation_runs`/`_run_steps` power a per-run trace
  panel; the dependency map is **derived** on read from active `predecessor_done` nodes,
  never separately maintained.

**Verdict: adapt into `/workflows`, never build a sibling.** CommandCenter already has a
graph automation app (WS-11: DB graphs compiled to MAF workflows, manual/webhook/cron
triggers, run console) and ADR-028/D6 makes `workflows_app.md` the single owner of the
engine. What Paca proves is the *binding*: task events feeding the trigger vocabulary,
task-mutation and dispatch-agent action nodes, per-step traces, and the stateless
AND-join/idempotency discipline. WS-27 emits task events into the existing
`event_hooks.emit_event → workflows/triggers.dispatch_event` path and contributes node
types; deeper engine uplifts (multi-branch switch, step snapshots, dependency map) are
recorded as `workflows_app.md` backlog, not duplicated.

**Written up 2026-08-06 → [`workflows_app.md`](workflows_app.md) §13.** This section's
findings now have a home that owns work: eight items **U1–U8**, each pairing the Paca design
above with that engine's *measured* current state and a done-when. Read §13, not this
section, when implementing — §13 also records the five Paca features **deliberately refused**
(`call_api`'s reader-visible headers, a sibling worker process, the WASM plugin runtime, a
second engine, and a per-fire bookkeeping table where our CAS on `last_fired_at` is already
better), so the refusals do not read as oversights to a later implementer.

## 5. Agent integration — the dispatch chain

The chain is fully event-driven; the HTTP handler never calls the agent runtime:

1. A human (or the automation engine) assigns a task → `task.assigned` appended to a
   durable stream with one payload shape for all sources (`extra` carries attribution like
   `automation_name`).
2. The notification consumer writes the in-app notification, and — **if the assignee is an
   agent member** — creates an `agent_conversations` row (`queued`) and appends a trigger
   (`{conversation_id, project_id, agent_id, task_id, trigger_type, message}`) to
   `paca:agent:triggers`. It also records an `agent.session.started` activity on the task,
   so the handoff is visible in the task timeline immediately.
3. `services/ai-agent` consumes with a semaphore-bounded worker, spins an OpenHands sandbox
   (or reuses a warm one for chat), and streams every conversation event both to a durable
   stream and to the realtime channel; events persist to `agent_conversation_events` with a
   DB-seeded event index so resumed turns can't collide.
4. **The agent updates the task through the ordinary MCP tools against the API** — API key +
   `X-Agent-ID` header, permission-checked as its own project member. The AI service never
   writes to Postgres directly (a stated "Boundary Rule").

Trigger types beyond assignment: `comment_mention` (@handle), `chat_message` (in-app
project chat, warm sandbox + heartbeat), `description_write` ("write with AI"),
`automation_message`. Controls (`stop|pause|heartbeat`) ride the same stream.

**ACP mode** (v0.10): an agent can instead be a developer-side CLI (Claude Code, Codex,
Gemini CLI) connected via `paca-acp-bridge` — an **outbound** WebSocket from the dev's own
checkout, authenticated by a `hello` frame token, with a server-side watchdog that fails the
conversation if no terminal status arrives. No code enters a cloud sandbox; the CLI uses its
own local credentials. Events persist through the same path, so the UI renders both sources
identically.

**Verdict: adopt the chain shape, map onto MAF.** Assignment-to-`agent:<name>` → event →
orchestrator dispatch → activity-visible session → agent writes back through the same
gateway API under its own identity (our `EffectiveAccess.intersect()` already narrows an
agent by the acting member — Paca has nothing this strong). The ACP bridge is prior art for
"hand a task to the owner's local Claude Code" and worth a later ticket, not v1.

## 6. MCP server — tool-design lessons

`@paca-ai/paca-mcp` (stdio, TS). Worth stealing regardless of transport:

- **Permission-filtered `ListTools`** — the tool list is computed from the caller's actual
  permissions, and single-project mode hard-rejects calls naming another project.
- **Collapse tools.** An earlier automation surface exposed 16 tools and confused calling
  agents; it was deliberately collapsed to 4 (`get/create/update/delete_automation`) taking
  rich nested payloads with **per-item outcomes** (one bad entry doesn't block siblings) and
  **lenient removes** (removing a missing thing is a no-op) so partial-failure retries are
  safe.
- **Internal UUIDs are never agent-facing** — nodes are addressed by task id, transitions by
  status id; the MCP layer resolves. The agent never needs a read round-trip to write.
- Agents write plain Markdown; the MCP layer converts to the store's block format.

## 7. Realtime and eventing

Valkey carries **two deliberately separate transports**: Pub/Sub (`paca.events`) for
immediate Socket.IO fan-out, and durable Streams (activities, assignments, agent triggers,
plugin events, automation triggers) for at-least-once work — realtime reads only the
former. Socket.IO rooms are per-project-per-domain (`project:<id>:tasks` etc.);
**permission is checked once at join**, never per message; an expired-token join
disconnects the socket to force a fresh reconnect. The realtime service verifies JWTs by
calling the API (one source of truth) and never persists raw tokens.

**Verdict: no new service.** Our equivalents exist (Redis streams + `event_hooks`, AG-UI/SSE,
BO-20 consumer). The lesson to keep is the **two-transport separation** and "nothing is
written synchronously that a consumer can write".

## 8. Plugin system (context only)

Backend plugins are WASM (wazero) with a capability manifest (`db:read:tasks`,
`events:subscribe:task.*`…), typed query builders instead of raw SQL, and per-plugin KV +
cache namespaces; frontends load via Module Federation; plugins can contribute automation
node types, MCP tools, and views. This is Paca's answer to the problem our App
Workshop/skills registry already answers differently — noted for awareness, **not** an
adoption target (ADR-028: no second runtime).

## 9. The architectural decisions worth carrying, in one table

| # | Paca decision | Verdict for WS-27 |
|---|---|---|
| 1 | Hierarchy = one `parent_task_id` self-FK + types-as-data; Epic-root + cycle-walk are the only rules | **Adopt** (plus a project self-FK for subprojects) |
| 2 | Statuses as per-project rows with a semantic `category` CHECK | **Adopt** (converges with D-CRM-2) |
| 3 | Per-view fractional-index ordering; no rank column on tasks | **Adopt** — it is what makes Center slices order-independent |
| 4 | One view resource + one task-list endpoint; presentation vs filters split in config JSONB | **Adopt** |
| 5 | Agents are ordinary members/actors; one actor vocabulary everywhere | **Adapt** onto `email \| agent:<name>` actor strings |
| 6 | Single activity spine; comments = activities; field-diff content enables revert | **Adopt** (converges with `crm_activities`) |
| 7 | Automation = trigger/condition/action graph over the ordinary event stream, mutating through the ordinary service, idempotent everywhere | **Adapt into `/workflows`** — bind, don't rebuild |
| 8 | Assignment→agent dispatch via events, session visible as a task activity, agent writes back through the same API under its own identity | **Adopt**, mapped onto MAF + Action Broker conventions |
| 9 | Stateless AND-join + "already in target state" checks + at-most-once fire tables | **Adopt** as the idempotency discipline for sync + automation |
| 10 | Config-as-JSONB for polymorphic nodes | **Adopt** where node/config polymorphism appears |
| 11 | MCP: few rich tools, per-item outcomes, lenient removes, no internal UUIDs | **Adopt** for the agent-facing tool surface |
| 12 | Two Valkey transports (pub/sub vs streams), permission-once-at-join rooms | Already have equivalents; keep the separation principle |
| 13 | Tags as a bare JSONB array | **Refuse** — weakest part of the model |
| 14 | Sibling services for realtime/agents; WASM plugin runtime; BlockNote docs | **Refuse** — CommandCenter already owns these concerns |

Everything above is annealed into `specs/project_management_app.md` (WS-27), which owns all
work, decisions, and status. This file is evidence, not a plan.
