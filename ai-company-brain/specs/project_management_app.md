# Projects App — Master Plan (native project management; ClickUp retirement path)

> **Product:** CommandCenter · **Feature:** Projects (the People Center's primary work-management
> module, sliced into every other Center) · **Created:** 2026-08-05 · **Updated:** 2026-08-06
> (owner pass — §8's three open questions are answered as **D-PM-8/9/10**; §7.1 gains the
> Space→Center mapping step and WS-27b's done-whens grew with it) ·
> **Status:** 🟢 **WS-27a + WS-27b BUILT** (2026-08-06, branch
> `claude/paca-research-task-management-a1f6zd`, PR #367) — migration `146_projects.sql`
> (§3.1–§3.10), `feature:projects` registered on both sides, the `routes/projects/` API (§4
> minus `sync.py`) live behind the feature gate on the `gateway/db.py` seam, and the ClickUp
> importer with its Space→Center mapping plan (§7.1). **Not deployed and never run** — the
> migration has not been applied anywhere and neither import endpoint has been executed
> against the live tenant. · **WS-27c–g: 🟡 SPEC, nothing built.** ·
> **Owner:** vjvarada · **Board row: WS-27**
>
> **Verified 2026-08-06:** 140 hermetic cases across
> `test_projects_{routes,grants,migration,import_mapping}.py` (no DB, no ClickUp, no LLM),
> plus the unchanged org-access and CRM fences — 298 passed on the combined set.
> **Nine mutants measured red and reverted byte-identical:** WS-27a's five (unscoped
> visibility clause, dropped assignee escape, transition skipping its activity,
> `completed_at` never cleared on reopen, removed Epic-root rule) and WS-27b's four
> (applying the suggestion instead of the confirmed mapping, refusing to import an unmapped
> Space, a plan that writes, and a re-import that duplicates).
>
> **Not built, on purpose:** no UI (WS-27d), no sync (WS-27c — blocked on BO-1a/BO-1b), and
> `schema.generated.sql` was NOT regenerated — it needs a migrated live DB and is stale
> repo-wide, so it stays an owner-run chore (the WS-26a precedent).
>
> **Not in WS-27a, on purpose:** sprints, custom fields, time tracking, a docs/wiki surface,
> and the ACP-style "hand a task to the owner's local coding CLI" — all recorded as non-goals
> or later phases in §1, so their absence is a decision, not an omission.
>
> **Research provenance (2026-08-05):**
> - `Paca-AI/paca` @ master (v0.11.0) — **Apache-2.0: patterns adopted, no code translated**
>   (stack mismatch). Full findings + adopt/adapt/refuse verdicts:
>   `specs/paca_pm_research_2026-08.md` (reference-only; this spec owns all work).
> - CommandCenter full-tree sweep — every ClickUp touchpoint, `gtd_*` anchor, and Centers
>   convention cited below was verified in-tree on the date above.

---

## 1. Product vision and scope

**Who this is for:** all of Fracktal Works. Today the company's work lives in ClickUp
(departments as Spaces, projects as Folders/Lists, tasks/subtasks) and CommandCenter's
`/tasks` app is a *personal* GTD lens over it. This spec adds the missing middle: a native,
org-level project-management system — **departments → projects → subprojects → tasks →
subtasks**, ClickUp/Paca-grade — that lives in the People Center and projects scoped slices
into every other Center.

**What it replaces:** ClickUp. Today ClickUp is the system of record (root `AGENTS.md`
constraint 8) and CommandCenter holds two mirrors of it (§2). The native Projects app
inverts that in stages: **first two-way coexistence sync, then CommandCenter becomes the
system of record, then ClickUp is retired.** The inversion is deliberate and staged in §7 —
a reviewer should read it as the same import-and-retire move WS-26 made for Zoho, with the
extra middle phase two-way sync demands.

**What "done" means (end state, WS-27g):**
1. Departments, projects, subprojects, tasks, and subtasks live in `pm_*` tables with a
   working UI (project tree + list + board + task panel + activity timeline) at `/projects`.
2. The People Center shows the whole portfolio; every other Center sees exactly the
   projects granted to its `org_group` — **(app + scope) projections per
   `department_centers.md` §1 rule 2, never forks.**
3. Every member's personal `/tasks` app surfaces the `pm_tasks` assigned to them, with
   their GTD overlay intact (§6.1) — the org board and the personal system are two lenses
   on one fact.
4. Task events drive the existing `/workflows` automation app, and assigning a task to
   `agent:<name>` dispatches a real agent run whose progress is visible on the task (§6.3,
   §6.4).
5. All ClickUp data is imported with provenance (`clickup_id`), counts verified; the sync,
   both ClickUp code paths, their webhook, cron, and credentials are retired (§7.4).

**Non-goals (v1 — record departures here per `user_management_contract.md` §7):**
- **Sprints.** Paca has them; we don't run Scrum. The schema leaves room (nothing blocks a
  later `pm_sprints` + a `sprint` view context); no table now.
- **Custom fields.** Paca's `field_key`→JSONB pattern is the recorded additive path; v1
  fields live in the schema.
- **Tags as a first-class registry.** v1 is `tags TEXT[]` on tasks (searchable, no colors);
  Paca's bare-JSONB tags are its weakest area and a registry is additive later.
- **Time tracking, docs/wiki, dashboards-in-app.** Notes and the Center dashboards
  (WS-15) own those concerns; the Projects app binds, never rebuilds (§6).
- **A second automation engine.** ADR-028/D6: `/workflows` is the only engine; WS-27
  contributes events and node types to it (§6.3).
- **A second realtime stack.** The Control Plane's existing polling/SSE conventions apply;
  no Socket.IO sibling.
- **ClickUp *feature* parity.** Whiteboards, chat, goals, forms — out. The retirement bar
  is "our work-management needs", not "ClickUp's feature list".

---

## 2. Current state — the two ClickUp systems and the personal store, measured 2026-08-05

**ClickUp integration exists twice, independently, and neither is an org-level PM store.**

