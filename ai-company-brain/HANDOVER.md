# Handover — branch `claude/paca-research-task-management-a1f6zd`

> **Written 2026-08-08 for a coding agent with database access.** Everything here was built in
> a sandbox with a *scratch* Postgres and **no access to production, no deploy, and no ability
> to apply a migration to the real box**. That is the gap you are picking up.
>
> Read §1 and §2 before touching anything. §3 is the ticket queue. §4 is what only the owner
> may decide. §5 is the accumulated list of traps — it is the most valuable part of this
> document and it will save you a day each time you read it.

---

## 1. Where the branch is

**16 commits ahead of `main`, tree clean, everything pushed.** Open PR **#399**.

| Verified on this branch | |
|---|---|
| Backend tests | **2151 passed**, 11 skipped |
| Frontend tests | **1106 passed** (green in 4 timezones) |
| `tsc --noEmit` | clean |
| `ruff` / `xenon` | clean on all changed files |
| Theme conformance | green |

Two workstreams landed:

**WS-27 (Projects) — the ClickUp parity backlog in `specs/project_management_app.md` §11.2 is
CLOSED.** Tickets a, b, d, e, f, i–t are built. The app has hierarchy, statuses-as-data,
custom fields, tags, bulk edit, recurrence, dependencies, attachments, notifications, filters
and saved views, a personal lens, a board, a list, a calendar, a Gantt timeline with drawable
dependencies, and a ⌘K search palette.

**WS-29 (multi-tenancy) — started, and deliberately not finished.** See §3.

### ⚠️ 1.1 The first thing to do, before any ticket

**Two migrations exist on this branch and are on no real database:**

- `infra/postgres/158_projects_tenancy.sql` — `organization_id NOT NULL` on all 17 `pm_*`
  tables, plus a parent-consistency trigger.
- `infra/postgres/159_app_user_email_case.sql` — `UNIQUE (lower(email))` on `app_user`.

Both are idempotent and both were applied twice against a live Postgres 16 here. **But this
sandbox's database is not yours**, and `schema_migrations` (migration 153) is the ledger —
check it before assuming anything about what the box has:

```sql
SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 15;
```

⚠️ **Migration 158 backfills to the organization with `slug='default'` and fails loudly if it
is absent.** That is deliberate — guessing a tenant is worse than stopping. If your database
has no such row, migration 130 seeds it.

⚠️ **`schema.generated.sql` is stale** — it predates migration 146 and knows about none of the
`pm_*` tables. Do not read it as truth; read the migrations, or the live database. Regenerating
it needs a database with every extension available (this sandbox lacked `vector`, so a dump
from here would have been *worse* than the stale file).

### 1.2 The deploy path is broken and that is not fixed

`specs/deploy_delivery_path.md` — WS-25. GitHub's packets do not reach the VPS; deploys
alternate 4-minute successes with 54-minute timeouts. **Merging does not ship.** D1 (extracting
and shellcheck-cleaning the deploy script) is done; the delivery mechanism itself is owner-gated
and untouched. Assume nothing you merge reaches the box until somebody switches it.

---

## 2. House rules — non-negotiable

These are not style preferences. Each one exists because it caught a real defect in this
codebase, most of them during this branch's work.

### 2.1 The verification protocol

1. **Hermetic tests first.** Route functions called directly, `_get_db` monkeypatched onto each
   SUT submodule, against the shared fake. Never a `TestClient`.
2. ⚠️ **Never run `uv run pytest tests/unit/` bare** — whole-directory collection hangs against
   a live DB. **Name the files**, or use `-k`.
3. **Mutation testing on every guard you add.** Mutate it, prove the suite goes red, revert
   **byte-identically** (`diff -q`). A mutant that survives means the test asserts nothing —
   *strengthen the test, do not accept the pass.* On this branch three mutants survived their
   first pass and every one of them exposed a test that was checking nothing.
4. **A live Postgres run, always.** Start:
   ```
   su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D <datadir> -o '-k /var/tmp -p 55432' start"
   ```
   DSN: `postgresql+asyncpg://postgres@/cc?host=/var/tmp&port=55432`.
   Drive the **real endpoint functions**, not a mock. **Twelve working harnesses are in
   [`tests/live/`](../tests/live/)** with a README explaining what each one pins — read that
   table before writing a new one, because it is a list of the things a fake structurally
   cannot catch. ⚠️ Most of them `TRUNCATE pm_projects CASCADE`; point them at a throwaway
   database, never production.

   **This found a bug in every single ticket on this branch — including several where the
   entire hermetic suite was green.** It is not optional and it is not a formality.
5. **Gates:** `uv run ruff check <files>` and
   `uv run xenon --max-absolute F --max-modules F --max-average B <package>`.
   Frontend: `npx tsc --noEmit`, `npx vitest run`, and **`npx vitest run src/lib/theme/`**
   before pushing.

### 2.2 The fake is a MIRROR, and a mirror can only agree with itself

