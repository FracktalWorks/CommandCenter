# Department Centers — one platform, many projections

**Status:** Phase A shipped (UI scaffold + feature gating) — **but no Center is reachable by anyone on `main` today, owner included**: the `center.*` feature-vocabulary fix and its invariant tests are on the open branch `ws-13-centers-feature-vocabulary` (2026-08-03), **unmerged**. §2 records the defect and the registration checklist that prevents its recurrence. Phase B groups admin UI + seed shipped pending review (2026-08-01 — directory read view still open) · **Date:** 2026-08-03 · **Owner:** vjvarada

**Verified against code:** 2026-08-03 (WS-14 doc remediation, on `ws-14-doc-remediation`
off `bebbd924`; **repair round the same day off `264f881e`**). Scope of that pass: **§3
Phase C only** — all four bullets were audited against the tree, three were found to rest
on things that do not exist, and each now carries acceptance and an **AGENT-SAFE /
OWNER-GATE** label. §1, §2 and Phases B/D/E were not re-measured in that pass and keep
their earlier stamps. Findings, so no reader has to re-derive them: `email_account_member`
**exists nowhere in the repo** (0 hits across
`*.sql` and `*.py`); the seven agents the team-instancing bullet pointed at
(`sales`, `billing`, `delivery`, `startup-coach`, `triage`, `reconciler`, `strategy`)
**do not exist** — `apps/agents/` holds exactly six others; and `pending_actions`
(`infra/postgres/66_pending_actions.sql:13-38`) has **no column naming the requesting
member, their group, or a Center**, so per-Center approvals is a schema change behind an
open owner question, not a filter.

**Repair round, 2026-08-03 (review REQUEST-CHANGES on the pass above).** Four defects in
that pass, all fixed here: (1) **C1's acceptance could go green with no way to create a
grant** — done-when 1 now names a caller-reachable creation path (method, path,
permission) and done-when 2 requires the grant under test to be created *through it*, not
by a fixture `INSERT`; (2) **`role` was in the proposed schema with zero done-when
touching it** — it is **cut**, with the reasoning and the additive path back recorded;
(3) **C4 repeated an absolute this ticket exists to stop** — *"`actor` is the proposing
agent … not the human behind it"* is **false**, `routes/apps/tools.py:393` and
`routes/apps/actions.py:345` both write `app:<slug>:<email>`; the six proposers and five
actor shapes are now measured in place and **the OWNER-GATE verdict is unchanged and
better supported**; (4) **C2's "NOT DISPATCHABLE" was a third gate token** in a corpus
whose contract allows two — mapped onto AGENT-SAFE (the doc action) + blocked (the
build). C3 additionally states that its migration is pre-provisioning with columns
intentionally unread, and reproduces D3's column shape.

The commitment this document records: **CommandCenter stays one deployment, and
departments get Centers — scoped projections of the same platform, never
separate systems.** A "Sales Center" is the sales team's slice of the one
platform's apps, agents, memory, and workflows; it is not a second product that
"feeds data back."

This supersedes the earlier informal framing of per-department apps as separate
systems. It does not change the tenant rule: a *separate deployment* is reserved
for a separate organization (the multi-tenant path in
`multi_user_organization_research.md` §17), never for a department.

**Why not separate systems.** Every load-bearing capability shipped in July is
cross-cutting and assumes one deployment: intersection authority
(`groups_sessions_authority.md` §3), agent delegation at intersected clearance
(`agent_architecture.md` §8), cross-system workflows (`workflows_app.md` §1.1),
`org:global` memory readable from every scope (`memory_architecture.md`,
`agent-kinds.md` §5), and the single Action Broker / approvals / audit path.
Splitting by department severs all five.

---

## 1. Nomenclature — the words we commit to

UI copy and specs use these terms consistently. Renames are cheap now and
expensive after the team learns the wrong word.

