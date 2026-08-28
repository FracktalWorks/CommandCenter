# HANDOFF — what the last session left unfinished

**This file is a QUEUE OF ACTIONS, not a status board.** It is injected into
every session by `.claude/hooks/session-handoff.mjs` (D39) so nobody has to
remember what was in flight.

---

## The one rule that keeps this file honest

> ⚠️ **Never restate state here. Point at it, and carry the command that
> re-derives it.**

`work_plan.md` §2 is **the only current-state authority** (CLAUDE.md §1). A
handoff file that also described state would be a second board, and a second
board is the CLAUDE.md §5 defect by construction: two descriptions of one truth,
one of which stops being updated first, and the stale one is trusted because it
is the one loaded into the prompt.

So every entry below carries a **Check** — a command whose output tells you
whether the entry is still real. You do not trust this file. You run the Check.

That inverts the usual failure. A stale entry here costs one command and gets
deleted; it can never *quietly* be believed, because believing it requires
running something that would have contradicted it.

## The protocol

**At the start of a session** — before any other work, and before picking up
whatever you were asked to do:

1. Run the **Check** for every entry.
2. **Delete every entry whose Check shows it is done.** In your first commit.
   Deleting a finished entry is not optional housekeeping — an entry that
   outlives its work is how this file starts lying.
3. Report what is left to the user in one short list, then proceed.

**During a session** — add an entry the moment you create the obligation, not at
the end when context is short. The entry you write while you still remember why
is worth five you reconstruct.

**Before ending a session** — add an entry for anything you are handing over:
work you started, an owner gate you hit, a finding you scoped out, a decision
you are owed. If you are not sure it matters, add it. A one-line entry costs
nothing; the thing nobody wrote down costs a session.

**`/handoff`** does all of this — see `.claude/commands/handoff.md`.

## The shape of an entry

```
### H-<n> · <one line, imperative> · [AGENT|OWNER]
- **Check:** `<command>` → <what output means STILL PENDING>
- **Why:** <one or two sentences — the reason, not the status>
- **Authority:** <file §section, or board row>
- **Added:** <date> · <session or PR that created it>
```

`[OWNER]` marks an entry an agent **must refuse by name** (`work_plan.md` §6).
An agent may verify an OWNER entry's Check and report it; it may never do it.

Ids are never reused. Delete the whole block — do not tick it off in place, or
this file grows a graveyard and the graveyard is what goes stale.

---

# OPEN

### H-11 · 🔴 The CommandCenter VPS is serving METORITE — take the box back · [OWNER]
- **Check:** `curl -s https://commandcenter.fracktal.in/signin | grep -o '<title>[^<]*</title>'`
  → `Metorite Control Plane` means still pending; `CommandCenter Control Plane`
  means closed. Once the box runs a build carrying the identity endpoint, the
  stronger form is `curl -s https://api.commandcenter.fracktal.in/health` → its
  `sha` must satisfy `git cat-file -e <sha>` **in this repo**.
  ⚠️ **The original Check named `/version` and could never have closed.**
  CommandCenter has no `/version` route at all — `tasks_lens`, a field in the
  response the box returns, appears nowhere in this repository. `/version` is a
  *Metorite* endpoint, so "the sha does not resolve" was going to stay true
  after a perfect recovery, when the route would simply 404.