`tests/unit/_projects_fakes.py`. It reads the *statement text* to decide which rows a clause
addresses. **Every clause must be mirrored only when the statement carries it.** A fake that
re-implements a predicate in Python and applies it unconditionally passes against a route that
dropped the clause entirely — which is the whole defect class the file exists to prevent.

Two corollaries learned the hard way on this branch:

- **Fingerprints must be specific, not merely present.** `"AS blocker"` also matches
  `AS blockers`. Dispatching on a substring that appears in a *different* statement silently
  routes the wrong query.
- **Read the SQL's own column choices; never assume them.** A mirror that hard-coded which end
  of a `blocks` link was the blocker let a mutant swap the SQL's two aliases — every arrow
  drawn backwards — with the whole suite green.

### 2.3 Documented rules that bite

- **R1** — resolve the next free migration number **at build time** (`ls infra/postgres/`),
  never from a spec.
- **R3** — identity from the authenticated context only, never a request parameter.
- **R5** — **404, never 403.** "Not yours" and "no such thing" must be indistinguishable.
- **R10** — case-insensitive email on both sides.
- `DESIGN_SYSTEM.md` is a contract: never write a colour, never
  `import … from "lucide-react"` (use `<Icon name="…" />`), never hand-roll a control.

---

## 3. The ticket queue

Dependency order. Everything here is agent-safe to **build**; the owner gates in §4 are about
*executing* against production.

### WS-29c — enforce the boundary (blocked on D-MT-2)

The column and the application predicate exist for `pm_*`. What enforces isolation for
everything else is **D-MT-2, still open** (§4). The recommendation on record is Postgres RLS,
because it is the only option where the *absence* of code is safe rather than a leak — and
given 123 unscoped tables, absence of code is the failure mode this system actually has.

**Do not start until D-MT-2 is answered.** Building the wrong enforcement is a rewrite.

### WS-29d — the remaining 123 tables

`tests/unit/test_tenancy_boundary.py` holds the frozen list and fails any **new** unscoped
table. Work by family; the migration pattern is `158_projects_tenancy.sql` and it is worth
copying wholesale, including the trigger.

⚠️ **Before `crm_*`: the column name is already taken.** `crm_activities`, `crm_contacts` and
`crm_deals` have an `organization_id` that references **`crm_organizations`** — a customer
company. Scoping the CRM needs a rename or a different name. That is a decision, make it
explicitly.

⚠️ **Before `gtd_*`: those tables are scheduled for retirement** (WS-27h, D-PM-6). Adding a
tenant key to a table you are about to delete is wasted work — do WS-27h first or skip the
family knowingly.

**Split the baseline while you are here.** The audit's §5 proposes three sets and the argument
is right: `NEVER_SCOPED` (`organization`, `schema_migrations`, `feature_catalog`),
`DEPLOYMENT_GLOBAL` (each needing a named decision), `NOT_YET_SCOPED` (the rest). "Deliberately
global" is a decision, and hiding it among "not done yet" is how it gets made by accident.

### The leak backlog — `specs/multi_tenancy_leak_audit.md`

14 findings with `file:line` citations, ranked by blast radius. **S1-1 and S1-4 are FIXED** on
this branch. The rest are open:

| | Finding | Note |
|---|---|---|
| **S1-2** | One set of LLM and integration credentials for the whole deployment | Needs a decision — see §4 |
| **S1-3** | Global event bus: tenant A's event fires tenant B's workflow, which may write tenant A's task | Needs the workflow tables keyed first |
| S2-5 | `org` means "everybody in the deployment" in rooms and session authority | |
| S2-6 | An org-visible Custom App is visible to every tenant, and carries its data | |
| S2-7 | The Action Broker queue is global, and approving executes | |
| S2-9 | Shared agents have one workspace and one blob partition | The instance vocabulary has `u:`/`t:` but no `o:` |
| S3-10 | Global tool/plugin registries reach every tenant's agents | |
| S3-11 | Public webhook receivers authenticate a *deployment*, not a tenant | |
| S3-12 | Jobs that run with no `X-User-Email`, and therefore no tenant | |
| S3-13 | Enumeration surfaces without a tenant | |
| S3-14 | One sign-in domain for the deployment | |

The audit's **§3 (SAFE, with reasons)** is as valuable as the findings — it stops you
re-checking closed paths. Notably: **there is no object storage at all**; attachments are local
disk, `uuid4`-named, never served by path.

The audit's **§4 (could not determine)** is honest ground nobody has covered: ingestion consumer
drain semantics, Mem0/graphiti partitioning, `custom_api_definitions`, the meeting-bot chain,
and the frontend.

### WS-27h — retire `gtd_items`

Sequenced after WS-27e (built). D-PM-6 makes `pm_tasks` the one task store; `gtd_items` is a
lens over it now, not a copy. This is a destructive data move — treat it accordingly, and note
it interacts with WS-29d as above.

### WS-27g — cutover and ClickUp retirement

🔴 Owner-gate end to end. See §4.

---

## 4. Owner decisions and gates — an agent must refuse these

Registered in `work_plan.md` §6. Do not execute; propose and stop.

**Open decisions:**

