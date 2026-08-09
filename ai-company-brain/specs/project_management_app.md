# Projects App — Master Plan (native project management; ClickUp retirement path)

> **Product:** CommandCenter · **Feature:** Projects (the People Center's primary work-management
> module, sliced into every other Center) · **Created:** 2026-08-05 · **Updated:** 2026-08-06
> (owner pass — §8's three open questions are answered as **D-PM-8/9/10**; §7.1 gains the
> Space→Center mapping step and WS-27b's done-whens grew with it) ·
> **Status:** 🟢 **WS-27a + WS-27b + WS-27d + WS-27e BUILT** (2026-08-06, branch
> `claude/paca-research-task-management-a1f6zd`, PR #367) — migration `146_projects.sql`
> (§3.1–§3.10), `feature:projects` registered on both sides, the `routes/projects/` API (§4
> minus `sync.py`) live behind the feature gate on the `gateway/db.py` seam, the ClickUp
> importer with its Space→Center mapping plan (§7.1), and the `/projects` UI with its Center
> projections (§5), and the personal lens (§3.11-§3.12, §6.1) on migration
> `147_projects_personal.sql`. **Not deployed and never run** — neither migration has been
> applied anywhere and neither import endpoint has been executed against the live tenant. ·
> **WS-27c, f, g, h: 🟡 SPEC, nothing built.** ·
> **Owner:** vjvarada · **Board row: WS-27**
>
> **Verified 2026-08-06:** 140 hermetic cases across
> `test_projects_{routes,grants,migration,import_mapping}.py` (no DB, no ClickUp, no LLM),
> plus the unchanged org-access and CRM fences — 298 passed on the combined set.
> Frontend: **315 vitest cases** and `tsc --noEmit` clean.
> **Fifteen mutants measured red and reverted byte-identical:** WS-27a's five (unscoped
> visibility clause, dropped assignee escape, transition skipping its activity,
> `completed_at` never cleared on reopen, removed Epic-root rule), WS-27b's four
> (applying the suggestion instead of the confirmed mapping, refusing to import an unmapped
> Space, a plan that writes, and a re-import that duplicates), and WS-27d's six (an unknown
> Center yielding an empty forest, `planDrop` never materialising, a board drop hard-coding
> status, unpositioned tasks sorting to the top, a missing nav pane, a Center linking at a
> forked route). **WS-27e adds six more:** an overlay keyed by task rather than per member,
> a personal-only completion that leaves the board behind, `is_triaged` always true, an
> inbox that drops its personal-project arm, a disposition filter matching only the stored
> value, and a tickler that ignores `defer_until`. ⚠️ Two of those first **survived** and
> the fake was at fault, not the tests — it applied the inbox's arms unconditionally instead
> of keying them off the statement, the exact mirror failure `_projects_fakes.py`'s own
> docstring warns about. Found by mutation, not by review.
>
> **Not built, on purpose:** no sync (WS-27c — blocked on BO-1a/BO-1b), no automation or
> agent dispatch (WS-27f), no `gtd_items` retirement (WS-27h), and
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
- ~~**Custom fields.**~~ Paca's `field_key`→JSONB pattern was the recorded additive path,
  and **WS-27l took it 2026-08-07** (§11.9). The departure from the recorded plan is one
  line: deleting a definition also strips its values, which Paca does not do.
- ~~**Tags as a first-class registry.**~~ v1 was `tags TEXT[]` on tasks (searchable, no
  colors) and the registry was named as additive later; **WS-27m added it 2026-08-07**
  (§11.10). The array stayed — the registry sits beside it, not instead of it.
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
| `me.py` | `GET /projects/assigned-to-me` — the flat "what is mine" read |
| `personal.py` (WS-27e) | `GET /projects/my/inbox` · `GET/POST /projects/my/project` · `POST /projects/my/tasks` · `PATCH /projects/tasks/{id}/personal` · `POST /projects/tasks/{id}/{complete,defer}` · `GET /projects/my/contexts` |
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
completing it in either place is one fact. **Since 2026-08-06 that is true by construction
rather than by synchronisation** — there is one row, and the personal view is a lens over
it (D-PM-6 revised). What follows describes the superseded mirror; it is kept for the
reader who needs to know what was rejected. ~~Mechanism is the Tasks app's
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

