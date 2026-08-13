# People Center — the person record, the directory, and the assignment seam

> **Product:** CommandCenter · **Feature:** People Center (`/centers/people` and the
> `/people` app behind it) · **Created:** 2026-08-06 · **Rewritten 2026-08-13**
> · **Status:** ✅ **a + b + b-write BUILT** (2026-08-06/07) · ✅ **g BUILT** (2026-08-13)
> · 🟢 **c–e, h–m dispatchable** · 🔴 **f owner-gate** · **Owner:** vjvarada
> · **Board row: WS-28**
> · *Verified against code on 2026-08-13* (`routes/people/`, `routes/tasks/people.py`,
> `routes/tasks/capability.py`, migrations 49/74/75/148/149, `src/app/people/`,
> `src/lib/centers.ts`, `acb_auth/permissions.py`).
>
> **Scope, owner-set 2026-08-06 and WIDENED 2026-08-13.** The original scope was
> *directory, skills, org chart, capacity, seats/roles* — exactly what assignment needed.
> The owner's 2026-08-13 directive widens it on one axis and one axis only:
>
> > *"we should be able to set up all the personal details of a particular user with access
> > control … somebody with admin privileges will be able to edit every user … a particular
> > user will only be able to edit their own details … primarily from a perspective of
> > project management, so the AI can manage people, follow up with people, and say what
> > person can be assigned to what task."*
>
> So v2 adds: **the person record itself** (§3), **self-service editing** (§4), the
> **remaining sub-apps** of the People Center (§5), and **what the AI is allowed to read
> and do with all of it** (§6.5–§6.8). Leave policy, hiring and payroll stay deferred in
> §10 — with one narrowing: *availability* is in scope and *leave management* is not, and
> §5.8 explains why those are different products.
>
> **This spec owns SURFACES and the PERSON RECORD; it does not own identity.** Everything
> else is owned elsewhere and cited, never restated:
> - `specs/task_manager_hr_planning_and_memory.md` — HR intelligence, résumé ingestion,
>   capability vectors. **Owns the ingestion pipeline**; this doc owns the record's shape,
>   who may see each field, and who may write it.
> - `specs/org_access_control.md` — members, roles, per-user overrides. **Owns identity**
>   and the permission grammar every rule here is expressed in.
> - `specs/colleague_onboarding.md` — the invite runbook and the role × app capability
>   matrix. **Owns the process.**
> - `specs/department_centers.md` — Centers, groups, the five-place registration checklist.
>   **Owns the projection model.**
> - `specs/project_management_app.md` — projects, tasks, assignment. **Owns the work.**
>
> A reader who wants "what is a manager allowed to see" goes to `colleague_onboarding.md`
> §3. This doc answers "where do I click to change who someone reports to", "which fields
> may I change about myself", and "what does the assignment AI actually get to read".

---

## 1. Why this exists

**Two reasons, and the second one is new.**

**(a) Assignment.** The Projects app (WS-27) can hand a task to `alice@fracktal.in`
today, but nothing in the product answers the questions a person asks *before* they
assign: who is there, who knows about extruder firmware, who has capacity this week, who
does this person report to.

**(b) A model of people the AI can reason over.** The owner's 2026-08-13 directive is
about the *second* consumer: an agent that manages projects has to manage the people in
them — propose owners, notice who is overloaded, chase what is stale, and report what the
org is actually doing. An agent can only do that against a record that says what a person
*can do*, *is doing*, and *is available for*. Today the record says name, department, a
flat list of skill words and a hand-typed capacity number. That is enough to render a
directory and not enough to reason with.

Everything in §3 is there because a specific question needs it. **A field that names no
question does not go in** — §3.6 lists the ones deliberately refused, so their absence is
a decision rather than an oversight.

**Non-goals (v1):** payroll, compensation, performance ratings and reviews, time-off
*balances* and approval chains, applicant tracking. §10 records where those would go if
they are ever wanted.

---

## 2. Three questions, two stores, and one self predicate

This is the single most important thing to understand before building anything here, and
it is not a defect to be tidied away.

| | `app_user` (+ `user_role`, `org_group_member`) | `gtd_people` (+ `gtd_person_resumes`) |
|---|---|---|
| Answers | *Can they sign in, and what may they see?* | *Who are they, what can they do, who do they report to?* |
| Created by | An invite (`POST /admin/members`) or a sign-in request | An import, a résumé upload, or a hand-added row |
| Owned by | `org_access_control.md` | `task_manager_hr_planning_and_memory.md` |
| Key | `email` | `id`; `lower(email)` partial-unique since migration 148 |
| Includes people who never sign in | No | **Yes** — contractors, a new hire before day one, a vendor contact |

**They are joined on lowercased email, and the join is deliberately partial.** A person can
exist in the directory with no login (a contractor you assign work to but who has no seat),
and a login can exist with no directory row (a service identity). Collapsing them into one
table would force every contractor to become a member — which is a *licensing and access*
decision, not a directory one.

**The third question v2 adds is "which of these rows is ME?"** Self-service editing needs
a defensible answer, and there is exactly one:

```
is_self(caller, person)  ⇔  caller.email is not null
                        and person.email is not null
                        and lower(caller.email) = lower(person.email)
```

That predicate is safe **only because migration 148 made `lower(email)` partial-unique**:
before it, two rows could carry one address and "edit yourself" could have edited somebody
else. It is the same join `has_login()` already runs in `routes/people/core.py`, in the
other direction — so the badge the person page already draws and the right to edit are the
same fact seen twice, not two facts that can disagree (**D-PC-1**).

⚠️ **`gtd_people.name` is no longer UNIQUE and `email` is** (partial, `WHERE email IS NOT
NULL`). Migration 148 did that, for exactly this reason. Do not re-introduce a name key.

**The rule this doc adds:** the People Center *renders both stores* and never creates a
third. WS-13's board row already says it — "build the read view here, not a parallel store"
— and this is that instruction, made concrete.

---

## 3. The person record

The record is the product here. §3.1–§3.5 are the field inventory, grouped by what they
are *for*; the last two columns are the access model §4 defines and are stated per field
so nobody has to derive them. §3.6 is the refusals.

**Read tiers** (§4.2): **D** = directory (any `feature:people` holder) · **H** = HR
(`admin:members:read` **or** self) · **P** = private (`admin:members:manage` **or** self).
**Write classes** (§4.3): **A** = admin only · **S** = self **or** admin · **⚙** = derived,
written by no form at all.

### 3.1 Identity and directory — "who is this, and how do I reach them at work"

| Field | The question it answers | Read | Write | State |
|---|---|---|---|---|
| `name` | Who | D | A | ✅ 49 |
| `preferred_name` | What to actually call them (and what the AI should call them) | D | **S** | 🔲 P-3 |
| `pronouns` | How to refer to them in a generated summary without guessing | D | **S** | 🔲 P-3 |
| `email` | The join key, and the assignee string Projects writes | D | **A** | ✅ 49 |
| `title` | What they do, in their words | D | A | ✅ 74 |
| `role` | The org-chart role (imported; distinct from `title`) | D | A | ✅ 49 |
| `department`, `team` | Free-text org placement — see the overlay warning in §5.4 | D | A | ✅ 49 |
| `manager_id` | Who approves, who to escalate to. Self-FK | D | A | ✅ 74 |
| `reports_to` | The imported display name, kept until the backfill retires it | D | A | ✅ 49 |
| `status` | `active` \| `contractor` \| `alumni` \| `invited` (CHECK, 148) | D | A | ✅ 148 |
| `location` | Which site/city — "who is in the room" for a scheduling question | D | **S** | 🔲 P-3 |
| `timezone` | IANA name. **The single highest-value new field for assignment**: an overlap of two hours is a fact about a task's cycle time | D | **S** | 🔲 P-3 |
| `working_hours` | `{days: [1..5], start: "09:00", end: "17:00"}` — when a chase is rude and when a due date is unreachable | D | **S** | 🔲 P-3 |
| `bio` | One paragraph, theirs. What the directory reads like to a new colleague | D | **S** | 🔲 P-3 |
| `links` | `{github, linkedin, portfolio, …}` — professional, public-facing | D | **S** | 🔲 P-3 |
| `has_login` | Whether an `app_user` row exists | D | ⚙ | ✅ b |