| Term | Meaning | Never call it |
|---|---|---|
| **Center** | A scoped projection of the platform for an audience: Personal, a department, or the Company. | portal, workspace, hub, module (in UI) |
| **Personal Center** | The signed-in user's own slice: apps mapped one-to-one with the person. | "My apps" |
| **Company Center** | The founder/exec projection: org-wide dashboard, live activity, approvals, digests. | Executive Center (audience is exec; *content* is the company) |
| **module** | The **backend** container primitive from research §5 (org_access Phase 2). UI says "Center"; schema and specs say `module`. | — |
| **group** | `org_group` — the scoping primitive. **Group slug = center slug, 1:1** (`sales`, `marketing`, `finance`, `operations`, `people`, `company`). UI copy may say "team" when addressing humans. | department (in schema) |
| **Workshop** | A builder surface: **App Workshop** (`/build/apps`), **Agent Workshop** (`/build/agents`). | Workbench, Creator, Studio (for items) |
| **Studio** | The nav *section* holding cross-cutting creation surfaces (Chat, Workflows, the Workshops). | — |
| **app / sub-app** | An app is a first-party vertical surface (Email, Tasks). A **sub-app is an (app, scope) pair** — the same app projected into a Center, never a fork. | — |
| **Agent Registry** | The admin page for registered agents (`/agents`). Renamed from "Agents" to stop colliding with Agent Workshop. | — |

Naming rules:

1. **Feature slugs:** `center.<slug>`; **routes:** `/centers/<slug>`; **group
   slugs:** `<slug>`. One slug, three namespaces, zero mapping tables.
2. **A Center item is (app + scope).** Sales→Tasks is the Tasks app filtered to
   `group:sales`; the shared mailbox is the Email app on a team-owned account.
   Forking an app per department is the bloat failure mode — refuse it in review.
3. **Live vs planned is stated, not implied.** Scaffold surfaces carry their
   build status (`lib/centers.ts` statuses; "Scaffold" badge on landing pages).
   A card that opens an unscoped surface says so in its caveat.

## 2. The information architecture (shipped)

Sidebar and home page (source of truth: `workbench/control_plane/src/lib/nav.ts`,
deriving Centers from `src/lib/centers.ts`):

1. **Personal Center** — Dashboard¹ · Email · WhatsApp · Tasks · Notes ·
   Memories · Artifacts. All personally instanced (`agent-kinds.md` §6).
2. **Centers** — Sales · Marketing · Finance · Operations · People · Company.
   Each is one nav item landing on `/centers/<slug>`; as sub-apps go live a
   Center's landing page remains its front door.
3. **Studio** — Chat · Workflows · App Workshop · Agent Workshop. Everyone can
   hold these tools (feature-gated); every *object* made with them (session,
   workflow, app, agent) is personally or team scoped and optionally shared.
4. **Admin** — Models · Agent Registry · Approvals · Integrations ·
   Live Activity · Members & Roles (admin-flag gated).

¹ `/dashboard` renders the company overview today; the personal rollup replaces
it here in Phase D, and the company view becomes the Company Center dashboard.

**Access:** migration `140_center_features.sql` seeds `center.*` rows
(category `centers`, none member-default). Owners/admins see every Center via
`feature:*`; everyone else sees a Center only when a role or override grants
it. Granting a department = `allow feature:center.sales` (+ group membership,
once groups have a UI). Route guards: `lib/access.ts` maps `/centers/<slug> →
center.<slug>`.

> **Seeding the catalog row is not enough — the slug must also be in
> `acb_auth.permissions.FEATURES`** (fix on branch `ws-13-centers-feature-vocabulary`,
> 2026-08-03, unmerged; until it lands, no Center is reachable by *anyone*).
> `/auth/me` returns `list(access.allowed_features())`, and that method iterates
> the hardcoded Python tuple, never `feature_catalog`; the wildcard in
> `feature:*` is only ever evaluated against those literals, so an owner
> holding `*` still gets an empty Center set.

**Registering a Center — every place, or it is unreachable.** A Center is one
concept spread across five declarations, and omitting any one of them fails
*silently* in a different way. This is the checklist; nothing else in this spec
supersedes it.

| # | Where | What it decides | Omitted ⇒ |
|---|---|---|---|
| 1 | `workbench/control_plane/src/lib/centers.ts` | The registry the UI renders — `nav.ts` builds the Centers section from it, `access.ts` the `/centers/<slug>` → `center.<slug>` route map | No nav item, no landing page, no route guard entry |
| 2 | `infra/postgres/<next>_*.sql` — a `feature_catalog` row (category `centers`) **and** an `org_group` row, the way `140_center_features.sql` + `141_seed_center_groups.sql` did for the six (**find the next free number by listing the directory; never assume one**) | The admin UI's grantable-feature list and its category grouping; the group the Center projects | The feature cannot be granted or denied from `/settings/members` or `/settings/roles`, and the Center has no team behind it |
| 3 | `acb_auth.permissions.FEATURES` | The **only** vocabulary `allowed_features()` iterates; `/auth/me` returns exactly it | The pane is dropped from the nav and `/centers/<slug>` hits AccessGate — **for every principal, owner included** |
| 4 | `gateway/routes/admin/groups.py::CENTER_GROUP_SLUGS` | Which groups pair 1:1 with a Center — the grant-access toggle and the undeletable-group rule | The group is deletable and "grant the department in one admin action" does not appear |
| 5 | `tests/unit/test_org_access_control.py::EXPECTED_CENTER_SLUGS` | The one retyped literal — the anchor that stops the two invariant tests going vacuous when a derivation source empties | The suite goes red until you update it — deliberately: changing the set of Centers is a decision, not a refactor |