| What | Where |
|---|---|
| **System A — Phase-0 graph mirror** (read-only, shallow: comments/subtasks/custom fields ignored) | `apps/services/ingestion/ingestion/sources/clickup/{client,normaliser,webhook}.py` → `task`/`project`/`person` rows in `acb_graph` (`infra/postgres/01_schema.sql`). Webhook HMAC-verified, fail-closed; `taskDeleted` logged and skipped. Consumers: `orchestrator/sales_views.py`, `scripts/reconciler.py`, `acb_graph/resolver.py` |
| **System B — per-user Tasks-app connector** | `gateway/routes/tasks/providers.py` — `BaseTaskProvider` + `ClickUpProvider`; `task_accounts` (per-user, encrypted creds, `schema_cache`, `last_delta_token`); pull via `POST /tasks/sync`; push via `_broker_gate` |
| Personal store the connector fills | `gtd_projects` + `gtd_items` (`source 'LOCAL'\|'SYNCED'`, `provider_task_id`, `sync_state`, GTD overlay never clobbered on re-sync) — `infra/postgres/48_task_manager_gtd.sql` + ~20 extensions (59 subtasks, 60 spaces/folders, 91 assignees…) |
| The `/tasks` app over it | `gateway/routes/tasks/` — 21 modules, ~11.8k lines, ~68 endpoints behind `require_feature_router("tasks")`; **27 `user_id = :` predicates in `items.py`** (owner-scoped by design) |
| People substrate | `gtd_people` (+ resumes, `capability_embedding vector(1536)`); WS-24 N4: directory open, HR fields restricted |
| Centers scaffold | `lib/centers.ts` (People Center's five sub-apps all `status:"planned"`), `140_center_features.sql` + `141_seed_center_groups.sql`, `center.people` in `FEATURES` — **Centers gate navigation, not data** (migration 140's own header) |
| Broker chokepoint for ClickUp writes | `providers.py::_broker_gate` → `broker_handlers._WRITERS` (4 handlers for 6 gated actions — **BO-1a**); `_push_pending_item` ignores the pending marker (**BO-1b**) |

Consequences that shape this plan:
- **There is no org-level native store to extend in place.** `gtd_*` is per-user by
  construction (the 27 predicates are the measurement); an org PM store has opposite
  visibility semantics. That is the D-PM-1 question (§8).
- **A ClickUp write path already exists and already goes through the broker** — unlike
  WS-26, which faced a read-only mirror. Two-way sync therefore inherits **BO-1a and BO-1b
  as named prerequisites** (§9 WS-27c), not discoveries.
- **The two ClickUp systems retire on different schedules**: System B's ClickUp arm goes
  when personal mirroring repoints to `pm_*`; System A goes at WS-27g when the graph-mirror
  consumers repoint (the §6 repoint D-CRM-1 already owes has the same shape here).

---

## 3. Data model

All tables in one migration at the **next free number at build time** (R1 — resolve from
`infra/postgres/`, never from a spec). Idempotent per `infra/postgres/README.md`:
`CREATE TABLE IF NOT EXISTS`, `INSERT … ON CONFLICT DO NOTHING`, guarded `DO $$`. PKs
`UUID DEFAULT gen_random_uuid()`, timestamps `TIMESTAMPTZ DEFAULT now()`, indexes
`idx_<table>_<cols>`, new-status columns as CHECKs. `schema.generated.sql` is **not**
regenerated (owner-run chore, per the WS-26a precedent).

The spine is Paca's shape — two self-FKs for the whole hierarchy, statuses/types as data,
per-view fractional ordering, one activity spine — with CommandCenter's provenance columns
(`source`, `clickup_id`) and actor strings (`email` or `agent:<name>`).

### 3.1 `pm_projects` — departments, projects, and subprojects are one table
`id` · `name TEXT NOT NULL` · `description TEXT` · `parent_project_id UUID REFERENCES
pm_projects(id) ON DELETE CASCADE` (NULL = root; arbitrary depth, cycle-checked in code) ·
`task_prefix TEXT` (root projects only — human ids like `RND-42`) · `status TEXT NOT NULL
DEFAULT 'active' CHECK (status IN ('active','on_hold','done','archived'))` · `lead TEXT`
(email or `agent:<name>` — assignment, not ACL) · `position DOUBLE PRECISION` (sibling
order in the tree) · `source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN
('manual','import','agent'))` · `clickup_id TEXT UNIQUE` · `clickup_kind TEXT CHECK
(clickup_kind IN ('space','folder','list'))` (a Space, Folder, or List may each become a
project — the importer flattens ClickUp's container zoo into this one self-FK, §7.1) ·
`created_by TEXT NOT NULL` · `created_at` · `updated_at` · `archived_at TIMESTAMPTZ`.
Index: `parent_project_id`, `status`, `clickup_id`.

**A department is a root `pm_project` whose grant row names a Center's group** (§3.2). No
department table: the Center *is* the department (`department_centers.md` §1), and the
grant is what makes a subtree "belong" to it.

### 3.2 `pm_project_grants` — the scoping primitive (D12/D13's vocabulary, this store's table)
`id` · `project_id UUID NOT NULL REFERENCES pm_projects ON DELETE CASCADE` · `subject TEXT
NOT NULL` (**exactly the shipped vocabulary: `email` \| `group:<slug>` \| `org`** —
`tenancy_and_visibility.md` §3.2 is binding; do not invent a second one) · `created_by TEXT
NOT NULL` · `created_at` · `UNIQUE (project_id, subject)`.

Grants apply to the project **subtree** (a grant on a root project covers its
subprojects/tasks). Read model in §4. This is a *sibling* of WS-14 C1's `gtd_project_grant`
(D13) — same vocabulary, different store; C1 remains the personal Tasks app's ticket and is
unchanged by this spec.

### 3.3 `pm_task_statuses` — statuses as data (D-CRM-2 / Paca convergence)
Scoped to a **root** project (subtree inherits): `id` · `project_id NOT NULL REFERENCES
pm_projects ON DELETE CASCADE` · `name TEXT NOT NULL` · `color TEXT NOT NULL DEFAULT
'gray'` · `position INT NOT NULL` · `category TEXT NOT NULL CHECK (category IN
('backlog','todo','in_progress','done','cancelled'))` · `is_default BOOLEAN NOT NULL
DEFAULT false` · `UNIQUE (project_id, name)`. The `category` is the machine-readable
semantic: `done`/`cancelled` drive completion, mirror-to-personal disposition (§6.1), and
the automation `predecessor_done`-style gates; name/color/position are free, so the
importer can represent ClickUp's actual per-list status names (the D-CRM-2 argument,
verbatim). Root-project creation seeds Backlog/To do/In progress/Done.