### 3.2 Employment — "what is their relationship to the company"

| Field | The question it answers | Read | Write | State |
|---|---|---|---|---|
| `employee_id` | The HR system's key, for reconciliation | H | A | 🔲 P-3 |
| `employment_type` | `employee` \| `contractor` \| `intern` \| `vendor` \| `agent`. **Orthogonal to `status`** — see the note below | H | A | 🔲 P-3 |
| `start_date` | Tenure; "who was here when this decision was made" | H | A | 🔲 P-3 |
| `end_date` | When a contractor's engagement ends — an assignment past it is a mistake the assigner should be warned about | H | A | 🔲 P-3 |
| `seniority` | `junior` \| `mid` \| `senior` \| `lead` \| `principal`. Coarse on purpose: it feeds "should this person own it or review it", not a pay band | H | A | 🔲 P-3 |
| `cost_center` | Which budget the work lands against | H | A | 🔲 P-3 |
| `clickup_user_id` | The provider assignment target | H | A | ✅ 49 |
| `source`, `source_key` | Provenance and the importer's upsert key | H | ⚙ | ✅ 49/148 |

⚠️ **`status` and `employment_type` overlap and that is deliberate.** Migration 148's
CHECK mixes a lifecycle (`active`, `alumni`, `invited`) with an engagement type
(`contractor`), because that is the vocabulary the data already carried. **Do not rename
or re-map it** (R6: no rename in place, and the CHECK is live). `employment_type` is the
clean axis added beside it; when both are present, `employment_type` is the fact and
`status` is the lifecycle. A later release may narrow the CHECK — that is the contract
half of expand/contract and it is not this ticket (**D-PC-8**).

### 3.3 Capability — "what can they do"

This is the half the assignment AI actually reasons over.

| Field | The question it answers | Read | Write | State |
|---|---|---|---|---|
| `skills[]` | The flat list every existing consumer reads (GIN-indexed, `_match_capability`, clarify) | H | S | ✅ 49 |
| `skills_source` | Per-skill provenance — `stated` vs `résumé`, so an inferred skill never looks like a claim the person made | H | S | ✅ 74 |
| **`gtd_person_skills`** | The **structured** skill: level, years, last used, evidence. See below | H | S | 🔲 P-4 |
| `resume_summary`, `years_experience`, `domain` | Résumé depth, for seniority weighting | H | S | ✅ 49 |
| `gtd_person_resumes` | The CV itself + its parse | H | S | ✅ 74 |
| **`gtd_person_credentials`** | Education, certifications, and prior roles, extracted from the CV or typed — "is this person actually qualified to sign this off" | H | S | 🔲 P-4 |
| `languages[]` | Which customer can they talk to | D | S | 🔲 P-3 |
| `interests[]` | What they *want* to work on. An assigner who only optimises for fit assigns the same person the same work forever | H | S | 🔲 P-3 |
| `capability_embedding`, `capability_text_hash` | Semantic match (1536-dim, migration 75) | — | ⚙ | ✅ 75 |

**Why skills get a child table (P-4) rather than another array.** `skills TEXT[]` answers
"do they know Python" and nothing else. The assignment questions that actually come up are
*how well* (a mentor and a beginner are not interchangeable), *how recently* (five years
stale is a different answer), and *on what evidence* (they said so / the CV says so / they
shipped it). Three parallel arrays or a second JSONB map would be three things that must
agree; a child table with one row per (person, skill) is one thing.

**`skills[]` does not go away — it becomes a maintained projection.** Every writer of
`gtd_person_skills` rewrites `gtd_people.skills` and `skills_source` **in the same
transaction**, because `_match_capability()`, `fetch_people_for_clarify()`, the GIN index
and the directory's `skill`/`q` filters all read the array today and R6 forbids breaking
running code. The child table is the source; the array is the cache. **The fence is a
route test that asserts the array equals the table's contents after every write path**
(R7), not a paragraph asking people to remember (**D-PC-6**).

### 3.4 Availability and load — "can they take this on"

| Field | The question it answers | Read | Write | State |
|---|---|---|---|---|
| `capacity_hours_per_week` | The ceiling | H | A | ✅ 49 |
| `current_load_hours_per_week` | Legacy hand-typed load. **Read nothing into it** — WS-28b computes the real figure | H | A | ✅ 49 |
| `available_hours_per_week` | `capacity − load`, floored at 0 | H | ⚙ | ✅ 49 |
| *derived* open-task load + `unestimated` | What the bar actually draws (§6.2) | H | ⚙ | ✅ b |
| **`gtd_person_absences`** | Away from when to when, and roughly why. See §5.8 | H | S | 🔲 P-5 |
| `max_concurrent_tasks` | A person's own stated ceiling on parallel work — the number a suggester should respect before an hours figure it half-invented | H | **S** | 🔲 P-3 |

### 3.5 Personal — "the things only they and HR should see"

| Field | The question it answers | Read | Write | State |
|---|---|---|---|---|
| `phone` | How to reach them when the product is down | **P** | S | 🔲 P-3 |
| `emergency_contact` | `{name, relation, phone}` | **P** | S | 🔲 P-3 |
| `personal_email` | Off-boarding, and reaching an alumnus | **P** | A | 🔲 P-3 |
| `birthday` | **`MM-DD` only** — see §3.6 | H | S | 🔲 P-3 |

⚠️ **Migration 49 says "personal phone numbers are deliberately NOT imported".** Adding
`phone` reverses that, knowingly, because the owner asked for personal details in the
record. Two things keep the reversal honest: the field is **private tier** (§4.2 — self,
or a `admin:members:manage` holder, and nobody else, *including* a manager holding
`admin:members:read`), and **the importer still does not populate it**. It arrives only
when a person types it about themselves, or an HR admin does.

### 3.6 What the record deliberately does NOT carry

Each of these was considered and refused. Naming them is what stops the next agent adding
one "for completeness".

- **Date of birth.** `birthday` is `MM-DD`, so the team can say happy birthday, and the
  product never holds a field that is half of an identity-theft pair. Age is not an input
  to any question this spec asks (**D-PC-9**).
- **Compensation, pay band, bank details.** Different blast radius, different regulatory
  posture, and no assignment question needs them. If ever wanted they belong in a payroll
  module with its own access model, not in the directory.
- **Performance ratings, review scores, PIP status.** The moment the record carries a
  score, every suggester that reads the record starts optimising for it — and an
  automated "who should do this" that quietly ranks by a manager's rating is a management
  decision made by a machine. §10 keeps performance out of scope for this reason, not
  because it is hard.
- **Home address, national ID, marital status, dependants.** No question here needs them.
- **A free-text "HR notes" field.** It becomes the place things are written that the
  subject may not read, which is a policy this product has not decided.

---

## 4. Access control

Three read tiers, three write classes, and one predicate. **Nothing here introduces a new
permission slug** — a new slug is nobody's grant until an admin creates it, which is the
same trap `colleague_onboarding.md` N4 avoided by expressing the HR rule in the existing
`admin:members:*` vocabulary.

