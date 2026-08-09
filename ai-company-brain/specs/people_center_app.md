# People Center — the directory, the org chart, and the assignment seam

> **Product:** CommandCenter · **Feature:** People Center (`/centers/people` and the
> `/people` app behind it) · **Created:** 2026-08-06 · **Status:** 🔲 **SPEC, nothing built**
> · **Owner:** vjvarada · **Board row: WS-28**
>
> **Scope, owner-set 2026-08-06:** directory, skills, org chart, capacity, and the
> seats/roles view that decides which Center somebody belongs to — *exactly what assignment
> and planning need*. Leave, onboarding and hiring are named as later phases in §8 and are
> deliberately not designed here.
>
> **This spec owns SURFACES, not facts.** Every fact about people, permissions and Centers
> is owned elsewhere and cited, never restated:
> - `specs/task_manager_hr_planning_and_memory.md` — HR intelligence, résumé ingestion,
>   capability vectors. **Owns the data**; this doc owns how it is seen and edited.
> - `specs/org_access_control.md` — members, roles, per-user overrides. **Owns identity.**
> - `specs/colleague_onboarding.md` — the invite runbook and the role × app capability
>   matrix. **Owns the process.**
> - `specs/department_centers.md` — Centers, groups, the five-place registration checklist.
>   **Owns the projection model.**
> - `specs/project_management_app.md` — projects, tasks, assignment. **Owns the work.**
>
> A reader who wants "what is a manager allowed to see" goes to `colleague_onboarding.md`
> §3. This doc answers "where do I click to change who someone reports to".

---

## 1. Why this exists

Assignment is the whole reason. The Projects app (WS-27) can hand a task to
`alice@fracktal.in` today, but nothing in the product answers the questions a person asks
*before* they assign:

- Who is there? Who is in Operations?
- Who knows about extruder firmware?
- Who has capacity this week, and who is already at 40 hours?
- Who does this person report to, and whose approval does this need?

Those answers exist in the database already (`gtd_people` has skills, capacity, a manager
link and a 1536-dim capability vector) and are reachable through exactly one narrow surface
— a table inside the Tasks app. **The People Center is where they become a first-class
place**, and the Projects app reads them rather than growing its own copy.

**Non-goals (v1):** payroll, performance reviews, compensation, time-off balances,
applicant tracking. §8 records where those would go if they are ever wanted.

---

## 2. The two people stores, and why there are two

This is the single most important thing to understand before building anything here, and it
is not a defect to be tidied away.

| | `app_user` (+ `user_role`, `org_group_member`) | `gtd_people` (+ `gtd_person_resumes`) |
|---|---|---|
| Answers | *Can they sign in, and what may they see?* | *Who are they, what can they do, who do they report to?* |
| Created by | An invite (`POST /admin/members`) or a sign-in request | An import, a résumé upload, or a hand-added row |
| Owned by | `org_access_control.md` | `task_manager_hr_planning_and_memory.md` |
| Key | `email` | `name` (UNIQUE), with `email` nullable |
| Includes people who never sign in | No | **Yes** — contractors, a new hire before day one, a vendor contact |

**They are joined on lowercased email, and the join is deliberately partial.** A person can
exist in the directory with no login (a contractor you assign work to but who has no seat),
and a login can exist with no directory row (a service identity). Collapsing them into one
table would force every contractor to become a member — which is a *licensing and access*
decision, not a directory one.

⚠️ **`gtd_people.name` is UNIQUE and `email` is not.** That is migration 49's shape and it
is wrong for a directory that has to join on email: two people cannot share a name, and
nothing stops two rows carrying the same address. **P-1 in §7 fixes this** before the
directory becomes the assignment source, because an ambiguous email→person join would
silently attribute one person's capacity to another.

**The rule this doc adds:** the People Center *renders both* and never creates a third
store. WS-13's board row already says it — "build the read view here, not a parallel store"
— and this is that instruction, made concrete.

---

## 3. The surfaces

Route: **`/people`**, gated on its own feature slug `people` (§6). The People Center's
landing page (`/centers/people`) links to it, and it is one app, not one per Center — the
same (app + scope) rule the Projects app follows.

### 3.1 Directory — the default view

A searchable list of everybody, one row per person, with a card/table toggle.