### 3.4 `pm_task_types` — types are semantics, hierarchy is structure
`id` · `project_id NOT NULL REFERENCES pm_projects ON DELETE CASCADE` (root-scoped) ·
`name TEXT NOT NULL` · `icon TEXT` · `color TEXT` · `is_system BOOLEAN NOT NULL DEFAULT
false` · `UNIQUE (project_id, name)`. Seeded per root project: Task (default), Bug,
**Epic (`is_system`)**. Paca's two hard rules adopted: an Epic-typed task cannot have a
parent, and Paca demoted "Subtask" from system type to convention — a subtask is just a
task with a parent, so we never mint a Subtask type at all.

### 3.5 `pm_task_counters` + `pm_tasks`
`pm_task_counters(project_id UUID PRIMARY KEY REFERENCES pm_projects ON DELETE CASCADE,
last_value BIGINT NOT NULL DEFAULT 0)` — root projects only; atomic
`UPDATE … SET last_value = last_value + 1 RETURNING`.

`pm_tasks`: `id` · `project_id NOT NULL REFERENCES pm_projects ON DELETE CASCADE` (may be
any node in the tree) · `root_project_id UUID NOT NULL REFERENCES pm_projects ON DELETE
CASCADE` (denormalized for the counter, status/type scope, and subtree reads; maintained by
code, re-stamped on move) · `task_number BIGINT NOT NULL` · `UNIQUE (root_project_id,
task_number)` · `parent_task_id UUID REFERENCES pm_tasks(id) ON DELETE SET NULL`
(subtasks, arbitrary depth; Paca's depth-50 ancestor cycle walk at write time) ·
`type_id UUID REFERENCES pm_task_types ON DELETE SET NULL` · `status_id UUID NOT NULL
REFERENCES pm_task_statuses ON DELETE RESTRICT` · `title TEXT NOT NULL` · `description
TEXT` (Markdown — the platform's format; no block JSON) · `importance SMALLINT`
(higher = more urgent; bucketed in UI) · `estimate_mins INT` · `start_date DATE` ·
`due_at TIMESTAMPTZ` · `completed_at TIMESTAMPTZ` (stamped when status crosses into
`done`) · `tags TEXT[] NOT NULL DEFAULT '{}'` (GIN) · `created_by TEXT NOT NULL` ·
`source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN
('manual','import','email','agent','automation'))` · `clickup_id TEXT UNIQUE` ·
`clickup_snapshot JSONB` (last-synced provider field state — the three-way-merge base,
§7.2) · `clickup_synced_at TIMESTAMPTZ` · `created_at` · `updated_at` · `archived_at`.
Index: `(project_id)`, `(root_project_id, status_id)`, `parent_task_id`, `due_at`,
`clickup_id`, GIN on `tags`, FTS GIN on `title || description`.

### 3.6 `pm_task_assignees` — humans and agents, one vocabulary
`task_id UUID NOT NULL REFERENCES pm_tasks ON DELETE CASCADE` · `assignee TEXT NOT NULL`
(email, case-folded on write, or `agent:<name>`) · `assigned_by TEXT NOT NULL` ·
`assigned_at` · `PRIMARY KEY (task_id, assignee)`. Index: `lower(assignee)` — the personal
lens (§6.1) and "assigned to me" predicates read `lower(assignee) = :email` (R10). Paca's
member-row indirection is refused (D-PM-4): the platform's actor convention is already the
string vocabulary, and a join table to `app_user` would exclude agents.

### 3.7 `pm_task_links`
`id` · `source_task_id` · `target_task_id` (both `NOT NULL REFERENCES pm_tasks ON DELETE
CASCADE`) · `link_type TEXT NOT NULL CHECK (link_type IN
('blocks','relates_to','duplicates'))` · `created_by TEXT NOT NULL` ·
`UNIQUE (source_task_id, target_task_id, link_type)` · `CHECK (source_task_id <>
target_task_id)`.

### 3.8 `pm_activities` — the single timeline spine (comments = activities)
`id` · `task_id UUID REFERENCES pm_tasks ON DELETE CASCADE` · `project_id UUID REFERENCES
pm_projects ON DELETE CASCADE` · **CHECK: at least one target non-NULL** (the
`crm_activities` move) · `type TEXT NOT NULL CHECK (type IN
('comment','status_change','field_change','link','assignment','agent_run','sync',
'system'))` · `body TEXT` · `meta JSONB` (`field_change` carries
`{"changes":[{field,old,new}]}` — the Paca diff-and-revert shape; `agent_run` carries
`{run_id, agent}`; `sync` carries the conflict record, §7.2) · `created_by TEXT NOT NULL`
(email, `agent:<name>`, or `system:sync` / `system:workflow:<id>`) · `created_at` ·
`updated_at` · `deleted_at` (comments only). Index: `(task_id, created_at)`,
`(project_id, created_at)`.

One transition, three effects (the CRM's `apply_status_transition` lesson): a status PATCH
writes the new `status_id`, a `status_change` activity, and `completed_at` when crossing
into/out of `done` — one helper, called by every mutator including sync and automation.

### 3.9 `pm_views` + `pm_view_task_positions` — saved views and manual order
`pm_views`: `id` · `project_id NOT NULL REFERENCES pm_projects ON DELETE CASCADE` ·
`name TEXT NOT NULL` · `view_type TEXT NOT NULL CHECK (view_type IN ('list','board'))` ·
`config JSONB NOT NULL DEFAULT '{}'` (**presentation top-level** — `fields`, `column_by`,
`sort_by`, `swimlanes`; **query constraints under `config.filters`** — status/assignee/
type/tag arrays + `include_subtree BOOLEAN`) · `position DOUBLE PRECISION` · `created_by` ·
timestamps. Root-project creation seeds one List and one Board (`column_by: "status"`).

`pm_view_task_positions`: `id` · `view_id NOT NULL REFERENCES pm_views ON DELETE CASCADE` ·
`task_id NOT NULL REFERENCES pm_tasks ON DELETE CASCADE` · `position DOUBLE PRECISION NOT
NULL` · `group_key TEXT` · `UNIQUE (view_id, task_id)`. Fractional indexing exactly per
`paca_pm_research_2026-08.md` §2.4: no rank column on `pm_tasks`; unpositioned tasks sort
by `created_at`; the first drag materialises the group. **This is what lets the People
Center master board and a Sales-slice board order the same task differently without
fighting.**

### 3.10 What is deliberately absent
No `pm_sprints`, no `pm_custom_field_definitions`, no attachments table (bind `/tasks`'s
`gtd_attachments` pattern later or reuse the email/notes storage seam — additive), no
notifications table (the platform inbox owns notification concerns), no closure table, no
`position` on `pm_tasks`.

---

## 4. API surface

Layout mirrors `routes/crm/`: a `routes/projects/` package where `core.py` is the leaf
(router + entity registry + models + SQL helpers) and feature modules register routes on
the shared router as an import side effect; every path is a literal, so import order is not
load-bearing. Registered in `main.py` with the standard fail-soft `try/except`, listed in
`tests/unit/test_org_access_enforcement.py::GATED_ROUTERS`.

```python
router = APIRouter(
    prefix="/projects", tags=["projects"],
    dependencies=[require_feature_router("projects")],
)
from gateway.db import get_db as _get_db  # the shared engine seam (BO-10 / D-CRM-4)
```

**The engine seam is non-negotiable:** `routes/projects` contains **zero**
`create_async_engine` calls; it consumes `gateway/db.py` (the seam WS-26a built and proved
on tasks). No engine 13.

| Module | Endpoints |
|---|---|
| `tree.py` | `GET /projects/tree` (the granted forest, nested) · `GET/POST /projects/nodes` · `GET/PATCH/DELETE /projects/nodes/{id}` · `POST /projects/nodes/{id}/move` · grants: `GET/POST/DELETE /projects/nodes/{id}/grants` |
| `tasks.py` | `GET/POST /projects/tasks` (list contract: allowlisted sorts, `?q=` FTS, filters incl. `project_id` + `include_subtree`, keyset pagination) · `GET/PATCH/DELETE /projects/tasks/{id}` · `POST /projects/tasks/{id}/move` · assignees `PUT/DELETE` · links `POST/DELETE` |
| `activities.py` | `GET /projects/tasks/{id}/timeline` · `POST /projects/tasks/{id}/comments` · `PATCH/DELETE /projects/comments/{id}` · `POST /projects/activities/{id}/revert` (field_change only) |
| `admin.py` | statuses + types CRUD per root project (`RESTRICT` delete answers 409 naming the count in use) |
| `views.py` | views CRUD · `PUT /projects/views/{id}/positions` (bulk upsert) |
| `me.py` | `GET /projects/assigned-to-me` — the personal lens's read (§6.1) |
| `mapping.py` (WS-27b) | no routes — the three suggestion signals and their combination, kept apart from the importer because a proposal and an application are different acts (D-PM-10) |
| `import_clickup.py` (WS-27b) | `POST /projects/import/clickup/plan` (proposes a Center per Space, writes nothing) · `POST /projects/import/clickup` (applies the confirmed mapping) |
| `sync.py` (WS-27c) | `POST /projects/sync` · `GET /projects/sync/status` · `GET /projects/sync/conflicts` |

Patterns carried from `routes/crm/core.py`: the frozen `Entity` registry dict (segment
matched against it, never interpolated), sort keys as an allowlist (unknown = 422), typed
JSONB/timestamptz binds, two models per entity (output = column names 1:1; one all-optional
input for POST+PATCH with create-time requirements on the registry).

**Read model (D-PM-3):** a project (and its subtree) is visible to a caller when a grant
row on it or an ancestor matches `org`, `group:<slug>` for a group the caller belongs to,
or the caller's email (case-insensitive) — **or** the caller is assigned to the specific
task ("assigned-to-me always sees its own tasks"). Non-visible ⇒ **404, never 403** (R5).
Full-portfolio view (the People Center's "all departments") additionally requires
**`data:org:read`** — the slug D14 measured at zero consumers; this is deliberately its
first consumer, making `manager`'s org-wide visibility a mechanism instead of a name.
Writes: task-level writes for any caller who can see the project; project/status/type/grant
admin for the project's `lead`, `created_by`, or `admin:members:manage` holders.

**Rules that bind** (`user_management_contract.md`): identity from `X-User-Email` only
(R3); no `PUBLIC_ROUTES` additions — the BFF proxies everything (R2); server-side checks
first (R9); email comparisons case-insensitive both sides (R10); destructive deletes report
what cascaded (R7/R8) — deleting a project names the subtree/task/activity counts.

**Events:** every mutation emits `pm.task.created|updated|status_changed|assigned|
comment_added` and `pm.project.*` through `ingestion/event_hooks.emit_event` — the same
path ClickUp webhooks use today, which is what makes §6.3's automation binding one seam
instead of a new bus.

---

## 5. UI

```
workbench/control_plane/src/app/projects/
  page.tsx                      # tree sidebar + active view (list | board)
  components/*.tsx              # ProjectTree, TaskListView, TaskBoardView, TaskPanel,
                                #   TimelinePane, ViewSettings, StatusAdmin
  lib/*.ts + *.test.ts          # pure helpers: fractional positions, grouping, filters
src/app/api/projects/[...path]/route.ts   # BFF proxy (gatewayHeaders(), force-dynamic,
                                          #   AbortSignal.timeout, byte-exact passthrough)
```

**Registration — the five-place checklist does NOT apply** (this is an app, not a Center),
but the app-slug half does, and it is both-ways invariant-tested:
1. `acb_auth.permissions.FEATURES` gains `"projects"` (beside `"tasks"`).
2. `feature_catalog` row in the WS-27a migration: `('projects','Projects','Departments,
   projects and team tasks','/projects','apps', 56, false)` — **`is_default false`**, the
   D-CRM-3 posture: reaches `*`-holders and `admin` until an admin grants it.
3. `nav.ts` `PANES` entry + `access.ts` `HREF_FEATURES` `/projects → projects`.
4. `tests/unit/test_org_access_control.py` — the existing catalog↔FEATURES both-ways
   invariants pick the slug up automatically; add the named
   `test_projects_is_registered_on_both_sides` per the WS-26a precedent.

**Center projections (the (app + scope) rule, `department_centers.md` §1 rule 2):**
- `lib/centers.ts` People Center: flip a sub-app to
  `{label: "Projects & work", status: "live", href: "/projects"}`.
- Every other Center gains/updates a sub-app `{status: "live", href:
  "/projects?center=<slug>"}`. The query param is **presentation only** — it pre-filters
  the tree to projects granted `group:<slug>`; the server's grant model is what actually
  scopes data, so a hand-edited URL shows nothing the caller couldn't already see (R9).
- **Refuse any per-Center fork of the app in review.**

Conventions: Tailwind v4 semantic tokens only; Lucide icon names as strings; zustand +
pure `lib/` helpers with colocated vitest; drag-drop writes one `pm_view_task_positions`
upsert per drop (the board's cross-column drag patches whatever field `column_by` names).

---

## 6. Integrations — bind, don't rebuild

### 6.1 Personal tasks (`/tasks`) — the org↔personal seam this spec exists for
The requirement: a `pm_task` assigned to a member appears in their personal GTD system, and
completing it in either place is one fact. Mechanism is **D-PM-6** (§8): the Tasks app's
existing provider machinery mirrors `pm_tasks` where `lower(assignee) = user` into
`gtd_items` as `source='SYNCED'` rows (internal provider `commandcenter`, no credentials,
no broker gate — it is not an outward write). The GTD overlay (disposition, context,
energy, refile) is **never clobbered on re-sync** — the discipline `sync.py` already
enforces for ClickUp rows; completion state flows both ways (provider-of-record =
`pm_tasks`). The GTD lens maps `category` → disposition exactly as the ClickUp lens maps
stages today (done→DONE, backlog→SOMEDAY, assigned-to-me→NEXT, assigned-elsewhere→WAITING
with a `gtd_waiting` row). Result: clarify, calendar/timeboxing, Waiting-For, and delegation
all work on org tasks with **zero** changes to their code.

### 6.2 People (`gtd_people`) — assignment intelligence
Assignee pickers and the delegate flow read the existing directory + capability layer
(`fetch_people_for_clarify`, `capability_embedding`) — suggestion, never auto-assignment.
WS-24 N4's HR-field projection applies unchanged; the Projects app reads only directory
fields. The People Center's "Directory & org chart" sub-app remains WS-13's read view —
this spec does not build a parallel people store.

### 6.3 Workflows (`/workflows`) — automation, one engine
WS-27f emits `pm.*` events into `event_hooks.emit_event` → `workflows/triggers.
dispatch_event` (the path that already exists) and contributes **two node types**: a
`pm.update_task` action (multi-field patch through the ordinary service, so it gets
validation + a `field_change` activity with `created_by='system:workflow:<id>'` — Paca's
"mutate through the ordinary service" rule) and a `pm.task_event` trigger config (project/
status/assignee filters). Paca-grade engine uplifts — multi-branch switch conditions,
per-step input/output snapshots, due-date-offset triggers, the derived dependency map —
are **`workflows_app.md` backlog items** (single owner, D6); this spec records the demand
and stops.

### 6.4 Agents — assignment is dispatch
Assigning `agent:<name>` (WS-27f): the `pm.task.assigned` event carries the agent target; a
consumer creates the run through the existing orchestrator dispatch (the same seam chat
delegation uses), records an `agent_run` activity on the task immediately (Paca's
`agent.session.started` move — the handoff is visible in the timeline before the agent
says anything), and the agent works the task through a `skill-projects` tool family over
this API under its own `agent:<name>` identity — permission-intersected with the acting
member via `EffectiveAccess.intersect()`. Run completion/failure posts a closing activity.
**Agent edits are ordinary edits (D-PM-9):** during coexistence an agent may work linked
tasks as well as native ones, and its changes reach ClickUp through the WS-27c sync
chokepoint on exactly the same terms as the owner's own — auto-applying while
`ACTION_BROKER_ENFORCE` is off, attributable and timeline-reversible either way. Read
D-PM-9's Cost paragraph before building this: it names what that does and does not
guarantee.

### 6.5 Email / WhatsApp / Notes
Bind at the activity spine: email-to-task capture (`capture_email.py`) gains a `pm_tasks`
target beside `gtd_items`; Notes' action-item HITL (`actions.py`) gains "create as project
task". Both are thin: one insert path each, reusing §3.8's helper. Deeper linking
(`entity_ref`-style) follows the WS-26d pattern later.

### 6.6 The graph mirror (`acb_graph`)
`project`/`task` mirror rows keep flowing from ClickUp untouched until WS-27g, which
repoints the consumers (`reconciler.py`'s quiet-deal escalation reads deals, not tasks —
the task-side consumers are `resolver.py` and any org-brain queries) to `pm_*`, then
retires System A's ClickUp arm.

---

## 7. The migration path — coexistence, inversion, retirement

**Constraint-8 amendment, stated plainly:** root `AGENTS.md` #8 ("source systems are
authoritative") holds through WS-27a–c with ClickUp as the PM source of truth. WS-27g
inverts it **for project management only** — CommandCenter becomes the system of record and
ClickUp is retired — the same recorded inversion `crm_app.md` §1 made for Zoho. The
amendment lands in root `AGENTS.md` in the WS-27g PR, not before.

### 7.1 Import (WS-27b) — plan, then apply

**Step 1 — the mapping plan (D-PM-10).** `POST /projects/import/clickup/plan` reads the
workspace and returns one row per Space: the Space, its task/subtask counts, a **suggested
Center**, a confidence, and the evidence behind the suggestion. Three signals, cheapest and
most reliable first:

1. **Assignee overlap** — the share of the Space's task assignees who are members of each
   `org_group`. Deterministic, no LLM, and the strongest signal the platform already holds.
2. **Name match** — the Space name against Center names, slugs, and their aliases.
3. **Content classification** — a sampled set of task/subtask titles classified through
   `acb_llm`'s tiered routing. **EVAL-LOCKED**, like `routes/tasks/ai.py::propose`.

The plan is **pre-filled from existing grants** on re-run, so a mapping the owner has
already confirmed is stable and a re-import can never silently re-map a Space. Suggestions
are proposals: nothing is applied from this endpoint.

**Step 2 — the import.** The owner's confirmed mapping is passed to
`POST /projects/import/clickup`, which pulls with an owner-connected `task_accounts`
credential: Spaces → root projects, Folders → subprojects, Lists → subprojects (leaf
containers), tasks + subtasks → `pm_tasks` with `parent_task_id`, per-list statuses →
root-project `pm_task_statuses` (union by name, `category` mapped from ClickUp status type),
assignees → emails via the member map `schema_cache` already holds, everything stamped
`source='import'` + `clickup_id`. Each **mapped** Space's root project also gets a
`group:<slug>` grant — that grant is the entire mechanism by which the Space becomes a
Center's slice.

**Unmapped Spaces still import, in full.** They simply receive **no group grant**, which
leaves them reachable in `/projects` for `data:org:read` holders (the People Center's
full-portfolio view) and for anyone assigned to their tasks — so nothing is stranded or
invisible to the owner. Mapping one later is a grant write, never a re-import.

Re-runnable: upsert on `clickup_id`; **during coexistence a re-import is last-import-wins
on ClickUp-sourced fields only** (never on rows/fields the sync marks locally newer, §7.2).
Import summary reports per-entity counts; parity check = ClickUp count vs `pm_*` count per
Space.

### 7.2 Coexistence — two-way sync (WS-27c), the genuinely novel surface
Nothing in the repo does bidirectional reconciliation today; this is designed here, not
inherited:
- **Pull**: scheduled delta pull (`last_delta_token` discipline from `task_accounts`) +
  the existing ClickUp webhook fan-in, both landing on one upsert path.
- **Push**: local `pm_*` edits to ClickUp-linked rows queue as outbound mutations through
  **`_broker_gate`** — the single audited chokepoint (AGENTS.md #4). **Prerequisites,
  named:** **BO-1a** (register the missing `clickup.delete_task`/`archive_task` handlers)
  and **BO-1b** (honour the `pending` marker instead of writing `sync_state='synced'` with
  an empty id). Neither is optional; both are WS-1 tickets this spec depends on.
- **Merge**: three-way, field-level, using `clickup_snapshot` as the base: a field changed
  on only one side takes that side; changed on both sides ⇒ **newest-wins by timestamp,
  and the losing value is written to the timeline as a `sync` activity** (`meta` carries
  `{field, ours, theirs, taken}`) — a conflict is never silent and always recoverable via
  the timeline. Snapshot re-stamped after every successful reconcile.
- **Idempotency discipline** (Paca §9 of the research doc): every sync mutation checks
  "already in target state" first; re-delivery of a webhook or a re-run of a pull is a
  no-op.

### 7.3 Cutover (WS-27g, first half)
Final import + parity counts per Space · flip the sync to **pull-only mirror** (ClickUp
edits still land; pushes stop) · a soak window where the org works in `/projects` · then
stop the pull.

### 7.4 Retirement inventory (WS-27g, second half)
System A ClickUp arm: `ingestion/sources/clickup/` (client, normaliser, webhook),
`scheduler.py`'s ClickUp job, `scripts/clickup_sync.py`, `/webhooks/clickup` from
`PUBLIC_ROUTES` · System B ClickUp arm: `ClickUpProvider` + the four broker handlers +
ClickUp rows in `task_accounts` (the provider *interface* stays — it is the personal app's
abstraction and §6.1's internal provider uses it) · `apps/skills/skill-clickup-sync/` ·
integrations catalog card + OAuth provider entry · graph-mirror consumer repoint (§6.6) ·
**revoke the ClickUp tokens** (owner act) · root `AGENTS.md` #8 amendment + `README.md`
mentions. Each path re-verified at execution time, not trusted from this list.

---

## 8. Decisions

**D-PM-1 — New `pm_*` tables; `gtd_*` is not extended into an org store.**
`DECISION (agent-proposed, owner may overrule).` `gtd_items`/`gtd_projects` are per-user by
construction (owner-scoped 404 model, 27 `user_id` predicates, per-user `task_accounts`
sync) and carry a personal GTD overlay; an org PM store has opposite visibility semantics
and shared mutable state. Extending in place would put one table under two ownership
models — `gateway/AGENTS.md` 12c's exact warning. **Rejected:** growing `gtd_*` org-wide
(every existing predicate becomes a bug surface; the overlay's "never clobber" contract
breaks when rows are shared). **Cost:** assigned tasks exist in two tables during
coexistence (mirrored by §6.1's internal provider — the same duality `SYNCED` rows already
live with), and WS-27g owes the graph-mirror repoint.

**D-PM-2 — Hierarchy is two self-FKs + types-as-data (the Paca shape).**
`DECISION (agent-proposed, owner may overrule).` Departments/projects/subprojects are one
`pm_projects` self-FK; tasks/subtasks one `pm_tasks` self-FK; Epic/Story are `pm_task_types`
rows with the Epic-root rule; depth-bounded cycle walks in code. **Rejected:** per-level
tables (ClickUp's Space/Folder/List zoo — the importer *flattens* it instead) and a closure
table (write amplification nothing here needs). **Cost:** subtree reads are recursive CTEs;
`root_project_id` is denormalized to keep the hot paths flat.

**D-PM-3 — Visibility is grant-based from day one; full portfolio rides `data:org:read`.**
`DECISION (agent-proposed, owner may overrule).` Center slices are this feature's point, so
scoping cannot be deferred the way D-CRM-3 deferred it: `pm_project_grants` ships in
WS-27a using the shipped subject vocabulary, subtree-inherited, 404-not-403. The
all-departments view requires `data:org:read` — deliberately giving D14's zero-consumer
slug its first consumer. **Rejected:** org-visible v1 (contradicts the slice requirement)
and a new `projects:read_all` slug (WS-24 N4 precedent: a new slug is nobody's grant until
an admin acts, which would blank the People Center for the owner too). **Cost:** the read
model is a union query on day one; creation defaults to an `org` grant so a solo org
notices nothing until it starts scoping.

**D-PM-4 — Actors and assignees are the `email | agent:<name>` string vocabulary.**
`DECISION (agent-proposed, owner may overrule).` Paca's member-row indirection is refused;
the platform's convention (`crm_activities.created_by`, broker `actor` strings) already
admits both species, and `EffectiveAccess.intersect()` is our stronger answer to agent
authority. **Rejected:** a `pm_members` table (a third membership store beside `app_user`
and `org_group`). **Cost:** no per-project roles in v1; write floors are lead/creator/
`admin:members:manage` (§4).

**D-PM-5 — Ordering is per-view fractional indexing; no rank column on tasks.**
`DECISION (agent-proposed, owner may overrule).` Per `paca_pm_research_2026-08.md` §2.4;
it is what makes the same task orderable differently in the People Center and a Center
slice. **Rejected:** `gtd_item_sort_key`-style single order (one global order cannot serve
N views) . **Cost:** one side table and materialise-on-first-drag semantics the UI must
implement faithfully.

**D-PM-6 — The personal connection is the Tasks app's provider seam, run internally.**
`DECISION (agent-proposed, owner may overrule).` §6.1's mechanism: `pm_tasks` mirrored into
`gtd_items` as `source='SYNCED'` under an internal `commandcenter` provider — every GTD
feature works unchanged, the overlay contract already exists, and the mirror is in-DB
(cheap, transactional, no broker). **Rejected:** (a) a read-union inside `/tasks` (touches
the 27-predicate blast radius C1 already measured, and the GTD overlay has no home for
un-mirrored rows); (b) linking `gtd_items` rows by hand (two sources of truth with no
reconcile discipline). **Cost:** row duplication inside one database, and the internal
provider must be exempted from `_broker_gate` (it is not an outward write — assert that in
its tests).

**D-PM-7 — Sync conflicts: three-way merge, newest-wins per field, conflicts logged to the
timeline.** `DECISION (agent-proposed, owner may overrule).` §7.2. **Rejected:** whole-row
last-writer-wins (silently destroys the other side's edits — the exact class of lie BO-1b
documents) and manual conflict queues (an approval inbox for field merges would drown the
owner). **Cost:** `clickup_snapshot` storage per linked task and a merge function that must
be property-tested (§10).

~~**Open questions for the owner (deliberately unimplemented):** portfolio layer? · agent
writes during coexistence? · first-import scope?~~ — **ALL THREE ANSWERED 2026-08-06.** Kept
struck rather than deleted so the answers below read as decisions taken, not defaults
inherited. They are D-PM-8, D-PM-9 and D-PM-10.

**D-PM-8 — No portfolio/program layer; grants are the only grouping axis.**
`DECISION (owner-answered 2026-08-06).` A project may carry several grants at once, so a
genuinely cross-department initiative appears in both Centers without a second grouping
axis, and the People Center sees the whole forest through `data:org:read` (§4).
**Rejected:** a `pm_programs` table above departments — it is a second axis every view,
filter and picker would have to carry, for an expressiveness the grant model already has.
**Cost:** a cross-cutting initiative is expressed as multiple grants on one project (or a
shared parent project), not as a named program. If named programs are wanted later they are
purely additive — a table plus a nullable column — and nothing in §3 forecloses them.

**D-PM-9 — Agent edits to ClickUp-linked tasks are treated exactly like human edits.**
`DECISION (owner-answered 2026-08-06 — the agent proposed queueing agent-originated pushes
for approval and was overruled).` An agent may work any task it can see, native or linked,
and its edits sync outward through the same `_broker_gate` path as the owner's own.
**Rejected:** (a) asymmetric approval for agent-originated pushes — it would have made
agents second-class actors in a model whose whole point (D-PM-4) is one actor vocabulary;
(b) restricting agents to native-only projects until cutover — that would leave agents
useless on the existing portfolio for the entire coexistence period, which is most of
WS-27's life. **Cost, stated once and plainly:** `_broker_gate` auto-applies by default
(`ACTION_BROKER_ENFORCE` unset), so during coexistence a mistaken agent edit reaches the
live ClickUp workspace with no human in between. Three properties bound that cost and
**none of them is a gate — do not describe them as one**: every agent edit is attributable
(`created_by='agent:<name>'` on the activity, plus the broker audit row), reversible from
the timeline (§3.8's `field_change` carries old and new), and the whole class becomes
queue-on-approval the moment `ACTION_BROKER_ENFORCE` is flipped — itself an owner gate, and
one whose two flip-blockers (BO-1a, BO-1b) WS-27c already depends on. **Consequence that
motivated the call:** WS-27f's agent dispatch is demoable against real portfolio data
during coexistence rather than only against tasks created after cutover.

**D-PM-10 — ClickUp Spaces map to Centers explicitly, from agent-proposed suggestions;
unmapped Spaces still import and stay reachable.**
`DECISION (owner-answered 2026-08-06).` Mechanism in §7.1: a `plan` endpoint proposes a
Center per Space from assignee-overlap, name match, and an EVAL-LOCKED content
classification, with the evidence attached; the owner confirms; the import applies the
confirmed mapping as `group:<slug>` grants. **Rejected:** (a) making the mapping a required
precondition of import — it would block the import on a decision the owner may reasonably
want to take *after* seeing the data; (b) auto-applying suggestions — a wrong auto-map
grants one Center visibility of another department's work, which is the single error class
this app must never make silently; (c) giving unmapped Spaces an `org` grant — harmless
today with one member, wrong the moment colleagues land, and invisible when it turns wrong.
**Cost:** the importer grows a plan endpoint and an LLM-backed suggester carrying its own
eval lock, and the owner performs one confirmation step per import run. **Scope note:** this
supersedes the earlier "pilot Space vs all Spaces" framing — scope is now a per-Space
decision the plan step surfaces, so both a pilot and a full import are the same code path.

---

## 9. Tickets

**WS-27a — schema + feature registration + core API.** 🟢 AGENT-SAFE.
Done when: (1) the migration exists at the next free number, idempotent, with the
`feature_catalog` row — and the WS-26a-style **static idempotency test** over the migration
text passes; (2) `"projects"` is in `FEATURES` and the both-ways catalog invariants stay
green, including the named `test_projects_is_registered_on_both_sides`; (3) `routes/
projects/` serves §4's tree/tasks/activities/admin/views/me modules behind
`require_feature_router("projects")`, consumes `gateway/db.py` (grep-assertable: zero
`create_async_engine` under `routes/projects`), and is listed in `GATED_ROUTERS`; (4) the
grant read model answers 404-not-403 for a non-granted caller and honours `email`/`group:`/
`org` subjects + assigned-to-me, proven hermetically; (5) status transition writes all
three effects (§3.8); (6) `pm.*` events are emitted through `event_hooks.emit_event`.

**WS-27b — ClickUp org importer + the Space→Center mapping plan.** ✅ **BUILT 2026-08-06**
(`routes/projects/mapping.py` + `import_clickup.py`, 25 hermetic cases, 4 mutants red) ·
🔴 **running either endpoint against the production workspace is still OWNER-GATE** (§6 of
`work_plan.md`) — **neither has been executed**.
Two things the build recorded that this ticket did not ask for, both in `import_clickup.py`:
statuses are derived from the **tasks'** own status types rather than the space workflow
(that is where ClickUp puts the type, and it costs no extra API call), and **subtasks import
as top-level tasks of the right list** — ClickUp carries a parent id only on a detail fetch,
so linking them would cost one call per task; WS-27c's sync already fetches detail and
re-parents them. Recorded rather than silently skipped, because "subtasks became top-level
tasks" is exactly the surprise an importer must not spring.
Done when: (1) `POST /projects/import/clickup/plan` returns one row per Space with counts,
a suggested Center, a confidence, and the evidence, from all three §7.1 signals — and
**writes nothing**, proven by a test that asserts no INSERT/UPDATE reaches the session;
(2) the plan pre-fills from existing `group:` grants, so a re-run of an already-confirmed
mapping proposes the same mapping (fenced by a test — this is what stops a re-import
silently re-mapping a Space); (3) the LLM classifier is EVAL-LOCKED and the plan degrades
to the two deterministic signals when it is unavailable, never failing the whole plan;
(4) `POST /projects/import/clickup` maps Space/Folder/List/task/subtask/status/assignee per
§7.1 with provenance, re-runnably, and applies the confirmed mapping as `group:<slug>`
grants; (5) **a Space absent from the mapping still imports in full and receives no group
grant**, and a test proves it is then visible to a `data:org:read` holder and to an
assignee, and invisible to an unrelated Center's member (the D-PM-10 (c) rejection made
executable); (6) the response reports per-entity imported/updated/skipped counts, the
grants applied, and a parity summary; (7) permission floor is `admin:access:manage` (the
WS-26b finding: `integrations:use:*` gates nothing); (8) a dry-run mode reports counts
writing nothing.

**WS-27c — two-way coexistence sync.** 🟡 **blocked on BO-1a + BO-1b (WS-1)**; build
AGENT-SAFE once they land · 🔴 enabling push against the real workspace is OWNER-GATE.
Done when: (1) delta pull + webhook fan-in share one idempotent upsert path; (2) every
outbound mutation flows through `_broker_gate` and a pending disposition is honoured (the
BO-1b class is fenced by a test that fails on an empty provider id marked synced); (3) the
three-way merge takes the newest side per field and writes a `sync` activity for every
conflict, property-tested over generated edit interleavings; (4) `GET /projects/sync/
status` + `/conflicts` report truthfully (a failed push is never shown synced).

**WS-27d — UI + Center projections.** 🟢 AGENT-SAFE.
Done when: (1) `/projects` renders tree + list + board + task panel + timeline against the
real API via the BFF proxy; (2) drag-drop writes fractional positions (one upsert per drop)
and cross-column drags patch the `column_by` field; (3) nav/access registration per §5 with
`tsc --noEmit` + vitest green; (4) the People Center sub-app flips live and each Center's
slice pre-filters by its group — with a vitest asserting the `?center=` param filters
presentation only.

**WS-27e — personal-task connection + people binding.** 🟢 AGENT-SAFE.
Done when: (1) an assigned `pm_task` appears in the assignee's `/tasks` inbox as a
`SYNCED` row with the correct GTD disposition mapping; (2) re-sync never clobbers the
overlay (the existing contract's test extended to the internal provider); (3) completion
round-trips both directions; (4) the internal provider is asserted broker-exempt; (5)
assignee suggestions read the capability layer with N4's projection intact.

**WS-27f — automation + agent dispatch.** 🟢 AGENT-SAFE (the node types land in
`workflows_app.md`'s tree per D6 and are recorded there in the same PR).
Done when: (1) `pm.*` events reach `dispatch_event` (proven at the `emit_event` seam);
(2) the `pm.update_task` action mutates through the ordinary service and stamps
`system:workflow:<id>`; (3) assigning `agent:<name>` produces an orchestrator run, an
immediate `agent_run` activity, and a closing activity on completion/failure; (4) the
`skill-projects` tool family lets an agent read/update its assigned task under its own
identity, permission-intersected.

**WS-27g — cutover + ClickUp retirement.** 🔴 **OWNER-GATE end-to-end** (final import,
parity sign-off, sync flips, consumer repoint, token revocation, constraint-8 amendment —
each registered in `work_plan.md` §6).

---

## 10. Verification

⚠️ Never `uv run pytest tests/unit/` bare — whole-directory collection hangs on the
Windows box against the live DB. **Name the files.**

```bash
uv run pytest tests/unit/test_projects_routes.py tests/unit/test_projects_grants.py \
              tests/unit/test_projects_migration.py tests/unit/test_projects_sync.py \
              tests/unit/test_projects_import_mapping.py \
              tests/unit/test_projects_personal_mirror.py \
              tests/unit/test_org_access_control.py tests/unit/test_org_access_enforcement.py
cd workbench/control_plane && npx tsc --noEmit && npm test
```

House style applies: hermetic route tests (fake session, monkeypatch the DB seam on the
SUT submodule), the migration asserted idempotent **statically** over its text, cascade
claims checked against `tests/unit/_schema_cascade.py`'s derived FK graph (the N8 lesson:
never report a destroyed row as kept), and mutants for each new guard measured red and
reverted byte-identical.
