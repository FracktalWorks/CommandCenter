# PROJECT OPERATIONS — IMPLEMENTATION PLAN

**Surface:** `/projects` in CommandCenter (WS-27) · **Domain:** engineering project
operations for an automotive/industrial product-development company ·
**Revision:** 2026-08-12, rewritten against the supplied UI/UX mock.

---

## HOW TO READ THIS DOCUMENT

| Part | What it owns |
|---|---|
| **0** | Status ledger — what is already built, what is on the branch, what is missing. Read this first; the original brief assumed greenfield and it is not. |
| **I** | Product — context, the questions the system must answer, the one product decision. |
| **II** | Domain model — as actually implemented in migration 171, not as originally imagined. |
| **III** | **The UI contract** — screen by screen, derived from the mock. This is the new material and the bulk of the remaining work. |
| **IV** | Backend still owed — aggregates, capacity, snapshots, performance, security. |
| **V** | Data — the 29 supplied projects and their normalization rules. |
| **VI** | Delivery — slice sequence, tests, acceptance criteria, open decisions. |

**Precedence.** Where this document disagrees with the code, the code wins and this
document is a defect. Where it disagrees with `project-docs/work_plan.md`, the work
plan wins. Where it disagrees with `workbench/control_plane/DESIGN_SYSTEM.md`, the
design system wins.

---

# PART 0 — STATUS LEDGER

## 0.1 The audit is done. Here is what it found.

The original brief opened with "first, audit the repository." That audit has been
performed and its findings are recorded below, so no future agent repeats it.

**The application is CommandCenter.** Next.js 16 / React 19 / Tailwind v4 front end in
`workbench/control_plane`; FastAPI gateway in
`apps/services/gateway/gateway/routes/projects/`; PostgreSQL with numbered migrations in
`infra/postgres/`; multi-tenant by row (`organization_id` + FORCE ROW LEVEL SECURITY)
bound at the `acb_common.db` seam.

**A Projects app already exists** and is substantial: 30 route modules, a 1,771-line
page shell with five view modes, a keyboard/command layer, ClickUp import, custom
fields, saved views, recurrence, delta-sync and CSV export. **It must be extended, not
replaced.**

## 0.2 What is already shipped

| Capability | Where | State |
|---|---|---|
| Project/task tree, self-FK hierarchy | `pm_projects`, `pm_tasks` | main |
| Statuses as data, per root project | `pm_task_statuses` | main |
| Activity spine | `pm_activities` | main |
| Attachments, notifications, task links, watchers, tags | `pm_task_*`, `pm_notifications` | main |
| Views, filters, search, export, ClickUp import | `views.py`, `search.py`, `export.py` | main |
| List / board / calendar / timeline / tree view modes | `page.tsx` + `components/` | main |
| `Modal` and `Toast` primitives | `src/components/ui/` | main |

## 0.3 What is on this branch, unmerged (`ws-27-project-ops`)

Two commits landed the operations foundation. **The backend of the original brief
§§4–17 is essentially complete.**

| Thing | Where |
|---|---|
| `kind` on the tree — `department \| client \| program \| project` | migration 171 §1 |
| `pm_stages` — stage as a second axis, data not enum | migration 171 §2 |
| `health` on tasks — `healthy \| at_risk \| critical`, NULL = unassessed | migration 171 §3 |
| `next_action` / `_owner` / `_due`, denormalised + partial index | migration 171 §4 |
| `pm_blockers` — 11 kinds, `waiting_on`, resolution required by CHECK | migration 171 §5 |
| `pm_time_entries` — `duration_secs` GENERATED, one-open-session-per-actor UNIQUE index | migration 171 §6 |
| Lifecycle widened with `paused` and `blocked` | migration 171 §7 |
| Five activity verbs: `work_session`, `stage_change`, `blocker`, `next_action`, `handoff` | migration 171 §8 |
| Pure state machine + duration + at-risk rules | `operations.py` |
| 11 endpoints: start/pause/complete, sessions, current, blockers, resolve, next-action, handoff | `work.py` |
| Stage CRUD (4 routes) — put in `admin.py` beside statuses and types, not a new module | `admin.py` |
| `paused` + `blocked` added to the seeded lanes AND to `CATEGORY_HUES` | `tree.py`, `statusAccent.ts` |

**The state machine is enforced in `core.apply_status_transition`, not in `work.py`.**
Every status mover already funnels through that helper — PATCH, board drag, sync,
automation — so a guard in the new routes would be one the board walks around (§40).
It is gated by **`projects_enforce_transitions`, default OFF** (ship dark): the legacy
movers are unchanged, while the work routes pass `enforce=True` unconditionally.
**Flipping that flag is an owner act** — it makes a board drag from Delivered back to
Paused answer 422, which is the intended end state but a visible change on a daily
surface.

## 0.3a Defects found during S1–S2 — record, so they are not rediscovered

| Defect | State |
|---|---|
| **`acb_auth.ensure_owner_bootstrap()` is broken on any fresh database.** `access.py:550` uses `ON CONFLICT (email)`; migration 162 dropped `app_user_email_key` and replaced it with the functional index `app_user_email_lower_key ON (lower(email))`. The statement raises `InvalidColumnReferenceError`, logs `ownership_bootstrap_failed`, and provisions nobody. Production does not feel it because it bootstrapped before 162 and `_HAS_OWNER_SQL` short-circuits — so it bites only a **new tenant, a restore to scratch, disaster recovery, or a laptop**. The "way back in" path that exists *because* of the 2026-07-30 lockout is itself locked out. | **OPEN.** Fix verified against a real database: `ON CONFLICT (lower(email))`, which Postgres infers against the functional index. One word, but it is tracked code and wants its own ticket + fence. |
| `pm_task_assignees.assigned_by` is NOT NULL — handoff 500'd until the insert was copied from `tasks.py:700`. | Fixed in S2. |
| `_seed_root` seeded no `paused`/`blocked` lane, so `POST /work/pause` answered 422 on **every** project including new ones. | Fixed in S2. |
| `core.STATUS_CATEGORIES` was a stale mirror of the widened CHECK — creating a Paused lane 422'd while the database would have accepted it. Same failure as migration 150's `attachment`, one column over. | Fixed + fenced in S2 (`test_the_category_vocabulary_mirror_is_exact`). |
| `TaskModel` omitted the new columns, so `row_to_dict` dropped them — `next_action` was written correctly and never returned. | Fixed in S2. |
| `scripts/apply_migrations.sh` cannot run natively on macOS: line 247's `date +%s%3N` renders as `17865365543N` on BSD date and the arithmetic fails. | OPEN, low. Worked around locally by running the tracked script inside a `postgres:16` container. |

## 0.4 What is missing — this is the work