### 4.1 The self predicate

Defined in §2 and computed in exactly one place. Three consequences worth stating:

- **A directory-only person has no self.** No login, no caller, nothing to match — their
  record is admin-maintained. That is the contractor case working as designed
  (**D-PC-12**).
- **A person with no address on their row has no self either**, even if they can sign in.
  The fix is an admin setting their address, which is the same fix as "why does the
  directory not know it is me".
- **`email` is admin-write, always.** If a person could edit their own address they could
  point their row at a colleague's address and inherit that row's self-rights on the next
  request. Self-editable identity is privilege escalation with extra steps (**D-PC-2**).

### 4.2 Read tiers

| Tier | Who sees it | What is in it |
|---|---|---|
| **Directory** | any `feature:people` holder | §3.1 + `languages` — the "who is there" half the org runs on |
| **HR** | `admin:members:read` **or** self | §3.2, §3.3, §3.4 — capability, employment, load |
| **Private** | `admin:members:manage` **or** self | §3.5 — contact and emergency details |

The HR tier is **WS-24 N4's projection, already shipped and enforced** — `can_read_hr_fields`
in `routes/tasks/core.py`, imported (never redefined) by `routes/people/core.py`, with a
test asserting the *identity* of the function object. v2 changes it in exactly two ways:

1. **Self is added as a second door.** A person may read their own HR half without holding
   `admin:members:read`. Without this, "edit your own skills" is a form whose current
   values you cannot see.
2. **A third, narrower tier is added above it** for §3.5. `admin:members:read` is the
   *manager-ish* grant (D14 records that `data:org:read` grants nothing, so
   `admin:members:read` is what "org-wide visibility" actually means); a manager seeing
   skills and capacity is the point of the tier, and a manager seeing a colleague's
   emergency contact is not. Private is therefore keyed to the **write** grant, which is
   the HR-admin right (**D-PC-3**).

**The three filter clauses stay dropped without HR read** (`q`'s skills clause, `skill`,
`has_capacity`) — matching on a column that is then stripped turns the search box into an
oracle. Self does **not** re-open them: a self door on one row cannot license a filter that
runs across every row. That is the one place where "self is a second door" does not apply,
and it is worth a test of its own.

### 4.3 Write classes

| Class | Who may write | Which fields |
|---|---|---|
| **admin** | `admin:members:manage` | Identity and org placement (`name`, `email`, `title`, `role`, `department`, `team`, `manager_id`, `reports_to`, `status`), all of §3.2 employment, `capacity_hours_per_week`, `personal_email` |
| **self** | the subject **or** `admin:members:manage` | Everything a person is the best source for: `preferred_name`, `pronouns`, `location`, `timezone`, `working_hours`, `bio`, `links`, `languages`, `interests`, `max_concurrent_tasks`, `skills` (+ the structured rows), CV upload, credentials, absences, and §3.5's contact fields |
| **derived** | nobody | `available_hours_per_week`, the computed load, `capability_embedding`, `capability_text_hash`, `has_login`, `source_key`, `email_conflict` |

The split follows one line: **a person is the authority on what they can do and how to
reach them; the company is the authority on what they are.** Title, manager, department,
status and capacity are claims the *organisation* makes — a product where you can promote
yourself is not an org chart.

### 4.4 The server owns the field map, and says so on every read

Every person read carries four flags, three of which already exist:

- `hr_visible` — shipped (WS-28b)
- `can_manage` — shipped (WS-28b-write)
- `is_self` — new
- **`editable_fields: string[]`** — new, and the important one

The client renders write controls **from `editable_fields`**, never from its own copy of
the class map. The alternative is a second authority in TypeScript that drifts from the
Python one, and the drift is silent in the safe direction (a field you may edit is hidden)
and loud in the unsafe one (a field you may not edit is drawn, saved, and 403s after the
click) (**D-PC-4**).

**A write naming a field outside the caller's classes is a 403 that names the field.** Not
a silent drop: a save that reports success and discards half the form is worse than a
refusal, because the person believes the change landed (**D-PC-5**).

### 4.5 What is deliberately not in the model

- **A manager tier.** "My reports' records" is a real future ask, and it needs machinery
  that does not exist: `manager_id` is a directory fact, not a grant, and D14 already
  records that the `manager` role's "org-wide visibility" is a name. Building a
  manager-scoped write on top of an unenforced field would be a permission that looks like
  one and is not (R7). Named here so its absence is a decision (**D-PC-11**).
- **Role and group writes stay where they are.** Roles are edited at `/settings/members`;
  group membership is an owner gate (`work_plan.md` §6 (d)). §5.6 renders both and
  proposes; it applies neither.
- **An approval workflow for self-edits.** A person changing their own timezone does not
  need review. A person changing something that *does* need review is, by construction, in
  the admin class.

---

## 5. The surfaces

Route: **`/people`**, gated on its own feature slug `people` (§8). The People Center's
landing page (`/centers/people`) links to it, and it is one app, not one per Center — the
same (app + scope) rule the Projects app follows. Every sub-app below is a view **inside
that one app**, not a second registration.

### 5.1 Directory — the default view ✅ BUILT

A searchable list of everybody, one row per person, with a card/table toggle.

**Row:** avatar (initials fallback), name, title, department + team, status pill
(`active` / `contractor` / `alumni`), and a compact skills strip (top 3 + "＋4").
**Search** matches name, title, department and skills in one box — the Projects app's
assignee picker uses the same endpoint, so a person findable in one is findable in both.
**Filters:** department, team, status, skill, "has capacity". v2 adds **timezone** and
**available now** (derived from `timezone` + `working_hours` + absences), because "who can
pick this up in the next hour" is the question a live escalation actually asks.

⚠️ **The HR strip is permission-dependent and already enforced.** Without
`admin:members:read`, `skills`, `resume_summary`, `years_experience` and the capacity trio
are projected to null, and `?q=` drops its skills clause so search cannot become an oracle.
**The UI renders the projected shape and never re-fetches a richer one** — and the empty
state says "restricted" rather than "none", because a blank skills strip that means "you
may not see this" and one that means "nobody filled it in" are different facts.

### 5.2 Person page ✅ BUILT (four panels) · 🔲 extended to six (P-3/P-4)

1. **Identity** — name, title, email, department, team, manager, status, and the
   **login badge** (`app_user` exists / directory-only) that makes §2 visible.
2. **Skills** — chips with provenance. v2: level and recency per skill (§3.3), and a
   "stale" marker on a skill not touched in two years, because that is the one signal that
   makes a keyword match wrong in a way nobody notices.
3. **Capacity** — one bar, not three numbers, computed from open assigned tasks (§6.2).
4. **Work** — this person's open tasks across every project the *viewer* may see.
5. **Profile** *(new)* — §3.1's directory half plus timezone, working hours, languages,
   links, bio. Editable in place when `editable_fields` says so.
6. **Employment** *(new, HR tier)* — §3.2. Collapsed by default: it is the panel a
   colleague has no reason to read and an admin needs three times a year.

**Writes** are gated per field by §4.3 — not by one flag. A viewer with no write rights at
all sees the page read-only with **no disabled-button theatre**; the controls are absent.

### 5.3 My profile — `/people/me` ✅ BUILT (WS-28g)

The self-service surface, and the reason §4 exists. It is the **same person page**
resolved through the self predicate rather than a second page with a second layout — one
component, two entry points, so a field added to one cannot be missing from the other.

- Resolves via `GET /people/me`. Three honest answers, three different screens:
  **your row** · **no row matched your address** (say so, name the address, and point at
  the admin — do not render an empty form that silently saves nothing) · **no address on
  your account** (a sign-in state, not a People problem).
