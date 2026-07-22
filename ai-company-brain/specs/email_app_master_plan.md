# Email App — Master Plan (single source of truth)

> **Product:** CommandCenter · **Feature:** Email AI Assistant App · **Created:** 2026-07-22
> **Status:** 🟢 Live on the VPS, single Outlook account (`vjvarada@fracktal.in`), daily-driver.
>
> **This document supersedes and consolidates all prior email planning docs:**
> - [`archive/email_ai_assistant.md`](./archive/email_ai_assistant.md) — the v2.0 feature inventory (2026-06-29; historical reference for architecture detail and the provider matrix)
> - [`archive/email_inbox_zero_parity_plan.md`](./archive/email_inbox_zero_parity_plan.md) — the inbox-zero parity roadmap (open items carried into §5-§6 here)
> - [`archive/email_tool_consolidation.md`](./archive/email_tool_consolidation.md) — tool-surface plan (63→42 done; unfinished merges carried into §6)
> - [`archive/email_app_review.md`](./archive/email_app_review.md) — the M0→M9 build log (history only)
>
> **Evidence appendix:** [`email_feature_review_2026-07.md`](./email_feature_review_2026-07.md) —
> the 2026-07-22 eight-agent full audit. Every defect referenced below (IDs like "review §2.1")
> carries file:line evidence there. When an item in this plan lands, mark it here and, if it
> came from the review, note the PR next to the review item.

---

## 1. Product vision — who this is for and what "done" means

**The customer today is one founder running their company from one Outlook mailbox.** The app is
not a webmail clone; it is an **AI chief-of-staff for email**. "Fully featured" means the
customer can trust it to:

1. **Triage without supervision** — every arriving message gets one honest classification;
   conversations are never splintered; bulk mail is filed or killed.
2. **Surface only what needs a human** — Reply Zero, follow-ups, and the digest tell the truth
   about what's waiting, with numbers that are never fabricated.