Rows 1, 3 and 4 are pinned to each other by
`tests/unit/test_org_access_control.py::test_centers_registry_matches_the_feature_vocabulary`
(it parses `centers.ts`, so a retyped copy cannot drift) and
`::test_every_center_has_a_feature_slug`. Row 2 is not machine-checked — the
catalog table is the admin UI's list, not the authorization vocabulary.

**Center rosters** (sub-apps + status) live in `lib/centers.ts` — that file is
the registry; this spec deliberately does not duplicate it. Highlights: Sales
(proposal generator, Zoho pipeline, shared mailbox, lead-intake workflow),
Operations (production tracker, inventory/BOM, dispatch, service & AMC — the
strongest early candidate for a hardware company), Company (dashboard, live
activity, approvals live today; digests + reviewed org knowledge planned).

## 3. Work plan — Phases B–E

Phase A (this scaffold) is shipped. Each later phase is independently
shippable and folds in the pending items from earlier plans it depends on.

### Phase B — Groups become real *(the unlock; do first)*

> **Update 2026-08-01: first two bullets shipped pending review.** Gateway
> `/admin/groups` CRUD + membership (`routes/admin/groups.py`, gated on the
> members-admin permissions; the center-feature grant additionally requires
> `admin:access:manage`), the `/settings/groups` admin surface ("Teams" in UI
> copy, per §1), and a seed migration for the six groups (idempotent,
> DO NOTHING so admin edits survive redeploys). Verified by
> `tests/unit/test_admin_groups.py`. The directory read view (bullet 3) is
> still open.

- ✅ **Groups admin UI** over `org_group` / `org_group_member` (mig 138) — CRUD +
  membership + lead role. Was flagged as the gap in `groups_sessions_authority.md` §6.
- ✅ Seed the six groups (slug = center slug). Backfill: adding a member grants
  their department's `center.*` feature alongside group membership (one admin
  action — an allow override with reason `group membership: <slug>`; removing
  membership deliberately does NOT auto-revoke it).
- People Center's "Directory & org chart" is the same data rendered — build the
  read view here, not a parallel store.

### Phase C — Scoping deepens (org_access Phase 2, applied per Center)

Board row: `work_plan.md` §2 **WS-14**. The binding mechanism for every bullet below is
`tenancy_and_visibility.md` §3.2: **extend the shipped `email | group:<slug> | org`
subject vocabulary; do not invent a second one.** Each bullet carries its gate label per
the agent-ready spec contract item 7.

#### C1 — Tasks team slice · **AGENT-SAFE** · ~1 PR + 1 migration

`/tasks` scoped to the group's projects — the first (app + scope) sub-app, proving §1
rule 2. This is the bullet that has read "`/tasks` scoped to the group's projects" and
nothing else for weeks; that is not testable, so it is written out here.

**The grant table.** `tenancy_and_visibility.md` §4.1 makes the call and records the
alternatives: **`gtd_project_grant (project_id, subject, granted_by, created_at)`**, a
`gtd_*`-local table with a real FK onto `gtd_projects` — not a polymorphic
`object_grants`, and not a reuse of `app_grants` (whose key *is* `app_id UUID NOT NULL
REFERENCES apps(id)`, `114_custom_apps.sql:59`). It is a
`DECISION (agent-proposed, owner may overrule)` — registered on the board as
**D13** (`work_plan.md` §3); read §4.1's reasoning before overruling it, and if it is
overruled, the alternative is its own ticket that *also* migrates `app_grants`, never a
side effect of this slice.

> **No `role` column — decided 2026-08-03, not deferred.** Earlier drafts of this
> schema carried `role`, copied from `app_grants.role`
> (`114_custom_apps.sql:61-62`, `CHECK (role IN ('use','edit','own'))`). It is **cut**.
> `app_grants.role` earns its place because something branches on it — `can_edit`, at
> `routes/apps/_common.py:473`. Nothing would branch on a project grant's role in this
> slice: every done-when below is a **read**-path clause, and done-when 7 explicitly
> lets every write predicate stay owner-only. `role` would therefore ship with one
> legal value and no reader — a dead column, and an invitation for the next
> implementer to invent write semantics nobody chose. Whether a grantee may *edit*
> items in a granted project is a real question and it is **not answered here**; when
> it is, it arrives as its own ticket —
> `ALTER TABLE gtd_project_grant ADD COLUMN role …` at the next free migration number
> resolved at build time (R1). Additive, no backfill, no data at risk.