- Renders **only** `editable_fields`, and shows every other field read-only rather than
  hiding it — a person should be able to see what the company records about them even
  where they cannot change it. That is the whole difference between a profile and a form.
- **CV upload is here**, not only in the admin editor: "their CV … can be edited" was
  explicit in the directive, and a person is the best source for their own résumé.
  Uploading re-runs the existing parse → merge → re-embed pipeline unchanged.
- A **completeness meter** — which of the fields the assignment AI actually uses are still
  empty on your row, and what each one buys. Not a nag: the meter names the consequence
  ("no timezone means the scheduler assumes yours is the org default").

### 5.4 Org chart 🟢 WS-28c

`gtd_people.manager_id` is a self-FK, so the chart is the same recursive render the project
tree already uses — and the same cycle guard applies (a manager loop is a hang, not a
diagram).

- **Layout:** vertical tree, collapsible, with search-to-focus.
- **Unmanaged people** surface as roots. That is not an error state to hide: "nobody is
  recorded as this person's manager" is exactly what an org chart should make obvious.
- **Drag to re-parent** writes `manager_id` (admin class), with the cycle refused
  client-side before the request so the tree does not optimistically render an impossible
  shape.
- **Center overlay:** each node tinted by `org_group` membership, which is what makes "who
  is actually in Operations" answerable — and shows the mismatches between
  `gtd_people.department` (free text) and group membership (the real scoping).
  **That mismatch is the point of the overlay**, not a rendering bug to smooth over.

### 5.5 Capability search — "who should do this?" 🟢 WS-28d

A single box: *"Who can help with extruder firmware?"* Answers from three signals, most
defensible first, each labelled in the result:

1. **Stated skills** — exact/fuzzy match on `skills[]`, now weighted by level and recency
   (§3.3). Deterministic.
2. **Résumé evidence** — a match in `gtd_person_resumes.extracted`, quoting the line.
3. **Capability vector** — cosine on `capability_embedding` (1536-dim, populated by
   `POST /tasks/people/embed`), for what the first two miss.

Each result shows **why it matched, how loaded that person is, and whether they are
available** (absence, end date, timezone overlap) — a perfect skill match at 45/40 hours,
or one who is away all week, is the wrong answer. This is a *suggester*: **it never
assigns.** Same rule as the ClickUp Space mapper (D-PM-10) and for the same reason — a
system that auto-assigns work to people is making a management decision it is not entitled
to make (**D-PC-13**).

The **ranking prompt is EVAL-LOCKED**: a change to it needs the eval, not a review.

### 5.6 Seats & roles 🔴 WS-28f (write half is an owner gate)

The bridge to `org_access_control.md`, rendered here because "who is in Sales" is a People
question that today requires visiting `/settings/groups`.

A matrix: people down the side, the six Centers across the top, a checkbox at each
intersection reflecting `org_group_member`. Toggling one is a **group membership write** —
already an owner gate (`work_plan.md` §6 (d)) — so this surface **proposes and does not
apply** for anyone but the owner: a non-owner's toggle produces a request in the existing
access-request queue rather than a silent 403.

Beside it, each person's **role** (`owner`/`admin`/`manager`/`member`/`guest`) as a
read-only pill linking to `/settings/members`. Roles are not edited here — one editor for
a thing, and that editor already exists.

**Also here: "give this person a login."** `has_login` is displayed today and cannot be
acted on; the join is `lower(email)` on both sides, so the action is well-defined. It
belongs beside the seats matrix (both are membership acts), and it is an **invite**, which
§6 (d) gates. Propose-only, like the rest of this surface.

### 5.7 Workload & activity — "what is everybody actually doing" 🟢 WS-28j

The surface the directive's *"give reports on what people are actually doing"* asks for,
and it is a **read over the Projects app's tables**, never a second store.

- **Per person:** open tasks by status category, overdue count, tasks completed in the
  last 7/30 days, median cycle time, last activity timestamp, and the derived load bar.
  Sources: `pm_tasks`, `pm_task_assignees` (assignee is a plain string — an email or
  `agent:<name>`, D-PM-4), `pm_activities.created_by`.
- **Per team / Center:** the same figures rolled up, plus the two distributions that
  actually drive a conversation — **load spread** (who is at 150% next to who is at 20%)
  and **stale work** (assigned, open, no activity in N days).
- **Every figure is scoped by the VIEWER's grants**, through the Projects grant closure —
  the same rule §6.3's work panel already follows. A rollup is not a licence to see work
  you could not open. Where the viewer's scope hides rows, the surface says the count is
  partial rather than reporting a smaller number as if it were the whole.
- **Agents appear beside people**, because they hold tasks the same way (D-PM-4). An
  activity report that silently omits half the workforce is wrong in the direction that
  matters.

⚠️ **This is a measurement surface, not a performance surface.** "Completed in the last 30
days" is a number about *tasks*, and every one of these figures is trivially gamed and
trivially misread. The surface renders them as **workload signals for planning** and never
ranks people against each other — no leaderboard, no score, no per-person trend line
presented as an evaluation. §3.6 refuses to *store* a performance rating; this is the same
decision on the read side (**D-PC-14**).

### 5.8 Availability & absences — not leave management 🟢 WS-28k

An assigner needs to know that Rahul is away next week. That is a **fact**, and it is one
table: `gtd_person_absences(person_id, starts_on, ends_on, kind, note)` where `kind` is
`away` | `holiday` | `partial` and nothing more.

**Leave *management*** — accrual, balances, entitlements, an approval chain, carry-over,
policy per country — is a different product, needs a policy model nothing in the platform
has, and belongs on the Action Broker inbox when it comes. §10 keeps it deferred. What is
built here is the half assignment needs and nothing else: **who is away, when, and how that
changes their availability this week** (**D-PC-7**).

Absences are self-writable (a person records their own) and admin-writable. They feed:
the capacity bar, the capability search's availability line, the assignee picker's warning,
and the AI's "do not chase someone who is on holiday" rule (§6.7).

### 5.9 People dashboard — the Center landing rollup 🟢 WS-28l

What `centers.ts` already lists as *"People dashboard — who's in, who's out, open roles,
onboarding in progress"*, narrowed to what exists: headcount by department and status,
who is away this week, load spread, the data-quality panel (§5.10), and the org's
unmanaged roots. It is a **projection of §5.7 and §5.10**, not new arithmetic — a dashboard
that computes its own version of a number the app already renders is how two numbers start
disagreeing.

### 5.10 Skills coverage & data quality 🟢 WS-28m

Two questions with one surface, because both are "what is wrong with the record":

- **Coverage:** which skills exist in exactly one person (a bus factor of one), which
  appear in job titles but in nobody's skills, which are declared and never used on a task.
