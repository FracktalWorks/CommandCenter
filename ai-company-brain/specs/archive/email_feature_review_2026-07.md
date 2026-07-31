# Email Application — Comprehensive Feature Review (2026-07-22)

Full-surface audit of every email feature: robustness, architecture, purposefulness, and
completeness. Eight parallel deep-review passes over ~16,300 backend lines
(`apps/services/gateway/gateway/routes/email/`), the ingestion service, the email-assistant
agent, and the 34-component frontend (`workbench/control_plane/src/app/email/`).
Read-only review; no code was changed.

---

## 1. Executive summary

**The core architecture is healthy.** The load-bearing decisions are right and verified:
one message upsert (`persist.py`), one rule matcher (`engine.py`), one LLM-JSON seam
(`core._llm_json` — the deepseek JSON-mode requirement enforced in exactly one place), one
label writer (`runner.apply_label`), one signature choke point (`build_signed_bodies`), one
pattern-write backstop (`_upsert_rule_pattern`), a post-sync hook registry that fixed the
ingestion↔gateway layering inversion, and honest FAILED-vs-APPLIED history. No P0
(data-destroying) defect was found anywhere.

**The systemic weakness is duplication that has already diverged.** Every serious defect
class traces to a copy that drifted from its twin:

- Two sync cores (manual `trigger_sync` vs scheduler `_sync_account`) with three behavioral
  differences — one loses rotated refresh tokens, one silently killed label-change learning
  in production.
- Two send transports (full send vs draft) carrying different field sets — root cause of the
  undo-send data loss, the silent draft attachment loss, and three-way composer branching.
- The #110 "one classification per conversation" invariant enforced at only 2 of 5 apply
  entry points, because each call site must remember it.
- Per-tool confirmation gates instead of risk-annotation-driven gating — which is how
  `digest(send=True)` ended up sending email with no confirmation.

**Feature verdict scorecard:**

| Feature | Verdict | Headline |
|---|---|---|
| Classification core (engine/rules) | **Sound** | Single matcher, no drifted copies — a genuine achievement |
| Runner / Reply Zero modules | **Refactor (mechanical)** | 5 concerns in runner.py; 390 lines of chat SSE living in replyzero.py |
| Inbox Cleaner | **Sound** | Principled evidence ladder; 5 targeted fixes, no restructure |
| Learned patterns | **Sound + 1 live bug** | `_upsert_rule_pattern` returns None on success → Fix pin saves but reports failure |
| Knowledge base | **Real but naive** | Prompt-section KB, recency-first-fit, no relevance ranking |
| Writing style / drafting | **Real, needs de-pollution** | Learn-from-edits loop reads quote-polluted text → partly learns other people's writing |
| Digest | **Partial** | Wired end-to-end but semantically broken in the middle |
| Analytics | **Sound** | Pure projection, test-locked windows; 192-APPLIED mystery solved (mostly fixed) |
| Search (lexical) | **Sound** | FTS expression verified byte-identical to its GIN index |
| Search (semantic) | **Shipped-but-unlaunchable** | Flag set nowhere + SQL that cannot execute |
| Sync/transport | **Sound skeleton, drifting seams** | Two cores; delta dead; reconcile edge races self-heal |
| Assistant chat | **Sound + gate holes** | 42 tools, fail-closed sends; 5 mutating tools unconfirmed |

---

## 2. The six areas you flagged

### 2.1 Inbox Cleaner — sound; targeted fixes, no refactor

`automation/cleanup.py` is one of the best-engineered modules in the app: a deterministic,
no-LLM projector with an evidence ladder ordered strongest-first (approved pattern → sender
consensus ≥2 @ 0.8 dominance → domain consensus ≥4 @ 0.9 → bulk shape), tallies frozen per
run so the sweep can't feed on its own output, every threshold documented with the incident
that motivated it, and real unit tests. It converges the backlog to no-evidence residue by
design.

Defects (all fixable without restructuring):