**The migration.** One new file in `infra/postgres/`, at **the next free number resolved
at build time by listing that directory** — never a number copied out of a document
(R1). Idempotent `CREATE TABLE IF NOT EXISTS`, per the conventions in
`infra/postgres/README.md`.

**The read path.** "Mine" ∪ "granted to a group I'm in". Measured blast radius:
**27 `user_id = :` predicates in `apps/services/gateway/gateway/routes/tasks/items.py`**
(re-count before starting: `rg -c "user_id = :" apps/services/gateway/gateway/routes/tasks/items.py`).
Resolve the caller's group set **once per request**, mirroring
`gateway/rooms.py:181-199`'s `my_groups` — not once per predicate, and not per row.

**Done when:**

1. **A grant is creatable by a caller — not only by hand-written SQL.** Two routes
   exist, on the shipped `/tasks` router (`routes/tasks/core.py:27-30`, which already
   carries `dependencies=[require_feature_router("tasks")]`):

   | Method + path | Body / param | Does |
   |---|---|---|
   | `POST /tasks/projects/{project_id}/grants` | `{"subject": "group:<slug>"}` | upserts one `gtd_project_grant` row, `granted_by` = the caller |
   | `DELETE /tasks/projects/{project_id}/grants/{subject}` | — | revokes it |

   **The permission required is `feature:tasks` plus project ownership, and nothing
   else.** No new permission slug is minted — do not add one to
   `acb_auth.permissions.FEATURES` or `CAPABILITIES` in this slice — and **no
   `admin:*` is required**: granting your own project to your own Center is not an
   admin act (contrast `routes/admin/groups.py`, where minting a `center.*` feature
   override for someone else legitimately needs `admin:access:manage`). Ownership is
   `gtd_projects.user_id = <caller>`, and the status codes mirror the shipped
   app-grant shape `get_app_or_404(db, slug, user, edit=True)`
   (`routes/apps/_common.py:459-475`): **404 when the caller cannot see the project,
   403 when they can see it but do not own it.**

   > ⚠️ The routes go in a new `routes/tasks/grants.py`, and that module **must be
   > added to the import list in `routes/tasks/__init__.py:7-18`**. The feature
   > modules register onto the one shared `router` as an *import side effect*
   > (`__init__.py:3-5`), so a module left out of that list mounts **nothing** —
   > while every test that calls the route function directly still passes. That is
   > the exact failure this criterion exists to prevent.

2. A member of group X, who does not own project P, can read P and its items when a
   `gtd_project_grant` row with `subject = 'group:X'` exists — **and the grant under
   test was created by invoking criterion 1's `POST` route function, not by an
   `INSERT` in a fixture.** A repository helper reachable only from a fixture does
   **not** satisfy this. Use the shipped hermetic convention rather than a live DB:
   call the async route function directly with a fake in-memory session,
   monkeypatching the DB seam on the SUT submodule —
   `tests/unit/test_admin_groups.py:7-21` states the convention verbatim and
   `tests/unit/test_app_grants.py` is where it started.
3. A member of **no** group containing X gets **`404`, not `403`**, on the same project
   and on every item under it. This matches the shipped convention — see the probe at
   `routes/memory.py:237-240` and its comment: *"404, not 403: whether a memory id
   exists elsewhere is itself something the caller should not be able to probe for."*
   A `403` here would leak the existence of another Center's project.
4. Revoking the grant **through criterion 1's `DELETE` route** restores the `404` on
   the next request, with no cache to invalidate.