**Written down 2026-08-06 — `workflows_app.md` §13.** The demand is no longer only recorded
here as a sentence: the engine spec now carries a full Paca-referenced uplift backlog,
**U1–U8**, each with the Paca design, this engine's measured current state, and a done-when.
The mapping from this section is exact: **U1 is the `pm.update_task` node** (WS-27f's first
half) and **U7 is agent dispatch** (§6.4, WS-27f's second half); U2/U3/U6 are the switch,
step snapshots and due-date trigger named above; **U4** (task retargeting over
`parent|children|blocks|…`) is the item this section had not named and is what makes "when
every child is Done, move the parent to Done" expressible at all. Nothing in §13 is built —
it is the reference an implementer picks up, so WS-27f no longer has to re-derive the engine
work from Paca's source.

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

### 7.5 The `gtd_items` retirement (WS-27h) — the cost D-PM-6's revision accepted

One store means the old one goes. Sequenced **after** WS-27e (which is the destination) and
independent of the ClickUp work, because it is a move between two tables we own:

1. `/tasks` reads a **union** of `gtd_items` and `pm_tasks` during coexistence, so the app
   keeps working while rows move.
2. Every `gtd_items` row migrates: `LOCAL` rows into the owner's personal project; `SYNCED`
   rows onto their `pm_tasks` counterpart by `clickup_id`, with the GTD overlay landing in
   `pm_task_personal`. The disposition vocabulary is **unchanged on purpose** (§3.12), so
   this is a copy rather than a translation.
3. `items.py`'s 27 `user_id` predicates retire with the table they scope. They are untouched
   by WS-27e, deliberately — the blast radius WS-14 C1 measured belongs to this ticket.
4. `gtd_projects`, `gtd_spaces`, `gtd_folders` retire with it; `gtd_people` does **not** —
   that is the People Center's store (`specs/people_center_app.md`).

⚠️ **Not started, and it is the largest single piece of WS-27 remaining.** Until it lands
there are two personal task stores, which is the state this decision exists to end.

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

~~**D-PM-6 — The personal connection is the Tasks app's provider seam, run internally.**
`DECISION (agent-proposed, owner may overrule).` §6.1's mechanism: `pm_tasks` mirrored into
`gtd_items` as `source='SYNCED'` under an internal `commandcenter` provider…~~
— **SUPERSEDED 2026-08-06.** Kept struck rather than deleted because the replacement is
only legible against what it replaces: the mirror was the thing rejected, and a reader who
finds `pm_task_personal` without this will wonder why the obvious answer was not taken.

**D-PM-6 (revised) — ONE task store. The personal manager is a lens, not a copy.**
`DECISION (owner-directed 2026-08-06: "the personal task manager should be a proper
extension of the project system … a cohesive whole that should fit within each other".)`

`pm_tasks` is **the** task table. Three consequences, and they are the whole design:

1. **Assignment is not a sync.** A task assigned to a member is the row in their inbox.
   Completing it there completes it for the project at the same instant, because there is
   one row and one status. The mirror would have had two rows for one fact, and every
   feature built afterwards — search, calendar, agents, reporting, the weekly review —
   would have had to know about both.
2. **Private work is a personal project.** An ordinary `pm_projects` row carrying
   `personal_owner`, granted to that one address (§3.11). Nothing about tasks, boards,
   timelines, automation or agent dispatch needs a special case; it is a project whose
   grant happens to name a person. Personal projects are excluded from every *team* read —
   "My tasks" is not a department — which is presentation, not access.
3. **The GTD overlay is per-member** (§3.12, `pm_task_personal`). Two people assigned the
   same task hold different dispositions: the person doing it says NEXT, the person who
   delegated it says WAITING. A single column on `pm_tasks` could not express that, and it
   is what delegation looks like rather than an edge case.

**Rejected:** (a) the mirror, above — cohesion was the owner's stated requirement and a
mirror is by construction two things; (b) keeping `gtd_items` for private todos and merging
in the UI (owner-answered: two task tables forever, and every future feature has to handle
both — the seam that quietly drifts); (c) rewriting `/tasks` onto `pm_tasks` in one pass
(same end state, but ~11.8k lines and 68 endpoints at once, and a regression there breaks
the owner's daily driver).

**Cost, and it is real:** `gtd_items` becomes legacy and needs its own retirement
(**WS-27h**, §7.5) — a second retirement project running beside ClickUp's. `/tasks` reads a
union of both stores until it lands. The 27 owner-scoped predicates in `items.py` are
untouched by this ticket and are WS-27h's problem, deliberately.

**A property worth stating because it falls out rather than being built:** `disposition` is
NULL until a member triages, and the read *derives* one from the task's status. So "never
looked at" and "deliberately filed to INBOX" stay distinguishable — which is the only
question the Weekly Review exists to ask, and a column defaulting to `'INBOX'` would have
destroyed it silently.

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

**D-PM-11 — The timeline shows a chosen SCOPE, not every task.**
`DECISION (agent-proposed 2026-08-08, owner delegated the choice back — "go ahead with the
decision that you think would be best to make the product as useful as possible").`
**ANSWERED: (b), with (c) underneath.** A Gantt of 400 rows is a
wall nobody reads, so something has to decide which tasks earn a bar. Three candidates, and
they are not equivalent:

* **(a) A task TYPE, the Paca answer.** Paca's Timeline pre-filters to the `Epic` system type
  and its view settings let you add others back. Clean, and it costs us a convention we do
  not have: `pm_task_types` is per-root data with no reserved names, so "Epic" would either
  become a seeded row every project inherits or a name-match, and a name-match is a rule that
  silently stops working the day somebody renames a type.
* **(b) Hierarchy DEPTH.** Top-level tasks get bars; subtasks roll up into the parent's bar
  and expand on click. Needs no new vocabulary — `parent_task_id` already says it — and it
  matches how the tree is already drawn everywhere else in this app.
* **(c) Whatever the current filters select.** No new concept at all: the timeline is the
  board's filters in a third shape, which is the rule §11.16 already holds for the calendar.
  Honest, and it puts the wall back the moment somebody clears the filters.

**Chosen: (b), with (c) underneath it** — depth decides the default and the filter bar
still narrows, so the two compose instead of competing. **Rejected:** (a) as the primary,
because inventing a reserved type name to make a chart legible is a data-model change in
service of a rendering problem, and D-PM-2 put types in the hands of each project on purpose.
**Cost:** a subtask's dates have to roll up into the parent's bar, which means the parent's
bar is sometimes derived rather than stored, and "why does this bar not match the dates I
typed" becomes a question the UI has to answer on the bar itself.

**D-PM-12 — Does a dependency CONSTRAIN the schedule, or only describe it?**
`DECISION (owner-delegated 2026-08-08).` The owner was given the three options and their
costs, and answered *"go ahead with the decision that you think would be best to make the
product as useful as possible"* — so the agent's recommendation was taken as the decision
rather than the question being left open. **ANSWERED: (c) — constrain, but only warn.**
Recorded this way, and not as an agent proposal, because the delegation was explicit and
the reasoning below is what it was delegated on.

This is the one that changes what the data means, which is why it is not agent-proposed.
Jira and ClickUp both offer to **push** a dependent task's dates when you move its blocker.
Adopting that turns `pm_task_links` from a description into a constraint:

* **(a) Describe only.** Drawing an arrow records the dependency and moves nothing. This is
  the straight extension of WS-27p, which states the position explicitly — *"blocked-ness is
  DERIVED and SHOWN, never enforced"* — on the argument that dependencies in a real workspace
  are frequently approximate, and a tool that will not let somebody finish work they have
  finished is a tool they route around. **Cost:** the chart will show arrows pointing
  backwards in time, because nothing stops a blocker being due after the task it blocks.
  Users read that as the feature being broken.
* **(b) Constrain, and auto-push.** Moving a blocker drags its dependents forward. What
  people expect from Jira. **Cost, and it is not small:** one drag becomes an unbounded
  cascade of writes across a project — every one of them a real `PATCH` with a
  `field_change` activity and a revert (§3.8), so a single gesture can produce fifty timeline
  rows and fifty notifications. It also directly contradicts WS-27p's stated position, so
  taking it means striking that paragraph rather than quietly living beside it.
* **(c) Constrain, but only warn.** The arrow goes red and the panel says "this starts before
  its blocker finishes"; nothing is written. Keeps WS-27p's position intact, kills the
  backwards-arrow complaint, and adds no cascade. **Cost:** somebody still has to do the
  rescheduling by hand, which is exactly the work (b) automates.

**Chosen: (c).** It is the only one of the three that neither contradicts a decision already
made nor lets one gesture write fifty rows, and it can become (b) later behind an explicit
per-project setting — whereas (b) cannot become (c) without taking a behaviour away from
people who have started relying on it. **WS-27p's position therefore stands unamended:**
blocked-ness is derived and shown, never enforced, and a schedule conflict is now shown the
same way — a red arrow and a sentence, with nothing written.

**What "useful as possible" actually argued for, since that was the brief.** The reflex
answer is (b), because auto-push is the feature Jira advertises. But the useful half of a
dependency is *knowing* — being told, at the moment you move something, that two tasks now
disagree. (b) delivers that and then also silently rewrites other people's dates, which is
where it stops being useful: the cascade lands in the timeline (§3.8) as fifty
`field_change` rows and fifty notifications with no single act to point at, and the first
time somebody's carefully-negotiated date moves without them touching it, they stop trusting
the dates. (c) keeps the information and drops the part that costs trust. **What it does not
do** is reschedule for you, and if that turns out to be the thing actually wanted, (b) is
still reachable — as an opt-in per project, with the cascade bounded and previewed before it
writes, which is a better version of (b) than the one that would have shipped today.

**D-PM-13 — Project docs live in the KNOWLEDGE BASE; PM links to them, never owns them.**
`DECISION (owner-answered 2026-08-09).` The Plane research (§11.19,
`plane_pm_research_2026-08.md` §6 Q2) surfaced that free-form project documentation was
owned by nobody: this spec assigned it to Notes, and `note_taker_app.md` §1.2 declines it.
The owner's answer, verbatim: *"we have separately a knowledge base, so somehow the PM tool
has to fit in with the knowledge base and be able to do that. Now everybody who creates a
knowledge base will own it, and if it's shared with multiple people or shared across the
team, then depending on the user access, they have access to the knowledge base document."*

What that binds, stated as the integration contract:

1. **PM never grows a docs surface.** Plane's Pages stays refused (P-30); the §5 non-goal
   is now permanent, not provisional. A "project doc" is a knowledge-base document that a
   project or task **links to**.
2. **The KB's access model is: creator owns; shared to people or a team; visibility follows
   the share.** That is grant-vocabulary shaped — the same `email | group:<slug> | org`
   subjects `pm_project_grants` already uses (D12) are the natural encoding of "shared with
   multiple people or across the team", and the KB should reuse that vocabulary rather than
   mint a second one.
3. **Two keys, never one.** Linking a KB document to a task does NOT widen the document's
   audience: a viewer sees the link's title/existence only if they satisfy the *document's*
   grants, independently of satisfying the task's. The converse also holds — a doc reader
   doesn't gain the task. R5 applies on both sides (a non-granted viewer gets 404, never a
   locked-item stub). This is the same two-door lesson S2-8 taught about assignees.
4. **The PM-side shape, when the KB exists as a store:** a `pm_task_links`-style reference
   row (task/project → KB doc id) rendered beside attachments in the panel, with the KB's
   own grant check resolving at read time — never a copied snapshot of the doc, which would
   silently fork access. Until the KB store lands, this decision blocks nothing in the
   beyond-parity queue; it exists so no ticket accidentally builds doc storage inside PM.

**D-PM-14 — Public read-only boards: DEFERRED.**
`DECISION (owner-answered 2026-08-09).` *"For now, let's leave out public read-only boards.
We will revisit it when needed."* Not built, not scheduled. The risk analysis to start from
when revisited is `plane_pm_research_2026-08.md` §6 Q1 — the anchor-capability-URL shape, a
physically separate route module with read-only models, no member-roster endpoint, per-board
kill switch, and the RLS-bypass point that must be resolved before `SET LOCAL app.tenant_id`.
Until then the gateway's posture is unchanged: no anonymous tenant-data read routes exist.

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

**WS-27d — UI + Center projections.** ✅ **BUILT 2026-08-06**
(`src/app/projects/` + the BFF proxy; 34 vitest cases, 6 mutants red).
One finding recorded: `featureForPath` is fed `usePathname()`, which carries **no query
string**, so `/projects?center=<slug>` never reaches the route guard — the slice URL is
gated on the bare `/projects` path. A first version of the registration test asserted the
query-string form and was wrong about the contract, not about the code; no speculative
query-stripping was added to the shared `access.ts` for a case that cannot occur.
Done when: (1) `/projects` renders tree + list + board + task panel + timeline against the
real API via the BFF proxy; (2) drag-drop writes fractional positions (one upsert per drop)
and cross-column drags patch the `column_by` field; (3) nav/access registration per §5 with
`tsc --noEmit` + vitest green; (4) the People Center sub-app flips live and each Center's
slice pre-filters by its group — with a vitest asserting the `?center=` param filters
presentation only.

**Authoring landed 2026-08-06** (`lib/assignees.ts` + edits to `page.tsx`, `ProjectTree`,
`TaskPanel`; 17 vitest cases, 7 mutants red). WS-27d shipped a UI that could **read and
drag but never create**: `createProject`, `createTask` and `setAssignees` existed in the
client and were wired to nothing, so a member could only work with rows a ClickUp import
had put there. Four surfaces close it, each placed where the answer already is:

- **New department** from the sidebar header, **new subproject** from a `+` on the node
  itself — the parent is on screen, and a dialog that asks "which parent?" is how a
  fifty-node tree acquires mis-parented rows.
- **New task** from a one-field row above the board. Status is deliberately **not sent**:
  the API picks the project's default (`create_task`), so the browser never has to know
  which lane a new task starts in.
- **Subtask** from the task panel. A subtask is a task with a parent (§3.5) — one endpoint,
  one table, so it inherits statuses, timeline and assignment whole.
- **Assignees** as removable chips plus one input. This is where **D-PM-4 stops being a
  schema note**: an agent and a person go in the same field, and the only difference on
  screen is an icon. Handing work to an agent is now literally the same gesture as handing
  it to a colleague — which is the precondition for WS-27f's dispatch being reachable at
  all, since `pm.task.assigned` is what it keys off.

Two details worth keeping: `withAssignee` returns the **same array** when the assignee is
already present, and the caller skips the PUT on that identity — a re-assert must not emit
`pm.task.assigned` and re-dispatch an agent run. And `parseAssignees` splits on commas,
semicolons and newlines but **never on spaces**, because a pasted `Priya <priya@x.com>`
would otherwise shred into tokens that assign work to nobody.

**WS-27e — the personal lens (one store).** ✅ **BUILT 2026-08-06**
(migration `147_projects_personal.sql`, `routes/projects/personal.py`; 31 hermetic cases,
6 mutants red). **Its shape changed with D-PM-6's revision** — this was specced as a mirror
into `gtd_items` and is built as a lens over `pm_tasks`, so the done-whens below are
restated against what was actually built rather than what the mirror would have owed.
Done when: (1) an assigned `pm_task` appears in the assignee's inbox **with no sync** —
same row, same id — with the correct derived disposition; (2) a member's triage cannot move
the team's board and a status change cannot overwrite a stated disposition, both proven
structurally; (3) completing from the inbox moves the shared status and writes the
transition's three effects; (4) two assignees hold independent dispositions; (5) a personal
project is created once, granted to its owner alone, and excluded from every team read;
(6) no route here accepts a `?member=` in any form.

**The surface landed 2026-08-06** (`src/app/projects/components/MyWork.tsx` +
`lib/mywork.ts`; 17 vitest cases, 7 mutants red). WS-27e had shipped API-only, which meant
the cohesion the revision bought was true in the schema and invisible to a member. **"My
work" sits above the project tree in the same app** — not a second surface and not a second
nav entry, because a personal lens reached from somewhere else re-teaches exactly the split
D-PM-6 was revised to remove. Four decisions worth recording, each of which could
reasonably have gone the other way:

- **Four lanes, not eight.** `INBOX | NEXT | WAITING | SOMEDAY` are work states and get
  lanes; `PROJECT | REFERENCE` are filing states and collapse into one "Filed" lane shown
  only when occupied; `DONE | TRASH` the endpoint already excludes. Eight lanes would make
  the daily view a filing cabinet.
- **Empty work lanes still render.** "You have triaged nothing into today" is a real and
  useful state, and a lane that vanishes when empty cannot say it. Only "Filed" hides.
- **Undated tasks sort BELOW dated ones.** A task nobody dated is not more urgent than one
  due tomorrow, and the opposite order is how a personal list stops being read.
- **Untriaged is stated in the row, not implied by a missing badge**, and counted in the
  header. That count is the Weekly Review's whole question and is only answerable because
  the server derives dispositions instead of storing them on first read (§3.12).

Completing from a row calls `POST /tasks/{id}/complete`, which moves the **shared** status
— the checkbox carries a title saying so. Triage buttons call
`PATCH /tasks/{id}/personal` and cannot touch a shared field. One repair the surface forced:
`TaskPanel` previously read the *selected project's* statuses, which is wrong for a task
opened from My work — it may belong to any project the member is assigned into — so the
panel's statuses are now resolved from the task's own root project.

**WS-27f — automation + agent dispatch.** ✅ **BUILT 2026-08-06**
(`routes/projects/automation.py` + `agent_dispatch.py`, the `pm_task` node type in
`workflows/engine/`, `PM_EVENT_TOPICS` in the catalog; 34 hermetic cases, 10 mutants red).
Both halves of `workflows_app.md` §13 — **U1** the task-mutation node, **U7** dispatch.
The node types land in `workflows_app.md`'s tree per D6 and are recorded there.

**Six decisions worth reading before changing any of it:**

- **The engine imports a service, not a route.** `apply_task_patch` is transport-free and
  reuses `apply_status_transition`, `update_row`, `record_activity` — so an automation's
  edit is *indistinguishable in validation* from a human's PATCH and lands the same
  timeline row. That is Paca's "mutate through the ordinary service" rule as code.
- **Status is named, never keyed** (`"Done"`, or the category as a fallback). Statuses are
  per-project rows, so a graph pinned to one project's status UUID could only ever automate
  that project — the opposite of what an automation is for. An unknown lane fails with the
  project's actual lane names in the message.
- **A `pm_task` node is NOT write-class.** The `write_without_approval` publish gate fires
  for `tool` nodes reaching *external* systems; an internal task move must not need an
  approval step. That exemption is now pinned by a test rather than true by accident.
- **"Already in target state" writes nothing** — and the test asserts **no `UPDATE` is
  issued**, not merely that no activity was written. `update_row` stamps `updated_at`, so a
  redundant write is invisible in a diff while leaving the task looking freshly touched;
  an automation firing on `pm.task.updated` would bump every task it inspected, forever.
- **Assignment is dispatch, from a sink.** `PUT /tasks/{id}/assignees` emits and returns;
  `agent_dispatch.on_event` is registered beside the workflows dispatcher. A slow or broken
  agent therefore cannot fail the act of assigning somebody a task. Only **newly added**
  assignees dispatch — `set_assignees` emits the added set, so a re-assert cannot start a
  second run, and both sides say so.
- **The handoff activity is committed BEFORE the run starts** (Paca's
  `agent.session.started`), and the failure path writes too. A dispatch that fails silently
  leaves a session that appears to be running forever and nobody knows to pick the work up.

**One engine defect found and fixed:** `templating.resolve_value` keeps an unresolvable
`{{ref}}` **as-is at run time by design**, and `{{trigger.missing}}` passes the publish gate
because its *root* is legal. The literal would have reached Postgres as a would-be uuid and
come back "Task not found", sending the maker to look for a task rather than at their
reference. The node now fails with `task id did not resolve: '…'`.

Done when: (1) an event-triggered workflow mutates a task and the target carries a
`pm_activities` row actored `system:workflow:<id>`; (2) unknown field and missing target
both fail at **publish** with named issues; (3) re-running against a task already in the
target state records a skip and writes nothing; (4) the node is served by
`GET /workflows/catalog` (D7); (5) assigning `agent:<name>` starts a run whose session is on
the task timeline within the same request.
Done when: (1) `pm.*` events reach `dispatch_event` (proven at the `emit_event` seam);
(2) the `pm.update_task` action mutates through the ordinary service and stamps
`system:workflow:<id>`; (3) assigning `agent:<name>` produces an orchestrator run, an
immediate `agent_run` activity, and a closing activity on completion/failure; (4) the
`skill-projects` tool family lets an agent read/update its assigned task under its own
identity, permission-intersected.

**WS-27h — `gtd_items` retirement.** 🟡 sequenced after WS-27e; the data move itself is
🔴 **OWNER-GATE** (it rewrites the owner's live task store).
Done when: (1) `/tasks` serves a union with no visible regression; (2) every `gtd_items`
row has a `pm_tasks` counterpart and the counts match per disposition; (3) the overlay
landed in `pm_task_personal` with dispositions preserved exactly; (4) `items.py`'s
owner-scoped predicates and the `gtd_*` task tables are gone. See §7.5.

**WS-27g — cutover + ClickUp retirement.** 🔴 **OWNER-GATE end-to-end** (final import,
parity sign-off, sync flips, consumer repoint, token revocation, constraint-8 amendment —
each registered in `work_plan.md` §6).

**WS-27t — the timeline, and dependencies you can draw.** ✅ **BUILT 2026-08-08.**
Was 🟡 blocked on D-PM-12; the owner delegated the choice back on 2026-08-08 and it is
answered as **(c) constrain-and-warn**, with D-PM-11 as **(b) hierarchy depth**. Both are
recorded in §8 with the alternatives they beat.

*Asked for directly, 2026-08-08:* **"a timeline view that can also make tasks and subtasks
dependent on each other, with wiring them to each other, similar to how it works on Jira and
ClickUp."** Two things, and the second is the one that matters — a Gantt chart with no
dependency gesture is decoration, which is precisely why Gantt was a non-goal until now.

**The data is already built.** This is a rendering-and-gesture ticket, not a schema one:

| Needed | Status |
|---|---|
| `start_date` (DATE) + `due_at` (timestamptz) on every task | ✅ migration 146, surfaced at WS-27q |
| `pm_task_links` with `blocks`, `CHECK(source <> target)` | ✅ WS-27a |
| Cycle refusal on `blocks` (`assert_no_block_cycle`, `MAX_DEPTH`-bounded) | ✅ WS-27p |
| Both-direction read with `direction` on each link | ✅ WS-27p `GET /tasks/{id}/relations` |
| Blocked-count and subtask progress per row, in one aggregate | ✅ WS-27s `attach_relation_counts` |
| Interval-overlap window query, timezone-safe | ✅ WS-27q `OVERLAPS` |
| Move a task's dates through the ordinary write path | ✅ WS-27q `rescheduleTo` → `PATCH /tasks/{id}` |

**What is genuinely new is three things.** (1) Bar geometry on a continuous date axis instead
of a day grid. (2) `GET /projects/timeline`, or an argument for why the calendar endpoint
serves both — it very nearly does, and the honest difference is that a timeline wants the
LINKS for every row in the window, which is one more aggregate of exactly the shape
`attach_relation_counts` already is. (3) The arrow gesture, which is the only part with no
precedent anywhere in this tree.

**Paca has the chart and not the wiring.** `apps/web/src/components/projects/interactions/
roadmap-view.tsx` (438 lines, Apache-2.0) is a real Gantt and worth taking the geometry from:
a sticky 280px task column beside a scrolling canvas, `PX_PER_DAY = 28`, month header cells
computed by walking `Date(y, m+1, 1)`, a today line, a range auto-fitted to the data with
seven days of padding either side, single-date tasks drawn as a one-day bar, and — the rule
this app would have arrived at anyway — **an undated task listed on the left with no bar**,
which is the same honesty §11.16 enforces with its `undated` count. It draws **no dependency
arrows at all** (zero matches for arrow/svg/path/depend) and is **entirely read-only** (zero
for drag/resize). So Paca answers "how do I lay out bars"; for the wiring, Jira and ClickUp
are the reference and the interaction is ours to design.

**Two decisions gate it.** **D-PM-11** — what earns a bar (agent-proposes hierarchy depth,
owner may overrule). **D-PM-12** — whether an arrow constrains the schedule or only describes
it (**owner-answer required**; the agent recommends *warn, do not push*, because auto-push
contradicts WS-27p's stated position and turns one drag into an unbounded cascade of real
`PATCH`es, each carrying a `field_change` activity and a notification).

**Done when:** (1) a timeline view renders every task in a window as a bar from `start_date`
to `due_at`, with undated tasks listed and unbarred; (2) `blocks` links are drawn as arrows
between bars, in the direction WS-27p already stores; (3) dragging from one bar to another
creates a `blocks` link through the existing endpoint, and a drag that would close a cycle is
refused with `assert_no_block_cycle`'s existing message rather than a new one; (4) whatever
D-PM-12 decides is implemented and its rejected alternatives are recorded; (5) the board's
filters apply, and the parameter-coverage test §11.16 added is extended to the new endpoint
so a filter cannot be dropped silently; (6) the geometry is pure and tested — including
across at least three timezones, the WS-27q lesson.

**Not in scope:** resizing a bar by dragging its edge (a second gesture with its own
half-day/rounding questions), critical-path computation, and baselines. Each is a separate
decision, and none of them is what was asked for.

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

---

## 11. ClickUp parity — the measured gap, and how it gets closed

> **Added 2026-08-06** against the owner's standing requirement: *"I want to be able to do
> everything that I was doing from ClickUp and more."* WS-27g retires ClickUp, and it cannot
> honestly be called until this list is short. **Measured against the built tree** (twelve
> `pm_*` tables, 34 endpoints) rather than recalled — every "have" below is a table or a
> route that exists today.

### 11.1 What is already there

Hierarchy (departments → projects → subprojects → tasks → subtasks, two self-FKs) ·
statuses-as-data with a semantic category · task types · assignees in one vocabulary for
people **and** agents · comments and a single activity timeline **with field-level revert** ·
`blocks | relates_to | duplicates` links · per-view fractional ordering · board and list
surfaces · the personal lens · grant scoping with Center projections · the ClickUp importer ·
a `pm_task` automation node and assignment→agent dispatch.

Several of those ClickUp does **not** have — revert, agents as assignees, per-Center
projections of one board. That is the "and more" half, and it is already true.

### 11.2 What is missing, in the order it hurts

Ordered by *what stops somebody using this instead of ClickUp on a Monday*, not by how
interesting it is to build.

| # | Gap | Why it blocks | Ticket |
|---|---|---|---|
| 1 | ~~**Attachments**~~ | — | **WS-27i ✅ BUILT 2026-08-06** |
| 2 | ~~**Notifications + @mentions**~~ | — | **WS-27j ✅ BUILT 2026-08-07** |
| 3 | ~~**Filters, grouping and saved views**~~ | — | **WS-27k ✅ BUILT 2026-08-07** |
| 4 | ~~**Custom fields**~~ | — | **WS-27l ✅ BUILT 2026-08-07** |
| 5 | ~~**Tags**~~ | — | **WS-27m ✅ BUILT 2026-08-07** |
| 6 | ~~**Bulk edit / multi-select**~~ | — | **WS-27n ✅ BUILT 2026-08-07 · unblocks g** |
| 7 | ~~**Recurring tasks**~~ | — | **WS-27o ✅ BUILT 2026-08-07** |
| 8 | ~~**Dependency and subtask UI**~~ | — | **WS-27p ✅ BUILT 2026-08-07** |
| 9a | ~~**Calendar view**~~ | — | **WS-27q ✅ BUILT 2026-08-08** |
| 9b | **Timeline view** (Gantt bars on a date axis) | The calendar answers *what is due when*; it cannot answer *what runs alongside what*, which is the question a multi-month project asks | **WS-27t** |
| 10 | ~~**Global task search**~~ | — | **WS-27r ✅ BUILT 2026-08-08** |
| 11 | ~~**The card looks nothing like /tasks'**~~ | — | **WS-27s ✅ BUILT 2026-08-07** |
| 12 | **Dependencies cannot be drawn** | `blocks` exists and is cycle-guarded, but wiring one means a dropdown and a task number in a panel — Jira and ClickUp make it a drag between two bars | **WS-27t** |

**Deliberately NOT on this list:** sprints (a stated non-goal, §1), and time tracking and
checklists (Paca moved both out of core into plugins — the growth path is subtraction). If
any is wanted, it is a decision to record, not an omission to fix.

~~and Gantt~~ — **REVERSED 2026-08-08, owner-asked.** Kept struck rather than deleted
because the reversal is the interesting part: the original note treated Gantt as decoration,
which is true of the *chart* and false of the thing the owner actually asked for — a surface
where a dependency is DRAWN rather than typed. `pm_task_links` has been cycle-guarded since
WS-27p and reachable only through a dropdown and a task number; the chart is the gesture's
excuse to exist. Recorded as it should have been: a decision, in **D-PM-11** and
**D-PM-12**, with a ticket (**WS-27t**) that does not start until D-PM-12 is answered.

### 11.3 Sequencing, and the one dependency that matters

**WS-27n (bulk edit) gates WS-27g — and as of 2026-08-07 it is built (§11.11), so this
dependency is satisfied.** The cutover imports a real workspace, and an import that cannot be
re-triaged in bulk is an import somebody abandons halfway — leaving two live systems, which is
the exact state the retirement exists to end. It was built before the cutover, as required.
WS-27g itself remains 🔴 OWNER-GATE for its own reasons (§6), which this does not change.

**1 → 2 → 3 are the daily-use tier** and should go first as a block: a member who can
attach a file, hear about an assignment, and filter their board can run a day here. 4-5
(custom fields, tags) are the *modelling* tier — they change what a task can say. 6-10 are
reach.

Every one is 🟢 **AGENT-SAFE** to build. The gates stay where they already are: running the
importer against production, confirming a Space→Center mapping, and the WS-27g cutover are
owner acts (`work_plan.md` §6), and nothing in §11 changes that.

### 11.4 WS-27i — attachments (built 2026-08-06)

Migration `150_projects_attachments.sql`, `routes/projects/attachments.py`, the Files
section of the task panel. 25 hermetic cases, 10 mutants red.

**One file store, not two.** `gtd_attachments` already IS Paca's "central files registry"
(research §2.7) — owner, name, mime, size, path — so the bytes and the upload rules are
**imported** from the capture flow rather than copied. A second table with a second storage
directory would have meant two places to back up, two size limits to keep in step and two
answers to "is this extension allowed".

**What differs is who may READ, and that is the entire reason for the join.**
`gtd_attachments` is owner-scoped end to end; `pm_task_attachments` makes a file readable by
anyone who can see a task it hangs off. Two consequences, both security properties rather
than conveniences:

- **There is no attach-by-id endpoint.** Upload and attach are one call. A caller who could
  name an arbitrary `attachment_id` could attach somebody else's private capture to a task
  they own and read it back — privilege escalation dressed as a feature.
- **A personal capture stays unreachable here**, because it has no join row.

Detaching **keeps the bytes**: the same file may hang off another task, and deleting the row
from under it would turn one person's tidy-up into somebody else's broken link. Detaching
something already gone is a no-op, not a 404 (Paca's lenient-removes lesson, research §6).

**A bug caught before it shipped:** the projects BFF proxy re-serialised every POST as JSON.
A multipart upload would have failed `req.json()`, fallen into the `catch(() => ({}))`, and
reached the gateway **with no file at all — while still answering 201**. The proxy now passes
a non-JSON body through byte-for-byte. `workflows_app.md` §3.3b documents the identical trap
for HMAC-signed webhook bodies; this was that trap on the upload path.

**A test that was asserting the wrong thing:** the first traversal test checked the file's
path on disk, which is safe *by construction* (`<uuid><suffix>` — the supplied name never
reaches it), so a mutant removing `_safe_name` entirely survived. What that function actually
protects is the **stored name**, which is echoed into the descriptor, rendered in the UI, and
handed to `FileResponse(filename=…)` — i.e. into a `Content-Disposition` header, where
separators, quotes and newlines matter. Both properties are now asserted separately.

### 11.5 WS-27j — notifications and @mentions (built 2026-08-07)

Migration `152_projects_notifications.sql`, `routes/projects/notifications.py`, the bell in
the Projects header, the mention picker in the comment box. 39 hermetic + 27 vitest cases,
10 mutants red.

**Three rules decide who hears, and each one is the whole reason for a rule.**

1. **Never the actor.** A bell that pings you about your own click is a bell people mute,
   and a muted bell notifies nobody about anything.
2. **Never an agent.** Agents are handed work by the WS-27f dispatch sink, which starts a
   run. A row addressed to `agent:<name>` would sit unread forever and inflate a badge
   nobody could clear. Enforced in Python **and** by a CHECK, because a row that reached the
   table another way would still be wrong.
3. **Never somebody who cannot open it.** This is the security property. A notification
   carries the task's title, so delivering one outside the project's grant closure leaks
   that title and lands the recipient on a 404. The comment still posts; the response names
   who was skipped, and the UI says so — silently dropping a mention would leave the author
   believing a colleague was pulled in.

**Rule 3 needed new machinery, and the machinery is the point.** `resolve_visibility` reads
a `UserContext`; the recipient of a mention has no request in flight. `resolve_visibility_for`
answers for a third party by reading the same tables `/auth/me` reads and handing them to the
**real** `build_access`, so a wildcard grant (`*`, `data:*`) and an allow/deny override
resolve identically on both paths. Re-deriving that precedence in SQL is how two answers to
"may they see this" start disagreeing.

**Written inside the transaction, not emitted on the bus.** `core.emit` swallows failures by
construction so a broken workflow can never fail a task edit — right for agent dispatch,
where a missed run is recoverable, and wrong here. An assignment that committed while its
notification did not is exactly the silent assignment this ticket closes.

**A mention is an ADDRESS, not a name.** Migration 148 dropped `UNIQUE(name)` on the argument
that two real people share one, so `@Priya` has no answer and guessing would ping the wrong
person about work that is not theirs. The picker inserts `@priya@fracktal.in` so nobody types
it; the browser's pattern is deliberately the same one the gateway parses, because a composer
that highlighted names the server ignores would promise notifications nobody receives.

**Audience is derived, not subscribed.** A comment reaches the task's assignees and its
author. A `pm_task_watchers` table is the fuller answer and is not this ticket — and this is
the set one would be seeded from, so nothing here has to be undone when it arrives.

**Two bugs found on the way in, both shipping at the time:**

- **Every project-task file upload was answering 422.** `core.ACTIVITY_TYPES` mirrors
  `pm_activities`'s CHECK by hand, and `record_activity` refuses an unknown type *before* the
  insert. Migration 150 added `attachment` to the database; the tuple was never updated. All
  25 attachment tests passed throughout, because they monkeypatch `record_activity` — the
  seam under test was mocked out. Fixed, with two tests that read the migrations rather than
  restating them: one asserting set equality with the CHECK, one grepping every
  `activity_type=` call site in the package.
- **`/projects?task=<id>` did nothing.** The People Center's "Open work" list has linked
  there since WS-28b and landed on an unchanged board, because the page never read the
  parameter. The bell needed the same entry point, so it is now wired.

### 11.6 WS-27b's missing UI — the import was unreachable (built 2026-08-07)

`routes/projects/import_clickup.py` shipped with WS-27b and **no way to call it
from the product**. The empty state read *"No projects yet. Create one, or
import a ClickUp workspace"* — naming an action that had no control anywhere in
the app. So a new install stayed empty, and the fastest route to real data was
a curl command.

`components/ImportClickUp.tsx` + `lib/importPlan.ts` close that. 18 vitest
cases, 3 mutants red.

**Three steps, and only the last one writes.** Preview (`/import/clickup/plan`)
reads the live tenant and lists every Space with its folders, lists, tasks and
people, plus the proposed Center and the evidence for it. Dry run
(`/import/clickup {dry_run:true}`) exercises the whole path — including the
Space→Folder→List flattening — and reports what it *would* create. Import is
the same call with the flag off, on a button that says "writes".

**The mapping is still the owner's act (D-PM-10), and the UI is built so it
stays one.** The suggestion is pre-filled and shown beside its confidence *in
words* — "a guess — check it" rather than `0.45`, because a bare number invites
acceptance without looking. A **confirmed** mapping always beats a fresh
suggestion, so re-running never silently re-maps a Space somebody already ruled
on; that is the mutant most worth having red.

**Unmapped Spaces are a notice, not a blocker**, matching the importer's own
behaviour: they import in full and stay reachable, and refusing them would make
the mapping a precondition of seeing the data you need to decide the mapping.

**`already_present` is reported, never hidden.** The upsert is idempotent and
re-running is the normal case; "0 created" with no mention of the 400 rows it
matched reads as a failure of the import rather than a success of the last one.

⚠️ The owner gate is unchanged and is now exactly one click: **building** this
was agent-safe, **pressing Import** is the owner's act, and no agent has run
either endpoint against production.

### 11.7 The Tasks-app mirror path (built 2026-08-07)

Owner-directed: *"just show up all the data that is there in the Tasks app
inside the Projects app"* — one department now, real departments later.

`POST /projects/import/from-tasks` + `routes/projects/import_tasks.py`. 43
hermetic cases, 7 mutants red.

**Why a second importer rather than a flag on the first.** `import_clickup.py`
talks to the live tenant: it needs a working token, spends LLM budget proposing
a Center per Space, and asks the owner to confirm a mapping *before* anything is
written. That is the right shape for the migration and the wrong shape for "show
me my work today" — being made to decide who may see what before you have seen
the data is backwards. This one reads `gtd_projects` and `gtd_items`, the
ClickUp mirror the Tasks app already holds, so there is no API call, no token,
no rate limit and no model spend, and it works when the connector is stale.

**One department, and the real ClickUp shape beneath it.** Everything lands
under a single root the caller names; below that, **Space → Folder → List** are
rebuilt as projects, each carrying its own `clickup_id` and `clickup_kind` —
the same flattening `import_clickup` performs, so both paths produce one shape.
Promoting a Space node to a root is how the department split happens later: one
`/move`, not a re-import.

⚠️ **The placement comes from `task_accounts.schema_cache->'hierarchy'`, not
from `gtd_projects.space_id`.** Migration 60 defines that column as LOCAL-only
and it is *always NULL* on the synced rows this importer reads.

**The root IS org-granted, and that is narrower than it sounds.** §11.6's
importer deliberately does not org-grant unmapped Spaces, because bulk-granting
a whole tenant is a large implicit decision. Here the caller named one
department and asked for their work inside it — the same act as
`tree.create_node`, which org-grants for exactly the reason a solo org must not
be locked out of the thing it just made.

**Four properties the tests pin, each a way this could quietly do harm:**

1. **Nothing outside `pm_*` is written.** The Tasks app's rows are the mirror
   and must survive untouched, or an import would damage the personal task
   manager it read from.
2. **Only `source <> 'LOCAL'` rows are read.** A personal capture is the
   member's own; publishing it to a shared board is a disclosure nobody asked
   for.
3. **The provider's own status names are kept**, mapped to our categories.
   Renaming somebody's "Backlog" to "To do" makes the board stop matching the
   tool it came from on day one.
4. **A task whose list did not come across is counted, not dropped.** "412
   imported" while 30 were silently skipped is a number that gets trusted and
   should not be.

**Three defects a real Postgres found that the hermetic suite could not.**
Run against a scratch database with the full migration set and a seeded mirror:

1. **`gtd_projects.space_id` is LOCAL-only.** The first version read it for the
   Space, so every import would have recorded `null` — a promise in the
   docstring, the commit message and the PR body that was never true.
2. **`pm_projects` has no `clickup_snapshot` column** (only `pm_tasks` does).
   The first real click on "Bring it all in" would have answered 500. A fake DB
   accepts any column; Postgres does not. This shipped in #393 and was fixed
   before anybody pressed the button.
3. **The preview under-counted.** It reported 4 projects where the run then
   created 7, because Space and Folder nodes were only tallied on the write
   path — a number somebody would have read out loud during a demo.

Verified end to end afterwards: the tree comes out
`Fracktal Works / Engineering [space] / Hardware [folder] / Enclosure [list]`,
statuses keep their ClickUp names, assignee emails lowercase, a LOCAL capture
("Buy milk") stays out, `gtd_*` is untouched, and a re-run reports
`created: 0, already_present: 4`.

**A gap mutation testing found, worth recording.** Deleting `dry_run` from the
write guards left every test green: on a *first* dry run `_root_department`
returns `None`, so `root_id is None` blocks the write and the `dry_run` check
beside it never has to do anything. On a **second** dry run the department
already exists and its id comes back regardless — and the projects resolve too —
leaving `dry_run` as the only thing between a preview and a write. That is the
realistic case (preview → import → preview again), and it now has its own test.

### 11.8 WS-27k — filters, grouping and saved views (built 2026-08-07)

*"My open bugs in Ops, grouped by assignee"* is the sentence §11.2 used to name the gap. It
is now typeable: `routes/projects/filters.py`, `lib/grouping.ts`, `components/FilterBar.tsx`,
with the board and the list both drawing whatever `groupTasks` returned. 34 hermetic + 24
vitest cases, 13 mutants red, and 23 checks run against a real Postgres.

**One filter builder, shared by the endpoint and by saved views.** A saved view is nothing
but a stored set of these filters. Two implementations would drift, and a *saved* view that
shows a different set of tasks than the same filters typed by hand is the one thing it may
not do — so `build_task_filters` is a pure function that both paths call, and the test that
says so compares the two outputs directly.

**Every filter is a WHERE clause.** Pagination happens in SQL. A filter applied in Python
after `LIMIT` returns short pages, and *"page 2 is empty but there are 40 more"* is the kind
of bug people work around for months instead of reporting.

**`overdue` means past due AND still open.** A finished task with a past due date is not
overdue, it is done. Colouring it red forever is how a board teaches people to ignore red.

**An unknown status category is a 422, not an empty board.** A client filtering on
`in-progress` (hyphen) would otherwise see nothing and conclude the project is empty. The
error names the five real categories, which is the whole difference between a typo that takes
five seconds and one that takes an afternoon.

**An unknown config *key* is dropped; an unknown *value* falls back.** Those are different
failures. A view is a saved preference written by an older client, so refusing to open one
because it carries a key this version has never heard of would turn every deploy into a
migration of everybody's saved views. A bad `group_by`, on the other hand, still has to
render something, and `status` is the board's own axis rather than a guess.

**A task with two assignees appears in BOTH columns.** It is both people's work; picking one
arbitrarily hides it from the other. The consequence is that group sizes sum to more than the
task count, which is why the header counts tasks.

**Empty status lanes are kept; every other grouping drops empties.** A board missing its "In
progress" column reads as *"this project has no in-progress state"*, not *"nothing is in
progress"*. There is no equivalent meaning to an "assignees with nothing assigned" column.

**Dragging is offered only when the columns are statuses.** A drop writes the field the
columns represent, and status is the one that is a plain `PATCH status_id` — assignees are a
separate PUT, priority is an integer, and moving a task between projects crosses a grant
boundary. A card that can be dragged into a column which cannot accept it, and snaps back, is
worse than a column that is honestly static.

**`toConfig` is deliberately not `toQuery`.** A query string carries only text, so `toQuery`
writes `"true"`; a config is JSON and keeps a boolean a boolean. `fromConfig` refuses a string
where a toggle belongs — a hand-edited `"false"` must not read as on — so a view built from
query shape would come back with every toggle silently cleared. That round trip is a test.

**The project's order-bearing board is withheld from the chips.** `tree.py` seeds two views
per project, and the `board` one owns every `pm_view_task_positions` row. Offering its ✕
would offer to delete every hand-arranged position on the project. Saved views sit at
position 300, above the seeded pair, so `orderBearingView` — one function, used by both the
drag handler and the delete guard — keeps answering the seeded board.

**A fifth live bug, found the same way as the previous four.** `due_before` was
`t.due_at < CAST(:due_before AS timestamptz)` with the string straight off the query string.
asyncpg infers the parameter's type *from that cast* and then refuses to encode a `str`, so
the query never reached the database and **`?due_before=…` answered 500** — while the
hermetic fake, which agrees with whatever SQL it is handed, stayed green. `parse_when` now
parses on this side and binds a real `datetime`, an unparseable value is a 422 that says what
was expected, and a naive value is read as UTC rather than inheriting the connection's
TimeZone. Two tests: one on the bound value's *type*, one refusing any `CAST(:param AS
timestamp…)` anywhere in the builder, so the next `after=` filter written the obvious way
fails in CI instead of in production.

### 11.9 WS-27l — custom fields (built 2026-08-07)

ClickUp's signature feature, and the fourth row of the parity backlog. Migration
`155_projects_custom_fields.sql`, `routes/projects/custom_fields.py`, `lib/customFields.ts`,
a field block in the task panel and a manager dialog behind **Fields** in the header. 47
hermetic + 36 vitest cases, 23 mutants red, 35 checks against a real Postgres.

The shape is the one §5's non-goals recorded as the additive path: **definitions in a table,
values denormalised onto the task as JSONB keyed by `field_key`.**

**Why not a row per (task, field).** That is the textbook EAV answer and it costs a join per
field on every board paint — five custom fields across two hundred imported tasks is a
thousand rows to gather and re-pivot, per render. The JSONB column arrives with the task for
free, which is what makes the denormalisation worth its cost.

**What the denormalisation costs, stated rather than discovered.** A value is not
referentially tied to its definition, so the *database* cannot stop a key no definition owns
from being written. That guarantee moves into Python, and it is why the validation is the
feature rather than a formality:

* **An unknown key is a 422**, not a silent drop. A typo that no-ops looks exactly like a
  save, and the sender finds out weeks later.
* **A patch MERGES.** A client that knows about three of five fields must not wipe the other
  two by sending what it knows — and an older client, or an automation written before a field
  existed, is precisely that client.
* **An explicit `null` CLEARS the key**, removing it rather than storing a null. It is the
  only way to express "unset this", and a stored null would make "never filled in" and
  "deliberately emptied" the same value in every filter downstream.
* **`true` is not the number 1.** `isinstance(True, int)` is True in Python, so a number
  branch reached before the boolean one accepts both, in both directions. The coercers are
  one-per-type in a dispatch dict specifically so that ordering cannot be undone by accident.

**The deliberate departure from Paca: deleting a definition strips its values.** Paca's
research notes record "deleting a definition does not clean task data" as an accepted cost
(§2.3). It is not accepted here. A key left behind in the JSONB is invisible — no definition
means no column, no form row, no filter — right up until somebody creates a field with the
same name, and then every old value resurfaces carrying the new meaning. The count of tasks
cleared is reported (R7/R8), for the same reason `delete_view` reports its cascade.

**Two things a definition may not change once values exist**, both because the stored values
would stop meaning what they say: **`field_key` is never editable** — it is the identity
every value is filed under, and changing it orphans the lot in one statement — and
**`field_type` is refused with a 409 naming the count**, because "Customer" going from text to
select cannot re-interpret what is already written. Dropping a *select option* some task still
holds is refused the same way; adding one is free. The UI shows the derived key while the name
is still being typed, since that is the last moment anybody can change it.

**Custom fields are revertible, which makes them first-class.** `patch_task` folds a custom
edit into the SAME `field_change` activity under namespaced keys (`custom.<key>`) rather than
inventing an activity type — `record_activity` refuses a type the migration's CHECK does not
list, the trap that made every attachment upload answer 422, and a custom field changing *is*
a field change. Revert then restores it by **merging onto what the task holds now**, never by
writing back the whole object: another field may have been edited since, and replacing the
blob would silently undo that too — a revert that reverts more than it names.

**A bug this ticket's own tests caught before it shipped.** `changedValues` compared a form's
boolean against a `null` baseline, so a task with an unanswered checkbox sent `open: false` on
*every* save and posted a timeline entry for an edit nobody made. A checkbox has no "unset"
state to render — an unticked box and a never-answered field are the same pixels — so `false`
is the baseline for a boolean and `null` for everything else.

**A fence that was quietly a subset check.** `test_projects_routes` asserted that a list of
paths was mounted, which catches the module somebody remembered to add a path for — i.e. the
one least likely to have been forgotten. It now also reads the package directory and asserts
that **every module declaring a `@router` route is imported by `__init__.py`**, which is the
trap `department_centers.md` C1 documents: a module left out mounts nothing while every test
that calls its functions directly still passes. Verified by deleting the import and watching
it fail.

### 11.10 WS-27m — the tag registry (built 2026-08-07)

The fifth row of the parity backlog, and the one the research notes left open **on purpose**.
`paca_pm_research_2026-08.md` row 13 REFUSED Paca's model — *"a bare jsonb string array on
tasks. No registry, no colors, no rename/merge — the weakest part of Paca's model; don't copy
it as-is"* — and §5's non-goals shipped `pm_tasks.tags TEXT[]` in its place with a registry
named as additive later. This is that registry.

Migration `156_projects_tags.sql`, `routes/projects/tags.py`, `lib/tags.ts`, a picker in the
task panel, a tag row in the filter bar, a `tag` axis on the board, and a manager behind
**Tags** in the header. 31 hermetic + 37 vitest cases, 16 mutants red, 30 checks against a
real Postgres.

**The array stays.** The obvious "proper" alternative is a join table, and it is the wrong
trade here for the same reason §11.9 gave for custom fields: the array arrives with the task,
and its GIN index (146) already answers *"tagged X"* without touching another relation. A
join table would add a row per tag per task and a join to every board paint, to buy
referential integrity this app can enforce in one place instead.

**What the registry buys, given that:**

* **One spelling per tag.** "Bug", "bug" and "BUG" are one tag, so filtering by it finds all
  of it rather than a third of it. The task's array stores the **registry's** display form,
  which is what makes that true rather than aspirational — and what lets a rename be one
  statement. Identity is case-insensitive (a unique index over `lower(name)`, so two racing
  requests cannot create both); display is case-preserving.
* **Rename**, which rewrites every task wearing the tag and reports the count.
* **Merge**, which is the answer to the real failure mode of free tagging.
* **A colour**, so a board can show a tag rather than spell it.

**Applying an unregistered tag REGISTERS it.** Refusing would make tagging a two-step errand —
leave the task, create the tag, come back — which is how tagging gets abandoned, and an
abandoned tag set is worse than a messy one. **The cost, stated: every typo becomes a tag.**
Which is exactly why merge is here and is not optional, and why the picker *shows* the moment
of creation ("Create …") rather than minting silently.

**A rename onto an existing name is a 409, not a silent merge.** They are different operations
with different outcomes — a merge destroys one tag — and quietly doing the destructive one
because the names collided is the kind of surprise that stops people using a rename button.
The error names the tag that is in the way and points at merge.

**A task carrying BOTH tags ends a merge with the target once.** That is the case that is easy
to get wrong, and getting it wrong leaves a duplicate that renders twice and survives the next
merge too. `merged_tags` is a pure function precisely so that case can be asserted directly —
and it is why the rewrite runs over the affected rows in Python rather than as an
`array_replace`, which would leave the duplicate.

**Two tag filters, because both questions get asked and one cannot answer the other.** `tags`
is ANY (`&&` — *"bugs or regressions"*), `tags_all` is ALL (`@>` — *"the ones that are both"*).
Collapsing them into one parameter would silently pick a meaning, and with three tags the two
answers differ by almost everything. Both use the operators the existing GIN index serves.

**On the board, a task with three tags appears in three columns** — the same honesty as a task
with two assignees appearing in both theirs (§11.8).

**The migration backfills, and rewrites data — deliberately, and narrowly.** `tags` has been on
`pm_tasks` since 146 and the import path writes them, so an empty registry beside a tagged
corpus would mean the first rename found nothing and the manager showed nothing. The winning
display form is **the spelling people actually use** (the most frequent), ties broken
deterministically — `min()` alone would canonicalise a corpus of 400 "Bug" to a single stray
"BUG". Task arrays are then made to agree with the registry: it only ever replaces a tag with
a different *casing* of the same tag, the meaning is identical, and the count is reported in a
NOTICE. Leaving it undone would make the registry's central claim false on day one.

**A bug the live run caught in that block.** The canonicalisation used
`FROM pm_tasks t, unnest(t.tags) AS tag LEFT JOIN pm_tags g ON … t.root_project_id …` — with
the implicit comma form the `LEFT JOIN` binds only to `unnest(...)` and `t` is not in scope
for its `ON` clause, so the migration aborted with *"invalid reference to FROM-clause entry
for table t"*. Rewritten as `CROSS JOIN LATERAL … WITH ORDINALITY`, which also fixed a second
problem the first version would have shipped: `array_agg(DISTINCT ...)` sorts by its own
expression, so every task's tag list would have come back alphabetised.

### 11.11 WS-27n — bulk edit (built 2026-08-07)

The sixth row of the backlog, and **the one §11.3 names as gating WS-27g**. That dependency is
now satisfied: the cutover imports a real workspace, and an import that cannot be re-triaged
in bulk is one somebody abandons halfway, leaving two live systems — the exact state the
retirement exists to end.

`routes/projects/bulk.py` (`POST /projects/tasks/bulk`), `lib/selection.ts`,
`components/BulkBar.tsx`, plus checkboxes on the board and the list. 35 hermetic + 32 vitest
cases, 16 mutants red, 34 checks against a real Postgres. **No migration.**

**It reuses `automation.apply_task_patch` rather than growing a second writer.** That service
exists because WS-27f needed a task edit *indistinguishable in validation from a human PATCH*;
a bulk endpoint with its own field handling would be a third opinion about what a task edit is,
and three opinions drift. Assignees and tags are separate write paths on the task, so those
are handled here — once, and through the same registry the panel uses, because the tag
registry cannot be true if bulk is a second door into the array.

**Status is named, never keyed — and here that is load-bearing rather than stylistic.** A
selection can span projects, and a status id belongs to exactly one root. Sending `status_id`
for fifty tasks across three projects would put two thirds of them in a lane that is not
theirs, or fail on the foreign key. `status_id` in a bulk patch is therefore a 422 with its
own message, because it is the mistake somebody makes by copying a single-task PATCH body and
"unknown field" would not explain why the thing that works on one task is refused on fifty.

**Assignees and tags are ADD/REMOVE, never SET.** "Assign these to Priya" means *also* Priya;
a replace across a selection wipes every individual assignment the fifty tasks already
carried. The destructive spelling is absent rather than merely discouraged.

**Shape is validated once, up front; outcomes are per task.** Those are genuinely different
failures. A field nobody can set is the same mistake for every task in the selection and earns
a 422 before anything is written. A status name that exists in one project and not another is
a fact about *that task*, and failing the whole batch for it would make a mixed selection
unusable — which is precisely the selection somebody makes after an import.

**A task the caller cannot see is skipped, not an error** (R5). Reporting it per id says
exactly what a per-id 404 would say and nothing more; aborting instead would let a caller
probe for existence by watching whether the batch failed. **One transaction**, because partial
application is the worst outcome available: a re-triage that half-happened is harder to
recover from than one that did not, since nobody can tell which half.

**Re-asserting a value is not a change.** Fifty tasks that were already Priya's would each
gain a timeline entry saying nothing, and a bulk edit reporting "50 changed" when it changed
nothing is one whose count nobody can trust. `moved_people` is pure so that claim is asserted
directly.

**One notification per person per batch, not one per task.** Being handed fifty tasks should
ring once and say fifty. Fifty bells is a bell people turn off, and a muted bell notifies
nobody about anything — WS-27j's own argument, applied to the case that would have broken it.

In the browser, the selection is **pruned whenever the filter changes**: selecting forty,
narrowing to three and pressing Done must not act on thirty-seven tasks nobody can see. A
shift-click ranges over the board's *on-screen* order (after filtering and grouping), and a
task drawn in two columns — a two-assignee card, §11.8 — counts once. The outcome line names
every category including the boring ones, because "47 changed" against "I selected 50" is a
support conversation, whereas "2 already like that, 1 not available" is a sentence somebody
already read.

### 11.12 A shipped notification bug this ticket uncovered

Building bulk assignment surfaced a defect in WS-27j that had been live since it shipped.

**There are two ways to see a task** — a grant on its project, or being an assignee of it —
and `core.task_visibility_clause` says so in one place, with a docstring warning that a second
implementation "would drift the moment one is edited alone". `notifications.deliverable` had
drifted exactly that way: it probed only `vis.project_clause('t.root_project_id')`.

Two consequences, both silent:

1. **Anybody assigned work in a project they hold no grant on was judged undeliverable.** They
   could open the task — `get_task` uses the shared clause — but the assignment that put them
   there notified nobody, and the response told the assigner they could not see it. That is
   the silent assignment WS-27j exists to end, still open for the most common case in a
   grant-scoped app: delegating outward.
2. **Scoping to `root_project_id` also missed a grant made on a SUBPROJECT.** The old test
   asserted that scoping, on the argument that "probing `project_id` would miss a grant made
   on an ancestor" — which is backwards, and running it against a real Postgres is what showed
   it: the grant closure is recursive and expands *downward*, so `project_id` catches an
   ancestor grant, while `root_project_id` is the one that misses a subproject grant.

`deliverable` now uses `task_visibility_clause`. The test that encoded the wrong reasoning has
been replaced with one that records why it was wrong, and a second asserts the shared clause
still carries both branches.

**A fake collision the fix exposed, worth recording.** The hermetic suite's `FakeDB` matched
the rule-3 probe by substring. The new clause embeds both `pm_task_assignees` and the
closure's `UNION`, which is exactly the fingerprint the *audience* branch used — so
`deliverable` received a list of assignees where it expected a visibility answer, and four
tests failed for a reason with nothing to do with the code under test. The probe is now
matched first and the audience branch keys off `assignee AS who`, which only its own query
has. A fake that dispatches on substrings needs its fingerprints to be *specific*, not merely
present.

### 11.13 WS-27o — recurring tasks (built 2026-08-07)

*"Every operations cadence is recurring. Without it those live in someone's head or in
ClickUp."*

Migration `160_projects_recurrence.sql`, `routes/projects/recurrence.py`, `lib/recurrence.ts`
and a repeat row in the task panel. 45 hermetic + 27 vitest cases, 31 mutants red, 39 checks
against a real Postgres.

**No scheduler — and that is forced rather than chosen.** §5's non-goals: *"A second
automation engine. ADR-028/D6: `/workflows` is the only engine; WS-27 contributes events and
node types to it."* A recurrence worker here would be exactly that second engine. So the
successor is created **when a task closes**: `apply_status_transition` already owns that
moment, which means a task finished from the board, from My work, from an automation or from a
bulk edit all recur identically. A second call site would be a fifth way to finish a task that
forgets to.

**What that costs, stated rather than discovered.** A series only advances when somebody
finishes the current one. A monthly report nobody closes does not pile up twelve copies —
which is right — but a daily stand-up nobody ticks does not appear tomorrow, which is the
honest limitation. Materialising ahead of time is already reachable through the engine that
owns scheduling (a cron trigger plus the `pm_task` node WS-27f added), so nothing here has to
be undone to get it.

**The anchor is per rule, because the two answers mean different things.** `due` keeps the
schedule — "stock count on the 1st" stays on the 1st however late the last one was closed, so
the series does not drift. `completed` measures the interval from when the work was actually
done — "water the plants every 3 days" restarts when you water them. Neither is a sensible
global default. A `due` anchor also **catches up**: a monthly task closed six weeks late would
otherwise produce a successor already overdue the moment it appeared, which teaches people the
date is meaningless. The missed occurrences are *skipped rather than backfilled* — nobody
wants four copies of a stand-up they did not attend.

**The date arithmetic is where this is either right or quietly wrong for a year**, so it is
pure and each case is one assertion:

* **January 31st, monthly.** The day is clamped at *computation* time and stored as asked.
  Storing the clamped value instead would permanently demote the rule to the 28th after its
  first February.
* **February 29th, yearly.** The same shape, once every four years.
* **"Every other Monday and Thursday."** Within a week the rule takes the next allowed day;
  only when the week runs out does it jump `interval` weeks. A naive `+14 days` alternates
  between the two days instead of giving both days of every second week.
* **A stand-up at 09:00** stays at 09:00.

**Closing a task twice must not spawn twice.** A task can cross into `done` more than once —
close it, reopen it to add a note, close it again — and every crossing reaches the same seam.
`recurrence_spawned_at` is the guard, and it is never cleared: reopening undoes `completed_at`,
but it does not un-emit a successor that already exists and may already have been worked on.

**Stopping a series keeps the work.** Deleting the rule detaches the tasks it produced rather
than deleting them: they are real work, some of it finished, and a "stop repeating this"
button that swept away three months of completed reports would be the last time anybody
pressed it.

**Two bugs the live run caught, and reading could not.**

1. **The weekly CHECK passed the very row it existed to reject.**
   `CHECK (freq <> 'weekly' OR array_length(weekdays, 1) >= 1)` looks correct and is not:
   `array_length('{}', 1)` returns **NULL**, `NULL >= 1` is NULL, and a CHECK constraint only
   *fails* on FALSE. A weekly rule with no weekdays inserted happily. `coalesce(…, 0)` fixes
   it, and a test now asserts the coalesce is present because the hermetic suite has no
   database to try the expression on.
2. **`_next_number` and `_default_status` were reimplementations**, and one of them invented a
   column (`last_number`; the real one is `last_value`). Both were replaced by `core`'s own
   `next_task_number` and `load_default_status` — the same mistake WS-27n had just been careful
   to avoid, made two tickets later in the same package.

**A third, caught by its own test:** `int(rule.get("interval") or 1)` turns an explicit `0`
into "every 1" — a typo that looks exactly like a save, and one the database's CHECK would
then have refused as a 500 rather than a 422. Absent now means "every 1"; zero means the
sender made a mistake.

**In the browser, the sentence is the feature.** A form of five controls is a shape; *"Every 2
weeks on Mon, Thu, keeping to the schedule"* is something somebody can check before committing
to it — shown live rather than on save, because picking the wrong anchor is invisible until a
cadence has drifted for three months. The occurrence limit reads as what is **left**, not the
cap, and switching frequency clears the fields the new one does not use so a stale
`day_of_month` cannot reappear.

### 11.14 WS-27p — dependencies and subtasks, made reachable (built 2026-08-07)

*"`pm_task_links` and `parent_task_id` both exist, unreachable from the board. Data with no
surface is a promise the product does not keep."*

`routes/projects/relations.py` (`GET /projects/tasks/{id}/relations`), `lib/relations.ts` and
a relations block in the task panel. 21 hermetic + 16 vitest cases, 11 mutants red, 19 checks
against a real Postgres. **No migration** — the tables have been right since 146.

**Both halves were unreachable, and for different reasons.** Links could be *created* and
*deleted* since WS-27a but never **listed**: `get_task` returns a `links` **count** and nothing
else, so no client could draw one. Subtasks could be created from the panel but never listed
either — `?parent_task_id=` has existed on the list endpoint since WS-27a and nothing called
it. What was missing was a way to read them, and one rule nobody had written down.

**That rule: `blocks` may not form a cycle.** `assert_no_task_cycle` has guarded
`parent_task_id` since WS-27a, and the identical hazard sat unguarded on links the whole time.
A blocks B blocks C blocks A is a deadlock no human can resolve by finishing something, and
every walk over it runs forever. `assert_no_block_cycle` closes it, bounded by the same
`MAX_DEPTH` its sibling uses, and it **tracks what it has seen** — data can already contain a
loop, since every link created before the guard existed went in unchecked, and the walk has to
terminate over one rather than spin.

**Only `blocks` is guarded.** A cycle in `relates_to` or `duplicates` is redundant, not
harmful, and refusing one would be a rule with no failure to prevent.

**Blocked-ness is DERIVED and SHOWN, never enforced.** A task is blocked when something that
blocks it is still open, so a blocker reaching `done` makes the section go quiet — that is how
you learn you can start. Refusing to *close* a blocked task is the obvious next step and is
deliberately not taken: dependencies in a real workspace are frequently approximate, and a
tool that will not let somebody finish work they have finished is a tool they route around —
after which the links stop being maintained and the feature is worse than absent.

**Visibility is applied to the CHILDREN, not inherited from the parent.** A subtask can be
moved into a project the reader cannot see, and listing it because its parent is readable
would disclose a title from behind a grant. The live run asserts a subtask in an ungranted
project is absent *and* that its title does not appear.

**One endpoint, both directions.** `blocks` outgoing means "this holds those up"; incoming
means "this is waiting". A client given one side would have to ask twice and would still not
know which was which — so each link carries a `direction`, and the browser's `populated()`
turns that into headings, with **Blocked by first** because it is the only section that
changes what somebody should do next. Empty sections are dropped: six empty headings on every
task is how a panel becomes something people scroll past.

**Progress counts the status CATEGORY**, not `completed_at`, for the same reason everything
else in this app does: a project can name its finished lane "Shipped" or "Signed off", and
`cancelled` counts as resolved even though nothing was completed. It reads as "1 of 3" rather
than a percentage — 33% is a worse answer than "1 of 3" to the question people are asking.

### 11.15 WS-27s — the shared task card (built 2026-08-07)

Not on the parity backlog, and asked for directly: *"the UI, kanban, task cards etc can be
taken from the tasks app right? so that the experience seems familiar?"*

**Familiar, yes. Taken, no — and the difference is the whole ticket.** `/tasks`'s `TaskCard`
is 395 lines bound to `useTaskStore` and to `GtdItem`'s own fields — `energy`, `deepWork`,
`disposition`, `nextAction` — none of which `pm_tasks` has or should grow. Worse, D-PM-6 has
`gtd_items` retiring at WS-27h, so a straight port would take the Projects board down with
it. What moved instead is the **vocabulary**: `@/lib/taskCard` holds how a duration reads,
what an avatar's letters are, what counts as overdue, and which chips a task earns;
`@/components/TaskMeta` is the one file that turns a tone name into a colour. Both apps draw
from those, and neither knows about the other's store.

**A card can only show what the LIST endpoint returns, and it was returning almost nothing.**
`pm_task_links` and `parent_task_id` have been readable since WS-27p — *one task at a time*.
A board draws them on every card at once, so this ticket is mostly a backend one: two
aggregates over the page's ids (`attach_relation_counts`), filling `subtasks {done,total}`
and `blocked_by_count` on every row. Per card it would be N+1 across an imported workspace of
hundreds, and at the three-task scale of any test the two look identical.

**A finished blocker does not block, and the count says so in SQL.** The same rule WS-27p's
`blocked_by_open` makes, moved into the aggregate rather than applied after: a card still
marked blocked after its dependency shipped is a card people learn to ignore, and one round
trip per card to find out is the N+1 again. Archived subtasks leave the denominator for the
matching reason — counted, "2/3" could never reach 3/3.

**A zero earns no chip.** Most tasks have no subtasks, no tags and no blockers; drawing "0"
for each turns the meta row into noise and pushes the chips that mean something off the edge
of a 288px column. Chip order is fixed — blocked, due, progress, then the quiet counts — so
the row can be scanned rather than read.

**Overdue is past due AND still open**, and it changes the *icon* as well as the tone, so the
signal survives a reader who cannot tell muted from destructive. `/tasks` was checking only
the date, which painted every completed task with a past due date red forever; sharing the
function fixed that side too, and it is the one behaviour change this ticket makes outside
Projects.

**What the card honestly does not claim.** No attachment count and no estimate: attachments
are counted on the single-task read (WS-27i) and there is no estimate column at all. A
plausible zero would be the card asserting something the endpoint never told it.

The hermetic fake needed teaching, as it did for WS-27n — and the lesson recorded there
applied again: every clause in the two roll-ups is mirrored **only when the statement carries
it**, and which end of a `blocks` link is the blocked one is read off the SQL rather than
assumed. A mirror that filters unconditionally agrees with itself no matter what the route
stops emitting, which is how a deleted WHERE clause survives a green suite.

### 11.16 WS-27q — the calendar (built 2026-08-08)

**Backlog row 9 was named "Calendar / timeline view" and this built the calendar half only.**
Recorded here because closing the whole row was wrong: a month grid of day cells answers *what
is due when*, and a timeline of bars on a continuous axis answers *what runs alongside what*.
They are different questions, the second is the one a multi-month project asks, and the row is
now split — 9a closed, **9b open as WS-27t**.

The first view that **cannot be a page**.

**`/projects/tasks` is paginated, which is right for a list and catastrophic for a
calendar.** A month with ninety tasks read at `page_size=50` draws forty of them and leaves
the other days looking EMPTY. A short page announces itself — "page 2 of 3"; a short month
does not, and nobody investigates a quiet week. So `GET /projects/calendar?from=&to=` takes a
WINDOW, returns everything in it, and when the cap is reached says `truncated` rather than
handing back a plausible-looking month.

**`start_date` has existed since migration 146 and no surface had ever shown it.** The same
complaint §11.14 makes about links, and the reason a calendar is the view that needed
building: a task is a BAR from its start to its due date, not a dot on one day.

**Overlap, not equality.** A task that starts Monday and is due Friday belongs on Wednesday's
cell. `due_at BETWEEN :from AND :to` — the implementation everyone writes first — puts it on
Friday alone, which is exactly the week somebody looks at Wednesday and concludes they are
free. The clause is `coalesce(start_date, due_at) < :to AND coalesce(due_at, start_date) >=
:from`, so a task with one date is a point and a task with both is a bar.

**A task with NEITHER date falls out through NULL**, which is correct and invisible — so
`undated` counts them with the SAME filters and the view says "12 unscheduled". Dropping them
silently is how a calendar comes to look like the whole workspace while showing a third of it.

**The window is read in UTC and the client asks for a day of slack.** A `start_date` is a
floating calendar date and a `due_at` is an instant; no single frame makes both exact, since a
`due_at` of 23:00Z sits on the next day in IST and the previous one in PST. Rather than
pretend, the server OVER-selects and the browser — the only party that knows the viewer's
timezone — does the placement. `start_date` is anchored with `AT TIME ZONE 'UTC'` rather than
`CAST(… AS timestamptz)`, which would silently read the connection's `TimeZone`: a session
setting no caller controls and no test would notice changing. A live run with the session set
to `America/Los_Angeles` pins that.

**Filters carry across the switch, and one is deliberately excluded.** Board and calendar are
the same question in different shapes, so a filtered board that shows everything on the
calendar reads as the FILTER breaking. `due_before` stays out because it bounds the same
column as the window and the loser of a contradiction leaves no trace; `overdue` looks like
its twin and is not — "already late" is a fact about the status as much as the date. Since
FastAPI **ignores an unknown query parameter**, a dropped filter is not an error but a silent
behaviour change, so a test asserts the calendar's parameter set covers the list's minus a
named, reasoned exclusion list.

**No second write path.** Dragging a card is `PATCH /tasks/{id}` — the same validation, the
same `field_change` activity, the same revert. A `POST /calendar/move` is how two paths start
disagreeing about what is allowed.

**Dragging a bar moves the WHOLE bar, and keeps the time of day.** The span is an estimate
somebody made; a drag that silently shortens it to one day destroys information the user did
not offer to change. Writing only the dropped date — the version every calendar implements
first — leaves the other end behind and inverts the interval the moment you drag left. "Due
Friday at 5" dragged to Monday is due Monday at 5.

**`new Date("2026-08-07")` is midnight UTC**, which is the 6th anywhere west of Greenwich, and
routing a `start_date` through it is the single most common way a calendar loses a day. The
grid works in `YYYY-MM-DD` keys throughout. That claim is only *behaviourally* testable west
of Greenwich — in UTC and everywhere east, the buggy version happens to give the same answer —
so the suite runs in four timezones AND pins the rule structurally, because CI runs in one.

**Building it found a hole in the test fake.** `overdue`'s date half (`due_at < now()`) had
never been mirrored, so every `overdue` test since WS-27k was really asserting only the
status half and would have passed with the date comparison deleted. Teaching the fake `<
now()` killed that mutant on the list endpoint as well as the calendar.

### 11.17 WS-27t — the timeline, and dependencies you can draw (built 2026-08-08)

Asked for directly: *"a timeline view that can also make tasks and subtasks dependent on each
other, with wiring them to each other, similar to how it works on Jira and ClickUp."* Two
things, and the second is the one that matters — **a Gantt chart with no dependency gesture is
decoration**, which is exactly why Gantt was a non-goal until this was asked for.

**Almost none of this was schema work.** Dates, links, the cycle guard, the both-direction
read, blocked counts and the interval-overlap window all shipped in WS-27a/p/q/s. The whole
ticket is one aggregate, some geometry, and a gesture.

**The window is the resource, so there is no `/projects/timeline`.** `GET /projects/calendar`
grew `include_links`, and calendar and timeline are two renderings of one question — the same
rule §11.8 states for list and board, extended a third time. A second endpoint would be a
second filter surface to keep in step.

**An arrow needs two bars, so an edge is returned only when BOTH ends are in the window.**
The edge to an off-window blocker is not lost, it is undrawable: `blocked_by_count` already
badges the visible bar, which is the honest rendering of *"something you cannot see is holding
this up"*. Only `blocks` is drawn — `relates_to` and `duplicates` have no direction that means
anything to a schedule (WS-27p's `DIRECTED_TYPES`), and an arrow would claim a sequence nobody
asserted.

#### D-PM-11 — hierarchy depth decides what earns a bar

Top-level tasks get rows; subtasks fold in and expand on a chevron. **A parent with no dates
of its own borrows its children's span**, marked `derived` and drawn dashed, because otherwise
the default view is blank for exactly the projects that use subtasks properly. **A subtask
whose parent is off-window is promoted to its own row** rather than hidden — hiding it is how
a filtered timeline silently drops work.

Paca's Timeline pre-filters to a reserved `Epic` type instead. Rejected: `pm_task_types` is
per-project data with no reserved names (D-PM-2), so "Epic" would have to become either a
seeded row every project inherits or a name-match that stops working the day somebody renames
a type. `parent_task_id` already means depth and cannot be renamed.

#### D-PM-12 — an arrow WARNS; it never reschedules

The owner was given the three options and delegated the choice back. Chosen: **constrain, but
only warn**. A `blocks` edge whose blocker's END falls after the blocked task's START is drawn
in the danger tone with a sentence that says *nothing has been rescheduled*.

**Why not Jira's auto-push,** which was the reflex answer: the useful half of a dependency is
*knowing* — being told, the moment you move something, that two tasks now disagree. Auto-push
delivers that and then also silently rewrites other people's dates, which is where it stops
being useful. The cascade lands in the activity spine (§3.8) as dozens of `field_change` rows
and dozens of notifications with no single act to point at, and the first time somebody's
negotiated date moves without them touching it, they stop trusting the dates. It also
contradicts WS-27p's written position — blocked-ness is **derived and shown, never enforced**
— which now stands unamended. (b) remains reachable later as an opt-in per project, with the
cascade bounded and previewed before it writes; that is a better version of it than the one
that would have shipped today.

Three sub-rules, each one a way the warning could have become noise:

* **equal dates are not a conflict.** A blocker due the 10th and a task starting the 10th is
  the normal way people schedule a handover. Flagging it fires on half a healthy plan, after
  which nobody reads the warning at all.
* **a missing date on either end is not a conflict.** It is unknowable, and a warning that
  fires on absent data teaches people it means nothing.
* **a finished blocker never conflicts.** WS-27p's rule applied to the warning exactly as it
  applies to the badge.

**One rule, two surfaces.** `conflicts()` is pure and lives in `lib/timeline.ts`; the timeline
colours its arrows with it and `RelationsBlock` writes its sentence with it — which is why
`GET /tasks/{id}/relations` grew `start_date` and `due_at`. Two implementations of *"does this
start before its blocker finishes"* would eventually disagree, and the one that got it wrong
would be the surface nobody was looking at.

**The cycle check is NOT duplicated in the browser.** `canLink` refuses only self-links and
exact duplicates; `a→b` when `b→a` exists is allowed through so `assert_no_block_cycle`
refuses it with its own message. A second bounded graph walk in the client is the one that
drifts, and a drag creates a link through the same `POST /tasks/{id}/links` the panel's
dropdown uses — same guard, same activity, same permission.

**Paca gave the layout and nothing else.** `roadmap-view.tsx` (438 lines, Apache-2.0):
sticky task column, fixed pixels-per-day, month cells walked with `Date(y, m+1, 1)`, a today
line, a data-fitted range with padding, an undated task listed and unbarred. It draws **no
dependency arrows** and is **entirely read-only**, so everything from the handle onwards is
ours.

**Two rounding traps, and only one is catchable in CI's timezone.** `dayPx` rounds its
millisecond division because a range that straddles a DST transition is 23 or 25 hours across
it, and an unrounded quotient lands a fraction of a day off for every day after — permanently.
The behavioural test only fails in a zone that *has* daylight saving, so the rule is pinned
structurally too, the same treatment `new Date("2026-08-07")` gets. A bar also covers its
**last** day rather than stopping at that day's left edge; the alternative makes every span
one day short and a one-day task a zero-width line.

**Found while building:** the fake's mirror of the new edge query hard-coded which column was
the blocker, so a mutant that swapped the SQL's two aliases — every arrow drawn backwards —
passed the whole suite. It now reads the roles and the membership tests off the statement, and
both mutants die behaviourally.

### 11.18 WS-27r — the search surface, and the LIKE defect under it (built 2026-08-08)

The last row of the parity backlog. *"`?q=` exists on the list endpoint; there is no search
surface."* Both halves turned out to be true, and the second one was worse than advertised.

**`_` and `%` were live wildcards on every search anybody had done.** `build_task_filters`
bound `%{q}%` raw, so `_` — LIKE's single-character wildcard — meant `task_id` also matched
`taskXid` and `task-id`, and `50%` quietly meant `50`. In a workspace where people search for
identifiers all day that is a steady drip of hits nobody asked for, and it reads as fuzzy
matching rather than as a bug. `like_escape` fixes it **on the shared builder**, so the board
and every saved view get the fix, not only the new endpoint — fixing only the new code would
have left the bug exactly where people meet it.

**Why a second endpoint, having twice argued against one.** The list answers *"which tasks
match these filters, in this order, on this page"*; search answers *"what did you mean"*.
It **ranks** — and the list's ordering is a column allowlist (`TASK_SORTS`) that deliberately
cannot express relevance, so a `sort=relevance` would be a sort key that only works when `q`
is present, a worse contract than a separate route. It is **capped, not paged**: nobody pages
through search results, they retype, and page 2 of a relevance ordering is where relevance has
run out. And it **names the project**, which the list does not because its caller already has
the tree. What decides *what a caller may see* is still shared — same
`task_visibility_clause`, same archived rule — so search can never surface what the list would
hide. That is the part that must not be duplicated; the rest is a different question.

**Ranking happens in SQL, before the `LIMIT`.** Ranked afterwards over a capped set, the best
answer is only present if it was already inside the arbitrary fifty rows the database happened
to return — a defect that presents as "search is bad at long queries". Four tiers: the exact
task number, a title PREFIX, a title match, then description-only; ties break on recency, then
id, so a repeated search does not reshuffle.

**`#42` is a task number.** People quote them, and a search box that returns every task whose
description mentions 42 has ignored what was typed. Bounded to eighteen digits — `task_number`
is a BIGINT, and an unbounded `int()` on user input is a parse nobody asked for.

**A short query is empty, not a 422.** A search box types one character on the way to three,
and an error flashing on every keystroke is noise the user cannot act on. Below the minimum it
costs no database round trip at all.

**Comments are deliberately not searched.** The largest text in the system and the least
likely to be what somebody is hunting by name; a comment hit would also have to render as its
task, which makes ranking across the two incomparable. Recorded so the absence reads as a
decision rather than an oversight.

#### The palette

`⌘K` from anywhere in Projects, not a search page: the question is *"where is that task"*,
asked while doing something else, usually about a project the person is not looking at. A page
makes finding something a place you navigate **to**, which is one navigation more than the
problem has.

Four rules that only break under real typing speed on a real connection, so all four are
pure functions in `lib/search.ts` rather than something to click at:

* **"No results" may be claimed only once, and never while a request is in flight.** Shown
  during the gap it flashes between every keystroke and its answer — the commonest bug in
  hand-rolled search UIs, and it reads as the search being broken rather than slow. The
  previous results stay on screen while the next load runs, so the list does not blank and
  re-fill under the cursor.
* **A stale response must not win.** "par" and "parser" are two requests with no ordering
  guarantee; a slow "par" landing last replaces the right answers with old ones and the list
  changes without a keystroke. The endpoint echoes `query` back, so the guard needs no request
  ids.
* **The arrows belong to the palette, unless a modifier is held.** Left to the browser they
  move the text caret to the start or end of the query — two effects from one key. But
  `Cmd+Left` is "go to line start", and stealing it breaks editing inside the palette's own
  box.
* **The highlight needle is escaped before it becomes a regex.** Searching `(draft)` would
  otherwise throw a syntax error and blank the palette — the browser-side twin of the very
  LIKE defect this ticket fixed on the server.

**Found by the live run, invisible to all 43 hermetic tests:** `:number IS NOT NULL` names no
column, so Postgres has nothing to infer the parameter's type from and asyncpg answers
`AmbiguousParameterError: could not determine data type of parameter $1` — the query never
runs. A Python fake has no type system to be ambiguous about. Fixed with an explicit
`CAST(:number AS bigint)` and pinned structurally, because that is the only level at which a
hermetic suite can hold it.

**The fake learned to read LIKE properly.** `like_to_regex` translates `%`, `_` and the
backslash escape rather than doing a substring match — a mirror that treated the pattern as a
literal would have agreed with both the escaped and the unescaped implementation, and the
whole defect would have been invisible to the suite that exists to catch it.

### 11.19 Plane research — the beyond-parity queue (research 2026-08-09)

*"I want you to learn and study this project as well and add it as another reference in
addition to Paca … come back with findings about what we can actually lift from it to make
our system fully featured and better, both in terms of backend as well as UI/UX."*

Second reference studied: `makeplane/plane` v1.4.1. Full findings, evidence, and the
consolidated verdict table live in **`specs/plane_pm_research_2026-08.md`** (reference-only,
owns no work — same posture as the Paca doc). ⚠️ **Plane is AGPL-3.0**: patterns and
interaction designs only, never code — categorically stricter than Paca's Apache-2.0, and
the research doc's license wall is binding on every ticket below.

**What the research changed here:**

1. **Twelve of our shipped decisions are now validated against a second production
   codebase** (research doc §2): per-view ordering, the trigger-enforced tenant key, the
   atomic counter, cycle guards (Plane has none), the single visibility predicate,
   404-never-403, validate-then-apply bulk, page-batched aggregates, 422-over-fallback
   (theirs arrived after two CVEs), statuses-as-data + priority-as-enum, single-writer
   `completed_at`, agent-as-member. None of these should be re-litigated against a future
   reference without reading that table first.

2. **The beyond-parity ticket queue.** §11.2's ClickUp-parity backlog is CLOSED; the next
   backlog is Plane-informed, tabled as P-1…P-31 in the research doc §8. The high-value
   head of the queue, in recommended build order:
   - **Intake/triage** (P-1) — wrapper row + `triage` status category excluded from default
     lists + accept-in-place; the front door §6.5's email capture and agent-created tasks
     have been missing. Pairs with `/workflows` for routing (D6: states in PM, automation
     in the engine).
   - **Watchers + mention diffing** (P-2) — `pm_task_watchers`, auto-subscribe on touch,
     edits notify only *new* mentions.
   - **Archive guard** (P-3, one predicate, do immediately) — refuse manual archive unless
     the status category is done/cancelled; an archived open task silently exits every
     default list.
   - **Spreadsheet layout + kanban sub-grouping + display-properties contract + group-context
     quick-add** (P-10…P-13) — the four UI gaps with the highest daily-use value.
   - **Auto-archive policy** (P-4) — `archive_in`/`close_in` on root projects; sweeper is a
     `/workflows` scheduled workflow, never a PM cron.
   - Activity meta id+label rule and description-edit coalescing (P-5); semantic sort ranks
     + deterministic tiebreaker (P-6); picker exclusions in search (P-7); human task IDs
     surfaced with copy-link (P-21).

3. **Two owner questions minted — and answered the same day** (research doc §6): **Q1**
   public read-only boards → **deferred, D-PM-14** ("revisit when needed"); **Q2** who owns
   free-form project docs → **the knowledge base, D-PM-13** — PM links to creator-owned,
   grant-shared KB documents and never grows a docs surface of its own.

4. **A non-goal reversed in part**: §5 refuses "a docs surface" and "sprints" — both stand,
   but the sprints refusal now carries Plane's reference design (join-table membership,
   snapshot-on-close, carry-forward — research doc §3.7) so the eventual build starts from
   a settled shape rather than a blank page.

## Board record (2026-08-09) — moved from work_plan.md §2

> Moved here in the 2026-08-09 consolidation (work_plan.md D18): board rows now
> carry state + gates only. The narrative below is preserved verbatim from the
> final long-form row; the dated corrections after it win where they conflict.

### WS-27 — **Projects app — native project management + ClickUp retirement** *(minted 2026-08-05)*
**State cell (as of the move):** ✅ **a + b + d + e + i BUILT 2026-08-06 · j + k + l + m + n BUILT 2026-08-07** · 🟢 f dispatchable · 🟡 c gated · 🟡 h sequenced
**Narrative (verbatim):** Research pass 2026-08-05: `Paca-AI/paca` v0.11.0 (Apache-2.0 — **patterns adopted, no code translated**; findings + the adopt/adapt/refuse table live in `specs/paca_pm_research_2026-08.md`, reference-only), plus a full-tree ClickUp sweep. **ClickUp today is TWO independent systems** — the Phase-0 graph mirror (read-only, shallow) *and* the per-user Tasks-app connector with a **live broker-gated write path** — so leaving ClickUp is coexistence-sync-then-invert, **not** WS-26's import-and-retire; the constraint-8 inversion is staged and recorded in spec §7. Spine: Paca's two-self-FK hierarchy (departments→projects→subprojects→tasks→subtasks as `pm_projects` + `pm_tasks`, types-as-data with the Epic-root rule), statuses-as-data with a semantic `category` (D-CRM-2 convergence), per-view fractional ordering (`pm_view_task_positions` — what lets People-Center and Center-slice boards order the same task differently), and a single activity spine. **First data-scoped app:** `pm_project_grants` on the shipped `email|group:<slug>|org` vocabulary (D12; sibling of C1's D13, which is unchanged), 404-not-403, and the full-portfolio view gives D14's zero-consumer `data:org:read` its **first consumer**. **Three owner answers recorded 2026-08-06 as D-PM-8/9/10, and two of them changed the build:** **D-PM-8** no portfolio/program layer — grants are the only grouping axis, a cross-department project simply carries several (a `pm_programs` table stays purely additive if wanted later); **D-PM-9** agent edits to ClickUp-linked tasks are treated **exactly like human edits** (*the agent proposed queueing agent-originated pushes for approval and was overruled*) — so during coexistence a mistaken agent edit reaches the live workspace with no human in between while `ACTION_BROKER_ENFORCE` is off; bounded by attribution (`agent:<name>`), timeline-reversibility, and the fact that the enforce flip converts the whole class to queue-on-approval. Read D-PM-9's Cost paragraph before building WS-27f; **D-PM-10** ClickUp Spaces map to Centers **explicitly**, from agent-proposed suggestions (assignee-overlap → name match → EVAL-LOCKED content classification), owner-confirmed, applied as `group:<slug>` grants — and an **unmapped Space still imports in full with no group grant**, staying reachable in `/projects` for `data:org:read` holders and its assignees. This supersedes the "pilot vs all Spaces" framing: scope is now a per-Space decision the plan step surfaces, so a pilot and a full import are one code path. Tickets: **a** schema + `feature:projects` both sides + core API on the `gateway/db.py` seam — **BUILT 2026-08-06** (mig `146_projects.sql`, `routes/projects/` with zero `create_async_engine` calls, 115 hermetic cases + 5 mutants measured red; **not deployed — the migration has not been applied anywhere**) · **b** ClickUp org importer **+ the Space→Center mapping plan** — **BUILT 2026-08-06** (`routes/projects/mapping.py` + `import_clickup.py`; `POST /projects/import/clickup/plan` proposes and writes nothing, `POST /projects/import/clickup` applies the confirmed mapping; 25 hermetic cases, 4 mutants red incl. *applying the suggestion instead of the confirmed mapping*; **neither endpoint has been run — prod execution stays OWNER-GATE, §6**) · **c** two-way coexistence sync — three-way field merge, conflicts logged to the timeline (🟡 **blocked on WS-1's BO-1a + BO-1b, named prerequisites**; enabling push is OWNER-GATE) · **d** UI + Center (app + scope) projections, no forks — **BUILT 2026-08-06** (`src/app/projects/` tree + board + list + task panel + timeline, BFF proxy, nav/access registration, all six Centers linking at the SAME `/projects` path and differing only by `?center=`; 34 vitest cases incl. a registration fence, 6 mutants red) · **authoring landed 2026-08-06** — d shipped a UI that could read and drag but never **create**, so a member could only work with rows a ClickUp import had put there: new department / subproject (from the node, where the parent already is), new task (status not sent — the API picks the project's default), subtask from the panel, and **assignees as chips where an agent and a person share one field** (`lib/assignees.ts`, 17 vitest cases, 7 mutants red). That last one is where D-PM-4 stops being a schema note and is the precondition for WS-27f's dispatch being reachable at all · **e** the personal lens — **BUILT 2026-08-06** and **its shape changed**: `D-PM-6` was revised (owner-directed — *"the personal task manager should be a proper extension … a cohesive whole"*) from a mirror into **one store**. `pm_tasks` is THE task table; private work is a personal project (`pm_projects.personal_owner`); the GTD overlay is **per-member** (`pm_task_personal`, mig `147_projects_personal.sql`) so two assignees can hold different dispositions. Assignment is no longer a sync — the inbox row IS the project row, and completing it there moves the shared status. 31 hermetic cases, 6 mutants red. **Its surface landed the same day** — "My work" above the project tree in the SAME app (`components/MyWork.tsx` + `lib/mywork.ts`, 17 vitest cases, 7 mutants red): capture-first, four work lanes that render even when empty, untriaged counted in the header (the Weekly Review's question, answerable only because dispositions are derived not stored), and a completion checkbox that moves the **shared** status. e had shipped API-only, so the cohesion the revision bought was true in the schema and invisible to a member. One repair it forced: `TaskPanel` read the *selected* project's statuses, wrong for a task opened from My work — now resolved from the task's own root project. **Cost accepted: `gtd_items` becomes legacy and WS-27h retires it** · **f** automation + agent dispatch — **BUILT 2026-08-06** (`routes/projects/automation.py` + `agent_dispatch.py`, the `pm_task` node type in `workflows/engine/`, `PM_EVENT_TOPICS` served by the catalog; 34 hermetic cases, 10 mutants red). Both halves of `workflows_app.md` §13 — **U1** the task-mutation node and **U7** dispatch. The engine imports a transport-free SERVICE, not a route, so an automation's edit is indistinguishable in validation from a human PATCH and lands the same timeline row; **status is named, never keyed** (a graph pinned to one project's status UUID could only automate that project); a `pm_task` node is deliberately **not** write-class (the approval gate is for outward writes — now pinned by a test rather than true by accident); and "already in target state" is asserted to issue **no UPDATE at all**, because `update_row` stamps `updated_at` and a redundant write is invisible in a diff while making a task look freshly touched. Assignment dispatches from an event SINK beside the workflows dispatcher, so a broken agent cannot fail the act of assigning somebody a task, and the handoff activity is committed BEFORE the run starts. **Engine defect found and fixed:** `resolve_value` keeps an unresolvable `{{ref}}` as-is at run time by design and `{{trigger.missing}}` passes the publish gate because its *root* is legal — the literal would have reached Postgres as a would-be uuid and returned "Task not found", pointing the maker at the wrong thing · **i** attachments — **BUILT 2026-08-06** (mig `150_projects_attachments.sql`; 25 cases, 10 mutants red): one file store (`gtd_attachments` reused, upload rules imported) with a thin `pm_task_attachments` join that carries the ACCESS decision, so a file is readable by whoever can see the task rather than only its uploader; no attach-by-id endpoint exists, because naming an arbitrary attachment id would let a caller attach somebody else's private capture to their own task and read it back. **Caught before shipping:** the projects BFF proxy re-serialised every POST as JSON, so a multipart upload would have reached the gateway with NO FILE while still answering 201 · **j–r** the rest of the ClickUp-parity gap, measured against the built tree and sequenced in spec §11 (attachments, notifications/@mentions, filters+saved views, custom fields, tags, bulk edit, recurring, dependency UI, calendar, search) — all 🟢, and **n (bulk edit) gates g — and n is now BUILT (2026-08-07), so that dependency is SATISFIED**: an import that cannot be re-triaged in bulk is one somebody abandons halfway, leaving two live systems, which is the state the retirement exists to end. g itself stays 🔴 OWNER-GATE for its own reasons (§6); this changes the prerequisite, not the gate · **g** cutover + retirement inventory (both ClickUp systems) + token revoke + the root-`AGENTS.md` constraint-8 amendment (🔴 OWNER-GATE end-to-end) · **h** `gtd_items` retirement — the cost D-PM-6's revision accepted: union read, row migration into `pm_tasks` + `pm_task_personal`, then `items.py`'s 27 owner-scoped predicates retire with the table they scope (🟡 after e; the data move is 🔴 OWNER-GATE — it rewrites the owner's live task store).. **j BUILT 2026-08-07** (mig `152_projects_notifications.sql`, `routes/projects/notifications.py`, the header bell + mention picker; 39 hermetic + 27 vitest cases, 10 mutants red): closes §11.2's second gap — *"assignment is silent"*. **Three rules decide who hears**, each the whole reason for a rule: never the actor (a bell that pings you about your own click gets muted, and a muted bell notifies nobody about anything); never an agent (they are handed work by the WS-27f dispatch sink, so a row addressed to one sits unread forever inflating a badge nobody can clear — enforced in Python AND by a CHECK); and **never somebody who cannot open it**, which is the security property: the notification carries the task's TITLE, so delivering one outside the grant closure leaks it and lands them on a 404. That third rule needed `resolve_visibility_for`, which answers for a THIRD PARTY — `resolve_visibility` reads a `UserContext` and the recipient of a mention has no request in flight — by reading the tables `/auth/me` reads and handing them to the **real** `build_access`, so wildcards and allow/deny overrides resolve identically on both paths. Notifications are written **inside the transaction**, not emitted on the bus: `emit` swallows failures by construction so a broken workflow can never fail a task edit, which is right for agent dispatch and wrong here. A mention is an **address, not a name**, because 148 dropped `UNIQUE(name)` — `@Priya` has no answer. **Two bugs found on the way in, both shipping at the time:** every project-task file upload was answering **422** (`ACTIVITY_TYPES` never learned 150's `attachment`; all 25 attachment tests passed because they monkeypatch `record_activity` — the seam under test was mocked out), fixed with two tests that READ the migrations; and `/projects?task=<id>` did nothing, though the People Center has linked there since WS-28b. **WS-27b's UI BUILT 2026-08-07** (`components/ImportClickUp.tsx`, `lib/importPlan.ts`; 18 vitest cases, 3 mutants red): the importer shipped with WS-27b and was **unreachable from the product** — the empty state named "import a ClickUp workspace" and no control anywhere did it, so a new install stayed empty and the only route to real data was curl. Three steps, only the last of which writes: Preview (`/plan`, reads the tenant) → Dry run (`dry_run:true`, exercises the flattening) → Import. **The mapping stays the owner's act (D-PM-10)** and the UI is built so it stays one: the suggestion is pre-filled and shown beside its confidence IN WORDS ("a guess — check it", not `0.45`, because a bare number invites acceptance without looking), and a CONFIRMED mapping always beats a fresh suggestion so a re-run never silently re-maps a Space somebody already ruled on. Unmapped Spaces are a notice rather than a blocker, matching the importer. ⚠️ The gate is unchanged and is now exactly one click: building this was agent-safe, pressing Import is the owner's act, and no agent has run either endpoint against production. **The Tasks-app mirror path BUILT 2026-08-07** (`routes/projects/import_tasks.py`, `POST /import/from-tasks`; 43 hermetic cases, 7 mutants red) — owner-directed: *"just show up all the data that is there in the Tasks app inside the Projects app"*. A SECOND importer rather than a flag: the ClickUp one needs a live token, spends LLM budget and demands a Center mapping BEFORE anything is written, which is backwards for "show me my work today". This reads `gtd_projects`/`gtd_items` — the mirror already on the box — so no API call, no token, no model spend, and it works when the connector is stale. One named department, with the real ClickUp shape beneath it — **Space → Folder → List** rebuilt as projects, each carrying its own `clickup_id`/`clickup_kind`, so promoting a Space node is how the department split happens later. **Verified against a real Postgres** (full migration set + seeded mirror), which found THREE defects the hermetic suite could not: `gtd_projects.space_id` is LOCAL-only so the Space was always NULL; `pm_projects` has no `clickup_snapshot` column, so the first real click would have 500'd (this shipped in #393 and was fixed before anybody pressed it); and the preview under-counted 4 vs 7 because container nodes were only tallied on the write path. The root IS org-granted (same act as `create_node`, narrower than bulk-granting a tenant). Pinned: nothing outside `pm_*` is written; only `source <> 'LOCAL'` rows are read (a personal capture must not be published to a shared board); the provider's own status names are kept; an orphaned task is COUNTED, not dropped. **Mutation found a real gap**: deleting `dry_run` from the write guards left every test green, because on a FIRST dry run `root_id is None` blocks the write anyway — on a SECOND one the department exists and `dry_run` is the only protection. That is the realistic case (preview → import → preview again) and it now has its own test. **k BUILT 2026-08-07** (`routes/projects/filters.py`, `lib/grouping.ts`, `components/FilterBar.tsx`; 34 hermetic + 24 vitest cases, 13 mutants red, and 23 checks against a REAL Postgres) — closes §11.2's third gap, the one whose name was the sentence *"my open bugs in Ops, grouped by assignee"*. **ONE filter builder serves both the list endpoint and saved views**, because a saved view is nothing but a stored set of these filters and two implementations would drift — a *saved* view showing a different set than the same filters typed by hand is the one thing it may not do, so a test compares the two outputs directly. **Every filter is a WHERE clause**: paging happens in SQL, so a filter applied in Python after `LIMIT` returns short pages, and *"page 2 is empty but there are 40 more"* is a bug people work around for months instead of reporting. **`overdue` means past due AND still open** — a finished task with a past due date is done, and permanent red is how a board teaches people to ignore red. **An unknown category is a 422 naming the five real ones**, not an empty board a client reads as "this project is empty". Unknown config **keys** are DROPPED while a bad **value** falls back, because those are different failures: a view is a preference written by an older client, so refusing one over an unrecognised key would make every deploy a migration of everybody's saved views, whereas rendering still has to produce something. On the board, **a task with two assignees appears in BOTH columns** (it is both people's work; picking one hides it from the other, so the header counts tasks not group sizes), **empty status lanes are kept** while every other grouping drops empties (a missing "In progress" column reads as "no such state", not "nothing in progress"), and **dragging is offered only when the columns are statuses** — a drop writes the field the columns represent, and status is the one that is a plain PATCH, so a card that can be dragged into a column which cannot accept it and snaps back is worse than an honestly static column. `toConfig` is deliberately NOT `toQuery`: a query string carries only text so `toQuery` writes `"true"`, and `fromConfig` refuses a string where a toggle belongs, so a view built from query shape would come back with every toggle silently cleared. The project's **order-bearing board is withheld from the chips** — `tree.py` seeds one `board` view per project and it owns every `pm_view_task_positions` row, so offering its ✕ would offer to delete every hand-arranged position; saved views sit at position 300 above the seeded pair and `orderBearingView` is one function used by both the drag handler and the delete guard. **A FIFTH live bug, found the same way as the previous four:** `due_before` was `CAST(:due_before AS timestamptz)` with the raw query-string value — asyncpg infers the parameter's type FROM that cast and then refuses to encode a `str`, so the query never reached Postgres and **`?due_before=…` answered 500** while the hermetic fake, which agrees with whatever SQL it is handed, stayed green. `parse_when` parses on this side and binds a real `datetime`; garbage is a 422 that says what was expected; a naive value is read as UTC rather than inheriting the connection's TimeZone. Two tests — one on the bound value's TYPE, one refusing any `CAST(:param AS timestamp…)` anywhere in the builder — so the next `after=` filter written the obvious way fails in CI instead of in front of a member. **l BUILT 2026-08-07** (mig `155_projects_custom_fields.sql`, `routes/projects/custom_fields.py`, `lib/customFields.ts` + the panel block and the Fields dialog; 47 hermetic + 36 vitest cases, 23 mutants red, 35 checks against a REAL Postgres) — ClickUp's signature feature, and the shape §5's non-goals already recorded as the additive path: **definitions in a table, values denormalised onto the task as JSONB keyed by `field_key`**. NOT a row per (task, field): that is the textbook EAV answer and costs a join per field on every board paint — five fields across two hundred imported tasks is a thousand rows to gather and re-pivot, per render — whereas the JSONB column arrives with the task for free. **The cost is stated rather than discovered**: a value is not referentially tied to its definition, so the DATABASE cannot stop a key no definition owns from being written, and that guarantee moves into Python. Hence the validation IS the feature: an unknown key is a **422 not a silent drop** (a typo that no-ops looks exactly like a save); a patch **MERGES** (a client that knows three of five fields must not wipe the other two — and an older client, or an automation written before a field existed, is precisely that client); an explicit **null CLEARS the key** rather than storing a null, because it is the only way to express "unset this" and a stored null makes "never filled in" and "deliberately emptied" one value in every filter; and **`true` is not the number 1** — `isinstance(True, int)` is True in Python, so the coercers are one-per-type in a dispatch dict specifically so the boolean check can never drift below the number one. **The deliberate departure from Paca:** its research notes record "deleting a definition does not clean task data" as an accepted cost; it is NOT accepted here, because a key left in the JSONB is invisible — no definition means no column, no form row, no filter — until somebody recreates the name and every old value resurfaces carrying the new meaning. The cleared count is reported (R7/R8). Two things a definition may not change once values exist, both because the stored values would stop meaning what they say: **`field_key` is never editable** (it is the identity every value is filed under) and **`field_type` is a 409 naming the count** (text→select cannot re-interpret what is already written); dropping a select option some task holds is refused the same way, adding one is free, and the UI shows the derived key while the name is still being typed since that is the last moment anybody can change it. **Custom fields are REVERTIBLE, which is what makes them first-class:** `patch_task` folds a custom edit into the SAME `field_change` activity under `custom.<key>` rather than inventing an activity type — `record_activity` refuses a type the CHECK does not list, the trap that made every attachment upload answer 422 — and revert restores by **merging onto what the task holds NOW**, never writing back the whole object, since another field may have been edited since and replacing the blob would silently undo that too. **A bug the ticket's own tests caught before it shipped:** `changedValues` compared a form's boolean against a `null` baseline, so a task with an unanswered checkbox sent `open:false` on EVERY save and posted a timeline entry for an edit nobody made — a checkbox has no "unset" state to render, so `false` is its baseline. **And a fence that was quietly a subset check:** `test_projects_routes` asserted a LIST of mounted paths, which catches the module somebody remembered to add a path for; it now also reads the package directory and asserts every module declaring a `@router` route is imported by `__init__.py` — the C1 trap where a missing import mounts nothing while every direct-call test still passes. Verified by deleting the import and watching it fail. **m BUILT 2026-08-07** (mig `156_projects_tags.sql`, `routes/projects/tags.py`, `lib/tags.ts` + the panel picker, the filter row, a `tag` board axis and the Tags dialog; 31 hermetic + 37 vitest cases, 16 mutants red, 30 checks against a REAL Postgres) — the row the research notes left open ON PURPOSE: `paca_pm_research_2026-08.md` row 13 REFUSED Paca's model (*"a bare jsonb string array on tasks. No registry, no colors, no rename/merge — the weakest part of Paca's model"*) and §5 shipped `pm_tasks.tags TEXT[]` in its place with a registry named as additive later. **The array STAYS** — a join table would add a row per tag per task and a join to every board paint, to buy referential integrity this app enforces in one place, whereas the array arrives with the task and its GIN index (146) already answers "tagged X". What the registry buys: **one spelling per tag** (identity is case-INSENSITIVE via a unique index over `lower(name)` so two racing requests cannot create both, display is case-PRESERVING, and the task's array stores the REGISTRY's form — which is what makes "filter by bug finds all of it" true rather than aspirational, and what lets a rename be one statement); **rename**; **merge**; and a **colour**. **Applying an unregistered tag REGISTERS it** — refusing would make tagging a two-step errand (leave the task, create the tag, come back), which is how tagging gets abandoned, and an abandoned tag set is worse than a messy one. **The cost is stated: every typo becomes a tag** — which is exactly why merge is here and is not optional, and why the picker SHOWS the moment of creation rather than minting silently. **A rename onto an existing name is a 409, not a silent merge**: different operations, different outcomes, and one of them destroys a tag — quietly doing the destructive one because the names collided is what stops people using a rename button. **A task carrying BOTH tags ends a merge with the target ONCE** — the case that is easy to get wrong, and getting it wrong leaves a duplicate that renders twice and survives the next merge too; `merged_tags` is pure so that case is asserted directly, and the rewrite runs over affected rows in Python rather than as an `array_replace`, which would leave the duplicate. **TWO tag filters** because both questions get asked and neither answers the other: `tags` is ANY (`&&`) and `tags_all` is ALL (`@>`); collapsing them would silently pick a meaning, and with three tags the answers differ by almost everything. On the board a task with three tags appears in three columns, the same honesty as two assignees appearing in both theirs. **The migration backfills AND rewrites data, deliberately and narrowly:** `tags` has been on `pm_tasks` since 146 and the import path writes them, so an empty registry beside a tagged corpus means the first rename finds nothing; the winning display form is **the spelling people actually use** (most frequent, ties broken deterministically — `min()` alone would canonicalise 400 "Bug" to a single stray "BUG"), and task arrays are then made to agree, only ever swapping one CASING of a tag for another, with the count reported in a NOTICE. **A bug the live run caught in that block:** the canonicalisation used the implicit-comma `FROM pm_tasks t, unnest(t.tags) ... LEFT JOIN` form, where the LEFT JOIN binds only to `unnest(...)` and `t` is not in scope for its ON clause — the migration aborted with "invalid reference to FROM-clause entry for table t". Rewritten as `CROSS JOIN LATERAL … WITH ORDINALITY`, which also fixed a second problem the first version would have shipped: `array_agg(DISTINCT ...)` sorts by its own expression, so every task's tag list would have come back alphabetised. **n BUILT 2026-08-07** (`routes/projects/bulk.py` → `POST /projects/tasks/bulk`, `lib/selection.ts`, `components/BulkBar.tsx` + checkboxes on board and list; 35 hermetic + 32 vitest cases, 16 mutants red, 34 checks against a REAL Postgres; **no migration**) — **the ticket §11.3 names as gating g, so that prerequisite is now satisfied.** It **reuses `automation.apply_task_patch` rather than growing a second writer**: that service exists because WS-27f needed an edit indistinguishable in validation from a human PATCH, and a bulk endpoint with its own field handling would be a third opinion about what a task edit is. Tags go through the same registry the panel uses, because the registry cannot be true if bulk is a second door into the array. **Status is named, never keyed — load-bearing here rather than stylistic**: a selection spans projects and a status id belongs to one root, so `status_id` for fifty tasks across three projects puts two thirds of them in a lane that is not theirs; it is a 422 with its OWN message, because it is the mistake somebody makes by copying a single-task PATCH body and "unknown field" would not explain why the thing that works on one task is refused on fifty. **Assignees and tags are ADD/REMOVE, never SET** — "assign these to Priya" means ALSO Priya, and a replace wipes every individual assignment the fifty tasks already carried; the destructive spelling is absent rather than discouraged. **Shape validated once, outcomes per task**, because those are different failures: an unsettable field is the same mistake for all fifty (422 before any write), while a status name present in one project and absent from another is a fact about THAT task — failing the batch for it makes a mixed selection unusable, which is precisely the selection somebody makes after an import. **An invisible task is SKIPPED, not an error** (R5: per-id reporting says exactly what a per-id 404 says, and aborting would let a caller probe for existence). **One transaction** — a re-triage that half happened is harder to recover from than one that did not, because nobody can tell which half. **Re-asserting a value is not a change** (`moved_people` is pure so the claim is asserted directly): fifty tasks already Priya's would each gain a timeline entry saying nothing, and a count nobody can trust is worse than no count. **ONE notification per person per batch, not one per task** — being handed fifty tasks should ring once and say fifty; fifty bells is a bell people turn off, which is WS-27j's own argument applied to the case that would have broken it. In the browser the selection is **pruned whenever the filter changes** (select forty, narrow to three, press Done must not act on thirty-seven nobody can see), a shift-click ranges over the board's ON-SCREEN order, a two-assignee card drawn in two columns counts once, and the outcome line names every category including the boring ones. **AND IT UNCOVERED A SHIPPED WS-27j BUG** (spec §11.12): `notifications.deliverable` probed only `project_clause('t.root_project_id')` while `core.task_visibility_clause` — whose docstring warns a second implementation "would drift the moment one is edited alone" — carries TWO ways in. So (1) anybody assigned work in a project they hold no grant on was judged undeliverable: they could OPEN the task, the assignment notified nobody, and the response told the assigner they could not see it — the silent assignment WS-27j exists to end, still open for the most common case in a grant-scoped app; and (2) scoping to `root_project_id` ALSO missed a grant made on a SUBPROJECT — the old test asserted that scoping on the argument that "probing `project_id` would miss a grant made on an ancestor", which is BACKWARDS, as a real-Postgres run showed: the closure is recursive and expands DOWNWARD. Fixed to use the shared clause; the test that encoded the wrong reasoning now records why it was wrong. **A fake collision the fix exposed:** `FakeDB` matched the rule-3 probe by substring, and the new clause embeds both `pm_task_assignees` and the closure's `UNION` — exactly the AUDIENCE branch's fingerprint — so `deliverable` got a list of assignees where it expected a visibility answer and four tests failed for a reason unrelated to the code under test. A fake that dispatches on substrings needs fingerprints that are SPECIFIC, not merely present

**Corrections applied 2026-08-09:**
- a/b/d/e/f/i/j/k/l/m/n are MERGED TO MAIN (#390, #393, #394, #398 + fixes) — the 'BUILT (branch)' wording was stale
- the state cell's 'f dispatchable' contradicted the body's 'f BUILT 2026-08-06' — f is built and merged
- the WS-27j notifications.deliverable clause bug (probes project_clause instead of core.task_visibility_clause) is an OPEN defect recorded at spec §11.12, found by n's tests.