| Gap | Severity |
|---|---|
| **No UI is wired to the work API.** Nothing in the front end calls `/work/start`, `/work/pause`, `/work/complete`, `/handoff`, or the blocker routes. The entire mock is unbuilt. | **Blocking** |
| **No management aggregate endpoints.** No dashboard, workload, attention, pipeline, or blocker-breakdown route exists. Every card on the Home screen needs one. | **Blocking** |
| **No capacity model.** The mock's workload percentages divide by a per-person capacity (40h) that is stored nowhere. | **Blocking** |
| **No metric history.** The KPI tiles show "12% vs last month". Nothing records yesterday's counts. | High |
| **No chart library, by design.** Donut, bars and Gantt must be hand-drawn SVG/CSS. Adding a charting dependency would be a second substrate. | High |
| **Missing UI primitives.** Only `Badge`, `Button`, `Input`, `Modal`, `Toast` exist. The mock needs Select, Textarea, Checkbox, DatePicker, Tabs, Table, Avatar/AvatarStack, ProgressBar, Tooltip, Skeleton. | High |
| **No seed for the 29 supplied projects.** A local, UNTRACKED stopgap exists at `.staging/seed/seed-projects.mjs` (excluded via `.git/info/exclude`) which loads all 29 through the BFF — but it models them as tasks under customer nodes, with **no `kind` typing, no stages and no normalized blockers**. S16 is still owed and is what §32's normalization actually describes. | Medium |
| **No build record.** The spec has no §11.35 for the two commits above. A slice without a record is undispatchable for the next agent. | Medium |

## 0.5 Standing constraints (these bind before anything below)

1. **Never commit or push on `main`.** Branch first.
2. **Refuse owner-gated work by name** — live credentials, deploy reach, force-push,
   member/role writes, enforcement flips, cutovers.
3. **R5 tenant-ready**: new tables carry `organization_id` and derive it via
   `pm_organization_from_parent`; no new DB connection sites outside the seam.
4. **R6 expand/contract**: nullable with defaults, never rename in place, tighten in a
   later release. There is no rollback — only roll forward.
5. **R7 name the fence**: every rule introduced names the test that makes breaking it
   fail, or is labelled advisory.
6. **R8 verify SQL against a real database.** Hermetic fakes agree with any SQL.
7. **Respect the seams.** One DB engine, one status colour vocabulary
   (`src/lib/statusAccent.ts`), one categorical ramp (`src/lib/categorical.ts`), one
   modal substrate (`Modal.tsx` is the only file allowed to import `@base-ui/react`).
8. **Ship dark.** New behaviour lands behind a flag, default OFF.

---

# PART I — PRODUCT

## 1. Context

The customer is an engineering and product-development firm serving automotive and
industrial clients. Their work runs:

```
CLIENT  →  PROGRAM / VEHICLE  →  PROJECT  →  WORK ITEM  →  ACTIVITY / TIME
```

```
Mahindra & Mahindra                 Mahindra & Mahindra
└── Z121                            └── U171
    └── Front Non-Winch Bumper          └── Ladder
        ├── Concept                         ├── Concept
        ├── CAD Development                 ├── Design
        ├── Prototype                       ├── Prototype
        ├── Fitment                         ├── Testing
        ├── Correction                      └── Finalization
        ├── Validation
        └── Submission
```

Their day is: assign an engineer, know the stage, know who is working right now, know
the next action, know the blocker, know who we are waiting on, record time, hand work
over, and explain six months later what happened.

**Not every project uses every stage.** Stages are per-project data (`pm_stages`), never
a hard-coded enum.

## 2. The fifteen questions

Every active project must answer these **without navigating away from its page**:

1. What is this project? 2. Who owns it? 3. Who else is on it? 4. What stage is it in?
5. What is happening right now? 6. What was the last action? 7. What is the next action?
8. Is it blocked? 9. Why? 10. Who are we waiting on? 11. How long has it been blocked?
12. How much engineering time has been spent? 13. What happens next? 14. Who must act?
15. Is it on track?

And management must be able to ask, across the portfolio: how many are active · which
are blocked and why · who are we waiting for and how long · what has not moved · who is
overloaded · who has capacity · how much time went into a project / a client · what is
overdue · what has no next action · who worked on this · what exactly happened · who
handed it over · why was it paused.

**Every screen in Part III exists to answer one of these.** A card that answers none is
decoration and should be cut.

## 3. The one product decision

This is an **engineering project operations system**, not a generic task manager and not
a Kanban board with extra fields. The optimised path is:

```
CLIENT → VEHICLE/PROGRAM → PROJECT → STAGE → OWNER → WORK → TIME
       → BLOCKER → HANDOFF → NEXT ACTION → COMPLETION
```

The board remains available as one view mode among five. It is not the product.

---

# PART II — DOMAIN MODEL (AS BUILT)

## 4. Hierarchy — one table, typed; not a table per level

The original brief asked for `clients` and `programs` tables. **That was superseded.**
D-PM-2 took the hierarchy decision: departments/projects/subprojects are one
`pm_projects` self-FK and types are data. A per-level table zoo is what that decision
rejected, and the ClickUp importer already flattens on the way in.

So **Client and Program are a `kind` on the existing node**:

```sql
pm_projects.kind ∈ {department, client, program, project} | NULL
```

`NULL` means untyped, which every pre-171 row is. The tree already nests three deep and
already carries grants, counters, statuses and tenancy — typing it is additive; forking
it is not.

| Concept | Representation |
|---|---|
| Mahindra & Mahindra | `pm_projects` row, `kind='client'` |
| Z121 | `pm_projects` row, `kind='program'`, parent = the client |
| Front Non-Winch Bumper | `pm_tasks` row under that program |
| CAD / Prototype / Fitment | `pm_stages` rows; the task points at one via `stage_id` |
| A work session | `pm_time_entries` row |

**Do not add `pm_clients` or `pm_programs`.** If a client needs fields a project node
lacks (contacts, code, description), add nullable columns to `pm_projects` or use the
existing custom-fields mechanism.

## 5. Project fields