- **Quality:** rows with no email (no self, no assignment), rows with `email_conflict`
  set (migration 148 quarantined an address and a human still has to choose), statuses
  outside the vocabulary (148's CHECK is `NOT VALID` where legacy data was dirty),
  managers pointing at alumni, people with no manager, profiles whose AI-relevant fields
  are empty.

The `email_conflict` and un-validated-CHECK rows are **listed here by design** — migration
148 deliberately quarantined rather than failed the deploy, and this panel is where that
decision gets paid off. A quarantine nobody surfaces is a data-loss with a delay.

### 5.11 Onboarding and hiring — later, and §10 says where

Both stay planned in `centers.ts`. Onboarding binds to `colleague_onboarding.md`'s runbook
and would create tasks in the Projects app rather than a new store; hiring is structurally
a second CRM. Neither is designed here.

---

## 6. Where the People Center meets the Projects app, and the AI

Seams §6.1–§6.4 are **reads across the boundary** — neither app writes the other's tables.
§6.5–§6.8 are the AI contract, which is new in v2.

### 6.1 The assignee picker (Projects → People) 🟢 WS-28e
Assigning a task opens a picker backed by the directory endpoint, not by a list of
`app_user` rows. It shows name, title, top skills and a capacity bar, and it lists
**agents** in the same picker under a separate heading — D-PM-4's one-vocabulary decision
made visible: handing work to an agent is the same gesture as handing it to a colleague.

⚠️ The picker must offer **directory-only people** (no login). They can hold a task and
appear on a board; they simply cannot sign in to see it. Hiding them would make the
directory's whole point — contractors — unusable, and the assignee column is a plain string
precisely so this works (Projects spec §3.6).

v2 adds one line to each row: **why this person is or is not a good idea right now** —
away until the 20th, at 140% load, engagement ends before the due date. Shown, never
enforced: the picker warns and still lets you assign, because the assigner knows things the
record does not.

### 6.2 Capacity (Projects → People) ✅ BUILT
`current_load_hours_per_week` is **derived**, not typed: the sum of `estimate_mins` over
open tasks assigned to that person, divided into a week, and carrying `unestimated` —
because a bar built from the estimate sum alone shows somebody holding thirty un-estimated
tasks as completely free. When nothing is estimated the bar refuses to draw a percentage
rather than drawing a confident zero.

### 6.3 The person's work panel (Projects → People) ✅ BUILT
`GET /projects/tasks?assignee=<email>`, scoped by the *viewer's* grants, answering
`available: false` without `feature:projects` — "this surface is not yours" and "they have
nothing open" must not render identically.

### 6.4 Delegation (People → Projects) 🟢 WS-28e
From a person page, **"Assign work"** opens task creation with the assignee pre-filled;
from the capability search, **"Assign to…"** on a result. Both land in the ordinary
task-create flow — no second write path, so every rule the Projects app enforces
(visibility, status, activity) applies unchanged.

### 6.5 What the AI reads, and under whose eyes

Two modes, and conflating them is how a projection leaks:

| Mode | Example | What it may read |
|---|---|---|
| **Server-side heuristic** — no human is asking, the system is proposing | the clarify assignee proposal; the capability ranking behind a suggestion | the **full roster**. `fetch_people_for_clarify()` is already deliberately outside the N4 projection and documented as such |
| **Answering a caller** — an agent replying to a person in chat | *"what is Priya working on?"*, *"who knows Modbus?"* | **exactly what that caller could read through the API**, tier by tier |

The rule (**D-PC-10**): *a suggestion computed on the server may use everything; a sentence
rendered to a human may contain only what that human may see.* The fence is that the
caller-facing agent tool calls the same projection function the routes do, and the test
asserts the function's identity — the pattern `routes/people/core.py` already uses for
`can_read_hr_fields`.

### 6.6 The assignment suggestion contract

The suggester returns, per candidate: **the match reason** (which skill, at what level,
from what evidence), **the load**, **the availability**, and **a confidence**. It returns
*candidates*, plural, ranked — never a single answer presented as a decision — and the
surface that renders it always offers "assign somebody else" as a first-class action.

It never writes an assignment (§5.5, D-PC-13). What it may write is a **proposal** into
the existing pending/broker path, where a human approves it — the same seam every other
outward action in this platform goes through.

### 6.7 Follow-ups and chasing — drafted, queued, never sent

The directive asks the AI to *"help follow up with the people"*. The People Center supplies
the **who and the why**: this person owns three tasks that have had no activity in nine
days; this one is at 160% while their team is at 40%; this one has work due after their
engagement ends.

⚠️ **Sending is an owner gate.** `work_plan.md` §6 registers *"outbound nudge sending — one
shared gate for two rows"* (WS-21's chase block and WS-18's follow-up nudges): drafting and
queueing are AGENT-SAFE, sending is not, and **no row may flip it independently — including
this one**. The People Center's follow-up surface therefore ends in a **draft in a queue a
human releases**, and the spec says so here so an agent building §5.7 does not reason its
way to a send.

Two behaviours the record makes possible and which are non-optional: **never chase someone
who is recorded absent** (§5.8), and **never chase outside their `working_hours` in their
`timezone`** (§3.1). Both are the difference between a helpful assistant and one people
turn off.

### 6.8 The agent tool surface

One tool, `people_directory`, replacing nothing: `gtd_people(query)` already exists for the
task-manager agent and keeps working. The new tool is the **caller-bound** one from §6.5 —
it takes the caller's context, applies the tiers, and answers about people and their work.
It exposes reads only. There is no agent-callable write to a person record in v1, because
the first write an agent should be trusted with is not one that changes what a colleague is
recorded as being.

---

## 7. Data model

**No new people STORE.** The People Center reads `gtd_people`, `gtd_person_resumes`,
`app_user`, `org_group` and `org_group_member`. Everything below is additive, and every
new table is tenant-scoped by construction (R5(a): discovered by
`scripts/gen_tenant_migration.py`, covered by the generated RLS migration, absent from
`EXEMPT`).

| # | Change | Ticket |
|---|---|---|
| **P-1** | ✅ Key shape: `UNIQUE(name)` dropped, partial unique on `lower(email)`, `source_key`, status CHECK, `email_conflict` quarantine | WS-28a (migration 148) |
| **P-2** | ✅ Status vocabulary + `has_login` derived, never a column | WS-28a |
| **P-3** | ✅ Profile columns on `gtd_people` — §3.1's self half, §3.2's employment half, §3.4's `max_concurrent_tasks`, §3.5's private half | WS-28g |
| **P-4** | 🔲 `gtd_person_skills` (structured skills) + `gtd_person_credentials` (education, certifications, prior roles) | WS-28h |
| **P-5** | 🔲 `gtd_person_absences` | WS-28k |
| **P-6** | 🔲 The tightening half: narrow `employment_type` / `seniority` CHECKs once real data is in, and validate 148's status CHECK where the quarantine panel (§5.10) has been cleared | later release, R6 contract half |

**Every P-3 column is nullable with no NOT NULL and no rewrite of an existing column**
(R6). The deploy applies migrations *before* restarting services, so the currently-running
code meets the new schema first — and it must find the table exactly as it left it.

**JSONB vs columns.** `working_hours`, `links`, `emergency_contact` and `work_prefs` are
JSONB because they are *records the product never filters on*. Anything a query filters or
sorts by — `timezone`, `location`, `employment_type`, `start_date` — is a column. A field
that migrates from one to the other later is an expand/contract, which is exactly why the
distinction is drawn at design time rather than discovered at query time.

---

## 8. Registration

The five-place checklist (four from `project_management_app.md` §5, plus the fifth WS-28b
found the hard way):

1. `acb_auth.permissions.FEATURES` gains `"people"` — ✅ shipped.
2. A `feature_catalog` row — ✅ migration 149 (`people`, `/people`, `apps`, 57, `false`).
3. `nav.ts` `PANES` + `access.ts` `HREF_FEATURES` → `/people` → `people` — ✅ shipped.
4. The both-ways catalog↔FEATURES invariant, plus the named
   `test_people_is_registered_on_both_sides` — ✅ shipped.
5. **`test_org_access_enforcement.GATED_ROUTERS`** — hand-maintained; a router absent from
   it is not passing, it is *unchecked*. Every new router this spec adds joins it in the
   same PR.

Plus the Center projection in `centers.ts`: *"Directory & org chart"* is ✅ live, and
**"My profile"** → `/people/me` joined it ✅ live with WS-28g; v2 flips **"People
dashboard"** (§5.9) when WS-28l lands. A sub-app entry that says `live` and links nowhere is
worse than one that says `planned`.

**Visibility posture:** `is_default false`, like `crm` and `projects`. The directory is
open to holders; the HR fields inside it are restricted by `admin:members:read`, and §3.5
by `admin:members:manage` — restrictions that already exist and must not be
re-implemented.

⚠️ **`/people/me` needs no new feature slug** and must not get one. It is the same app
under the same gate; what changes is which row you are looking at.

---

## 9. Tickets

### Built

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
`set -euo pipefail` + `ON_ERROR_STOP=1`; main has already been bitten twice by a
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
database with the ladder applied, which that build had no access to. Regenerate it on the
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
- **Load is computed, and says when it cannot be.** The bar counts open assigned tasks —
  and carries `unestimated`, because a task with no estimate adds no hours and a bar built
  from the sum alone shows somebody holding thirty un-estimated tasks as completely free.
- **The work panel is scoped by the VIEWER**, via the Projects grant closure, and answers
  `available: false` without `feature:projects`.

**Registration is five places, not four** — §8's fifth is
`test_org_access_enforcement.GATED_ROUTERS`, hand-maintained, where an absent router is
unchecked rather than passing. Also added: `test_projects_is_registered_on_both_sides`,
which WS-27a never wrote — the generic pair passes when **both** sides are missing a slug,
so only a named test catches a feature nobody registered.

The person-page **writes stay on `/tasks/people`** under `admin:members:manage`. The
`/api/people` proxy is **GET-only** for that reason: forwarding write verbs to endpoints the
gateway does not serve would mint a second, hollow write path, and the first person to find
it would reasonably assume it worked. *(WS-28g changes this deliberately and says why.)*

**WS-28b-write — the person write half.** ✅ **BUILT 2026-08-07.**
The tasks app's People view was removed the same day (owner-directed scope narrowing,
`task_manager_app.md` §6.0), and `PersonEditor` went with it. That was the only UI for
creating a person, editing their skills, and uploading a résumé. **The API was untouched** —
`POST /tasks/people`, `PATCH /tasks/people/{id}`, `POST /tasks/people/{id}/resume`, all on
`admin:members:manage` — but until this landed, an admin could not do any of it from the
product.
Shipped: `people/components/PersonEditor.tsx` (create + edit + résumé, themed through
`Button`/`Input`/`Icon`), `people/lib/form.ts` (the pure half) and `people/lib/write.ts`
(the write client). The controls are absent without `admin:members:manage`, driven by a
**`can_manage`** flag on the reads — the UI cannot hide-rather-than-disable unless the read
tells it, and discovering the answer from a 403 after the click is the behaviour §5.2
rejects.