- **Why:** 🔴 **CommandCenter is not down — it was replaced in place.**
  `commandcenter.fracktal.in` and `api.commandcenter.fracktal.in` both resolve
  to **187.127.179.143** (Hostinger `srv1747539`, the original CommandCenter
  box), and that box serves Metorite under the title *Metorite Control Plane*.
  The owner's symptom — "none of the apps are there, I can't reach my email" —
  is not a grant, feature-catalog or RLS failure. It is a **different product**
  answering on the CommandCenter hostname.
  **Re-measured 2026-08-27 — three things changed since this entry was written:**
  1. ✅ **The bleed has stopped.** Metorite now deploys to its own box,
     **187.127.172.200** (`srv1914284`): `api.metorite.com` serves today's
     Metorite HEAD, and all eight of Metorite's deploys on 2026-08-27 landed
     there. `.143` has been **frozen since 2026-08-26T08:05Z** on Metorite
     commit `d9fe3932` (their PR #112). Repointing it is no longer a race
     against a 5-minute timer — but confirm the pull unit on the box before
     relying on that.
  2. 🔴 **A new risk that did not exist when this was written: deploying
     CommandCenter right now could take out Metorite's *live* box.**
     CommandCenter's `HOSTINGER_HOST` secret was **updated 2026-08-25T14:22Z**
     — after two CommandCenter deploys failed/cancelled that afternoon, and
     after Metorite's own `HOSTINGER_*` secrets were created earlier the same
     day. Secret *values* are not readable, so **which box CommandCenter now
     deploys to is unknown**. If it was repointed at `.200`, re-running the
     CommandCenter deploy clobbers Metorite's production box — the same
     accident, in the other direction. **Read that value before any deploy.**
  3. ⚠️ **The R1 collision has grown.** CommandCenter's ladder ends at **176**;
     Metorite's now ends at **192** (was 188). Metorite ran against
     CommandCenter's own Postgres — both repos declare the identical compose
     project `acb`, container `acb-postgres` and database `acb` — so `.143`'s
     `schema_migrations` plausibly records **177–192**. CommandCenter's next
     migration would be 177, which is taken. Decide this before the next
     CommandCenter migration is written, not at merge time.
  ⚠️ **On data loss — expected zero, one new file worth naming.** Metorite's
  `190_gtd_retirement_drop.sql` (merged 2026-08-25T19:14Z, i.e. *inside* the
  window when `.143` was deploying Metorite) does `DROP TABLE gtd_items` and
  `gtd_waiting` — the tasks tables. It is **triple-guarded and fails safe**:
  it returns early if the arming table is absent, returns early if
  `gtd_retirement_arm` is empty (*"NOT ARMED — the drop is a deliberate act,
  not a consequence of deploying"*), and RAISES rather than dropping if armed
  with unmigrated rows. A deploy alone cannot fire it. So the tasks data is
  expected intact — but that is read from the migration text, **not verified
  against the box**, which is step 4 below.
- **What to do (all of it OWNER — §6 covers VPS reach, deploy, cutover):**
  1. **First, and before anything else: read `HOSTINGER_HOST` in BOTH repos.**
     CommandCenter's must be `187.127.179.143` and Metorite's must be
     `187.127.172.200`. Fix whichever is wrong. Deploying while
     CommandCenter's points at `.200` is the one action here that would cause
     a *second* outage rather than fixing the first.
  2. On `.143`, check how it came to track Metorite — `git -C /opt/acb/app
     remote -v` and the pull unit (`systemctl cat 'acb-*pull*'`). Metorite's
     `d9fe3932` is literally *"the pull timer — the half that was never
     shipped"*, so assume a timer exists and points at `Hathi-Labs/Metorite`.
     Stop/disable it BEFORE repointing, or a tick undoes the repair.
  3. Snapshot the `acb` Postgres volume before touching the ladder. **We cannot
     roll back (R6)** and `BACKUP_REMOTE` is still unset, so today's backups
     live only on that box.
  4. Record the evidence, in this order — it is the input to the R1 decision
     and the answer on data loss:
     `SELECT filename FROM schema_migrations ORDER BY filename;`
     `SELECT to_regclass('public.gtd_items');`  (non-null = tasks tables intact)
     `SELECT count(*) FROM gtd_retirement_arm;` (0 = the drop was never armed)
  5. Repoint the checkout to `FracktalWorks/CommandCenter` and re-run the
     deploy. **Confirm by evidence, never by a green job** (CLAUDE.md §3.8):
     the workbench title reads `CommandCenter Control Plane`, and
     `/health`'s `sha` resolves in this repo.
- **Authority:** `work_plan.md` §6 (VPS/deploy reach, cutover) · CLAUDE.md §3.8
  (verify by evidence) · R1 · R6 · `project-docs/metorite_migration.md`
- **Added:** 2026-08-26 · session that diagnosed the owner-reported outage
  · re-measured and Check repaired 2026-08-27

### H-1 · Deploy: `main` is many migrations ahead of every box · [OWNER]
- **Check:** compare `ls infra/postgres/[0-9]*.sql | sort -V | tail -1` against
  `SELECT max(filename) FROM schema_migrations;` on a box. A gap means still
  pending. ⚠️ From a clean checkout with no box access an agent can only get the
  first half — report the gap as unverified rather than closing this.
  ⚠️ The `[0-9]*` glob and `sort -V` are both load-bearing: a bare `*.sql | tail
  -1` answers `schema.generated.sql`, which sorts after every numbered migration
  and is not one. That is what the first draft of this Check did.
- **Why:** #437 merged 2026-08-13 and was never deployed; everything since has
  stacked behind it, and the pile grows every day. **We cannot roll back** (R6),
  so the longer the gap the more lands at once. Deploy applies migrations before
  restarting services, so the ORDER is safe — the risk is volume.
  ⚠️ Deliberately does not name a migration range: a range here would be state,
  which this file must never restate. It was written as "171–175" for one hour
  and 176 landed inside it.
- **Authority:** `work_plan.md` §2 WS-27 row · §6 (deploy is owner-gated)
- **Added:** 2026-08-14

### H-2 · Count archived projects on prod BEFORE migration 171 applies · [OWNER]
- **Check:** `SELECT count(*) FROM pm_projects WHERE status = 'archived';` on
  prod. If 171 has already applied, this number is no longer recoverable this
  way and the query becomes `WHERE archived_root_id = id` — which answers a
  *different* question. Unanswered → still pending.
- **Why:** ⚠️ **Time-sensitive and ordered against H-1.** 171 changes what
  "archived" means; the pre-migration count is the only baseline that can tell
  us whether the lifecycle sweep behaved. Not a deploy blocker — if H-1 happens
  first, record that this number was lost rather than substituting the other one.
- **Authority:** `work_plan.md` §2 WS-27 row
- **Added:** 2026-08-14 · session that built WS-27bj

### H-3 · 🔴 Rotate the production root SSH password — disclosed TWICE · [OWNER]
- **Check:** can the old password still authenticate? If nobody has rotated it,
  it can. Treat as pending until rotation is confirmed. A second Check that
  needs no secret: `ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no
  root@187.127.179.143` → a password PROMPT (rather than `Permission denied
  (publickey)`) means password auth is still enabled and this is still open.
- **Why:** 🔴 Root credentials for the production VPS have now been pasted into
  an agent transcript **twice** — 2026-08-14 and again **2026-08-28**, the
  second time for `root@187.127.179.143` while trying to unblock the H-11
  recovery. Both times they were **refused and never used**
  (`work_plan.md` §6). That refusal protects the box; it does **not** un-disclose
  the secret. A password in a transcript is a leaked password, and this one now
  sits in two.
  ⚠️ **The recurrence is the finding.** It happened the second time for the
  same reason as the first: an owner-gated repair felt urgent, and handing over
  the password looked like the fastest way through. It will keep happening
  while root-password auth remains possible, so the durable fix is not "be more
  careful" — it is **key-only auth**, which makes the paste useless and
  therefore pointless.
- **What to do:**
  1. `passwd root` on the box — new password, stored in a password manager,
     never typed into a chat.
  2. Set `PermitRootLogin prohibit-password` and `PasswordAuthentication no` in
     `/etc/ssh/sshd_config`, then `systemctl restart sshd`. ⚠️ Confirm the
     deploy key in `HOSTINGER_SSH_KEY` still authenticates **in a second
     terminal before closing the first**, or this locks everyone out.
  3. Rotating the password does **not** rotate `HOSTINGER_SSH_KEY`; that key is
     unchanged since 2026-06-10 and is a separate decision.
- **Authority:** `work_plan.md` §6 · `specs/engineering_practice.md` (security)
- **Added:** 2026-08-14 · carried from the session that refused them
  · second disclosure recorded 2026-08-28

### H-4 · WS-27bj: build the admin surface for org-wide vocabularies · [AGENT]
- **Check:** `rg -n "refuse_org_wide_write" apps/services/gateway/gateway/routes/projects/`
  → still present on the patch/delete/merge paths means still pending.
- **Why:** An org-wide tag, task type or custom field can currently be
  **created but never edited or retired** — `refuse_org_wide_write` answers 409
  rather than letting those routes 500 on `CAST('None' AS uuid)`. That is the
  conservative half of ship-dark and it is real debt: the affordance to fix a
  typo in an org-wide row does not exist.
- **Authority:** `specs/project_management_app.md` §9.11 ("Not in scope" —
  the seam lands first) and §9.11.1
- **Added:** 2026-08-14 · session that built WS-27bj

### H-5 · Flip `PROJECTS_ORG_VOCABULARIES` when org-wide creates should go live · [OWNER]
- **Check:** the variable's value on the box → unset or `0`/`off`/`false` means
  still dark.
- **Why:** Default OFF and it gates **only** the affordance that *creates* an
  org-wide row, never the read union — which is already on and inert until a row
  exists. Flipping it is a restart, not a release. Requires H-1 first.
- **Authority:** `specs/project_management_app.md` §9.11 · `work_plan.md` §6
- **Added:** 2026-08-14 · session that built WS-27bj

### H-6 · `TagRow` is declared twice on the frontend · [AGENT]
- **Check:** `rg -n "interface TagRow" workbench/control_plane/src/app/projects/lib/`
  → two hits means still pending.
- **Why:** `lib/tags.ts` and `lib/api.ts` each declare it, and `page.tsx` passes
  rows between them, so they are assignable only while they agree. Widening one
  for org-wide vocabularies is what surfaced it; both were widened to keep the
  build green. Collapsing two public wire types is its own change (CLAUDE.md §5).
- **Authority:** `specs/project_management_app.md` §9.11.1 ("findings for the board")
- **Added:** 2026-08-14 · session that built WS-27bj

### H-7 · `now()` can move backwards, and migration 168's keyset cursor assumes it cannot · [AGENT]
- **Check:** `rg -n "updated_at, id" infra/postgres/168*.sql` → the delta feed's
  cursor still ordering on `(updated_at, id)` with no monotonic guarantee means
  still pending. Needs its own board row and a decision before anyone builds.
- **Why:** `now()` is the **transaction-start** timestamp, so a transaction that
  opens early and commits late stamps a time earlier than a row already written
  by a newer, faster-committing transaction — reproduced on a real database, 201
  ms backwards. Harmless to the `If-Match` precondition (an exact comparison
  still differs). **A real gap in the delta feed**: a client whose cursor has
  passed the newer value never receives the row stamped behind it, and that
  change leaves the stream silently.
- **Authority:** `specs/project_management_app.md` §9.10.2 · already-merged code,
  so CLAUDE.md §5 says record it, do not refactor it
- **Added:** 2026-08-14 · PR #439

### H-8 · Still owed on WS-27bg slice 2, and WS-27bg slice 3 / WS-27bh unbuilt · [AGENT]
- **Check:** the WS-27 row in `work_plan.md` §2 — it names what is built. Read
  it rather than this entry; this entry only says *look there*.
- **Why:** A project still cannot be **renamed**; the bulk-close-on-Stop offer
  and the Delete affordance are unbuilt. Slice 3 (overdue suppression across four
  predicates) and WS-27bh (task-type chip, derived urgency + the "Urgent" →
  "Critical" relabel, recurring indicator, source badge) are queued behind them.
  ⚠️ WS-27bh's source badge must **promote** `/tasks`' existing `SourceBadge`,
  not author a fourth copy.
- **Authority:** `work_plan.md` §2 WS-27 row · `specs/project_management_app.md`
  §9.9
- **Added:** 2026-08-14 · session that built WS-27bj

### H-9 · `schema.generated.sql` regeneration is overdue · [AGENT]
- **Check:** compare `ls -l infra/postgres/schema.generated.sql` against
  `ls infra/postgres/[0-9]*.sql | sort -V | tail -1` → a generated file older
  than the newest migration means still pending. Measured 2026-08-14: generated
  2026-08-12, newest migration 176. (⚠️ Two bugs already found in this one line:
  the path is `infra/postgres/`, not `docs/` — a `docs/` Check would have
  silently "passed" on a missing file — and a bare `*.sql` glob answers
  `schema.generated.sql` itself.)
- **Why:** Stale since roughly migration 113; the ladder is now at 175. A
  generated artefact that lags by sixty migrations is worse than absent, because
  it is read as current.
- **Authority:** `work_plan.md` §2 WS-28 row (where it was first flagged)
- **Added:** 2026-08-14 · pre-existing, carried in so it stops being invisible

### H-10 · A conflicted PR runs NO checks — the R1 guard's blind window · [AGENT]
- **Check:** `rg -n "pull_request" .github/workflows/pr-check.yml` → if the
  migration-prefix guard still runs only on `pull_request` (which checks out
  `refs/pull/N/merge`, a ref GitHub does not compute while a PR is conflicted),
  the window is still open. A `merge_group`/`push`-on-branch trigger, or a job
  that checks out the head ref and merges the base itself, would close it.
- **Why:** ⚠️ Measured, not guessed. `test_migration_prefixes.py` DOES catch two
  migrations at one number — verified by putting the duplicate back. It was
  simply never run: #439 sat `dirty` and reported `check_runs: 0`, **no jobs at
  all**. So the window in which a cross-branch collision is most likely is
  exactly the window in which nothing is watching, and the collision surfaces
  only when somebody hand-resolves the conflict — i.e. while editing the very
  tree that hides it.
- **Authority:** `work_plan.md` §2 WS-27 row (the R1-collision record)
- **Added:** 2026-08-14 · session that built WS-27bj

---

# DONE — deleted, not archived

Nothing lives here. When an entry's Check passes, **delete the block**. Git
history is the archive; a "done" section in a loaded-into-context file is just
tokens that make the open items harder to find.