**Row:** avatar (initials fallback), name, title, department + team, status pill
(`active` / `contractor` / `alumni`), and a compact skills strip (top 3 + "＋4").
**Search** matches name, title, department and skills in one box — the Projects app's
assignee picker uses the same endpoint, so a person findable in one is findable in both.
**Filters:** department, team, status, skill, "has capacity".

⚠️ **The HR strip is permission-dependent and already enforced.** WS-24 N4 shipped
*directory open, HR fields restricted*: without `admin:members:read`, `skills`,
`resume_summary`, `years_experience` and the capacity trio are projected to null, and `?q=`
drops its skills clause so search cannot become an oracle. **The UI must render the
projected shape, never re-fetch a richer one** — and the empty state should say "restricted"
rather than "none", because a blank skills strip that means "you may not see this" and one
that means "nobody filled it in" are different facts.

### 3.2 Person page

One person, four panels:

1. **Identity** — name, title, email, department, team, manager, status. The email carries a
   badge saying whether this person has a **login** (`app_user` exists) or is
   **directory-only**. That badge is the visible half of §2 and stops "why can't they see
   the board" being a mystery.
2. **Skills** — editable chips, each showing its **source**: `stated` (typed by a human) or
   `résumé` (extracted). `gtd_people.skills_source` already carries this. A skill nobody
   stated and the parser inferred should not look like a claim the person made.
3. **Capacity** — `capacity_hours_per_week`, `current_load_hours_per_week`, and the derived
   `available`. Rendered as one bar, not three numbers. **Load is computed from open
   assigned tasks** (§5.2), so the bar moves when work is assigned — a hand-typed load
   figure is stale the moment anyone assigns anything.
4. **Work** — this person's open tasks across every project the *viewer* may see, with a
   link to each. Scoped by the viewer's grants, not the subject's: a Sales lead looking at
   an Operations colleague sees the Sales work they share, not that person's whole life.

**Writes** are gated on `admin:members:manage`, which WS-24 N4 already put on all four
people-write routes. A viewer without it sees the page read-only, with no disabled-button
theatre — the controls are absent.

### 3.3 Org chart

`gtd_people.manager_id` is a self-FK, so the chart is the same recursive render the project
tree already uses — and the same cycle guard applies (a manager loop is a hang, not a
diagram).

- **Layout:** vertical tree, collapsible, with search-to-focus.
- **Unmanaged people** surface as roots. That is not an error state to hide: "nobody is
  recorded as this person's manager" is exactly what an org chart should make obvious.
- **Drag to re-parent** writes `manager_id` (gated), with the cycle refused client-side
  before the request so the tree does not optimistically render an impossible shape.
- **Center overlay:** each node can be tinted by the person's `org_group` membership, which
  is what makes "who is actually in Operations" answerable — and shows the mismatches
  between `gtd_people.department` (free text) and group membership (the real scoping).
  **That mismatch is the point of the overlay**, not a rendering bug to smooth over.

### 3.4 Seats & roles

The bridge to `org_access_control.md`, rendered here because "who is in Sales" is a People
question that today requires visiting `/settings/groups`.

A matrix: people down the side, the six Centers across the top, a checkbox at each
intersection reflecting `org_group_member`. Toggling one is a **group membership write** —
already an owner gate (`work_plan.md` §6 (d)), so this surface **proposes and does not
apply** for anyone but the owner: a non-owner's toggle produces a request in the existing
access-request queue rather than a silent 403.

Beside it, each person's **role** (`owner`/`admin`/`manager`/`member`/`guest`) as a
read-only pill linking to `/settings/members`. Roles are not edited here — one editor for a
thing, and that editor already exists.

### 3.5 Capability search — "who should do this?"

A single box: *"Who can help with extruder firmware?"* Answers from three signals, most
defensible first, each labelled in the result:

1. **Stated skills** — an exact/fuzzy match on `skills[]`. Deterministic.
2. **Résumé evidence** — a match in `gtd_person_resumes.extracted`, quoting the line.
3. **Capability vector** — cosine similarity on `capability_embedding` (1536-dim, already
   populated by `POST /tasks/people/embed`), for the cases the first two miss.