5. A subject outside `email | group:<slug> | org` is rejected at write time by a
   validator that is **not a third route-local copy**. There is no shared home today,
   which is why "use the shared validator" was unbuildable as previously written: the
   only two validators are route-local, private, and disjoint —
   `routes/rooms.py::_valid_subject` (`:100-111`; `email | group:<slug> | org`) and
   `routes/apps/grants.py::is_valid_subject` (`:68-85`; `email | agent:<name> |
   agents:*`, and it **rejects** the literal `org` at `:77`). Importing either into
   the other's route package means importing a private symbol across packages.

   **This slice creates the home: `packages/acb_auth/acb_auth/permissions.py`,
   exported from `acb_auth/__init__.py`** — e.g. `valid_grant_subject(subject: str)
   -> bool`, which becomes the definition of record for the
   `email | group:<slug> | org` grammar. Why there, and not a new module: that file
   already owns the permission vocabulary and is **pure — no DB, no FastAPI, no I/O**
   (its own docstring, `permissions.py:1-8`, and `packages/AGENTS.md`); a subject
   grammar is vocabulary of exactly that kind; and all three consumers already import
   `acb_auth` (`routes/rooms.py:38`, `routes/apps/grants.py:26`,
   `routes/tasks/items.py:23`), so this adds **no new edge** to the import graph.
   The alternative homes were considered and rejected: a `gateway/`-local helper is
   not reachable from `packages/`, and a new `acb_auth` submodule would split one
   vocabulary across two files.

   > **Deliberately NOT in this slice:** repointing `_valid_subject` and
   > `is_valid_subject` at the new helper. `rooms.py:100-111` is published as an
   > anchor by this spec, `tenancy_and_visibility.md` §3.2, `work_plan.md` D12 and
   > `docs/multiplayer/memory-clearance.md`; editing it here would move four
   > documents' anchors for no gain to this slice. It is a named follow-on, not an
   > oversight — and per §3.2 the two grammars are not identical, so it is a
   > *composition*, not a deletion.
6. Every one of the 27 `user_id` predicates is either widened through the union path or
   explicitly justified in the PR as owner-only (e.g. a write path). "I widened the list
   endpoint" is not this criterion.
7. `uv run ruff check apps/services/gateway/gateway/routes/tasks/items.py \
   apps/services/gateway/gateway/routes/tasks/grants.py \
   packages/acb_auth/acb_auth/permissions.py` is clean.
   Do **not** claim `uv run ruff check .` clean — it reports ~1983 pre-existing errors
   on this tree and is not a signal.

**Verification** — *name the test files; never `uv run pytest tests/unit/` as a
directory, it hangs against this box's live DB*:

```
uv run pytest tests/unit/test_tasks_gtd.py tests/unit/test_tasks_archive_upstream.py \
              tests/unit/test_admin_groups.py tests/unit/test_org_access_control.py \
              tests/unit/test_tasks_project_grants.py -v -rs
uv run ruff check apps/services/gateway/gateway/routes/tasks/items.py \
                  apps/services/gateway/gateway/routes/tasks/grants.py \
                  packages/acb_auth/acb_auth/permissions.py
```