Carried on `pm_tasks` (existing columns plus migration 171's additions): name, number,
parent program, description, owner, assignees, status, `stage_id`, priority, start date,
target/due date, estimated effort, actual effort (derived from time entries),
`next_action` + `next_action_owner` + `next_action_due`, open blocker (via
`pm_blockers`), `health`, timestamps, `completed_at`.

**A project has many people.** Owner plus contributors, via `pm_task_assignees`. Never
assume a single assignee.

## 6. Status and Stage are two axes — this is the crux

**STATUS** is the lifecycle state. It lives in `pm_task_statuses.category`, which was
already the machine-readable half of a status and which 171 widened:

```
backlog · todo (NOT_STARTED) · in_progress · paused · blocked · done · cancelled · triage
```

**STAGE** is position in the development pipeline, in `pm_stages`:

```
Concept · Design · CAD · Prototype · Fitment · Testing · Correction · Validation · Submission · Production
```

They are orthogonal. A project can be `in_progress` at Prototype, then `blocked` at
Prototype, without either value being wrong.

**Never create statuses like "Awaiting M&M Input", "Prototype Sent", or "Prototype Needs
Correction".** Those are a blocker, a stage, and a stage respectively. Conflating them is
exactly what made the source spreadsheet's status column uncountable and unfilterable —
it is the defect this whole system exists to remove.

`paused` and `blocked` are **not** closing categories. `CLOSING_CATEGORIES` stays
`{done, cancelled}`; paused work is still outstanding and must not drop out of "what is
open".

## 7. State machine

Centralised in `operations.py` as pure functions over plain values — no session, no
request, no clock it does not receive — so the edges are exhaustively testable.

```
NOT_STARTED ──► IN_PROGRESS ◄──► PAUSED
                    │  ▲
                    ▼  │
                 BLOCKED
                    │
                    ▼
                COMPLETED ──► REOPENED ──► IN_PROGRESS
```

The handler asks; it does not decide. Invalid transitions are refused server-side, not
hidden in the UI.

## 8. Blockers — first class

`pm_blockers`: `kind` (one of eleven), `title`, `description`, `waiting_on` (free text —
it is usually a customer or supplier, not a user row), `owner` (ours, `email` or
`agent:<name>`), `created_by`, `created_at`, `resolved_at`, `resolved_by`, `resolution`.

Kinds: `client_input · client_approval · supplier · material · prototype · engineering ·
information · internal_review · capacity · dependency · other`.

**A resolution must say what happened** — enforced by CHECK, not by a handler, because
three call paths can resolve a blocker and a reasonless resolution is the row that makes
a six-month-old audit trail useless.

A blocked project must render, wherever it appears:

> **BLOCKED** · Waiting for client input · Waiting on: Mahindra & Mahindra · Since: Aug 10 ·
> 3 days · Next action: Follow up with M&M · Owner: Jasim

## 9. Next action

Denormalised onto the task, not given a child table, because the brief wants **one**
next action visible on the card, the list, the dashboard and My Work — a hot read on
every list query. A child table would make the flagship read a join for one row, and
"which of these five is current" becomes a question nothing answers.

History is not lost: every change writes a `next_action` activity.

**A project with no next action is a defect the UI must surface**, and there is a partial
index for exactly that dashboard tile.

## 10. Time — the server owns the clock

`pm_time_entries`: `task_id`, `actor`, `started_at`, `ended_at`, `duration_secs`
**GENERATED**, `end_reason`, `remark`.

- **`duration_secs` is a generated column.** No API, no migration and no future handler
  *can* write a wrong one. That is a structural fence, not a rule in prose.
- **An open session is `ended_at IS NULL`**; elapsed time is computed at read time from
  `started_at`, so a refresh, a navigation, or a closed laptop cannot lose or inflate it.
- **One open session per actor, enforced by a UNIQUE partial index.** A handler check
  loses that race the moment two tabs click START together, and double-counted
  engineering time is the one bug here nobody notices until an invoice is wrong.
- **Never edit a past session.** Resume creates a new one.

The timer is **not** "increment a number every second in React". It is
`now() − started_at`, recomputed on tick, reconciled against the server.

Support aggregates: today · this week · project total · user total · by project · by
stage · by person · by client.

## 11. Activity — the audit spine

`pm_activities`, fourteen types. 171 added five; it did **not** add sixteen synonyms,
because eleven of the brief's names were already expressible and two words for one event
gives every reader a choice to get wrong.

| Verb | Carries in `meta` |
|---|---|
| `work_session` | `action: started \| paused \| resumed \| completed`, `seconds`, `reason` |
| `stage_change` | `from`, `to` |
| `blocker` | `action: raised \| resolved`, `kind`, `waiting_on`, `blocker_id` |
| `next_action` | `action: set \| cleared \| completed` |
| `handoff` | `from`, `to`, `reason` |
| existing ten | `comment · status_change · field_change · link · assignment · agent_run · sync · system · attachment · mention` |

⚠️ `core.py`'s `ACTIVITY_TYPES` tuple mirrors the DB CHECK and
`test_projects_activity_vocabulary` reads **both**. The mirror went out of step once
(migration 150 added `attachment`, the tuple did not, and every upload answered 422).
Update both.

**History is immutable.** Never overwrite, never delete, never hide.

## 12. Health

`healthy | at_risk | critical`, NULL = *not assessed* and distinct from healthy. Manual
today; `operations.py` already holds the shape so "later it can become calculated" is a
change to one function rather than a migration.

Future rules (do not build the AI version now): **CRITICAL** if overdue, blocked beyond
threshold, missed milestone, or upstream dependency slipped. **AT_RISK** if approaching
deadline, inactive several days, or effort materially exceeds estimate.

---

# PART III — THE UI CONTRACT

Derived from the supplied mock. Every screen below is currently **unbuilt**.

## 13. What the mock establishes globally

**Shell.** Persistent left sidebar, content area to the right. The sidebar is a dark
navy in the mock with light content beside it.

> ⚠️ **Do not hard-code that navy.** The UI is one product themed centrally across
> Fluent / Material / Graphite and light/dark. A fixed navy is an app-local palette,
> which is forbidden. Express the sidebar as an existing surface token; if a
> deliberately-darker nav shelf is wanted, it becomes a design-system token added in
> `DESIGN_SYSTEM.md`, applied to every app at once — never a `/projects` special case.

**Navigation, as grouped in the mock:**

| Group | Items |
|---|---|
| *(primary)* | Home · My Work · Projects · Clients · Programs / Vehicles · People · Calendar · Reports |
| **OPERATIONS** | Active Projects · Blocked · Awaiting · Paused |
| **MANAGEMENT** | Workload · Timeline · Health · Reports |

Bottom of sidebar: user chip (avatar, name, role, chevron).

> ⚠️ **"Reports" appears twice** — once in primary nav, once under Management. Two entry
> points to one destination is an IA defect. Resolve before build (see §36, D-OPEN-2).

**The running-timer chip.** The mock's My Work header carries a live timer
(`01:24:17`) and a "Start Break" control. The timer must be **global**, not local to My
Work — an engineer who navigates to Projects still has a session running, and a timer
that disappears is a timer people forget to stop. Mount it in the app shell, fed by
`GET /projects/work/current`.

**The mock is one theme, one breakpoint, one state.** It shows no loading, empty, error,
dark, or narrow rendering. Those are specified in §24–§25 and are not optional.

---

## 14. SCREEN 1 — Home / Project Control Center

Route: `/projects` (or `/projects/home`). The management landing page.

**Header.** `Good morning, {name} 👋` with subtitle "Project Control Center". Right:
date-scope selector (`Today, 12 Aug`) and a `Filters` button.

> The date-scope selector is a **global scope for the whole screen** — every tile,
> chart and table below re-queries against it. Define its options: Today · This Week ·
> This Month · Custom range.

**KPI row — six tiles**, each: big number, label, delta line with arrow.

| Tile | Mock value | Delta | Definition |
|---|---|---|---|
| Active Projects | 29 | ▲12% vs last month | status ∉ {done, cancelled}, not archived |
| In Progress | 12 | ▲8% | category = `in_progress` |
| Blocked | 7 | ▼2% | category = `blocked` **or** has an open blocker — pick one, §36 |
| Awaiting Client | 5 | ▼1% | open blocker of kind `client_input` or `client_approval` |
| Paused | 4 | — | category = `paused` |
| At Risk | 8 | ▲3% | `health ∈ {at_risk, critical}` |

> ⚠️ **The deltas require history that does not exist.** "vs last month" needs a stored
> count from last month. Either add a daily rollup table (§29) or ship the tiles without
> deltas. Do not compute a fake delta.

**"Projects Needing Attention"** — table, `View all` link. Columns: Project · Issue ·
Owner · Blocked Since · Next Action. Leading dot coloured by severity.

> The ranking rule is undefined in the mock and must be specified, because "attention"
> is the product's central claim. Proposed, server-side, deterministic:
> `score = 3·(critical) + 2·(at_risk) + 2·(overdue) + 1·(blocked days > 2) +
> 1·(no next action) + 1·(no activity > 5 days)`, descending, tie-break on oldest
> `updated_at`. Top 5 on the card, full list behind `View all`. **Write the rule as a
> pure, tested function** — it is business logic, not a SQL `ORDER BY` buried in a route.

**"Project Pipeline (By Stage)"** — donut, `View report`. Centre: total (29). Legend
rows: swatch · stage · count · percent. Mock: Concept 4 (14%) · Design 7 (24%) ·
Prototype 9 (31%) · Fitment 5 (17%) · Testing 2 (7%) · Validation 1 (3%) · Submission 1 (3%).

> Hand-drawn SVG arcs — no chart library. Stage colours come from the categorical ramp
> `--cat-1…8` via `src/lib/categorical.ts`, **never** raw Tailwind palette classes, and
> never the status vocabulary (stage ≠ status). Percentages round; show counts as the
> truth. A stage with 0 projects is omitted from the ring but listed in the legend.

**"Team Workload"** — per person: avatar, name, percentage, horizontal bar, `Xh / Yh`.
Mock: Jasim 103% (8.2h/8h) · Kiruba 82% (6.6h/8h) · Shahul 67% (5.3h/8h) · Vignesh 45%
(3.6h/8h). Bar colour by band: ≥100% over-capacity · 80–99% high · 50–79% healthy ·
<50% light. **These four bands are a status vocabulary and go through `statusAccent.ts`
or an equivalent single source — not four ad-hoc colours.**

**"Blocked Projects by Reason"** — horizontal bars with counts. Mock: Client Input 8 ·
Prototype 5 · Supplier 3 · Internal Review 2 · Other 1.

> ⚠️ **These sum to 19 while the Blocked KPI says 7.** Decide and label explicitly:
> is this counting *blockers* (a project can have several) or *projects*? Does it include
> Awaiting? The card's subtitle must say which, or management will read it wrong.

**"Recent Activity"** — avatar · sentence · relative time. Rendered from
`pm_activities` through **one** formatter shared with the project Activity tab (§18).
Two renderers for one event stream will drift.

---

## 15. SCREEN 2 — My Work

Route: `/projects/my-work`. **The engineer's home.** The mock's clearest instruction is
that starting work must be one click from here, with no navigation.

**Header.** Title `My Work`. Right: `Start Break` button, live timer chip `01:24:17`
with a stop control.

> ⚠️ **"Start Break" is new** — it is in neither the original brief nor the schema, and
> it collides with the one-open-session-per-actor unique index. Three options, owner's
> call (§36, D-OPEN-3): (a) a break simply ends the current session with
> `end_reason='break'` — no schema change, cheapest, correct; (b) a break is its own
> `pm_time_entries` row against a synthetic task — pollutes project time; (c) drop it
> from v1. **Recommendation: (a).**

**Three columns.**

*Currently Working* — project title, work-item subtitle, `Started at 10:12 AM`, large
running timer, `[Pause]` (secondary) `[Complete]`.

> The mock draws Complete in red. **Complete is not destructive** — red is the
> vocabulary's danger colour and must not mark a success path. Use the primary or a
> positive accent, consistent with the Complete dialog (which the mock itself draws in
> green — the two disagree). See §36, D-OPEN-4.

*Up Next* — next project, subtitle, `[Start]` full-width.

> `POST /work/start` already returns `switched_from` — starting here while another
> session runs **auto-pauses the other**. The UI must say so before acting, or a stray
> click silently ends someone's session. Confirm inline, then toast the switch.

*Waiting on Me* — count badge (3), rows of project + reason (`Review required`,
`Approval required`, `Client feedback`), `View all`.

**"My Today"** — four tiles: Active 1 · Completed 2 · Paused 1 · Total Time 6h 32m.

**"Today's Schedule"** — session rows: project · state badge (`Working` / `Paused` /
`Handoff`) · time range (`10:12 AM – Now`) · duration. `View full timeline`.

> ⚠️ The mock's numbers do not reconcile: the two visible sessions total ~2h14 against a
> stated 6h 32m, and 6h 32m also appears as *This Week* on the project Overview.
> Specify: My Today totals **all** of today's sessions for the current user across all
> projects; the schedule list is truncated with `View full timeline`.

**Runaway sessions.** `_session_dict` already returns a `runaway` flag. A session left
open overnight must be visibly flagged here with a one-click correction path — otherwise
the first bad week of data teaches everyone to distrust the totals.

---

## 16. SCREEN 3 — Projects list

Route: `/projects/list`. The densest management scan.

**Header.** Title · `Filter` · `+ New Project` (primary). Full-width search below.

**Columns:** Project · Client / Program · Owner · Status · Stage · Health · Due Date.
The brief additionally wants **Next Action**, **Actual Time**, **Blocked** and **Updated**
available — ship them as toggleable columns rather than dropping them.

- Status renders as a pill through `statusAccent.ts`.
- Health renders as a dot + word (`Good` / `At Risk` / `Critical`) — see the label
  mapping question in §36, D-OPEN-5.
- Client / Program renders as a two-part cell (`M&M / Z121`) sourced from the typed tree.

**Pagination.** Mock shows `1 2 3 ›` and `Showing 1 to 8 of 29` — page size 8,
**server-side**. Sorting is server-side on every column. Filtering is server-side.
Nothing loads the portfolio into the browser.

**Filtering must cover:** client · program · owner · contributor · status · stage ·
priority · health · blocker type · due date · overdue · awaiting · paused · active.
**Search must cover:** project names · codes · clients · programs · people · tags ·
descriptions. Reuse `search.py` and `filters.py`; do not build a second filter grammar.

**The other view modes stay.** Board, calendar, timeline and tree already exist. Board
columns are **lifecycle status only** — Backlog/Not Started · In Progress ·
Blocked/Paused · Completed — with grouping available by status, stage, client or owner.
**Never mix stages into lifecycle columns.**

---

## 17. SCREEN 4 — Project detail

Route: `/projects/{id}`.

**Header.** Breadcrumb `Projects › {name}` · title · status pill · subtitle `M&M / Z121`
· right: `Edit` and `…` overflow.

The overflow menu is where Pause / Complete / Handoff / Raise Blocker / Change Stage
live when the project is not the user's current session. **Changing status must never
require navigating to another page.**

**Tabs.** ⚠️ **The mock is internally inconsistent** — one screen shows
`Overview · Work Items · Timeline · Files · Activity · Dependencies`, another shows
`… · Activity · Stages`. Canonical set proposed (§36, D-OPEN-6):

```
Overview · Work Items · Timeline · Files · Activity · Dependencies
```

with **Stages** managed inside Timeline (they are the same objects) rather than as a
seventh tab.

### 17.1 Overview tab

Two columns.

**Left** — *Current Stage* card: stage name, progress bar, percent (mock: Prototype 78%).
*Next Action* card: text, `Assigned`, `Due`, `[Mark Done]`. *Overview* fields: Owner ·
Priority · Start Date · Target Date · Estimated · Actual.

**Right** — *Health*: value plus a sentence (`Good — On track. Good progress.`).
*Time Summary*: Today · This Week · Total, plus `View time report`. *Blocker*: either the
structured blocker or the explicit empty state `None — No active blockers`. *Team*:
avatar rows with role labels (Owner / Contributor) and `+ Add Member`.

> **Stage progress percent needs a definition.** Options: manual per project; or
> `completed work items in stage ÷ total`; or elapsed ÷ planned stage duration. Pick one
> and put it in a tested pure function. An undefined percentage is worse than none.

### 17.2 Timeline tab

A **stage Gantt**: date axis across the top, one row per stage, bars spanning
start→end, per-bar percent, a red **Today** marker, and a legend of four states —
Completed · In Progress · Pending · Blocked.

Mock rows: Concept Aug 1–3 (100%) · Design Aug 3–8 (100%) · CAD Development Aug 6–10
(100%) · Prototype Aug 10–18 (78%) · Fitment Aug 18–20 · Correction Aug 19–20 ·
Validation Aug 20–22 · Submission Aug 22–24.

> This **amends the original brief**, which said "do not build a Gantt". The mock shows a
> constrained one: fixed rows (stages, not arbitrary tasks), no drag, no dependencies
> drawn, no zoom beyond a date-range selector. Build exactly that — a read-mostly stage
> chart — and reuse `components/TimelineView.tsx` rather than starting a second timeline.
> Stage dates need `planned_start` / `planned_end` columns on `pm_stages`, which 171 did
> not add (§28).

### 17.3 Activity tab

Reverse-chronological feed grouped by date heading (`12 Aug 2025`), each entry: coloured
type icon · actor · verb · time · structured detail lines.

The mock's pause entry shows **Reason** and **Remark** as separate labelled lines —
confirming that structured pause capture must survive into the rendering, not be
flattened into a sentence.

Right rail: `All Activities` · `All Users` · `All Types` · `Clear`.

**One icon-and-colour mapping per activity type**, shared with the dashboard feed.

### 17.4 Work Items · Files · Dependencies

*Work Items* — the child tasks, reusing the existing list/board components.

*Files* — reuse `pm_task_attachments` and `attachments.py`. CAD, drawings, PDFs, images,
prototype photographs, specifications, client documents. **Do not rebuild file storage.**

*Dependencies* — reuse `pm_task_links` and `relations.py`. Types `BLOCKS` /
`BLOCKED_BY`. **Circular dependencies are rejected server-side**; `relations.ts` already
holds the "an unfinished blocker cannot be started" rule.

*Comments* — reuse the existing comment activity. **Comments are discussion; activity
records are audit history. Keep them separate** — a comment must never substitute for a
structured blocker.

---

## 18. SCREEN 5 — People / Workload

Route: `/projects/people`.

**Header.** Title · period selector (`This Week`) · view toggles (grid / table) · avatar
stack with `+2`.

**Table columns:** Person · Role · Active Projects · Today · This Week · Capacity ·
Workload %.

Mock rows: Jasim / Engineer / 9 / 7h 48m / 40h 20m / 40h / **103%** · Kiruba / 8 / 6h 10m
/ 32h 45m / 40h / 82% · Shahul / 6 / 4h 15m / 26h 50m / 40h / 67% · Vignesh / 4 / 2h 30m
/ 18h 10m / 40h / 45%.

> ⚠️ **The percentage basis is inconsistent in the mock.** 40h 20m ÷ 40h = 101%, but the
> row reads 103% — which is the *daily* figure (8.2h ÷ 8h) carried over from the
> dashboard card. Pick one: the dashboard card is **daily** (`today ÷ daily capacity`)
> and this table is **weekly** (`this week ÷ weekly capacity`), each labelled. Never show
> an unlabelled percentage.

> ⚠️ **Capacity is stored nowhere.** Needs a per-person weekly-hours field with an
> org-level default (§28). Until it exists, this screen cannot be honest.

Each person's row expands to: assigned projects · projects awaiting their action ·
blocked projects they own · overdue work · upcoming deadlines.

**Do not judge workload by project count alone** — the mock is right to divide tracked
time by capacity.

---

## 19. Operations views — Blocked, Awaiting, Paused, Active

Four sidebar destinations, all filtered projections of the same list with a purpose-built
column set.

**Blocked** — the key management tool. Per row: Project · Client · Program · Owner ·
Blocker · Waiting On · Blocked Since · **Days Blocked** · Next Action. Sorted by days
blocked, descending.

**Awaiting** — projects whose next action belongs to someone *outside* the team:
awaiting client · supplier · approval · prototype · internal review. **Distinct from
Paused** — paused is our choice, awaiting is our dependency.

**Paused** — category `paused`, showing pause reason, remark, and expected resume date.

**Active Projects** — everything currently in progress with a running or recent session.

---

## 20. Dialogs

All six go on the existing `Modal` primitive (already built, WS-27ak). No hand-rolled
overlays, no second scrim. Every dialog: focus trap, Escape to close, labelled fields,
required markers, disabled submit while pending, error surfaced inline, success toast.

### 20.1 Pause Project

| Field | Required | Notes |
|---|---|---|
| Why are you stopping? | yes | Select: End of day · Waiting for client · Waiting for material · Waiting for prototype · Waiting for another team · Technical issue · Need clarification · Other |
| Remark | **yes** | Free text |
| Next Action | no | Free text |
| Expected Resume | no | Date |

Actions: `Cancel` · `Pause Project` (primary).
Maps to `PauseIn { reason, remark, next_action, next_action_owner, expected_resume,
blocker_kind, blocker_waiting_on }`.

**One click creates five things**: the activity event, the closed time entry, the status
change, a blocker if the reason implies one, and a next action if supplied.

### 20.2 Complete Project

| Field | Required |
|---|---|
| Final Remark | **yes** |
| Deliverable / Result | no |
| ☐ Notify team members | no — defaults to **unchecked** |

Actions: `Cancel` · `Complete Project`.
Maps to `CompleteIn { remark, deliverable }`.

> The notify checkbox is **new** — it is not in the payload model and needs adding, or
> the control is a lie. Default off (§0.5, no notification spam).

Then: stop the timer · record final time · mark completed · write the activity · stamp
`completed_at` · **preserve the whole history**.

### 20.3 Handoff Project

| Field | Required |
|---|---|
| Hand off to | **yes** — person picker |
| Reason | **yes** |
| Message | no |
| Due Date | no |

Maps to `HandoffIn { to, reason, message, due, keep_me }`. The `keep_me` flag has no
control in the mock — surface it as "stay on as contributor".

The system changes ownership, adds the recipient, writes a `handoff` activity, and
notifies. **Ownership never changes silently.**

### 20.4 Raise / Resolve Blocker · 20.5 Edit Next Action · 20.6 New Project

Raise Blocker: kind (11 options) · title · description · waiting on · owner.
Resolve: resolution (**required by CHECK — enforce in the form too**) · resume?
Next Action: text · owner · due.
New Project: name · client · program · owner · priority · start · target · stage set.

---

## 21. Design system binding

The mock is a visual reference for **layout and information hierarchy**, not for colour
values. Translating it:

| Mock shows | Build as |
|---|---|
| Dark navy sidebar | A themed surface token; never a literal hex in `/projects` |
| Green/red/amber status pills | `statusAccent.ts` — the one status vocabulary |
| Stage colours in the donut | `--cat-1…8` via `categorical.ts` |
| Rounded cards, soft shadows | Existing card surface; no app-local radius or shadow scale |
| Selects, checkboxes, date fields | New shared primitives in `src/components/ui/`, on `@base-ui/react` via the `Modal.tsx` substrate rule — **not** hand-rolled per screen |
| Charts | Inline SVG/CSS, no new dependency |

**The theme-switch check is the real gate**: Fluent → Material → Graphite, light and
dark, on the new surface *and* its neighbour. The conformance suite checks regexes; it
tests neither layout nor cross-app continuity.

**Visual character**, per the original brief and consistent with the mock: professional ·
dense but readable · engineering-oriented · fast · calm · operational. Avoid excessive
rounding, gradients, pill-spam, decorative graphics, animation, generic-SaaS aesthetics
and dead space. **Colour communicates status, health, priority, blockers and warnings —
nothing else.** It should read as a real internal operations platform, not a mockup.

**Architecture.** `page.tsx` is already 1,771 lines and the hottest file in the tree. Do
**not** grow it. New surfaces are their own route segments; logic goes in `lib/` as pure,
colocated-tested modules; dialogs own their own files.

**Component inventory** (check for an existing equivalent before creating any):
`ProjectStatusBadge` · `ProjectHealthBadge` · `ProjectCard` · `ProjectTable` ·
`ProjectFilters` · `ProjectHeader` · `StageGantt` · `ActivityTimeline` · `TimerChip` ·
`StartWorkButton` · `PauseWorkModal` · `CompleteWorkModal` · `HandoffModal` ·
`BlockerPanel` · `NextActionPanel` · `WorkloadBar` · `KpiTile` · `DonutChart` ·
`AttentionTable` · `AvatarStack`.

## 22. Empty, loading and error states

The mock shows none of these. They are required.

| Surface | Empty copy |
|---|---|
| My Work, nothing running | "You have no active work." + a start affordance |
| Blocked view | "No blockers. Everything is moving." |
| Next action | "No next action assigned." + inline set control |
| Activity | "No activity recorded yet." |
| Attention table | "Nothing needs attention right now." |

**Loading** is skeletons matching final layout, not spinners and not layout shift.
(The `Skeleton` primitive is specified in spec §9.4.2 and still unbuilt.)

**Errors are explicit and actionable**: "Timer failed to start." · "Project could not be
assigned." · "You no longer have permission." · "Connection lost — retrying." · "This
project was updated by someone else — reload to see the current state." **Never fail
silently.**

## 23. Responsive

Desktop and laptop are the primary targets; tablet must remain usable.

**Mobile carries only**: My Work · Start/Pause/Complete · project status · blockers ·
activity · notifications. **Do not attempt the management dashboard on a phone.**

Fix while in here: the two hand-rolled overlays in `page.tsx` (mobile task panel at
`z-[60]`, `full`-mode scrim at `bg-background/70`) disagree with the one scrim
`DESIGN_SYSTEM.md` §4a documents (`bg-background/80`, `z-50`) and neither traps focus.

## 24. Keyboard and speed

Start = 1 click. Pause = 1 click + reason + remark. Complete = 1 click + remark.
Handoff = 1 click + recipient + reason. Next action = inline edit.

Extend the existing command palette rather than adding a second one: start/pause/complete
current, jump to My Work, raise blocker, set next action, hand off.

---

# PART IV — BACKEND STILL OWED

## 25. Aggregate endpoints

None of these exist. Each is one indexed, aggregated **server-side** query — the browser
never computes portfolio metrics.

| Endpoint | Feeds |
|---|---|
| `GET /projects/ops/summary?scope=` | The six KPI tiles |
| `GET /projects/ops/attention?limit=` | Projects Needing Attention |
| `GET /projects/ops/pipeline` | Stage donut |
| `GET /projects/ops/blockers/breakdown` | Blocked-by-reason bars |
| `GET /projects/ops/workload?period=` | Team Workload card + People table |
| `GET /projects/ops/blocked` · `/awaiting` · `/paused` | The three operations views |
| `GET /projects/work/today` | My Today tiles + Today's Schedule |
| `GET /projects/tasks/{id}/time/summary` | Overview Time Summary |

Put the **rules** (attention score, workload band, at-risk) in `operations.py` as pure
functions beside the existing ones; keep the handlers thin.

## 26. Schema additions still needed

| Need | Shape |
|---|---|
| Stage planning dates | `pm_stages.planned_start`, `planned_end` (nullable) |
| Stage progress | `pm_stages.progress_pct` or a derived rule — decide first |
| Person capacity | weekly hours per user, org default; new nullable column or settings row |
| Break sessions | if D-OPEN-3 picks (a), nothing — just an `end_reason` value |
| Complete-notify | plumb through `CompleteIn` |

All expand-only, all nullable, migration number taken at build time and **re-checked at
merge** (R1 — three collisions in two weeks).

## 27. Metric snapshots

For the "vs last month" deltas: a small daily rollup (`date, organization_id, metric,
value`) written by a scheduled job. Without it the deltas cannot be honest and should not
ship.

## 28. Performance

Hundreds to thousands of projects. Pagination · server-side filtering and sorting ·
indexed queries · aggregation in SQL · bounded activity loading. The partial indexes from
171 (open blockers by kind, tasks with no next action, open sessions by actor) already
serve the dashboard's hottest reads; add indexes for new aggregates rather than scanning.

## 29. Concurrency

Several people work one project. Handle simultaneous edits, assignment changes, status
changes, activity creation and timers. **The UI must never assume it owns the latest
state** — revalidate on focus and after every mutation; reconcile the timer against the
server rather than trusting local tick count.

## 30. Security and permissions

Reuse existing auth, grants and RLS. Three roles at minimum:

| Role | May |
|---|---|
| **Engineer** | see assigned work · start/pause/resume/complete · add remarks · update next action · view relevant projects |
| **Project Lead** | assign and reassign · manage stages and blockers · view team workload · manage project data |
| **Manager / Admin** | all projects and people · manage clients, programs, projects · reports · configure statuses and stages |

Enforce server-side. Users must not access unauthorised projects, touch another user's
time entries, change ownership without permission, fabricate time, delete audit history,
or bypass state transitions through direct API calls. **Hiding a button is not a
permission.** Do not build a new RBAC system.

---

# PART V — DATA

## 31. The 29 supplied projects

Seed for development/demo only, **idempotent**, reusing existing users where present
(Kiruba, Jasim, Shahul; Vignesh appears in the mock's workload view). Never create
production credentials.

**Normalize — do not dump the spreadsheet into a free-text status field.** Each row
becomes: Client · Program/Vehicle · Project · Owner · Status · Stage · Blocker · Blocker
type · Waiting on · Next action, with the **original wording preserved** in an import
note.

| # | Project | Client | Owner | Raw status |
|---|---|---|---|---|
| 1 | Quick Action Force Vehicle Doors | VAP | Kiruba | Work in progress |
| 2 | Z121 Front Non-Winch Bumper | M&M | Jasim | Work in progress |
| 3 | Bolero Camper Sports Bar | PRAD | Shahul | proto in process |
| 4 | Zealics Bike Frame Costing | Zealics | Shahul | Work in progress |
| 5 | VLTD Module Mount | M&M | Shahul | proto part send to M&M team |
| 6 | Z121 All-Parts Correction & Prototype | M&M | Kiruba | started |
| 7 | W501 Rear Tandem Bumper | PRAD | Kiruba | Paused |
| 8 | W502 Rear Tandem Bumper | PRAD | Kiruba | Paused |
| 9 | W502 Raptor X | PRAD | Jasim | Not yet Started |
| 10 | W502 Ladder & Box Mount | PRAD | Kiruba | Paused |
| 11 | W502 Trail Step Version-2 | PRAD | Jasim | Prototype needs corrections |
| 12 | Jimny Front Winch Bumper Version-2 | PRAD | Kiruba | Paused |
| 13 | Jimny Rear Bumper Version | PRAD | Kiruba | Not yet Started |
| 14 | Scorpio N Z101 Front Winch Bumper Modification | PRAD | — | Paused |
| 15 | Mahindra Defence Scorpio N Sidestep | M Defence | Jasim | Prototype Remaining |
| 16 | Mahindra Defence Roxor Project | M Defence | — | Not yet Started |
| 17 | U171 Ladder | M&M | Jasim | — |
| 18 | U171 Jerry Can Holder | M&M | Jasim | M&M helping for initial concept |
| 19 | U171 DEF Tank Guard | M&M | Jasim | submitted |
| 20 | U171 Fuel Tank Guard | M&M | Jasim | submitted |
| 21 | U171 Snack Tray | M&M | — | submitted |
| 22 | W121 Sports Bar | M&M | Jasim | Awaiting Inputs from M&M |
| 23 | W121 Front Bumper | M&M | — | — |
| 24 | Scorpio Classic | M&M | — | Data shared with M&M team |
| 25 | M210 Roof Carrier | M&M | — | shared data with M&M |
| 26 | M210 Pet Barrier | M&M | Kiruba | Awaiting Inputs from M&M |
| 27 | M111 Roof Carrier | M&M | Kiruba | Awaiting Inputs from M&M |
| 28 | UPP Parts | M&M | — | diesel tank guard pending |
| 29 | JAC Sports Bar | JAC | Jasim | Paused |

**Clients:** Mahindra & Mahindra · PRAD · JAC · VAP · Zealics · Mahindra Defence.
**Programs/Vehicles:** Z121 · U171 · W121 · W501 · W502 · M210 · M111 · Scorpio N ·
Scorpio Classic · Jimny · Bolero Camper · Roxor.

**Where owner data is missing, leave it unassigned. Do not invent a person.**
**Do not fabricate a stage that was not given** — use a reasonable default and mark it as
needing confirmation.

## 32. Normalization examples

**"W121 Sports Bar — Awaiting Inputs from M&M"**
→ Client `Mahindra & Mahindra` · Program `W121` · Project `Sports Bar` · Owner `Jasim` ·
Status `BLOCKED` · Stage `DESIGN` *(unconfirmed)* · Blocker "Awaiting client input" ·
Kind `CLIENT_INPUT` · Waiting on `Mahindra & Mahindra` · Next action "Follow up with M&M".

**"W502 Raptor X — Not yet Started"**
→ Status `NOT_STARTED` · Stage `CONCEPT` · Owner `Jasim` · no blocker.

**"M210 Pet Barrier — Awaiting Inputs from M&M"**
→ Status `BLOCKED` · Kind `CLIENT_INPUT` · Owner `Kiruba` · Waiting on `Mahindra & Mahindra`.

**"VLTD Module Mount — proto part send to M&M team"**
→ Status `BLOCKED` · Stage `PROTOTYPE` · Kind `PROTOTYPE` · Waiting on `M&M` ·
Next action "Get test feedback".

---

# PART VI — DELIVERY

## 33. Slice sequence

One narrowed slice at a time, each: audit → implement → **independent** verify → adversarial
review → PR → **stop before merge**. The verifier is never the implementer. Three or four
branches in flight is the ceiling. Slice IDs `WS-27a`–`WS-27bf` are taken; start at `bg`.

| # | Slice | Contents | Depends on |
|---|---|---|---|
| **S1** | *(done, this branch)* | Migration 171 — stage, blockers, time, health, next action | — |
| **S2** | *(done, this branch)* | Work API — timer, blockers, next action, handoff | S1 |
| **S3** | `WS-27bg` | **Build record** for S1+S2 in spec §11.35, and INDEX/board update | S2 |
| **S4** | `WS-27bh` | Missing primitives: Select, Textarea, Checkbox, DatePicker, Tabs, Avatar, ProgressBar (+ Tooltip ak-2, Skeleton ak-5) | — |
| **S5** | `WS-27bi` | Global timer chip in the shell, on `/work/current` | S2, S4 |
| **S6** | `WS-27bj` | **My Work** — currently working, up next, waiting on me, my today, schedule | S5 |
| **S7** | `WS-27bk` | The four dialogs on `Modal` — Pause, Complete, Handoff, Blocker | S4, S6 |
| **S8** | `WS-27bl` | Project detail — header, tabs, Overview | S4 |
| **S9** | `WS-27bm` | Activity tab — grouped feed, filters, one shared formatter | S8 |
| **S10** | `WS-27bn` | Aggregate endpoints + `operations.py` rules (attention, workload, pipeline) | S2 |
| **S11** | `WS-27bo` | **Home / Control Center** — KPI row, attention table, donut, workload, blocker bars, activity | S10 |
| **S12** | `WS-27bp` | Projects list columns, filters, server-side pagination | S10 |
| **S13** | `WS-27bq` | Blocked · Awaiting · Paused · Active views | S10, S12 |
| **S14** | `WS-27br` | Capacity model + People/Workload screen | S10 |
| **S15** | `WS-27bs` | Stage Gantt on Timeline tab (needs stage dates migration) | S8 |
| **S16** | `WS-27bt` | Seed for the 29 projects, idempotent | S1 |
| **S17** | `WS-27bu` | Metric snapshots + KPI deltas | S10 |
| **S18** | `WS-27bv` | Empty / loading / error states, responsive, scrim fixes, keyboard | all |
| **S19** | `WS-27bf` | **The four-theme visual sweep.** ✅ **DONE 2026-08-12 for every surface this branch touches**: 64 captures — the five board views plus Control Center, My Work and Blocked, across 4 themes × 2 modes, with theme, mode AND active view asserted on each; plus the Pause dialog in 5 theme/mode combinations. **One real defect found and fixed** (Graphite: `className="capitalize"` overrode the theme's `uppercase` on four buttons). ⚠️ **Still owed**: cross-app continuity — whether `/projects` and `/tasks` read as one product — which no capture can judge and which remains the half this ticket was really about. | all |

**S19 is already owed and every slice adds to its debt.** Do not let it slip further.

## 34. Testing

**Backend (pytest, `uv run pytest`)** — state transitions incl. every invalid one ·
duration from timestamps · one-open-session-per-actor under concurrent start · pause
creating five records · complete requiring a remark · blocker resolution requiring a
resolution · handoff ownership + activity · circular dependency rejection · permission
checks · attention/workload/at-risk pure functions · **SQL verified against a real
database (R8)**.

**Frontend (`npx tsc --noEmit && npx vitest run` in `workbench/control_plane`)** — every
`lib/` module pure and colocated-tested: attention ranking, workload banding, duration
formatting, schedule grouping, activity formatting, stage progress.

**E2E (Playwright, `npm run test:e2e`)** — a rendering "done when" is fenced in a real
browser or it is review-only (D-PM-21 refused jsdom). Run `npx next build` first; the
config runs `next start` against a prebuilt `.next` and a stale build 404s every route.
Note Next's route announcer lives in a shadow root — a bare `[role="alert"]` query
counts it.

**Environment**: `uv sync` at root, `npm install` in `workbench/control_plane`. Pass
`encoding="utf-8"` explicitly when reading files. Never run `tests/unit/` as a bare
directory without deselecting the memory and calendar suites.

## 35. Acceptance criteria

**Preserved:** 1. existing functionality still works · 2. existing navigation and design
language preserved.

**Domain:** 3. clients representable · 4. program/vehicle relationships representable ·
5. projects belong to clients and programs · 6. projects have multiple people ·
7. structured lifecycle status · 8. development stages, configurable · 9. priorities ·
10. next actions · 11. projects can be blocked · 12. blockers have structured reasons ·
13. assign and reassign · 14. handoffs recorded.

**Execution:** 15. engineers can start work · 16. and pause · 17. pause requires reason
and remark · 18. and resume · 19. and complete · 20. completion requires a remark ·
21. time recorded automatically · 22. time survives refresh and navigation ·
23. activity history immutable.

**Management:** 24. blocked projects visible · 25. awaiting-external visible · 26. team
workload visible · 27. project health visible · 28. overdue visible · 29. activity
visible.

**Data:** 30. all 29 supplied projects representable · 31. normalized, not dumped into
free text · 32. search and filtering work.

**Quality:** 33. permissions enforced server-side · 34. tests cover the business logic ·
35. the result feels native to the application.

**Added by the mock:** 36. Home answers "what needs attention" above the fold ·
37. My Work starts a session in one click without navigation · 38. a running timer is
visible from every screen · 39. every percentage on screen states its basis ·
40. every new surface passes the Fluent/Material/Graphite × light/dark sweep.

## 36. Open decisions — resolve before the affected slice

| ID | Question | Recommendation |
|---|---|---|
| **D-OPEN-1** | The mock brands the product **ATLAS**. CommandCenter's UI is one product themed centrally; a second brand in the sidebar is a product decision. | Owner's call. Default: keep CommandCenter's identity, treat "ATLAS" as mock chrome. |
| **D-OPEN-2** | "Reports" appears twice in the nav. | One entry. Keep it under Management; drop the primary duplicate. |
| **D-OPEN-3** | "Start Break" collides with one-open-session-per-actor. | End the session with `end_reason='break'` — no schema change. |
| **D-OPEN-4** | Complete is drawn red on My Work, green in its dialog. | Complete is not destructive. One non-red treatment in both places. |
| **D-OPEN-5** | Health labels: model says `healthy/at_risk/critical`; mock shows `Good/At Risk/Critical`. | Keep the model values; map to display labels in one place. |
| **D-OPEN-6** | Tabs: `Dependencies` in one mock screen, `Stages` in another. | Six tabs ending in Dependencies; manage stages inside Timeline. |
| **D-OPEN-7** | Blocker breakdown sums to 19 against a Blocked KPI of 7. | Decide blockers-vs-projects and whether Awaiting is included; label the card. |
| **D-OPEN-8** | Workload % basis differs between dashboard (daily) and People (weekly). | Both, each explicitly labelled. |
| **D-OPEN-9** | Stage progress percent (78%) has no definition. | Pick one rule, implement as a tested pure function. |
| **D-OPEN-10** | KPI deltas need history nobody stores. | Ship without deltas until the snapshot job lands (S17). |
| **D-OPEN-11** | Mock spells `WS02 Raptor X`; source data says `W502`. | `W502`. Transcription error in the mock. |
| **D-OPEN-12** | **Two surfaces are called "My Work".** `/projects`' tree has a "My work" node — `app/projects/components/MyWork.tsx`, the WS-27e GTD *triage* lens (disposition, context, defer). The plan's Screen 2 is `/projects/my-work`, a work *execution* home (start/pause/complete, waiting on me). Both are built and both are legitimate; the shared name is not. | Owner's call. Options: rename the triage lens to "Triage" or "My inbox"; or fold it into `/projects/my-work` as a second tab. Do NOT delete either — they answer different questions. |
| **D-OPEN-13** | **Sidebar panes vs the one-pane fence.** §19 asks for the operations views as "four sidebar destinations", and `/projects/home` + `/projects/my-work` want panes too. `registration.test.ts` ("is ONE pane, not one per Center") refuses: it encodes `department_centers.md` §1 rule 2, *forking the app per department is the bloat failure mode*. ⚠️ That rule is about per-CENTER forking; a per-SURFACE link is not the same thing — so the fence's implementation is broader than its intent. Narrowing it to let this through was deliberately NOT done: widening a fence so your own change passes is the recorded failure mode, and this one is Center doctrine (D22 territory). **Built meanwhile:** both surfaces are reachable from the board's app bar, which needs no doctrine change. | Owner's call. Recommend promoting **My work** and **Control Center** only — the two daily destinations, one per audience — and narrowing the fence to what it means (no `?center=` panes). The four ops views stay drill-downs: the Control Center already links and counts them, and six Projects rows would make this app shout over every other one in the rail. |

## 37. Execution rules

Work incrementally, one slice at a time. Inspect how the application already solves a
problem before adding a second solution. Reuse existing infrastructure. Do not replace
working components out of preference. Do not invent a tech stack. Do not create duplicate
entities where existing ones extend. **Do not build mock UI disconnected from the
backend** — every interaction connects to real state, every business rule is enforced
server-side, every state change is persisted, and every significant change writes an
activity record.

After each slice: run the tests · check types · check lint/build · verify existing
functionality still works · open the PR · **stop before merge**.

Verify delivery **by evidence, never by a green job** — migration ledger lines, the
deployed SHA, the log line. Four deploys once reported success while shipping nothing.