Each result shows **why it matched and how loaded that person is**, because a perfect skill
match at 45/40 hours is usually the wrong answer. This is a *suggester*: it never assigns.
The same rule as the ClickUp Space mapper (D-PM-10) and for the same reason — a system that
auto-assigns work to people is making a management decision it is not entitled to make.

---

## 4. Where the People Center meets the Projects app

Four seams. All are **reads from Projects into People**, or **reads from People into
Projects** — neither app writes the other's tables.

### 4.1 The assignee picker (Projects → People)
Assigning a task opens a picker backed by the directory endpoint, not by a list of
`app_user` rows. It shows name, title, top skills and a capacity bar, and it lists
**agents** in the same picker under a separate heading — D-PM-4's one-vocabulary decision
made visible: handing work to an agent is the same gesture as handing it to a colleague.

⚠️ The picker must offer **directory-only people** (no login). They can hold a task and
appear on a board; they simply cannot sign in to see it. Hiding them would make the
directory's whole point — contractors — unusable, and the assignee column is a plain string
precisely so this works (§3.6 of the Projects spec).

### 4.2 Capacity (Projects → People)
`current_load_hours_per_week` is **derived**, not typed: the sum of `estimate_mins` over
open tasks assigned to that person, divided into a week. Recomputed on assignment change and
on a schedule. Until estimates are widely filled in, the bar shows *task count* with an
honest "no estimates" label rather than a load figure invented from nothing.

### 4.3 The person's work panel (Projects → People)
`GET /projects/tasks?assignee=<email>`, already shipped, scoped by the *viewer's* grants.

### 4.4 Delegation (People → Projects)
From a person page: **"Assign work"** opens task creation with the assignee pre-filled. And
from the capability search: **"Assign to…"** on a result. Both land in the ordinary task
create flow — no second write path, so every rule the Projects app enforces (visibility,
status, activity) applies unchanged.

---

## 5. Data model

**No new people tables.** The People Center reads `gtd_people`, `gtd_person_resumes`,
`app_user`, `org_group` and `org_group_member`. Two additive changes only, both in §7:

- **P-1** — fix `gtd_people`'s key shape (§2): drop the UNIQUE on `name`, add a partial
  UNIQUE on `lower(email) WHERE email IS NOT NULL`. Without it the email join is ambiguous.
- **P-2** — `gtd_people.status` gains a CHECK (`active`/`contractor`/`alumni`/`invited`) and
  `gtd_people.has_login` becomes a *derived* read, never a column: two columns that must
  agree are two columns that can disagree.

Capacity is computed (§4.2), not stored beyond the existing columns.

---

## 6. Registration

The four-place checklist the Projects app followed (`project_management_app.md` §5):

1. `acb_auth.permissions.FEATURES` gains `"people"`.
2. A `feature_catalog` row at the next free migration number: `('people', 'People',
   'Directory, skills and org chart', '/people', 'apps', 57, false)`.
3. `nav.ts` `PANES` + `access.ts` `HREF_FEATURES` → `/people` → `people`.
4. The both-ways catalog↔FEATURES invariant picks it up; add the named
   `test_people_is_registered_on_both_sides`.

Plus the Center projection: `centers.ts` People Center's **"Directory & org chart"** sub-app
flips to `{status: "live", href: "/people"}` — closing WS-13's outstanding item, which asked
for exactly this read view.

**Visibility posture:** `is_default false`, like `crm` and `projects`. The directory is
open to holders; the HR fields inside it are restricted by `admin:members:read` — a
restriction that already exists and must not be re-implemented here.

---

## 7. Tickets

**WS-28a — the key-shape fix (P-1, P-2).** ✅ **BUILT 2026-08-06**
(migration `148_people_key_shape.sql` + `scripts/import_hr_people.py`; 22 static/hermetic
cases, 11 mutants red, 1 equivalent).
Done when: `gtd_people` no longer uniquely constrains `name`; a partial unique index exists
on `lower(email)`; a status CHECK exists; and a test proves two people may share a name and
may not share an address.