The first four files exist and are hermetic today — none carries a `skipif` guard
(verified 2026-08-03), so a new grant-path test added beside them **cannot skip green**,
unlike the room/authority files (`tenancy_and_visibility.md` §7's warning).
`test_tasks_project_grants.py` is **created by this slice** and is where done-when 1–5
live; it must likewise carry no `_db_ready()` guard. Re-list `tests/unit/` at dispatch
rather than trusting these names; there is no `test_tasks_items.py`.

#### C2 — Shared mailboxes · 🟢 **AGENT-SAFE (the doc action only)** · the build is 🔴 **blocked — no owner in fact**

*(Gate label, per contract item 7. **Corrected 2026-08-03:** this bullet used to read
"NOT DISPATCHABLE", which minted a **third** gate token into a corpus whose contract
allows exactly two — the same class of drift R2 and R3 exist to stop. It maps onto the
two without loss: the **doc action** below is ordinary AGENT-SAFE spec work — writing
the missing shared-mailbox section into `email_app_master_plan.md`, the spec D5 already
assigns — and the **build** is not gated on an owner *decision* but on that doc action,
so it is simply not dispatchable yet. Two clauses inside it stay owner's: **reassigning
ownership in `work_plan.md` §4** (an agent may not move work off the owner D5 named) and
any live mailbox reach. If the doc action lands and the build is still refused, that is
this bullet failing, not a missing third token.)*

**Struck from Phase C as an actionable bullet, 2026-08-03.** It read: *"`email_account_member`
by group (research §16.7); 'this mailbox belongs to the Sales team' ownership surfaced in
UI."* Two verified problems:

- **`email_account_member` is vapour.** Zero hits repo-wide across `*.sql` and `*.py`
  (measured 2026-08-03). It was cited as Phase-2 *content* by this spec and by
  `org_access_control.md:311` in a way that reads as though it shipped. It never
  existed. Nobody should cite it again as an existing table; if the work is built, the
  table is designed then, at the next free migration number resolved at build time.
- **The assigned owner does not mention it.** `work_plan.md` §4 assigns shared mailboxes
  to `email_app_master_plan.md`, "sequenced by WS-14" (D5). That spec contains **zero**
  occurrences of the phrase "shared mailbox" (measured 2026-08-03). Dispatching against
  it would send an implementer to a spec with nothing to implement.

**Where it really lives:** the storage shape is settled in
`tenancy_and_visibility.md` §5 — *a grant on the `email_accounts` **row**, not on
messages* — and `email_accounts.user_id` (`17_email_accounts.sql:16`) is the column it
widens. **The next action is not code: it is for `email_app_master_plan.md` to gain a
section for it, or for `work_plan.md` §4 to reassign the owner.** Until one of those
happens this bullet is not dispatchable and no agent should treat it as such.
WS-14 still *sequences* it (D5 is unchanged); WS-14 does not implement it.

#### C3 — Team-instanced agents · **AGENT-SAFE**, but read the traps first · ~1 PR

**Rewritten 2026-08-03 — the old bullet asked for agents that do not exist.** It sent
the implementer to the `agent-kinds.md` §6 roster for `sales` / `billing` / `delivery`
(`docs/multiplayer/agent-kinds.md:289-291`). **None of the seven aspirational agents named
in that roster exists.** `apps/agents/` holds exactly six, and they are different ones:
`agent-apis-config`, `agent-app-builder`, `agent-email-assistant`, `agent-orchestrator`,
`agent-task-manager`, `agent-whatsapp-assistant`. The roster is aspirational; it is not a
work list.

> ⚠️ **Trap — do not "align the agents to the roster".** The §6 roster assigns
> `task-manager`, `orchestrator` and `app-builder` **personal** instancing
> (`agent-kinds.md:288`, `:295`, `:296`). All three shipped `config.json` files say
> `"instancing": "shared"`. Flipping them to match the roster would **silently
> re-partition three live agents' memory and blob store**: `instance_key()` would start
> returning `u:<email>` instead of `''`, so `memory_scope()` moves from `agent:<slug>` to
> `agent:<slug>#u:<email>` and `blob_instance()` likewise — every existing memory and
> blob becomes unreachable from the running agent, with no error. That is a data
> migration wearing a config change's clothes, and `agent-kinds.md` §6 itself prescribes
> the quarantine-then-review procedure for it (shipped as migration 137). **It is not in
> this slice, and it is not AGENT-SAFE.**

> ⚠️ **Trap — the writer already exists.** `tenancy_and_visibility.md` §5 used to say
> `t:<team>` "exists but nothing writes it". That was false and is corrected there:
> `AgentManifest.instance_key()` returns `f"t:{self.sharing.team}"` for
> `instancing == "team"` (`acb_skills/manifest.py:242-246`), live on four non-test call
> sites. **What is missing is a config that asks for it, not code that produces it.**

**What this slice actually is, in order:**

1. **Decide which of the six existing agents (if any) should be team-instanced, and
   record it here.** The honest current answer is *possibly none*: two are already
   `personal` (email, whatsapp) and correctly so, and the four `shared` ones
   (apis-config, app-builder, orchestrator, task-manager) have no team boundary to draw
   yet because no team-owned agent has been built. A team-instanced agent becomes real
   when a Center gets its own agent — which is a new agent, not a re-flag of an existing
   one. **This is the first thing the ticket writes down**; it is a design note, and it
   is AGENT-SAFE to produce, but changing any existing agent's `instancing` is not.
2. **Reconcile the three contradictions** between `agent-kinds.md` §6 and the shipped
   `config.json` files, in the roster table itself. Either the roster is annotated as
   aspirational (preferred — it is an RFC), or a migration plan is written. Do not leave
   a table that a future reader will implement.
3. **The `dynamic_agents` sharing columns (D3).** Re-verified 2026-08-03:
   `15_dynamic_agents.sql:7-20` carries no owner, visibility or sharing column, and a
   repo-wide grep finds none — so this migration is genuinely WS-14's, at **the next
   free number resolved at build time** (R1). Per D3: columns now, derived from
   `agent_defs` manifests when agent-architecture Phase A lands.

   **The column shape is already written down — do not redesign it.** D3 points at
   `docs/multiplayer/agent-kinds.md` **§3**, whose `ALTER TABLE dynamic_agents` block
   (`agent-kinds.md:143-155`) is the shape of record: `instancing`
   (`personal|team|shared`, default `personal`), `visibility`
   (`private|team|organization`, default `organization`), `team_ref`, `memory_mode`
   (`instance|none`), `shareable`. Reproduced here so C3 is readable without opening
   an RFC under `docs/`. ⚠️ That block's own comment retains a stale `"119"`; take the
   **shape**, resolve the **number** at build time (R1).
4. **Answer, in the PR, whether that migration is additive to the live `config.json`
   path or replaces it.** `work_plan.md:149-153` (the D3 amendment) already says
   instancing ships via `config.json` today; the `agent_architecture.md` body does not
   say so, and this spec did not either. The default reading is **additive** —
   `dynamic_agents` rows describe GitHub-registered agents, `config.json` describes
   first-party ones, and `AgentManifest.from_config()` keeps reading the latter — but the
   ticket must state it rather than leave two stores with no precedence rule.

**Done when:** the roster contradictions are resolved in `agent-kinds.md`; the sharing
columns exist at a build-time-resolved migration number, in the `agent-kinds.md` §3
shape; the additive-vs-replacing question is answered in prose in this spec; and **no
existing agent's `instancing` value changed** (grep the six `config.json` files before
and after — four `shared`, two `personal`, unchanged).