3. **Draft in the customer's own voice** — replies that need light edits, not rewrites, learned
   from real sent mail (not from correspondents' quoted text).
4. **Close loops** — a promise made in a sent reply becomes a tracked task; a thread awaiting a
   reply nudges at the right time; nothing falls through.
5. **Act safely** — nothing outbound or destructive happens without explicit confirmation;
   automation failures are visible, never silent.

**Trust is the product.** The 2026-07 review's core finding: the architecture is sound (no P0s)
but several surfaces *lie* — a Fix that saves and says it didn't, a sweep that fails and reports
success, a digest counting all-time threads as "awaiting your reply", APPLIED audit rows that
never reached the mailbox. Phase 1 exists because a customer who catches the product lying once
stops delegating to it. That is the PM lens for everything below: **honesty first, convergence
second, new capability third.**

### Explicit non-goals (reset from the old spec)
- **Multi-account / multi-provider parity is not a near-term goal.** The old success criterion
  "Connect 2+ Gmail + 1+ Microsoft accounts" is retired. Gmail and IMAP code stays (latent,
  test-covered where cheap) but no feature work targets them until a second real account exists.
- **Inbound SMTP receiving** — dead subsystem, removing (§6 decisions).
- **Inbox-zero feature-checklist parity as an end in itself** — parity was the scaffolding;
  the roadmap now optimizes for this customer's jobs, not the reference app's feature list.

---

## 2. Current state (condensed; details in the archived inventory + review)

**Architecture** (verified sound by the review): Next.js `/email` app (34 components) →
FastAPI `routes/email/` layered package (`core` / `transport/` / `automation/` / `digest`,
~16.3k lines) → `email_ingestion` service (provider abstraction, per-account async sync loop,
post-sync hook registry) → Postgres (migrations 17→87). One MAF agent (42 tools), dual-surface
chat. Single-writer seams verified: one message upsert, one rule matcher, one LLM-JSON choke
point, one label writer, one signature assembler.

**Feature verdicts from the 2026-07-22 review:**

| Feature | Verdict |
|---|---|
| Classification core (engine/rules) | Sound — no drifted matcher copies |
| Runner / Reply Zero modules | Working, needs mechanical split (2,116 / 1,971-line files) |
| Inbox Cleaner | Sound — principled evidence ladder; 5 targeted fixes |
| Learned patterns | Sound design + one live bug (silent-save Fix) |
| Drafting / writing style | Real 5-layer system; learning inputs quote-polluted |
| Knowledge base | Real but naive (recency first-fit, no relevance ranking) |
| Digest | Wired end-to-end; semantically broken in the middle |
| Analytics | Sound; strongest-audited module |
| Search lexical / semantic | Sound / shipped-but-unlaunchable |
| Sync/transport | Sound skeleton; two drifted sync cores |
| Assistant chat | Sound; confirmation gate holes on 5 tools |

**Recently closed (do not re-plan):** #110/#111 one-classification-per-conversation; #112
thread repair; **#113 sweep armistice** (cleaner excluded from NEEDS_REPLY/AWAITING/DONE
threads); the 192 APPLIED-404 mystery (root-caused, #100/mig 86/#102/#103); analytics rebuild
(#99); auto-learn gate rework (#97 + #104); pattern approval (#96 + mig 85); Fix-teaches-
guidance (#105); whole-mailbox cleaner (#78/#91/#93).

**Doctrines that survived audit — do not "simplify" these away:**
- Reply Zero and sender categories are **projections of the rules pipeline**, never parallel classifiers.
- A conversation has **one** classification, re-evaluated per message; FYI status rows are **not** proof of conversation-ness; statused threads are **not the cleaner's to label** (#113).
- A metric ships **only if the user can act on it**; backlogs are levels, not flows.
- Drafts are **never auto-sent**; backfills **never draft** (user directive); live Reply-rule drafting stays ON.
- The sweep **never classifies** — it only projects existing evidence; internal domains are never blanket-labelled; Sent is skipped.
- Chat send tools **fail closed** when non-interactive.
- Local-commit-authoritative for *user* actions, but **provider-first for automation writes** (`apply_label` order; Phase 1 extends this to all rule actions).

---

## 3. Prioritization model

Four phases, strictly ordered by the PM lens from §1:

- **P0 · Phase 1 — Stop the lying** (correctness fixes, hours-to-a-day each; ~1 week total).
  Every item here is a place the product misreports its own behavior.
- **P1 · Phase 2 — Converge the seams** (structural PRs, ~2-3 weeks). Kills whole defect
  *classes* (drifted copies) instead of patching instances; unblocks Phase 3 features.
- **P2 · Phase 3 — Finish the product** (customer-visible features, ~3-4 weeks). What "fully
  featured" actually requires for this customer.
- **P3 · Phase 4 — Harden and scale** (security batch + multi-user prerequisites; ongoing).

Effort: **XS** <2h · **S** ≤1d · **M** 2-4d · **L** ~1wk.

---

## 4. Phase 1 — Stop the lying (P0) — ✅ COMPLETE (branch `fix/email-phase1-stop-the-lying`, 2026-07-22)

All twelve items done. Landed as 11 commits on the branch (1.1 was already fixed by
PR #113 mid-review). 706 email unit tests pass (+10 new); repo-wide CI-blocking lint
(`F821,F601,F602,F502,F7,B006`) and frontend `tsc` clean. Not yet merged/deployed.

| # | Fix | Status | Where |
|---|---|---|---|
| 1.1 | Cleaner sweep labels conversation messages | ✅ **PR #113** | `_CLEANUP_SCOPE` |
| 1.2 | `_upsert_rule_pattern` returns True on success (Fix-with-pin no longer says "Nothing was saved") | ✅ `9031ee1` | `rules.py` |
| 1.3 | Cleaner failure honesty: abort live sweep on auth failure; `_sweep_job` stamps error; `failed` counter; UI surfaces the real error | ✅ `e71bed4` | `cleanup.py`, `BulkUnsubscribeView.tsx` |
| 1.4 | Engine tri-state via `LLMUnavailable`; never stamp `rules_processed_at` on an outage; all 5 callers handle it | ✅ `640ddfc` | `engine.py`, `runner.py`, `replyzero.py` |
| 1.5 | Provider-first in `_apply_rule_actions` (a refused action leaves no phantom local folder) | ✅ `a119f2e` | `runner.py` |
| 1.6 | Digest truth: needs-reply from `email_thread_status`; category filter via `canonical_cleanup_category`; preview==sent; UTC-honest labels | ✅ `a49f14c` | `digest.py`, UI |
| 1.7 | `undoSend` restores cc/attachments/artifacts + splits the body back into main+quote | ✅ `fb4a289` | `emailStore.ts`, `ComposePanel.tsx`, `page.tsx` |
| 1.8 | Fail-closed `_confirm_destructive` on the 5 unguarded tools + `@_annotate_risk` | ✅ `9ff75a2` | `agents.py` |
| 1.9 | Quote-strip at all three learning seams | ✅ `f089e11` | `drafting.py`, `assistant.py` |
| 1.10 | `/messages` FTS → `websearch_to_tsquery` (fixes `find_urgent`) | ✅ `50f8e25` | `messages.py` |
| 1.11 | Trust panel split into `repairable`/`permanent_failures`; button gated on repairable; dead "Try again" fixed | ✅ `111eee3` | `analytics.py`, `AnalyticsView.tsx` |
| 1.12 | LLM-failure draft fallback → sentinel on automation paths (human template only interactive) + no Mem0 pollution | ✅ `02b77a0` | `drafting.py` |

**Exit criterion met:** every number, toast, and status the app shows is either true or absent.

**Deferred from 1.4 into Phase 2** (deliberately out of scope for the minimal outage fix):
the `provisional` boolean column replacing the `'· auto'` reason-suffix self-heal marker
(review §3.1 P2-4) — a schema change; fold into 2.2's `classify_and_apply` work.

**Next:** open the PR, deploy, verify on the live account (esp. 1.3/1.4/1.5 need a real
sync cycle to confirm — see memory note on verifying-after-a-cycle), then start Phase 2.

---

## 5. Phase 2 — Converge the seams (P1)

> **Status re-audit 2026-07-22** (evidence read directly from code, not the plan —
> the table below had drifted badly out of date). Several items were quietly
> completed alongside Phase 1 / migrations 88–90 and never struck here.
> **DONE:** 2.4, 2.8, 2.9, 2.10, 2.12. **Schema+code done, one-off remains:** 2.6.
> **PARTIAL:** 2.1, 2.2, 2.7 (specifics per row). **Not started:** 2.3, 2.11.
> **Parked by the user:** 2.5 (see [`email-semantic-search-revisit`] memory).

| # | Work | Kills / unblocks | Effort | Source |
|---|---|---|---|---|
| 2.1 ◐→ | Collapse the two sync cores + label-learning as a post-sync hook. **The DEFECT half is FIXED:** label-learning is revived on the scheduler path — `PostSyncHooks.learn_label_changes` (carries the per-message `(message, old_categories)` captured pre-upsert in `_sync_account`'s persist, since the upsert overwrites categories on a categories-authoritative provider); `run_label_learn_hook` invokes it after commit; the gateway registers `scheduler_hooks.learn_label_changes` → the shared `sync.learn_from_label_change_events` orchestrator. So the scheduler + webhook paths (which poll every ~300s) now learn from manual label changes instead of dropping them. Gated on incremental-only, same as the manual route. **Collapse DONE too:** `trigger_sync` is now a thin wrapper — ownership check + `_run_manual_sync` → `_sync_account` (the ONE core; ~268 duplicated lines deleted, incl. the now-redundant inline learning, which flows through the hook like every other path). `resync_account` routes through the same helper — fixing a latent crash where it called the trigger_sync ROUTE with `user` in the `background` slot (unresolved `Depends` → 500 on every direct resync). Parity tests re-pinned on the single core; `transport/sync.py` is no longer an ingest path (guard added). **2.1 COMPLETE.** | Kills refresh-token loss on manual sync, cursor drift, and revives label-learning (was dead in production — scheduler path never ran it) | M-L | review §3.2 |
| 2.2 ✅◐ | `classify_and_apply()` — centralize match → conversation-resolve → apply → watermark. **DONE (the substance):** match→resolve was already one place (`classify_matches`, `engine.py:832`; run-message bypass fixed; `approved_includes_only` explicit `engine.py:523`); apply+watermark is now ALSO one place — `_apply_matches` + `_stamp_processed_watermark` (`runner.py`) collapse the 4 hand-rolled copies (run-message, process-past, `_run_rules_job`, PENDING-retry). The watermark's "only when the run could act" guard and the `sole_match` learning guard each live in exactly one function; process-past routes through the shared apply+watermark while keeping its DELIBERATE oldest-first raw-match classify carve-out (inline resolve would let a thread's oldest message decide status). **Optional remainder:** surfacing `approved_includes_only`/`resolve` as one explicit policy arg on a single façade (today callers pass their own to `classify_matches`) — cosmetic; not blocking. | The #110 invariant enforced in ONE place instead of 2-of-5 call sites; closes the run-message/process-past bypasses and the unreviewed-pattern blast radius | M | review §3.1, §2.2 |
| 2.3 ✅ | Split `runner.py` → `actions.py` (label writers + `_apply_rule_actions` dispatcher) / `learning.py` (auto-learn gate) / `jobs.py` (already extracted) + routes+jobs staying in `runner.py` (2,344 → 1,735); split `replyzero.py` → `chat.py` (AI chat/quick-action SSE, ~390 lines finally leave Reply Zero) / `followups.py` (reminder scan+job) with the thread-status AUTHORITY + views staying in `replyzero.py` (2,167 → 1,565) — deliberate deviation from a separate `thread_status.py`: every consumer imports the authority from `replyzero`, and a rename adds churn with no concern-separation gain. `runner` re-exports the moved action names so lazy importers + tests keep addressing that seam. **The `LIKE '%sender%'` evidence collision fixed while moving** (`learning._sender_consistent_for_rule` now matches the sender by exact case-folded equality — substring matching let `a@b.com` corroborate/veto `aa@b.com`'s history, corrupting the auto-learn consistency bar). | 4,000 lines of mixed concerns; kills every lazy per-row import; the chat SSE code (~390 lines) finally leaves Reply Zero | M | review §3.1 |
| ~~2.4~~ | ~~Draft transport carries cc/bcc/attachments~~ ✅ **cc/bcc #119, attachments #123** | Killed silent draft data loss AND the three-way native-vs-full-send branching | M | review §3.2 |
| 2.5 ⏸ | Fix embeddings sweep SQL (`convert_to(...,'UTF8')`), align hash semantics, add a real-Postgres test, **enable `email_semantic_search_enabled` in prod**. **PARKED by the user** — deep-dive in a dedicated session (flag wiring + broken sweep SQL + live embed cost). | Semantic search stops being shipped-but-unlaunchable; **prerequisite for 3.1** | S | review §3.3 |
| 2.6 ✅◐ | `internet_message_id` column + `$select` + upsert dedupe + one-off merge of the ghost pairs. **Schema+code DONE** (mig 89 + ingest reclaim). **One-off written:** `scripts/merge_ghost_messages.py` — merges rows sharing a backfilled `(account_id, internet_message_id)`: keeps the richest (classified-then-newest) survivor, carries a sibling's categories/watermark if the survivor lacks them, repoints the SET-NULL FKs (`email_executed_rules`, `email_rule_guidance`), deletes the ghosts (attachments/embeddings cascade). Dry-run by default; reports (does NOT merge) rows still NULL — those must re-sync first to learn their id. **To run (user, live):** sync to backfill ids → `uv run python scripts/merge_ghost_messages.py` (dry) → `--apply`. | Kills duplicate classification of Outlook-rekeyed messages and the ghost rows skewing thread heuristics | M | review §3.1 |
| 2.7 ◐ | Digest = projection: extract shared aggregate helpers from `analytics.py`; `_generate_digest` composes them; HTML body; empty-digest suppression; exclude the digest's own emails from totals; merge the two config dialogs. **PARTIAL:** HTML body, empty-suppression, and self-exclusion all DONE. **Remains:** digest still runs its own parallel `_digest_*` SQL (`digest.py:45-155`) instead of composing analytics helpers (`_backlog`/`_categories`/`_noisy_senders`, imported by nothing); and the two config dialogs (`DigestView.tsx:255` + `SettingsTab.tsx:934`) are un-merged and inconsistent (categories only in the AI-Settings copy). | Digest stops re-deriving (wrongly) what analytics already computes correctly | M | review §2.5 |
| ~~2.8~~ | ~~`email_attachments` UNIQUE `(message_id, provider_attachment_id)` + dedupe migration~~ ✅ **mig 88 + both inserts (`messages.py:512,668`) name the arbiter** | Closes the dormant Gmail duplication bug at the schema level | S | review §3.2 |
| ~~2.9~~ | ~~Shared `JobTracker` with sequence-token guard; concurrency guard on manual sweeps~~ ✅ **`automation/jobs.py::JobTracker` adopted by cleaner/runner/replyzero; `is_running` guard at `cleanup.py:937,1000` + `replyzero.py:1812`** | Kills the job-clobbering class | S | review §2.1 |
| ~~2.10~~ | ~~Sync-loop exponential backoff + orphaned-`running` sweep; cache `masterCategories`; Graph 429 `Retry-After`~~ ✅ **`scheduler.py::_next_backoff`(cap 3600s)+`_close_orphaned_syncs`; `outlook.py` per-instance `_master_categories` cache + `_MAX_RETRY_AFTER_SECS` 429 handling** | Stops hammering a revoked account every 300s; cuts every Outlook label apply from 3 Graph calls to 2 | S-M | review §2.1, §3.2 |
| 2.11 ◐ | `provider_session()` context helper (instantiate → authenticate → persist rotated creds on exit) replacing the boilerplate copies. **PARTIAL (helper + request paths done):** `core.provider_session` async CM added, persists rotated creds in a `finally` only on clean exit; converted the clean user-scoped request paths (hydrate, both draft-create handlers, digest test-send, mailto-unsubscribe) + 6 tests. **Remains (Tier-A follow-up):** the large `/send` handler (persist sits mid-body among post-send learning) and the background/scheduler jobs (digest scheduled-send `digest.py:448`, cleaner sweep, senders categorize) — those query by `account_id` with no user, so they need an UNSCOPED loader variant + live-cycle validation. | Credential-rotation safety by construction | S | review §3.1 |
| ~~2.12~~ | ~~Promote the repair script's damaged-threads SQL to a maintained health metric~~ ✅ **`analytics.py::count_damaged_conversation_threads` (shared w/ the repair script) → `data_health.damaged_threads`** | The #110 invariant gets a permanent regression alarm instead of a one-off script | S | review §3.1 |

**Exit criterion:** no behavior-bearing logic exists in two places; every invariant has exactly
one enforcement point.

**Remaining Phase 2 work (2026-07-22):** 2.11 request-path conversions + the `provider_session`
helper shipped (branch `phase2-safe-dedup`); 2.11's `/send` + background-job sites still open.
**Reclassified out of "safe" by the re-audit:** 2.7 — its projection touches the LIVE analytics
computation (parameterizing the private helpers by window), and its dialog-merge is a
cross-component state-sync refactor with NO CI runtime validation (no frontend build in CI);
both belong with Tier A, not the safe tranche. Tier-A live-engine items: 2.1 (sync-core
collapse), 2.2 (apply+watermark unification), 2.6 (ghost-merge one-off), 2.7, and 2.11's
remaining sites; 2.3 (splits) folds into 2.1/2.2 (same files). 2.5 parked.

---

## 6. Phase 3 — Finish the product (P2, customer-visible)

Ranked by value to the founder-on-Outlook customer:

| # | Feature | Customer job | Effort | Notes |
|---|---|---|---|---|
| ~~3.1~~ | ~~**Sent-mail few-shot drafting**~~ ✅ **#131** (code shipped; DORMANT until semantic flag ON) | Draft in my voice | M | `_fetch_sent_fewshot` cosine-matches the account's Sent mail → `<voice>` block. Zero cost when `email_semantic_search_enabled` is off; enabling it (token-costing live sweep) is a confirm-point. |
| ~~3.2~~ | ~~**Conversation collapse in the mailbox list**~~ ✅ **#136** | Triage at thread level | M | `GET /messages?collapse=true` (default for the browse) DISTINCT-ONs the conversation key `COALESCE(thread_id, id::text)`, newest-in-view per thread; total counts conversations. Search stays per-message. |
| 3.3 | **Snooze** ✅ **#137** / **schedule-send** ⏳ | Control timing | M-L | **Snooze DONE (#137, mig 90):** `snoozed_until` column, query-time wake (no scheduler), thread-wide stamp, Snoozed view, right-click presets. **Schedule-send PENDING** — outbound; design ready (send-later table + `deliver_scheduled_sends` post-sync hook + composer UI); the one auto-send-on-live-account item — surfaced to the customer for a go/semantics call before building. |
| ~~3.4~~ | ~~**H6 — Fix strips the wrong label**~~ ✅ **#124** | Corrections stick | S | `remove_label` + `correct_applied_labels` strip the wrong rules' LABEL values off the message + apply the corrected one. |
| ~~3.5~~ | ~~**KB relevance ranking**~~ ✅ **#132** | Grounded drafts | S-M | Lexical relevance ranking (not recency first-fit) via `_load_assistant_about(query=)`, always-on; KB dropped from the thread-status classifier (`include_kb=False`). Embedding-cosine variant deferred. |
| ~~3.6~~ | ~~**Pattern review UX completion**~~ ✅ **#127** (reject in-force / restore rejected) | Trust the teaching loop | S | Deferred: manual pattern-add / `USER` badge, None-Fix exclude re-expose. |
| ~~3.7~~ | ~~**Reclassify that finishes the job**~~ ✅ **#129** | One-click recovery | S-M | Now drains the whole mailbox (loop-until-empty), resumable no-progress stop, JobTracker progress + status endpoint, concurrency guard. |
| ~~3.8~~ | ~~**Rule-path draft context parity** + compose-assist learning~~ ✅ **#125** | Auto-drafts as good as manual | S | Runner routes through `_build_reply_context`; compose-assist stores AI draft; follow-up nudge hydrates; pop-out passes `messageId`. |
| ~~3.9~~ | ~~**History per-message timeline**~~ ✅ **#135** | Audit any message | S-M | `GET /messages/{id}/timeline` — received anchor + each `email_executed_rules` row for the message, chronological; `MessageTimelineModal` off the detail "More" menu. Reuses the audit rows, no new table. |
| ~~3.10~~ | ~~**Calendar context in drafts**~~ ✅ **#133** | Scheduling replies | M | `_asks_about_scheduling` heuristic + `_fetch_calendar_context` (internal calendar = gtd_items hard-dates) → calendar block in the draft prompt only on scheduling asks. External calendar sync stays deferred. |
| ~~3.11~~ | ~~**Digest as the daily brief**~~ ✅ **#128** | One glance a day | S-M | Backlog aging (oldest NEEDS_REPLY) + commitments-due (open gtd_items linked via origin) lead both bodies + in-app cards. |
| ~~3.12~~ | ~~Search filter UI completion~~ ✅ **#126** | Find anything | S | Date-range / sender-category / importance pills + FilterMenu sections; `importance` added to `/search`. |

**Explicitly deferred** (revisit after Phase 3): AI-scored "Clean" review queue; PDF/attachment
content grounding; attachment auto-filing; meeting briefs; learning from bulk actions;
categorization backfill date-range + coverage report; Gmail Pub/Sub push; richer AG-UI typed
`requires_confirmation` events + rule-suggestion approve card; email-KB → other-agents/Mem0
bridge (needs a scoping design so account-scoped memories stay private).

### Build-or-kill decisions (each needs a one-line owner call)

| Item | Recommendation |
|---|---|
| Rule-action `delay_minutes` (stored/edited, never executed) | **Kill the UI knob** until a deferred-action executor has a real use case; the column stays |
| Slack/Telegram draft delivery ("Coming soon" UI) | **Remove the dead UI**; rebuild when a messaging integration exists platform-wide |
| Inbound SMTP receiver (`inbound.py`, no launcher, broken DB URL) | **Delete the subsystem** (git history preserves it) |
| Orphan endpoints: `/email/ai/chat`, `/email/ai/quick-action`, `GET /newsletters`, `POST /artifacts/import` | **Delete** (~250 lines; clients were removed) |
| Dead frontend: `useEmails.ts`, 6 dead `api.ts` exports, ~20 fossil card keys | **Delete** |
| Write-only tables `email_folders`, `email_sync_log` | Keep `email_sync_log` (cheap audit); **drop the `email_folders` mirror write** or start reading it |
| Gmail (1,106 lines) + IMAP (792 lines) providers | **Keep latent**, mark unsupported in docs; no feature work; fix only schema-level hazards (2.8) |
| Unfinished tool merges (M7 `manage_rule`, M8 `manage_knowledge`, M13 `manage_labels`) | **Close the plan at 42 tools** — measured value of further merging is low; delete the fossil card keys instead |
| `Support`/`Unknown` sender categories, `'user'` category-override reservation | Remove from the API vocabulary or build the manual set-category flow in 3.6 |

---

## 7. Phase 4 — Harden and scale (P3)

Security batch (carried from the 2026-07 codebase audit + review, still open):
- **OAuth owner-binding**: drop the `user_email` query-param identity override; authenticate the
  callback; move `_oauth_states` to Redis+TTL.
- **SSRF DNS-rebind**: pin the resolved IP into the transport (custom `AsyncHTTPTransport`) in
  the unsubscribe fetcher and image proxy (both currently resolve-then-refetch).
- Workspace path containment via `Path.is_relative_to` (two `startswith` sites in `send.py`).
- Webhook `clientState`: reject when stored state is NULL; `secrets.compare_digest`.
- Sanitize provider error text before persisting/surfacing; encode `Content-Disposition`.

Scale prerequisites (before any second user/account):
- 401-retry mid-sync (refresh + rebuild client + retry once) in both providers.
- Stop holding DB sessions across LLM/provider I/O in rule paths.
- LLM batching + shared concurrency cap / per-account daily budget for rule matching.
- N+1s + indexes: `list_accounts` unread counts, `_load_rules` per-email action fetch,
  `email_messages(account_id, thread_id, received_at DESC)`, FK on
  `email_thread_status.last_message_id`.
- Read-state two-way sync on open (today local-only despite the comment); Outlook star support
  decision (local-only today).
- Agent config hygiene: regenerate `config.json` `own_tool_scope` from `_TOOLS`; fix
  `instructions.md` references to ungranted tools.
- BYOK `run_agent` (non-streaming) DeepSeek-primary (mirror the streaming pre-injection block).

---

## 8. Operating rules (unchanged, carried forward)

- **Testing:** every item above lands with unit tests in `tests/unit/` (CI-gated); the review
  showed two bugs (silent-save Fix, embeddings SQL) that existed *because* tests mocked the
  seam under test — prefer exercising the real function/SQL. Integration tests opt-in;
  Playwright e2e for UI. Deploy gate = `pytest tests/unit/` (one red test silently blocks
  deploy — check `gh run list` after pushing).
- **CI reality:** pr-check is Python-only (no frontend build — validate `control_plane`
  locally); stacked PRs get zero CI (empty check list ≠ passing).
- **Migrations** auto-apply on deploy; runtime-mutable state lives in Postgres (deploy runs
  `git reset --hard`).
- **Docs:** this file is the plan; the review is the evidence; archive is history. When a
  phase item ships, update its row here (strike + PR#) rather than writing a new doc.

---

## 9. Documentation map (after 2026-07-22 cleanup)

| Doc | Role |
|---|---|
| **This file** | The plan + live status. Single source of truth for "what next". |
| [`email_feature_review_2026-07.md`](./email_feature_review_2026-07.md) | Evidence appendix (defect detail, file:line). Archive when Phases 1-2 complete. |
| [`archive/email_ai_assistant.md`](./archive/email_ai_assistant.md) | Historical feature inventory + architecture detail + provider matrix (v2.0, 2026-06-29). |
| [`archive/email_inbox_zero_parity_plan.md`](./archive/email_inbox_zero_parity_plan.md) | Historical parity roadmap; open items absorbed here. |
| [`archive/email_tool_consolidation.md`](./archive/email_tool_consolidation.md) | Historical tool plan; closed at 42 tools (§6 decision). |
| [`archive/email_app_review.md`](./archive/email_app_review.md) | M0→M9 build log. |