**What P-1 did not name, and it matters:** `scripts/import_hr_people.py` upserts
`ON CONFLICT (name)`. Dropping `UNIQUE(name)` leaves that with no constraint to infer, so
the importer fails outright — "no unique or exclusion constraint matching the ON CONFLICT
specification". The fix is a **`source_key`** column (`<source>:<lower(name)>`) with its own
partial unique index. That key is honest about what it claims: the HR snapshot is a JSON
object keyed by name, so names are unique *within that file* whether or not they are unique
among humans. It also means a person hand-added in the People Center is never overwritten by
a snapshot re-import. Backfilled **before** the constraint is dropped, while `name` is still
guaranteed distinct — which is what makes the backfill collision-free by construction.

**Nothing in this migration may block a deploy**, and that shaped both changes.
`apply_migrations.sh` replays every `02+` migration on every deploy under
`set -euo pipefail` + `ON_ERROR_STOP=1`; main has already been bitten twice this month by a
migration that stopped deploys. Both new constraints could plausibly fail on live rows:

- **A duplicate address** would fail `CREATE UNIQUE INDEX`. The loser's address is moved to
  a new `email_conflict` column instead — visible, reversible, non-blocking. Losing an
  address silently would be worse than the ambiguity this fixes; aborting the deploy would
  be worse than both. The winner is chosen **deterministically** (`updated_at`, then
  `created_at`, then `id`) so a re-run against a restored backup cannot pick differently.
- **An unanticipated status value** would fail the CHECK. Migration 49 documented
  `'active' | 'inactive' | …` and the `…` is the problem. Known legacy spellings are mapped
  (`inactive|former|left` → `alumni`); anything else is **left alone rather than rewritten**,
  and the constraint is added `NOT VALID` then validated in a guarded block. New writes are
  enforced either way; a legacy offender leaves the constraint un-validated with a `NOTICE`
  instead of stopping the deploy.

⚠️ **`schema.generated.sql` is NOT refreshed** — `scripts/dump_schema.sh` needs a live
database with the ladder applied, which this build had no access to. Regenerate it on the
first deploy that applies 148, per `infra/postgres/README.md` step 3.

**WS-28b — directory + person page.** ✅ **BUILT 2026-08-06**
(mig `149_people.sql`, `routes/people/`, `src/app/people/`; 32 hermetic + 28 vitest cases,
11 mutants red).
Done when: `/people` lists and filters; the person page renders all four panels; the HR
projection is honoured with a "restricted" empty state distinct from "none"; writes are
gated on `admin:members:manage` and absent (not disabled) without it.

**The permission story here is a projection, not a refusal**, and that shaped everything.
Four decisions worth reading:

- **The gate is new; the projection is imported.** `routes/people/core.py` re-exports
  `tasks.core.can_read_hr_fields` rather than defining its own — two answers to "may this
  caller see skills" are two answers waiting to drift, and a test asserts the *identity* of
  the function object, not merely that both agree today.
- **Three filters are the same rule wearing different hats.** The `q` skills clause, the
  `skill` filter and `has_capacity` are all dropped without `admin:members:read`, because
  matching on a column that is then stripped turns the search box into an oracle for the
  field the projection exists to hide. Dropping them silently would be its own defect, so
  the response carries **`hr_visible`** and the UI states it once at the top instead of
  leaving a blank strip to be misread as "nobody filled it in".
- **Load is computed, and says when it cannot be.** `current_load_hours_per_week` is a
  number somebody typed once. The bar counts open assigned tasks — and carries
  `unestimated`, because a task with no estimate adds no hours and a bar built from the sum
  alone shows somebody holding thirty un-estimated tasks as completely free. When nothing
  is estimated the bar refuses to draw a percentage rather than drawing a confident zero.
- **The work panel is scoped by the VIEWER**, via the Projects grant closure, and answers
  `available: false` without `feature:projects` — "this surface is not yours" and "they
  have nothing open" must not render identically.

**Registration is five places, not four** — §6 lists `FEATURES`, `feature_catalog`,
`nav.ts`/`access.ts` and `centers.ts`, and there is a fifth that is hand-maintained and easy
to miss: `test_org_access_enforcement.GATED_ROUTERS`. A router absent from that registry is
not passing, it is *unchecked*. Also added: `test_projects_is_registered_on_both_sides`,
which WS-27a never wrote — the generic pair passes when **both** sides are missing a slug,
so only a named test catches a feature nobody registered.

