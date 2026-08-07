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
| 3 | **Filters, grouping and saved views** — `pm_views` exists; the UI has a board/list toggle and nothing else | "My open bugs in Ops, grouped by assignee" is a daily question with no answer. The **table is already there**, so this is a UI ticket, not a schema one | **WS-27k** |
| 4 | **Custom fields** — no definitions table, no values | ClickUp's signature feature. Paca's shape (`custom_field_definitions` + a JSONB column keyed by `field_key`) is proven and portable | **WS-27l** |
| 5 | **Tags** — refused Paca's bare JSONB array (research row 13) and nothing replaced it | The refusal was right and left a hole. A tag registry with rename/merge is the version worth having | **WS-27m** |
| 6 | **Bulk edit / multi-select** | Re-triaging fifty imported tasks one at a time is how an import gets abandoned — this one gates the migration itself | **WS-27n** |
| 7 | **Recurring tasks** | Every operations cadence is recurring. Without it those live in someone's head or in ClickUp | **WS-27o** |
| 8 | **Dependency and subtask UI** — `pm_task_links` and `parent_task_id` both exist, unreachable from the board | Data with no surface is a promise the product does not keep | **WS-27p** |
| 9 | **Calendar / timeline view** | The third view ClickUp users actually use, after list and board | **WS-27q** |
| 10 | **Global task search** | `?q=` exists on the list endpoint; there is no search surface | **WS-27r** |

**Deliberately NOT on this list:** sprints (a stated non-goal, §1), time tracking and
checklists (Paca moved both out of core into plugins — the growth path is subtraction), and
Gantt. If any is wanted, it is a decision to record, not an omission to fix.

### 11.3 Sequencing, and the one dependency that matters

**WS-27n (bulk edit) gates WS-27g.** The cutover imports a real workspace, and an import
that cannot be re-triaged in bulk is an import somebody abandons halfway — leaving two live
systems, which is the exact state the retirement exists to end. Build it before the cutover,
not after.

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