> **For the reviewer, so this does not read as a no-op.** C3's only code artifact is a
> migration whose columns **nothing reads, on purpose**: it is **pre-provisioning,
> columns intentionally unread**, sanctioned by D3 ("columns now, manifest later"). No
> read path may be wired to them in this slice — instancing is served today by
> `AgentManifest.from_config()` / `instance_key()` off `config.json`, and adding a
> second live reader before WS-8 Phase A decides precedence is how two stores of truth
> start. A PR that ships these columns *and* a consumer is out of scope, not ahead of
> schedule. The rest of C3's value is documentary (the roster reconciliation and the
> additive-vs-replacing answer), and that is the honest description of the slice.

**Verification:**

```
uv run pytest tests/unit/test_agent_paths.py tests/unit/test_org_access_control.py -v -rs
rg -n '"instancing"' apps/agents/*/config.json     # expect 4 shared + 2 personal
```

#### C4 — Per-Center approvals routing · 🔴 **OWNER-GATE (an OWNER-DECISION)** — do not dispatch

**Re-stated honestly 2026-08-03.** It read: *"approvals inbox filterable by originating
group (org_access open Q2)."* That describes a UI filter. It is not one, for two
verified reasons.

**First, the question is open, verbatim.** `org_access_control.md:405` Q2:

> *"**Approval routing.** When a member lacking `admin:*` triggers an action needing
> approval, who is asked? Phase 1 routes to anyone with `feature:approvals`; per-module
> approvers is a Phase 2 question."*

Who is asked is a policy call about who can approve spending and outward writes on
another Center's behalf. No agent may take it. **OWNER-GATE.**

**Second, there is no column you can route on.** `infra/postgres/66_pending_actions.sql:13-38`
defines the whole row: `id`, `actor`, `action`, `target`, `payload`, `authority`,
`destructive`, `disposition`, `status`, `result`, `reviewed_by`, `reviewed_at`,
`created_at`. There is **no requesting-member column, no group column, and no Center
column.**

> **Correction, 2026-08-03 — this paragraph previously overstated its own evidence, and
> the overstatement was the exact sin WS-14 exists to fix.** It read: *"`actor` is the
> proposing agent … not the human behind it. A group cannot be derived from any existing
> column."* **Both halves of that absolute are false.** `pending_actions.actor` is
> written by exactly six `propose()` call sites, and **two of them put the requesting
> human's email in the string**: `routes/apps/tools.py:392-393` and
> `routes/apps/actions.py:344-345` both pass `actor=f"app:{slug}:{email}"`, where
> `email = _uid(user)` is the caller's identity (`tools.py:375`). For an app-tool
> proposal a group **is** derivable — parse the email out of the string and join
> `org_group_member`. The column comment's `"agent:sales"` is an *example*, and as it
> happens no shipped call site produces that shape at all.
>
> **The six shapes, measured (`rg -n 'proposal = propose\('` + the `actor=` argument at
> each site):**
>
> | Shape | Written at |
> |---|---|
> | `app:<slug>:<email>` | `routes/apps/tools.py:393` · `routes/apps/actions.py:345` |
> | `app:<slug>` | `routes/apps/publish.py:211` |
> | `workflow:<name-or-id>` | `routes/workflows/service.py:668`; threaded into `routes/workflows/tools.py:190` from `service.py:337` |
> | `tasks:<provider>` | `routes/tasks/providers.py:159` via `_broker_actor()` (`:127-130`) |
> | `tasks:clickup:ws:<workspace_id>` | the ClickUp override of the same method, `providers.py:314-317` |
>
> One shape on the list handed to this correction — `system:action_broker` — is **not**
> a `pending_actions.actor` at all: it is the *audit-event* actor the broker stamps on
> its own bookkeeping (`action_broker/broker.py:151`, `:161`, `:172`, `:225`, `:233`).
> Recorded so the next reader does not go looking for a seventh proposer.
>
> **The verdict survives; only the reasoning is repaired.** `actor` is a free-text
> identity string with **five** shapes and no grammar, and only **two of six** call
> sites carry a human at all. You cannot route approvals on a field that four of six
> proposers populate with no person in it — a Center-scoped inbox would silently show
> nothing for every workflow-, publish-, and provider-originated proposal. So C4 is
> still "answer Q2, then add a column", and the column must be **written by every
> proposer**, not parsed out of an ad-hoc string by the reader. That is a stronger
> argument than the false absolute it replaces, not a weaker one.