The person-page **writes stay on `/tasks/people`** under `admin:members:manage`. The
`/api/people` proxy is **GET-only** for that reason: forwarding write verbs to endpoints the
gateway does not serve would mint a second, hollow write path, and the first person to find
it would reasonably assume it worked.

**WS-28b-write — the person write half.** ✅ **BUILT 2026-08-07.** *(Minted 2026-08-06 as a
REGRESSION to close, not a new idea.)*
The tasks app's People view was removed the same day (owner-directed scope narrowing,
`task_manager_app.md` §6.0), and `PersonEditor` went with it. That was the only UI for
creating a person, editing their skills, and uploading a résumé. **The API was untouched** —
`POST /tasks/people`, `PATCH /tasks/people/{id}`, `POST /tasks/people/{id}/resume`, all on
`admin:members:manage` — but until this landed, an admin could not do any of it from the
product.
Shipped: `people/components/PersonEditor.tsx` (create + edit + résumé, themed through
`Button`/`Input`/`Icon`), `people/lib/form.ts` (the pure half) and `people/lib/write.ts`
(the write client). The proxy decision above is **unchanged**: `write.ts` calls
`/api/tasks/people`, never `/api/people`, so no write verb was added to the GET-only proxy.
The controls are absent without `admin:members:manage`, driven by a new **`can_manage`** flag
on the directory and person reads — the UI cannot hide-rather-than-disable unless the read
tells it, and discovering the answer from a 403 after the click is the behaviour §3.2 rejects.

**Restoring it turned up three ways migration 148 had already broken the write routes**, all
of which would have failed at the database rather than at the request — see §10.

**WS-28b-write-2 — assign a login from the person page.** 🟡 Not filed as a defect; named so
its absence is a decision. `has_login` is displayed and cannot be acted on: an admin who sees
"directory-only" still has to go to `/settings/members` to invite them. The join is
`lower(email)` on both sides, so the action is well-defined — it belongs with WS-28f's seats
matrix rather than bolted onto the editor.

**WS-28c — org chart.** 🟢 AGENT-SAFE.
Done when: the tree renders from `manager_id`, unmanaged people surface as roots, a
re-parent that would create a cycle is refused before the request, and the Center overlay
shows department/group mismatches rather than hiding them.

**WS-28d — capability search.** 🟢 AGENT-SAFE to build; the ranking prompt is **EVAL-LOCKED**.
Done when: all three signals are queried, each result names which matched and shows load,
and the surface never writes an assignment.

**WS-28e — the Projects seams.** 🟢 AGENT-SAFE.
Done when: the assignee picker is directory-backed and lists agents and directory-only
people; capacity is derived from open assigned tasks with an honest no-estimates state; and
"Assign work" routes through the ordinary task-create flow.

**WS-28f — seats & roles matrix.** 🔴 **OWNER-GATE** for the write half: group membership
writes are already registered in `work_plan.md` §6 (d). Building the read matrix and the
propose-a-change path is agent-safe; applying a membership change is the owner's act.

---

## 8. Later phases, named so their absence is a decision

- **Onboarding** — checklists that provision accounts and first-week tasks. Would bind to
  `colleague_onboarding.md`'s runbook and create tasks in the Projects app, not a new store.
- **Leave & attendance** — needs a policy model (accrual, approval chains) that nothing in
  the platform has, and an approval path that should reuse the Action Broker inbox.
- **Hiring pipeline** — structurally a second CRM (candidates as leads, stages as statuses).
  If wanted, it should reuse the `crm_*` shape rather than invent a third pipeline.