- **P1 · Auth-failure churn loop** — `cleanup.py:540-542` continues with `provider=None`
  after failed auth; labels are written local-only yet logged `APPLIED`; Outlook re-sync
  (categories authoritative) erases them; the message re-enters scope and loops every
  5 minutes minting false audit rows. Abort the live run on auth failure.
- **P1 · Failed sweeps report success** — exceptions are swallowed into `summary["error"]`
  (`cleanup.py:625-629`), job stamped `done`, and the frontend never reads `st.error`
  (`BulkUnsubscribeView.tsx:577-584`).
- **P1 · No concurrency guard** on `/cleanup/auto-categorize` (backfill has one; manual +
  scheduler sweeps run concurrently and clobber each other's job rows).
- **P1 · No Graph 429 handling + invisible failures** — each Outlook apply is 3 sequential
  Graph calls (`_ensure_categories` re-fetches masterCategories every time,
  `outlook.py:767-781`); throttled applies are swallowed per-message; there is no `failed`
  counter, and `by_category` (counted at decision time) silently disagrees with
  `categorized` (counted at apply time).
- **P1 · Consensus denominator bug** — `_label_tallies` (`cleanup.py:282-284`) drops
  conversation labels from the denominator: a real correspondent with 60 Reply/Done labels
  and 2 stray Notification labels computes dominance 1.0 and gets stamped Notification.
  Count conversation labels as evidence *against* a cleanup category.
- P2: nondeterministic pattern precedence (unordered dict), the scheduler's `limit=5000`
  scan wall (the module's own docstring warns against exactly this), `_sweep_tick` lacking
  runner's job-token guard, duplicate uncategorized predicate vs `core.UNCATEGORIZED_SQL`,
  Restore-labels banner offered on Outlook where it can never work, preview (newest-2,000
  sample) hiding viable runs.

**Also: P1 cross-feature hazard — FIXED mid-review by PR #113 (2026-07-22 13:09)** — the
sweep's per-message scope re-stamped cleanup labels onto older bubbles of classified
conversations (observed live: a repair stripped 12 threads' stale chips and the next sweep
cycle re-applied 36). #113 added the thread-level exclusion to `_CLEANUP_SCOPE`
(NEEDS_REPLY/AWAITING/DONE; FYI deliberately sweepable), test-pinned in both directions.
See §3.1.

### 2.2 Learned patterns — sound design; one live bug and two policy gaps

The subsystem (in `rules.py`/`engine.py`/`runner.py`/`transport/sync.py` — *not*
`senders.py`) has the right shape: four producers funneling into one write choke point with
centralized guards (conversation rules never pinned, own address never, rejected patterns
are durable tombstones non-user sources can't resurrect), a coherent
approved/pending/rejected state machine carried across rule resets, and the #97 gate rework
is genuinely principled (dry runs excluded, distinct messages counted, sole-match required,
correspondent check, LLM second opinion that fails closed). The review UI for pending
patterns **exists and is complete** (`SettingsTab.tsx:1343-1575` + `POST
/rules/patterns/review`) — "21 unreviewed" is a data state, not a missing feature.

- **P1 · `_upsert_rule_pattern` never returns `True`** (`rules.py:775` — the success path
  falls off the end). Since #105 made `_teach` honor the return value, a Fix with "pin this
  sender" checked **inserts and commits the pattern but shows "Nothing was saved"** and
  skips the immediate re-run. The tests mask it (they mock the return / assert only
  `db.inserted`). Fix: `return True` + a return-value test; consider a reason enum so the
  dialog can say *why* nothing was saved.
- **P2 · Process-past backfill applies unreviewed AI includes at cleaner-scale blast
  radius** (up to 2,000 messages, full actions incl. MOVE) — precisely the scenario
  migration 85's gate was written for. Make `approved_includes_only` an explicit parameter
  of the match entry points; today the policy lives in one cleaner call site and every new
  engine caller silently inherits the permissive default.
- **P2 · The "None" Fix can no longer teach an exclude** (pin checkbox only renders for
  specific rules), yet the endpoint docstring and success toast still promise "won't match
  anymore" — only advisory guidance is written. By the engine's own rationale excludes are
  the *safe* correction; either re-expose them for "None" or fix the copy.
- P2: no UI to reject an already-approved pattern (only weak "forget"=delete, re-learnable);
  mid-sweep rejection window (~minutes on big mailboxes). P3: comment drift (≥3 vs actual 5),
  unescaped `LIKE '%sender%'` evidence matching (`noreply@` feeds `reply@` evidence),
  vestigial `source='USER'` with no producer, `email_learned_patterns` vs
  `email_rule_patterns` naming collision.

### 2.3 Knowledge base — real but naive retrieval

`email_knowledge` (mig 26) with full CRUD and a real injection point — but selection is
**20 newest entries, recency-ordered, first-fit into a 4,000-char budget**
(`assistant.py:42-75`): no relevance ranking, one long recent entry evicts everything else,
and the KB text also rides into Reply-Zero thread-status *classification* prompts where it
adds cost and no value. Fix: embed KB entries with the existing embeddings machinery and
select by similarity; stop injecting KB into classifier prompts.

### 2.4 Writing style — layered and real; de-pollute, don't rebuild

Five real layers: explicit style guide (+ "Generate from my sent mail"), auto-derived
`learned_writing_style` from draft-vs-sent diffs, per-sender few-shot examples, scoped reply
memories (SENDER > DOMAIN > TOPIC), and per-account Mem0. Priority is documented (explicit
outranks learned). The NO_DRAFT sentinel is adversarially hardened and gated at every
consumer; signature/quoting is single-sourced at both send choke points.

The defect theme is **pollution of the learning inputs**:

- **P1 · `_learn_from_sent` reads the combined body including the quoted chain**
  (`send.py:203`; composers concat new + quote) — so the unchanged-draft check never
  passes (a tier-powerful extraction call on *every* send) and learned preferences are
  partly the correspondent's prose. One `split_quoted_text` call fixes both.
- **P1 · Pop-out composer "Draft with AI" sends no `messageId`** (`ComposePanel.tsx:94-108`)
  → drafts a "reply" with zero thread context; the other two composers pass it.
- P2: style-generation samples and sender examples also quote/signature-polluted; the rule
  runner builds its own draft context omitting to/cc/self/from_name (direction note and
  greet-by-name silently no-op on the highest-volume auto-draft path); LLM-failure fallback
  returns boilerplate instead of the sentinel (an outage auto-files generic drafts *and*
  feeds them into edit-learning); follow-up auto-drafts skip body hydration (the 200-char
  snippet bug survives on that one path); `/compose-assist` replies never store the AI draft
  so composer edits teach nothing; prompt fragments duplicated verbatim across the two
  drafters.

**The pending "sent-email knowledge profile" has a cheap concrete design**: per-message
embeddings already exist (`email_embeddings`, used only by search). Embed the incoming
message in `_build_reply_context`, cosine-match the account's Sent mail, inject top-3
quote-stripped bodies as few-shot — no new store needed. (Blocked on fixing the embedding
sweep, §2.6/D5.)

### 2.5 Digest — partial: wired end-to-end, broken in the middle

Genuinely complete plumbing (panel → endpoint → scheduler hook → provider email; no LLM,
pure SQL) — and the only *push* surface the app has. But:

- **P1 · The headline "N threads awaiting your reply" is an all-time count of threads whose
  latest message is in the inbox** (`digest.py:82-89`) — thousands, meaningless — instead of
  reading `email_thread_status` the way `analytics._backlog` already does correctly.
- **P1 · The category filter compares rule names against canonical sender categories,
  case-sensitively** (`digest.py:52`) — a rule named "My newsletters" silently produces an
  empty section. `canonical_cleanup_category` exists and isn't used.
- **P1 · Preview ≠ what's emailed** (manual endpoints ignore `digest_categories`; only the
  scheduled path passes them) and the filter only applies to one of four sections anyway.
- **P1 · Send time is UTC in code, "account-local" in the UI and migration** — a 09:00
  digest arrives at 14:30 IST.
- P2: markdown emailed as plain text (`body_html` unused); empty digests sent forever; the
  digest emails itself and is counted in its own next totals (and run through the rules
  pipeline); two divergent config dialogs; silent 300s retry loop on provider failure; no
  catch-up window after downtime; zero tests on the logic that matters.

**Recommendation: keep it, but make it a projection.** `analytics.py` already computes
totals, noisy senders, categories, and backlog with better SQL — extract shared aggregate
helpers and make `_generate_digest` a thin composition. The digest's distinct value is
*scheduled delivery*, not its own arithmetic.

### 2.6 Analytics — sound; and the 192-APPLIED mystery is solved

Pure read-only projection (no state of its own — correct), "a metric ships only if a user
can act on it" doctrine, the range selector is real now and test-locked, PENDING dry-runs
excluded from every trust number.

**Status correction: the "192 rule actions logged APPLIED that 404'd at Graph" issue is
mostly FIXED**, not open. Root causes (traced via PR #100 / commit 5c11d48): (a) status was
computed unconditionally `APPLIED` even when every action errored — fixed at
`runner.py:1316` with migration 86 backfilling 184 legacy rows to FAILED; (b) 46/138 were
self-inflicted — Outlook `/move` re-keys the message and multi-rule runs used the stale id —
fixed by re-reading the id before acting (`runner.py:1302-1304`); (c) ~92/138 were Outlook's
own junk/delete races — not preventable, permanently FAILED residue. #102 added the
retry/repair button; #103 excluded trashed mail.

What actually remains:

- **P1 · Mirror-before-provider in `_apply_rule_actions`** (`runner.py:1956-1987`): for
  ARCHIVE/TRASH/MARK_READ/STAR/MOVE the local mirror is updated *before* the Graph call and
  never reverted on failure — fabricated local state that analytics then reads, and a FAILED
  TRASH stamps `folder='trash'` locally so the repair's own trash-exclusion permanently
  excludes it from repair. `apply_label` already does provider-first; make actions match.
- **P1 · The trust number and the repair button measure different populations**
  (`failed_actions` = any-error, windowed, any status; retry = FAILED-only, unwindowed,
  not-disposed) — a repair *queue* (a level) reported as a windowed flow, violating the
  module's own doctrine; failures silently age out.
- P2: dead "Try again" button (`setDays(d => d)` bails out); zero-state after a swallowed
  query failure renders "every action reached the mail server"; `auto_handled_rate` mixes
  clocks (backfills inflate it); volume chart compresses empty days and buckets in UTC;
  `action_stats` lacks the ghost-row filter its sibling metrics have.

---

## 3. Classification core, transport, assistant (the rest of the surface)

### 3.1 Classification pipeline — one matcher, drifted post-match stage

Matching itself has **no drifted copies** — every entry point funnels through
`engine._match_email_to_rule(s)`. The drift is post-match: the #110
one-classification-per-conversation invariant and watermarking are re-decided per call
site, enforced at only 2 of 5 writing entry points.

- **P1 · The cleaner sweep could recreate the exact #110 damage — FIXED by PR #113, which
  landed mid-review (2026-07-22 13:09).** `_CLEANUP_SCOPE` was per-message;
  `_reconcile_thread_labels` deliberately leaves the status chip on only the latest inbound
  message — so older bubbles of classified conversations were in sweep scope, and the sweep
  re-applied 36 labels minutes after the #112 repair stripped them (observed live). #113
  added the thread-level exclusion (NEEDS_REPLY/AWAITING/DONE; FYI deliberately absent so
  bulk threads stay sweepable), with a test pinning both directions. Residual: the
  conversation collapse UI remains the other half of this invariant, and DONE threads still
  never re-ride the classification path (§ repair-metric recommendation).
- **P1 · An LLM outage silently consumes mail permanently.** `_llm_pick_rule` fails closed
  (`None` = indistinguishable from no-match) → SKIPPED logged, `rules_processed_at` stamped.
  The watermark is guarded against provider-auth failure but not classifier failure; the
  same outage writes unmarked FYI statuses. Fix: tri-state
  (`matched | no_match | unavailable`); never stamp the watermark on `unavailable`.
- **P1 · Two apply surfaces bypass #110 entirely**: `/rules/run-message` apply (Test-tab
  Apply, Uncategorized-pill rerun — one click re-splinters a conversation) and
  `/rules/process-past` (cleanup actions incl. MOVE run on conversation bubbles).
- P2: low-confidence statuses lose their provisional marker on the live path (self-heal
  invariant hangs on a `'· auto'` string suffix across 3 modules — should be a boolean
  column); classifier feedback loops (sweep's own APPLIED rows count as "classification
  history" hints; sweep labels become next-cycle consensus evidence); unguarded concurrent
  classification (duplicate LLM spend); preview ≠ live three ways; `retry_failed_executions`
  replays old MOVEs onto threads since recognized as conversations; `info@` in
  `_NO_REPLY_PREFIXES` permanently gates conversation rules for legitimate `info@` vendors;
  `/reply-zero/reclassify` deletes all non-DONE statuses then processes ~200 threads per
  click against a 3,500-thread mailbox.
- **internetMessageId ghosts (~110 rows)**: no column stores the RFC id anywhere; the upsert
  key is `provider_message_id`, which Outlook re-keys on every move done outside the app.
  Fix: `internet_message_id` column (+ `$select`), upsert dedupe preferring the newest
  provider id (carrying categories/watermark across), one-off merge migration.

**Module cohesion**: `engine.py`, `rules.py`, `core.py` are good. `runner.py` (2,116 lines)
mixes five concerns → split into `actions.py` / `learning.py` / `jobs.py` + HTTP.
`replyzero.py` (1,971) is worst: ~390 lines of AI-chat SSE endpoints (with a file-path
importlib hack) have nothing to do with Reply Zero → split into `chat.py` /
`thread_status.py` (the authority — kills every lazy `# noqa` import) / `followups.py`.
Also: promote the repair script's damaged-threads SQL to a maintained health metric (DONE
conversations never ride the classification path — a standing gap); one
`conversation_rule_key()` (currently 4 copies); one `provider_session()` helper (~9 copies
of auth boilerplate).

### 3.2 Sync/transport

- **P1 · Two sync cores** — the scheduler persists rotated Microsoft refresh tokens
  immediately (with a comment explaining why); the manual/deep path persists only at
  end-of-sync, so a mid-sync failure loses the token → manual reconnect. Cursor semantics
  differ; label-change learning runs **only** on manual sync, i.e. never in production.
  Collapse: make `trigger_sync` a thin wrapper over `_sync_account` with label-learning as
  a post-sync hook.
- **P1 · `email_attachments` has no unique constraint** — `ON CONFLICT DO NOTHING` never
  fires; Gmail's sweep would duplicate attachment rows every tick (dormant on Outlook by
  accident). Add `UNIQUE (message_id, provider_attachment_id)` + dedupe migration.
- **P1 · Undo-send loses attachments/artifacts/cc/bcc/bodyHtml** (`emailStore.ts:1281-1300`
  restores a 4-field projection) — plus it folds the quoted chain into the editable body.
  Fix: restore `pendingSend` wholesale.
- P2: draft transport carries only to/subject/body (silent draft attachment/Cc loss; forces
  3-way composer branching); `resync?purge=true` deletes local mail before the re-fetch;
  reconcile can transiently trash live mail on pagination races (self-heals ≤300s); no sync
  backoff (revoked account hammers every 300s); webhook clientState check skipped when NULL;
  OAuth `user_email` query param overrides the authenticated identity + unauthenticated
  callback + in-memory state dict; `startswith` workspace containment (sibling-dir bypass);
  image-proxy DNS-rebind TOCTOU still open.

### 3.3 Search

Lexical FTS is done well — the tsvector expression is byte-identical across the query, the
GIN index, and `/messages` (verified), the empty-tsquery headline trap is handled, "All
includes Sent" lives in one place. Semantic is **shipped-but-unlaunchable**: the flag
defaults False and is set in no env/deploy file; the UI always requests `hybrid:true` and
silently gets lexical; and the embedding sweep's SQL uses `(text)::bytea` — an invalid cast
that raises the moment the flag flips, so zero messages have ever been embedded
(`email_embeddings.py:103-116`). Also: `/messages` still uses `plainto_tsquery`, which is
why the agent's `find_urgent` ("urgent OR deadline OR ASAP…") almost never matches — the
terms get AND-ed. Decide: fix the SQL + enable the flag (which also unblocks the drafting
few-shot design), or delete the half-feature.

### 3.4 Assistant

42 tools, honest persona, real dual-surface parity, fail-closed confirmation on
`send_email`/`send_draft`. Holes: `digest(send=True)` sends outbound email with **no
confirmation and no risk annotation**; `unsubscribe_sender`, `manage_inbox` trash,
`install_default_rules(reset=True)`, `sync_account(purge=True)` are similarly unguarded
(prompt-level guidance only). Fix the class: drive confirmation centrally from
`@_annotate_risk` in the executor rather than per-tool calls. Config drift: `config.json`
tool scope lists 4 unregistered tools and omits ~28 registered ones; `instructions.md`
references ungranted tools. `read_email` claims two-way read-state sync but only writes
locally.

---

## 4. Partial / pending / dead inventory

### Partially implemented (exists, incomplete)
1. **Rule-action delay is decorative** — `delay_minutes` (mig 32) is stored, edited in
   RulesTab, round-tripped by the API, loaded by the runner… and never consumed. No
   scheduler, no deferred queue. Either build the deferred executor or remove the UI knob.
2. **`find_urgent` effectively broken** (plainto_tsquery AND-ing; §3.3).
3. Undo-send loss; draft transport field gap (§3.2).
4. Webhook clientState + OAuth owner-binding (§3.2).
5. Outlook delta sync implemented-then-disabled (dead branch kept "until a verified
   approach").
6. Tool consolidation 63→42 stalled: `manage_rule`/`manage_knowledge`/`manage_labels`
   merges never happened.
7. History tab: executions only, no per-message timeline (last parity gap).
8. Add-Rule parity remainder: NL append-editor, action reordering; agent `create_rule` caps
   at 2 actions with no per-action to/cc/subject.
9. AG-UI chat parity: mostly closed; missing the rule-suggestion approve card and typed
   `requires_confirmation` events (cards still inferred by parsing tool result *text*).

### Pending (promised, no code)
1. **Sent-email knowledge profile** — nothing exists; concrete cheap design in §2.4.
2. **Snooze / schedule-send / summarize-thread / templates** — zero code, no
   `snoozed_until` column anywhere.
3. **Slack/Telegram draft delivery** — visible disabled "Coming soon" UI in RulesTab; no
   server-side action types.
4. **Email knowledge → other agents / Mem0 bridge** — zero consumers outside the email
   agent; email Mem0 deliberately account-scoped so global agents can't retrieve it.
5. **Conversation collapse in the list view** — `threadCount` badge only; pairs with the
   §3.1 sweep-scope fix.
6. **internetMessageId ghost fix** (~110 rows) — design in §3.1.
7. **H6: Fix never removes the wrong label** — `rule_feedback` teaches but never strips the
   wrongly-applied label; plug in the existing undo machinery after `_teach`.
8. Gmail Pub/Sub push; calendar context in drafts; PDF grounding; meeting briefs — spec
   items, no code.
9. (H5 process-past arbitration skip: **resolved by design** and test-pinned — no action.)

### Dead / unreachable
1. **Orphan endpoints**: `POST /email/ai/chat` + `/ai/quick-action` (~200+ lines in
   replyzero.py, clients removed), `GET /email/newsletters`, `POST /email/artifacts/import`.
2. **Inbound SMTP receiver** (`inbound.py`) — no launcher anywhere; would crash on its DB
   URL if wired. Dead subsystem.
3. Write-only tables: `email_folders`, `email_sync_log` (inserts, never read).
4. ~20 fossil card keys in `EmailToolCards.tsx` for consolidated-away tools.
5. Dead frontend: `hooks/useEmails.ts` (zero importers), 6 dead `api.ts` exports.
6. Gmail (1,106 lines) + IMAP (792 lines) provider stack: latent multi-provider design, not
   dead — but it's where the dormant D4 attachment bug and the unreachable
   restore-labels/readback branches live. Keep, but stop letting Gmail-only paths mask bugs.
7. Vestigial: pattern `source='USER'` (badge exists, no producer), `Support`/`Unknown`
   sender categories (no producer), `'user'` category override "reserved for future".

### Doc/spec corrections
- `email_ai_assistant.md` §8 is broadly accurate. Parity plan's "67 tools" → actual 42.
  Spec success criteria still claims "2+ Gmail accounts" (live = 1 Outlook).
- Stale memory corrected by this review: the 192-APPLIED issue is mostly fixed (§2.6);
  `auto_run` is live again (scheduler_hooks gates on it), not inert.

---

## 5. Prioritized action plan

### Now (correctness, hours each)
1. ~~`_CLEANUP_SCOPE` thread-level conversation exclusion~~ — **DONE, PR #113 (landed
   mid-review 2026-07-22)**.
2. `return True` in `_upsert_rule_pattern` + return-value test (§2.2) — un-gaslight the Fix
   dialog.
3. Cleaner: abort live sweep on auth failure; surface `st.error`; add `failed` counter
   (§2.1).
4. Digest: needs-reply from `email_thread_status`; category filter through
   `canonical_cleanup_category`; pass categories into manual endpoints (§2.5).
5. `undoSend` restores `pendingSend` wholesale (§3.2).
6. Confirmation gate on `digest(send=True)` (+ the other four unguarded mutating tools, via
   central risk-annotation gating) (§3.4).
7. Engine tri-state so LLM outages don't stamp the watermark (§3.1).
8. `split_quoted_text` at the three learning seams (§2.4) — highest-leverage draft-quality
   change.

### Next (structural, a PR each)
9. Mirror-after-provider-ack in `_apply_rule_actions` (§2.6).
10. Collapse the two sync cores; label-learning as a post-sync hook (§3.2).
11. `classify_and_apply()` wrapper centralizing match → resolve → apply → watermark;
    callers choose cost policy; `approved_includes_only` an explicit parameter (§3.1, §2.2).
12. Split `runner.py` and `replyzero.py` along the seams in §3.1 (mechanical).
13. Fix the embeddings SQL + real-Postgres test; decide semantic search's fate; fix
    `/messages` → `websearch_to_tsquery` (repairs `find_urgent` for free) (§3.3).
14. `internet_message_id` column + upsert dedupe + merge migration (§3.1).
15. Digest → projection over shared aggregate helpers extracted from analytics (§2.5).
16. Split `failed_actions` into repairable/permanent; gate the repair button on repairable
    (§2.6).
17. `email_attachments` unique constraint + dedupe (§3.2).

### Then (product decisions)
- Build or remove: rule-action delay, Slack/Telegram delivery, `source='USER'` manual
  patterns, inbound SMTP, orphan endpoints.
- Build next (highest user value): sent-email few-shot drafting (§2.4 design), conversation
  collapse UI + sweep-scope pairing, snooze/schedule-send, KB relevance ranking,
  H6 label-strip on Fix.
- Security batch: OAuth owner-binding + state store, DNS-rebind pinning, workspace-path
  containment, webhook clientState.