**So the ticket is "answer Q2, then add a column", not "add a filter".** In that order:
the column's shape (a `requested_by` member email? a `center` slug? both?) follows from
the answer, and adding one first would bake in a routing model nobody chose. When Q2 is
answered, the migration goes at the next free number resolved at build time (R1), and
the filter is the small part.

### Phase D — Dashboards and the Company Center
- **Center dashboards**: per-department rollup pages replacing the "planned"
  cards, fed by app queries + digest workflows (`workflows_app.md` G1 names
  report digests as a launch goal).
- **Personal dashboard**: the Personal Center rollup (footnote ¹).
- **Fix the two flagged defects under the founder view**:
  orchestrator runs without org-scope memory (`agent_architecture.md` §11.1.2),
  and per-agent observability totals are misleading once instancing lands
  (`agent-kinds.md` §9.4 — per-instance cost attribution).
- **Weekly executive digest**: a scheduled workflow per Center → one Company
  Center brief.

### Phase E — AI budgets and governance
- **Per-member AI budgets**: monthly token/cost caps enforced at the gateway's
  LLM choke points (all traffic already flows through them with cost recorded
  per run). Soft-warn at 80%, downgrade-to-fast-tier or block at 100%
  (owner-configurable), exec exempt. Surfaced in Models settings + per-member
  admin view + observability. Depends on Phase D's attribution fix.
- Attribution and subject ordering per `work_plan.md` D1/D2: one attribution
  record — (run, member, agent, instance) stamped at the choke points — with
  per-member caps first; the multiplayer plan's per-room `token_budget` +
  degrade-to-read-only builds later on the same records.
- Later, per-group budgets roll up the same data by Center.

### Deliberately not in this plan
- Floor control / steer / observer lane — multiplayer workstream
  (`docs/multiplayer/README.md` §8), tracked there.
- Entity-graph RLS and consent records — org_access Phases 4–5.
- Multi-tenant / SaaS — research §17; untouched by Centers.

## 4. Open questions

1. ~~**"Pomad Centre."**~~ **Resolved 2026-08-01.** Owner confirmed the name
   was a stray (should have read Command Center), not a planned venture. All
   twelve sites across eight files were rewritten as "a second tenant
   deployment" — preserving each sentence's meaning, including the T2
   security gate in `agent_platform_hardening_2026-07.md` §64. Decision
   record: `work_plan.md` D9.
2. **R&D / Engineering Center?** Fracktal is a product company; a seventh
   Center (projects, test logs, design docs) is plausible. Deferred until a
   real workflow demands it. Adding one is **not** a one-file edit: work §2's
   *Registering a Center* checklist end to end — `lib/centers.ts`, a
   `feature_catalog` migration row, `acb_auth.permissions.FEATURES`,
   `CENTER_GROUP_SLUGS`, and the test anchor `EXPECTED_CENTER_SLUGS`. Doing
   only the first two is how Centers came to be unreachable by everyone once
   already; `tests/unit/test_org_access_control.py::test_centers_registry_matches_the_feature_vocabulary`
   is what now stops that recipe from passing CI.
3. **Support: Operations sub-app or own Center?** Service & AMC starts inside
   Operations; if the support team grows its own membership and mailbox, it
   graduates to a Center by that same checklist.
4. **Guest access to Centers** — org_access open Q4; a guest with
   `center.sales` only is a plausible contractor shape and needs a decision
   before external sharing.