**Restoring it turned up three ways migration 148 had already broken the write routes** —
see §12.

### Dispatchable

**WS-28c — org chart.** 🟢 AGENT-SAFE.
Done when: the tree renders from `manager_id`; unmanaged people surface as roots; a
re-parent that would create a cycle is refused before the request; the Center overlay shows
department/group mismatches rather than hiding them; and re-parenting is gated on the
**admin** write class (§4.3), not on the caller merely being signed in.

**WS-28d — capability search.** 🟢 AGENT-SAFE to build; the ranking prompt is
**EVAL-LOCKED**.
Done when: all three signals are queried; each result names which matched, shows load and
shows availability (§5.8); the surface never writes an assignment; and a caller without
`admin:members:read` cannot reach it at all — it is a skills query by definition, and the
oracle rule (§4.2) applies to a whole surface here rather than to a clause.

**WS-28e — the Projects seams.** 🟢 AGENT-SAFE.
Done when: the assignee picker is directory-backed and lists agents and directory-only
people; capacity is derived from open assigned tasks with an honest no-estimates state;
each row carries its availability warning (§6.1); and "Assign work" routes through the
ordinary task-create flow.

**WS-28f — seats & roles matrix.** 🔴 **OWNER-GATE** for the write half: group membership
writes are registered in `work_plan.md` §6 (d), and the "give this person a login" action
(§5.6) is an invite, gated by the same entry. Building the read matrix and the
propose-a-change path is agent-safe; applying a membership change is the owner's act.

**WS-28g — the person profile + self-service editing (P-3).** ✅ **BUILT 2026-08-13**
(migration `171_people_profile.sql`, `routes/people/{fields,profile}.py`,
`src/app/people/me/`, `components/ProfilePanels.tsx`, `lib/profile.ts`;
137 hermetic + 20 vitest cases, and **29 live checks against a real Postgres 16 with
the full ladder applied** — `tests/live/live_ws28g.py`).
Done when:
- Migration P-3 adds §3.1/§3.2/§3.4/§3.5's columns, all nullable, no rewrites, applied
  against a real Postgres (R8) and idempotent under a re-run.
- **One field-class authority in code** (`routes/people/fields.py`): every writable column
  is in exactly one class, and a **structural fence** asserts the map covers every writable
  column of `gtd_people` — so a column added later fails the test rather than defaulting
  into the permissive class (R7).
- `GET /people/me` resolves the self predicate and answers the three states of §5.3
  distinctly.
- Every person read carries `is_self` and `editable_fields`, and `editable_fields` is
  **empty** for a caller who may write nothing.
- `PATCH /people/{id}` enforces the classes: an admin may write any class; the subject may
  write the self class; a field outside the caller's classes is a **403 naming the field**
  (D-PC-5); a caller who is neither is a 403 with no field list.
- Self may read their own HR and private tiers without `admin:members:read` — and the
  three cross-row filters stay dropped regardless (§4.2).
- Self may upload their own CV, through the **existing** parse/merge/re-embed path.
- `/people/me` renders only `editable_fields`, shows the rest read-only, and carries the
  completeness meter.
- The `/api/people` proxy learns `PATCH`/`POST` **for the people routes only**, and the
  reason WS-28b kept it GET-only is recorded as satisfied rather than ignored: there is now
  a real write endpoint behind it.
- The new router is in `GATED_ROUTERS`.

**Five things the build decided, each of which is the reusable part:**

- **One write implementation, two doors.** `PATCH /people/{id}` authorizes with the field
  classes and then calls the tasks package's `update_person` **directly** — a route
  dependency is applied by FastAPI's router, not by Python, so the direct call is the body
  without the admin gate, which is exactly what the self door needs. What is *not*
  duplicated is the SQL: `build_person_update` was extracted from `update_person` and is now
  the only place a JSONB cast, an array bind or a date parse is decided. §13.1's lesson —
  a shape change has to be walked against every writer — is only worth anything if the
  writers are countable.
- **The write answers in the CALLER's shape.** `update_person` returns the admin projection
  because its own door is admin-only. Returned unchanged from the self door it would have
  handed a self-editor the full HR and private record of whoever they patched — the leak is
  in the *response*, not in the write, which is the half that is easy to miss.
- **`/people/me` has to be registered before `/people/{person_id}`**, because FastAPI
  matches in registration order and the literal `me` otherwise arrives at the person route
  and 500s casting to a UUID — on a route that looks perfectly registered in the OpenAPI
  schema. That forces `profile.py` to import *before* `directory.py`, which in turn forces
  their shared read seam (`person_payload`, `compute_load`) down into `core.py`: a module
  that imports from `directory` drags its routes in first and the ordering silently
  reverts. Fenced by a test on the router's own path list, plus a `# ruff: noqa: I001` on
  the package `__init__` — alphabetising those two imports is exactly what `ruff --fix`
  would do.