- **D-MT-2 — where is isolation enforced?** RLS / application predicate / schema-per-tenant.
  Options costed in `specs/multi_tenancy.md` §3. **Blocks WS-29c.**
- **D-MT-3 — `organization_id` on the row, or through a parent?** Agent-proposed: on the row.
  Already implemented that way for `pm_*`.
- **S1-2 — do LLM and integration credentials go per tenant?** `provider_keys.provider` is the
  primary key, so today one deployment has one set. This is a security *and* a billing
  question, not a config nicety.
- **The sign-in queue is genuinely shared.** `access_request` has no tenant column and cannot
  straightforwardly have one — an address knocking at the door has no organization yet.
  Admin B can see and **deny** admin A's pending knock: a cross-tenant DoS on onboarding.
  Approve is now fenced; deny cannot be without a routing rule (domain? invite token?).

**Execution gates:**

- Running either ClickUp import endpoint against production, and confirming a Space→Center
  mapping (D-PM-10). ⚠️ **The multi-tenant block on this is now LIFTED** — migration 158
  keyed the `pm_*` tables, which was the reason to wait.
- Enabling the WS-27c outbound push (needs BO-1a + BO-1b).
- The WS-27g cutover and ClickUp token revocation.
- Granting `feature:projects` or `data:org:read` to any real member on the live box.
- Flipping `ACTION_BROKER_ENFORCE`, `INGESTION_CONSUMER`, `CRM_ZOHO_SYNC`. ⚠️ The last two
  **write unscoped rows unattended** — the same hazard as the ClickUp import, without a button.

---

## 5. Traps — every one of these cost real time

**asyncpg**

- It infers a bound parameter's type from a surrounding `CAST(...)` and then **refuses to encode
  a mismatched Python type**. Binding a `str` to `CAST(:x AS timestamptz)` fails before the
  query reaches the database. Parse to a `datetime` on the Python side.
- A bare `:param IS NOT NULL` with no column to infer from raises
  `AmbiguousParameterError: could not determine data type of parameter $1`. **Cast it
  explicitly.** A Python fake has no type system, so every hermetic test passes.
- No codec for a bare `dict` — JSONB must be serialised and cast.

**SQL**

- `array_length('{}', 1)` is `NULL`, and a `CHECK` only fails on `FALSE`. A constraint written
  this way passes the row it exists to reject. Use `coalesce(…, 0)`.
- Implicit-comma `FROM` plus a `LEFT JOIN` leaves the earlier table out of scope for the join's
  `ON` clause.
- `array_agg(DISTINCT …)` sorts by its own expression — it will silently alphabetise a list you
  meant to keep in order.
- A `CHECK` **cannot read another table**; Postgres refuses the subquery. Cross-table invariants
  need a trigger.
- `UNIQUE (email)` is **byte-exact**. If your code matches `lower(email)`, the two disagree and
  one human becomes two rows. (Migration 159.)

**LIKE / search**

- `_` and `%` are metacharacters. Unescaped, searching `task_id` also matches `taskXid`. Escape
  the backslash **first**, or you double the escapes you just introduced.

**Dates and timezones**

- `new Date("2026-08-07")` is **midnight UTC** — the 6th anywhere west of Greenwich. Work in
  `YYYY-MM-DD` keys for anything that means a *day*.
- Millisecond arithmetic across a DST transition is 23 or 25 hours; an unrounded division lands
  a fraction of a day off **permanently**. Round.
- ⚠️ Both of the above are only *behaviourally* testable in some timezones. CI runs one. **Pin
  them structurally as well**, or the mutation that reintroduces them survives forever.

**Shell / deploy**

- `git reset --hard` **renames**, so a running script keeps its old inode: all its steps run,
  from the *old* version, against the *new* tree, and it **exits 0**. Two of the three
  self-rewrite failure modes are silent.

**Testing**

- A structural test that greps its own module's source will trip on **prose explaining the
  rule it enforces**. Strip comments first. (This bit twice on this branch.)
- Running two mutation harnesses in parallel makes verification unreliable — one agent's
  temporary mutation shows up as another's failure. If you fan out, use worktree isolation.

---

## 6. Where to read next

| Document | What it owns |
|---|---|
| `work_plan.md` | Every workstream, its status, and §6's owner-gate registry |
| `specs/multi_tenancy.md` | The measured tenant state, D-MT-1/2/3, the sequence |
| `specs/multi_tenancy_leak_audit.md` | 14 leak findings, the SAFE list, the unknowns |
| `specs/project_management_app.md` | WS-27 end to end; §11 is the parity story per ticket |
| `specs/deploy_delivery_path.md` | Why merging does not ship, and D1's measured evidence |
| `specs/paca_pm_research_2026-08.md` | The Paca patterns adopted, and the ones refused |

**Corrections already made in these documents are marked ⚠️ and kept rather than erased** —
including two of mine that were wrong in writing (the tenant-scoped table count, and a claim
that one-person-one-organization held structurally when it did not). If you find another, mark
it the same way. A document that quietly edits its mistakes teaches nobody where the traps are.
