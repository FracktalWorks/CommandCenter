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

### H-12 · CommandCenter's next migration must be numbered 193+, never 177 · [AGENT]
- **Check:** `ls infra/postgres/[0-9]*.sql | sort -V | tail -1` → if the next
  number anyone would take is <= 192, this is still live. On the box:
  `SELECT count(*) FROM schema_migrations WHERE filename ~ '^[0-9]+' AND
  (substring(filename from '^[0-9]+'))::int BETWEEN 177 AND 192;` → 16 means the
  range is occupied.
- **Why:** While Metorite was deployed on this box (2026-08-25 → 08-28) its
  deploys applied **177-192 into CommandCenter's own `acb` database**. Our ladder
  ends at 176, so the obvious next number is 177 — which is taken, by a file with
  a different name and different contents. `schema_migrations` keys on filename,
  so ours WOULD apply; the two ladders would then diverge silently and forever.
  Verified 2026-08-28: all 16 are present.
- **Authority:** R1 · CLAUDE.md §3.7 · closed-out H-11
- **Added:** 2026-08-28 · the session that took the box back

### H-13 · A changed migration RE-RUNS, and one of ours contains a DELETE · [AGENT]
- **Check:** `grep -n "DELETE FROM" infra/postgres/56_purge_synced_done_backlog.sql`
  → present, plus `apply_migrations.sh` still re-applying on checksum mismatch
  (`grep -n "CHANGED since it was applied" scripts/apply_migrations.sh`), means
  still live.
- **Why:** 🔴 **Measured, not theorised — it fired on 2026-08-28 and deleted
  rows.** `apply_migrations.sh` re-applies any migration whose sha256 no longer
  matches the ledger. Metorite's rebrand changed *comment text* in several of our
  migrations, so on the restore deploy eleven files re-ran — including
  `56_purge_synced_done_backlog.sql`, which is
  `DELETE FROM gtd_items WHERE source <> 'LOCAL' AND disposition = 'DONE'`.
  Two completed synced tasks were purged (818 → 816). Recoverable by a full
  re-sync, per that migration's own header — this time.
  ⚠️ **The general hazard:** re-apply-on-checksum-change assumes every migration
  is idempotent. A migration containing an unguarded `DELETE`/`UPDATE` is not,
  and a one-character comment edit is enough to fire it. Either migrations must
  be guarded (`IF NOT EXISTS`, arming rows — cf. Metorite's 190, which refused to
  drop because nobody armed it), or a checksum drift must REFUSE rather than
  re-apply. That is a decision, not a patch.
- **Authority:** R6 (cannot roll back) · R7 (name the fence) · `scripts/apply_migrations.sh`
- **Added:** 2026-08-28 · the session that took the box back

### H-2 · Count archived projects on prod BEFORE migration 171 applies · [OWNER]
- **Check:** `SELECT count(*) FROM pm_projects WHERE status = 'archived';` on
  prod. If 171 has already applied, this number is no longer recoverable this
  way and the query becomes `WHERE archived_root_id = id` — which answers a
  *different* question. Unanswered → still pending.
- **STATUS 2026-08-28: the window has CLOSED and the number is lost.** 171 is
  in the ledger on the box, so the pre-migration count is no longer
  recoverable. Per this entry's own instruction, record that it was lost
  rather than substituting the other query's answer. Kept only so nobody
  re-derives a different number and believes it.
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
  exists. Flipping it is a restart, not a release. Its prerequisite (the box
  running current `main`) was satisfied 2026-08-28 when the box was taken back
  from Metorite — the old H-1 that this line used to name is closed.
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