- **The create path was already dropping fields.** `create_person`'s INSERT was written in
  2026-07 and knows nothing of §3's columns, so a `POST` carrying `timezone` would have
  accepted it and stored nothing — the silent discard D-PC-5 refuses, arriving through the
  back door. It now runs the shared builder for the profile half in the same transaction,
  and the set is **derived** from the payload model rather than listed a second time.
- **The icon registry caught a UI defect the type-checker could not.** The Center entry was
  drafted with `UserCircle`, which has no Fluent or Material mapping — it would have
  rendered in Lucide's style next to correctly-themed neighbours, and nothing but
  `icon-registry.test.ts` would have said so.

⚠️ **`schema.generated.sql` is still NOT refreshed** — the same debt WS-28a recorded, now
one migration deeper. It needs a live database with the ladder applied
(`infra/postgres/README.md` step 3), and the ladder *does* apply cleanly end to end: this
build replayed all 170 numbered migrations plus 171 into a scratch Postgres 16 to run the
live harness, and 171 is idempotent under a re-run (every `ADD COLUMN` NOTICEs and skips).

**WS-28h — structured skills and credentials (P-4).** 🟢 AGENT-SAFE.
Done when: `gtd_person_skills` carries level, years, last-used and evidence; **every write
path rewrites `gtd_people.skills`/`skills_source` in the same transaction** and a test
proves the array equals the table after each one (D-PC-6); the résumé parser writes
structured rows and credentials instead of only merging words; and `_match_capability()` and
`fetch_people_for_clarify()` still pass unchanged — they read the array, and the array is
still true.

**WS-28j — workload & activity (§5.7).** 🟢 AGENT-SAFE.
Done when: per-person and per-team figures come from `pm_tasks`/`pm_task_assignees`/
`pm_activities`; every figure is scoped by the viewer's Projects grants and says so when
partial; agents appear beside people; and **no ranking, score or leaderboard is rendered**
(D-PC-14).

**WS-28k — availability & absences (P-5, §5.8).** 🟢 AGENT-SAFE.
Done when: absences are self- and admin-writable; the capacity bar, the picker and the
capability search all read them through one function; and there is **no approval step,
balance or accrual anywhere in the diff** — if the ticket grows one, it has become
`leave management` and needs §10's decision first.

**WS-28l — People dashboard (§5.9).** 🟢 AGENT-SAFE, after WS-28j and WS-28k.
Done when: every figure is a projection of an existing endpoint (no second arithmetic), and
`centers.ts`'s "People dashboard" entry flips to `live` in the same PR.

**WS-28m — skills coverage & data quality (§5.10).** 🟢 AGENT-SAFE.
Done when: the panel lists bus-factor-one skills, rows with `email_conflict` set, statuses
outside the vocabulary, managers pointing at alumni, and profiles missing the fields the
suggester uses — each with the action that fixes it.

**WS-28n — the AI seams (§6.5–§6.8).** 🟡 dispatchable after WS-28g and WS-28j; the
ranking half is EVAL-LOCKED and the sending half is an **OWNER-GATE** (§6.7).
Done when: the caller-bound tool applies the same projection functions the routes do (test
asserts function identity); the suggester returns ranked candidates with reasons and never
writes an assignment; follow-ups are drafted into the existing queue and **nothing in the
diff sends anything**.

---

## 10. Later phases, named so their absence is a decision

- **Onboarding** — checklists that provision accounts and first-week tasks. Would bind to
  `colleague_onboarding.md`'s runbook and create tasks in the Projects app, not a new store.
- **Leave management** — accrual, balances, entitlements, approval chains. Needs a policy
  model nothing in the platform has and an approval path that should reuse the Action
  Broker inbox. §5.8 builds the *availability* half deliberately without it.
- **Hiring pipeline** — structurally a second CRM (candidates as leads, stages as statuses).
  If wanted, it should reuse the `crm_*` shape rather than invent a third pipeline.