- **Performance, compensation, payroll** — out of scope, and each carries data-sensitivity
  questions (§2's HR restriction is the *floor*, not the answer) that need deciding before
  any of it is designed.

---

## 9. Verification

⚠️ Never `uv run pytest tests/unit/` bare — name the files.

```bash
uv run pytest tests/unit/test_people_directory.py tests/unit/test_people_write.py \
              tests/unit/test_people_key_shape.py tests/unit/test_tasks_people_scoping.py \
              tests/unit/test_org_access_control.py tests/unit/test_org_access_enforcement.py
cd workbench/control_plane && npx tsc --noEmit && npm test && npx vitest run src/lib/theme/
```

Every file above **exists**. The previous version of this block named three that do not
(`test_people_org_chart.py`, `test_people_capability.py`, `test_people_migration.py` — they
belong to WS-28c/d and to a migration test that ended up called `test_people_key_shape.py`),
and pytest answers a missing path by collecting *nothing* and exiting non-zero. A
verification command that cannot run is a verification command nobody runs; add a file here
when its ticket lands, not when its ticket is written.

`test_tasks_people_scoping.py` is in the list deliberately: WS-24 N4's 35 cases are the
fence around the HR projection, and any new read path over `gtd_people` must leave them
green rather than route around them. `src/lib/theme/` is in it because the theming engine's
conformance gate carries a frozen debt baseline that a new component can only make worse.

---

## 10. Migration 148 changed the table under the write routes

Found while restoring WS-28b-write, and worth recording as a pattern rather than as three
bugs: **148 was written for the read side, and nothing checked the write side against it.**
Each of the three would have surfaced as a 500 in front of an admin mid-typing, not as a
test failure.

1. **The status vocabulary moved and the editor did not.** 148 replaced migration 49's
   `'active' | 'inactive' | …` with a CHECK on `active | contractor | alumni | invited`. The
   deleted `PersonEditor` offered `active / inactive / on_leave`; restoring it verbatim would
   have shipped a status select where two of three options are refused by Postgres with a
   `CheckViolation`. Fixed by making the vocabulary **one tuple**
   (`tasks/core.py:PEOPLE_STATUSES`, re-exported as `people/core.py:STATUSES`) that the
   filter, the facets response, the editor's select and the write validation all read, and by
   validating in the route so the answer is a 400 that lists the four words.

2. **`create_person` still refused a duplicate NAME.** 148 dropped `UNIQUE(name)` on the
   explicit argument that two real people share a name and one of them was being locked out.
   The route-level `LOWER(name)` 409 preserved exactly the behaviour the migration existed to
   remove. Removed; what must be unique is the address, because that is the join key.

3. **Nothing checked the address that 148 made unique.** The new partial unique index on
   `lower(email)` turns a duplicate into an `IntegrityError` — a 500 naming a constraint. Now
   pre-checked, case-insensitively on both sides (R10), answering 409 with the name of the
   row already holding it; and a blank address is stored as NULL, because `''` is not NULL
   and two blanks would collide under the same index.

**The general lesson:** a migration that changes a table's *shape* has to be walked against
every route that writes it, not only the ones that read it. The read routes were built after
148 and were correct by construction. The write routes predated it and were never revisited.

## Board record (2026-08-09) — moved from work_plan.md §2

> Moved here in the 2026-08-09 consolidation (work_plan.md D18): board rows now
> carry state + gates only. The narrative below is preserved verbatim from the
> final long-form row; the dated corrections after it win where they conflict.

### WS-28 — **People Center — directory, org chart, and the assignment seam** *(minted 2026-08-06)*
**State cell (as of the move):** ✅ **a + b BUILT 2026-08-06 · b-write BUILT 2026-08-07** · 🟢 c–e dispatchable · 🔴 f owner-gate
**Narrative (verbatim):** Scope owner-set 2026-08-06: **directory, skills, org chart, capacity, seats/roles — exactly what assignment and planning need**; leave/onboarding/hiring are named as later phases so their absence is a decision. **The fact this spec exists to settle:** there are TWO people stores and that is deliberate — `app_user` answers *can they sign in and what may they see*, `gtd_people` answers *who are they and what can they do*, and the directory must include people with **no login** (contractors), which is why the Projects app's assignee is a plain string. They join on lowercased email, and **P-1 fixes that join before it is relied on**: migration 49 made `name` UNIQUE and left `email` unconstrained, so today two rows may share an address and an email→person join is ambiguous. Surfaces: directory (honouring WS-24 N4's HR projection, with a *restricted* empty state distinct from *none*) · person page · org chart from `manager_id` with a Center overlay that **shows** department/group mismatches rather than smoothing them · capability search over stated skills → résumé evidence → the existing `capability_embedding`, which **suggests and never assigns** · seats & roles matrix (read + propose; applying a membership change stays owner-gated per §6 (d)). Closes WS-13's outstanding *People directory read view* item. Tickets **a** key-shape fix (🟢) · **b** directory + person page (🟢) · **c** org chart (🟢) · **d** capability search (🟢, ranking EVAL-LOCKED) · **e** the Projects seams — directory-backed assignee picker listing agents and directory-only people, capacity derived from open assigned tasks (🟢) · **f** seats & roles writes (🔴 OWNER-GATE).. **a BUILT 2026-08-06** (mig `148_people_key_shape.sql` + `scripts/import_hr_people.py`; 22 cases, 11 mutants red, 1 equivalent): `UNIQUE(name)` dropped, partial unique on `lower(email)`, status CHECK. **P-1 did not name its own consequence** — the HR importer upserts `ON CONFLICT (name)` and would have failed outright, so a `source_key` (`<source>:<lower(name)>`) carries the upsert instead, backfilled BEFORE the constraint is dropped while `name` is still distinct. **Neither new constraint may block a deploy** (main was bitten twice this month): a duplicate address is quarantined into a new `email_conflict` column with a deterministic winner rather than failing `CREATE UNIQUE INDEX`, and the status CHECK is added `NOT VALID` then validated in a guarded block, so an unanticipated legacy value leaves a NOTICE instead of stopping the deploy. ⚠️ `schema.generated.sql` NOT refreshed — needs a live DB; regenerate on the first deploy that applies 148. **b BUILT 2026-08-06** (mig `149_people.sql`, `routes/people/`, `src/app/people/`; 32 hermetic + 28 vitest cases, 11 mutants red): `/people` directory, person page with all four panels, and the People Center's "Directory & org chart" sub-app flipped live — closing WS-13's outstanding read view. **Its own feature slug**, not `feature:tasks`: a manager who needs the org chart should not be handed the personal GTD task manager to get it. The gate is new but the HR **projection is imported** from `tasks.core` and a test asserts the function's *identity*, since two answers to "may this caller see skills" are two answers waiting to drift. Three filters (the `q` skills clause, `skill`, `has_capacity`) are dropped without `admin:members:read` so search cannot become an oracle for the hidden field — and the response carries `hr_visible` so the UI says "restricted" rather than leaving a blank strip to read as "nobody filled it in". Load is **computed from open assigned tasks** and carries `unestimated`, because a bar built from the estimate sum alone shows somebody holding thirty un-estimated tasks as completely free. The work panel is scoped by the **viewer's** grants and answers `available:false` without `feature:projects`. **Registration is FIVE places, not four** — the fifth is `test_org_access_enforcement.GATED_ROUTERS`, hand-maintained, where an absent router is unchecked rather than passing; also added the named `test_projects_is_registered_on_both_sides` that WS-27a never wrote. **b-write BUILT 2026-08-07** (`people/components/PersonEditor.tsx`, `people/lib/form.ts`, `people/lib/write.ts`; 26 hermetic + 23 vitest cases, 7 mutants red): closes the regression the 2026-08-06 scope narrowing opened — deleting the tasks app's People view took `PersonEditor` with it, and with it the only UI for creating a person, editing skills and uploading a résumé. The GET-only `/api/people` proxy is **unchanged**: the writes go to `/api/tasks/people`, where they have always lived. Controls are absent rather than disabled, driven by a new **`can_manage`** flag on the reads — hide-rather-than-disable is impossible unless the read tells the UI, and the alternative is drawing the button and letting the click find a 403. **Restoring it turned up three ways migration 148 had already broken the write routes**, each a 500 in front of an admin rather than a test failure: the status vocabulary moved (49's `inactive`/`on_leave` vs 148's CHECK) and is now ONE tuple shared by filter, facets, select and validation; `create_person` still refused a duplicate NAME, preserving precisely the behaviour 148 dropped `UNIQUE(name)` to remove; and nothing checked the address 148 made unique, so a duplicate was an `IntegrityError` instead of a 409 naming the other row. **The lesson recorded in spec §10:** a migration that changes a table's shape has to be walked against every route that WRITES it — the read routes were built after 148 and were correct by construction, the write routes predated it and were never revisited

**Corrections applied 2026-08-09:** schema.generated.sql regeneration is DUE — stale since ~migration 113, and migration 148 reached prod ~2026-08-07 after the #384 cast fix.