- **Performance, compensation, payroll** — out of scope, and each carries data-sensitivity
  questions (§3.5's tier is the *floor*, not the answer) that need deciding before any of it
  is designed. §3.6 and §5.7 record why performance data is refused on both the write and
  the read side rather than merely postponed.
- **A manager write tier** (§4.5) — needs `manager_id` to become an enforced grant first.

---

## 11. Verification

⚠️ Never `uv run pytest tests/unit/` bare — name the files.

```bash
uv run pytest tests/unit/test_people_directory.py tests/unit/test_people_write.py \
              tests/unit/test_people_key_shape.py tests/unit/test_people_profile.py \
              tests/unit/test_tasks_people_scoping.py \
              tests/unit/test_org_access_control.py tests/unit/test_org_access_enforcement.py \
              tests/unit/test_tenant_coverage.py
cd workbench/control_plane && npx tsc --noEmit && npm test && npx vitest run src/lib/theme/
```

Every file above exists **as of the ticket that adds it**: `test_people_profile.py` lands
with WS-28g. A verification command that cannot run is a verification command nobody runs
— pytest answers a missing path by collecting *nothing* and exiting non-zero — so a file
joins this block when its ticket lands, never when its ticket is written. (The pre-2026-08-09
version of this block named three files that did not exist, which is how that rule was
learned.)

`test_tasks_people_scoping.py` is in the list deliberately: WS-24 N4's 35 cases are the
fence around the HR projection, and any new read path over `gtd_people` must leave them
green rather than route around them. `src/lib/theme/` is in it because the theming engine's
conformance gate carries a frozen debt baseline that a new component can only make worse.

**SQL is verified against a real database (R8).** Each migration ticket adds a
`tests/live/live_ws28<x>.py` following `tests/live/README.md`: a real Postgres 16 with the
full ladder applied, driving the real endpoint functions. The hermetic suite cannot see a
`CHECK` that never fires, a partial unique index that case-folds differently from the route,
or a JSONB round-trip asyncpg has no codec for — and all three shapes are in this spec.

---

## 12. Decisions

Recorded once, cited thereafter. These are People-Center decisions (`D-PC-n`); platform
decisions live in `work_plan.md` §3 and are never re-litigated here.

| # | Decision | Why |
|---|---|---|
| **D-PC-1** | **"Self" is a row predicate — `lower(caller.email) = lower(person.email)` — not a permission grant | A new slug is nobody's grant until an admin creates it; and the predicate is the same join `has_login()` already runs, so the badge and the right cannot disagree. Safe only because 148 made `lower(email)` unique |
| **D-PC-2** | `email` is **admin-write only** | Self-editable identity is privilege escalation: point your row at a colleague's address and inherit their self-rights on the next request |
| **D-PC-3** | Three read tiers; the **private** tier keys on `admin:members:manage`, not `admin:members:read` | A manager seeing skills and capacity is the point of the HR tier; a manager seeing a colleague's emergency contact is not |
| **D-PC-4** | The server sends `editable_fields`; the client never carries its own copy of the field map | Two authorities drift, and the drift fails loud in the unsafe direction — a control drawn, saved, and 403'd after the click |
| **D-PC-5** | A field outside the caller's write classes is a **403 naming the field**, never a silent drop | A save that reports success and discards half the form is worse than a refusal |
| **D-PC-6** | Structured skills go in a child table; `gtd_people.skills[]` becomes a **maintained projection**, rewritten in the same transaction | Four live consumers read the array (GIN index, `_match_capability`, clarify, directory filters) and R6 forbids breaking running code. Fence: a route test comparing array to table after every write |
| **D-PC-7** | **Availability, not leave.** Absences are facts; no accrual, balances or approval chain | The assignment question needs "away next week". Everything else needs a policy model the platform does not have — and a half-built approval chain is worse than none |
| **D-PC-8** | `employment_type` is added **beside** `status`, not merged into it | 148's CHECK is live and R6 forbids a rename in place. Narrowing the vocabulary is the contract half, in a later release (P-6) |
| **D-PC-9** | `birthday` is `MM-DD`; **date of birth is not stored** | The team can say happy birthday without the product holding half an identity-theft pair. Age answers no question this spec asks |
| **D-PC-10** | A **server-side heuristic** may read the full roster; an **answer rendered to a human** carries only what that human may read | Extends the documented `fetch_people_for_clarify` exception rather than inventing a second rule. Fence: the caller-facing tool calls the same projection function the routes do, asserted by identity |
| **D-PC-11** | **No manager write tier** in v1 | `manager_id` is a directory fact, not an enforced grant, and D14 records that the `manager` role's "org-wide visibility" is a name. A permission that looks enforced and is not is worse than an absent one |
| **D-PC-12** | A **directory-only person has no self** | No login, no caller, nothing to match. Their record is admin-maintained — the contractor case working as designed |
| **D-PC-13** | The AI **suggests and never assigns**; it may write a proposal into the broker path a human releases | Auto-assigning work is a management decision the system is not entitled to make. Same rule as D-PM-10 |
| **D-PC-14** | The activity surface renders **workload signals, never a ranking** | Every figure here is trivially gamed and trivially misread. §3.6 refuses to store a performance rating; this is the same decision on the read side |

---

## 13. Build records

### 13.1 Migration 148 changed the table under the write routes (2026-08-07)

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

### 13.2 Board record (2026-08-09) — moved from work_plan.md §2

> Moved here in the 2026-08-09 consolidation (work_plan.md D18): board rows now
> carry state + gates only. The narrative below is preserved verbatim from the
> final long-form row; the dated corrections after it win where they conflict.

#### WS-28 — **People Center — directory, org chart, and the assignment seam** *(minted 2026-08-06)*
**State cell (as of the move):** ✅ **a + b BUILT 2026-08-06 · b-write BUILT 2026-08-07** · 🟢 c–e dispatchable · 🔴 f owner-gate
**Narrative (verbatim):** Scope owner-set 2026-08-06: **directory, skills, org chart, capacity, seats/roles — exactly what assignment and planning need**; leave/onboarding/hiring are named as later phases so their absence is a decision. **The fact this spec exists to settle:** there are TWO people stores and that is deliberate — `app_user` answers *can they sign in and what may they see*, `gtd_people` answers *who are they and what can they do*, and the directory must include people with **no login** (contractors), which is why the Projects app's assignee is a plain string. They join on lowercased email, and **P-1 fixes that join before it is relied on**: migration 49 made `name` UNIQUE and left `email` unconstrained, so today two rows may share an address and an email→person join is ambiguous. Surfaces: directory (honouring WS-24 N4's HR projection, with a *restricted* empty state distinct from *none*) · person page · org chart from `manager_id` with a Center overlay that **shows** department/group mismatches rather than smoothing them · capability search over stated skills → résumé evidence → the existing `capability_embedding`, which **suggests and never assigns** · seats & roles matrix (read + propose; applying a membership change stays owner-gated per §6 (d)). Closes WS-13's outstanding *People directory read view* item. Tickets **a** key-shape fix (🟢) · **b** directory + person page (🟢) · **c** org chart (🟢) · **d** capability search (🟢, ranking EVAL-LOCKED) · **e** the Projects seams — directory-backed assignee picker listing agents and directory-only people, capacity derived from open assigned tasks (🟢) · **f** seats & roles writes (🔴 OWNER-GATE).. **a BUILT 2026-08-06** (mig `148_people_key_shape.sql` + `scripts/import_hr_people.py`; 22 cases, 11 mutants red, 1 equivalent): `UNIQUE(name)` dropped, partial unique on `lower(email)`, status CHECK. **P-1 did not name its own consequence** — the HR importer upserts `ON CONFLICT (name)` and would have failed outright, so a `source_key` (`<source>:<lower(name)>`) carries the upsert instead, backfilled BEFORE the constraint is dropped while `name` is still distinct. **Neither new constraint may block a deploy** (main was bitten twice this month): a duplicate address is quarantined into a new `email_conflict` column with a deterministic winner rather than failing `CREATE UNIQUE INDEX`, and the status CHECK is added `NOT VALID` then validated in a guarded block, so an unanticipated legacy value leaves a NOTICE instead of stopping the deploy. ⚠️ `schema.generated.sql` NOT refreshed — needs a live DB; regenerate on the first deploy that applies 148. **b BUILT 2026-08-06** (mig `149_people.sql`, `routes/people/`, `src/app/people/`; 32 hermetic + 28 vitest cases, 11 mutants red): `/people` directory, person page with all four panels, and the People Center's "Directory & org chart" sub-app flipped live — closing WS-13's outstanding read view. **Its own feature slug**, not `feature:tasks`: a manager who needs the org chart should not be handed the personal GTD task manager to get it. The gate is new but the HR **projection is imported** from `tasks.core` and a test asserts the function's *identity*, since two answers to "may this caller see skills" are two answers waiting to drift. Three filters (the `q` skills clause, `skill`, `has_capacity`) are dropped without `admin:members:read` so search cannot become an oracle for the hidden field — and the response carries `hr_visible` so the UI says "restricted" rather than leaving a blank strip to read as "nobody filled it in". Load is **computed from open assigned tasks** and carries `unestimated`, because a bar built from the estimate sum alone shows somebody holding thirty un-estimated tasks as completely free. The work panel is scoped by the **viewer's** grants and answers `available:false` without `feature:projects`. **Registration is FIVE places, not four** — the fifth is `test_org_access_enforcement.GATED_ROUTERS`, hand-maintained, where an absent router is unchecked rather than passing; also added the named `test_projects_is_registered_on_both_sides` that WS-27a never wrote. **b-write BUILT 2026-08-07** (`people/components/PersonEditor.tsx`, `people/lib/form.ts`, `people/lib/write.ts`; 26 hermetic + 23 vitest cases, 7 mutants red): closes the regression the 2026-08-06 scope narrowing opened — deleting the tasks app's People view took `PersonEditor` with it, and with it the only UI for creating a person, editing skills and uploading a résumé. The GET-only `/api/people` proxy is **unchanged**: the writes go to `/api/tasks/people`, where they have always lived. Controls are absent rather than disabled, driven by a new **`can_manage`** flag on the reads — hide-rather-than-disable is impossible unless the read tells the UI, and the alternative is drawing the button and letting the click find a 403. **Restoring it turned up three ways migration 148 had already broken the write routes**, each a 500 in front of an admin rather than a test failure: the status vocabulary moved (49's `inactive`/`on_leave` vs 148's CHECK) and is now ONE tuple shared by filter, facets, select and validation; `create_person` still refused a duplicate NAME, preserving precisely the behaviour 148 dropped `UNIQUE(name)` to remove; and nothing checked the address 148 made unique, so a duplicate was an `IntegrityError` instead of a 409 naming the other row. **The lesson recorded in spec §10:** a migration that changes a table's shape has to be walked against every route that WRITES it — the read routes were built after 148 and were correct by construction, the write routes predated it and were never revisited

**Corrections applied 2026-08-09:** schema.generated.sql regeneration is DUE — stale since ~migration 113, and migration 148 reached prod ~2026-08-07 after the #384 cast fix.

**Scope widened 2026-08-13** (owner directive, quoted in the header): the person record
itself (§3), self-service editing (§4), the remaining sub-apps (§5) and the AI contract
(§6.5–§6.8) join the row as tickets **g–n**. The §7 references in the verbatim narrative
above are to the pre-rewrite section numbering; §9 and §13.1 are their current homes.
