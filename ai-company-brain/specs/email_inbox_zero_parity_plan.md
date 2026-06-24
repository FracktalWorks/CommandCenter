# Email Automation — Inbox-Zero Parity Plan

**Status:** living document · **Owner:** email app · **Created:** 2026-06-21
**Upstream reference:** [elie222/inbox-zero](https://github.com/elie222/inbox-zero)
(AGPLv3) — **cloned locally at `reference/inbox-zero`** (gitignored) so we can
read its real prompts, default rules, and UI components during parity work.

This plan tracks bringing the CommandCenter email app to functional parity with
inbox-zero's automation features, with a verifiable test for every claim. It is
the companion to [`email_ai_assistant.md`](./email_ai_assistant.md) (which
documents what already shipped). When a phase here lands, move its summary into
that doc.

---

## 1. Goal

A user should be able to:

1. **Auto-categorize** senders/emails — both a **historical backfill** (configurable
   how far back) and **just-in-time** on new mail, via an async hook that runs
   server-side with the UI closed.
2. **Auto-draft replies** for the *right* emails (inbox-zero "Reply Zero" needs-reply
   detection), authored by our **email MAF agent** (via the LiteLLM tier model),
   using the user's writing style, a knowledge base, and personal instructions.
3. Get **follow-up reminders** for sent mail awaiting a reply.
4. Configure the assistant the way inbox-zero allows: **Draft Knowledge Base,
   multi-rule selection, learned patterns, writing style, personal instructions**.
5. Use **History** and **Test** tabs that match inbox-zero's depth (per-message
   reasoning, undo; interactive rule testing against real mail).

Every feature ships with automated tests in the app-wide suite (§7).

---

## 2. Current-state audit (verified 2026-06-21)

Legend: ✅ done · 🟡 partial · ❌ missing

| Capability | inbox-zero | CommandCenter today | State |
|---|---|---|---|
| Rules: auto-run on new mail | yes | `_maybe_auto_run_rules` in sync loop **+ Graph webhook** (instant) | ✅ |
| Rules: LLM "best rule" match | yes | `_match_email_to_rule` (single best match) | ✅ |
| Rules: multi-condition (AI + static + category, AND/OR) | yes | single condition per rule | ❌ |
| Rules: ordered priority / multiple-apply | yes | first/best match only | ❌ |
| Rule actions (archive/label/draft/forward/…) | yes | full set in `_apply_rule_actions`, drafts never auto-send | ✅ |
| Sender categorization (smart categories) | on-demand + new senders | `_categorize_senders_job` (top-N, **manual** trigger) | 🟡 |
| Categorization: just-in-time on new mail | yes | none (no hook) | ❌ |
| Categorization: historical backfill w/ date range | yes | limit-based only, no date config | ❌ |
| Cold-email blocker | yes | `_maybe_block_cold` | ✅ |
| Reply Zero: needs-reply detection | yes (dedicated) | inferred via a "To Reply" rule | 🟡 |
| Reply Zero: awaiting-reply tracking | yes | `/reply-zero` awaiting tab | 🟡 |
| Draft replies via agent | yes | `_agent_draft_reply` → MAF drafter (memory + sales/task agents) | 🟡 |
| Draft uses **writing style** | yes (from sent mail) | none | ❌ |
| Draft uses **knowledge base** | yes | none | ❌ |
| Draft uses **learned patterns** (from edits) | yes | none | ❌ |
| **Personal instructions** (global) | yes | only `about` free-text | 🟡 |
| Follow-up reminders | yes | manual "draft follow-up" only | ❌ |
| Digest | yes | `_generate_digest` + `_maybe_send_digest` | ✅ |
| History tab: per-message reasoning + undo | yes | `email_executed_rules` log + approve/reject | 🟡 |
| Test tab: interactive rule test vs real mail | yes | single + recent-match preview | 🟡 |
| Email MAF agent (chat manages rules via tools) | yes | `apps/agent-email-assistant` (tools present) | 🟡 |

**Key findings**

- The async hook exists **for rules** (`_maybe_auto_run_rules`) and now fires
  instantly via the Graph webhook — but **not for sender categorization**. New
  senders are never auto-categorized; categorization is a manual/background job
  over the top-N senders with no date range.
- Drafting works and routes through the orchestrating MAF drafter, but it has
  **no writing-style, knowledge-base, or learned-pattern** context — the three
  things that make inbox-zero drafts feel personal.
- "Which emails to draft" today = whatever the user's *To Reply* rule matches.
  inbox-zero has an explicit **needs-reply classifier** feeding Reply Zero; we
  should make that a first-class signal rather than relying on a rule existing.
- The **Settings** gaps the user noticed (KB, multi-rule, learned patterns,
  writing style, personal instructions) are real — the underlying features are
  absent, not just the UI.
- **History** and **Test** are functionally narrower than inbox-zero.

---

## 3. Architecture mapping (inbox-zero → CommandCenter)

| inbox-zero concept | CommandCenter home |
|---|---|
| Rules + conditions (Prisma) | `email_rules` table, `_match_email_to_rule`, `_apply_rule_actions` |
| Rule history (`ExecutedRule`) | `email_executed_rules` table |
| Categories / `Newsletter` | `email_senders.category`, `EMAIL_CATEGORIES`, `_categorize_senders_job` |
| Cold email blocker | `_maybe_block_cold`, `email_cold_senders` |
| Reply tracking (Reply Zero) | `/reply-zero`, `email_messages` threads |
| AI draft (`aiDraftWithKnowledge`) | `_agent_draft_reply` / MAF `apps/agent-email-assistant` |
| Knowledge base | **(to build)** `email_knowledge` table |
| Writing style / "About" | `email_assistant_settings.about` (+ to build `writing_style`) |
| Learned patterns | **(to build)** `email_learned_patterns` table |
| Webhook (Gmail/Graph) | `/email/webhook/microsoft` (+ Gmail Pub/Sub backlog) |
| Assistant chat tools | `apps/agent-email-assistant/agents.py` tools |

---

## 4. Phased roadmap

Each phase is independently shippable and ends with green tests.

### Phase 0 — Foundation (this PR)
- [x] Audit + this plan doc.
- [x] App-wide test-suite scaffold + baseline tests for existing email features.
- [ ] **Auto-categorize new senders** just-in-time: sync-loop hook categorizes
  senders newly seen since last run (async, UI-closed). Acceptance: a new
  sender gets a non-null `category` within one sync cycle without a manual
  trigger. Test: unit test on the hook selecting only uncategorized senders.

### Phase A — Label UX fixes (shipped alongside Phase 0)
Concrete bugs found in the current email UI:
- [x] **Right-click "Label" menu was empty** — `availableLabels` only came from
  the provider's master categories (Outlook exposes none), so the picker showed
  "No labels yet". Now `fetchEmails` also seeds `availableLabels` from the
  categories present on loaded messages. (`emailStore.ts`)
- [x] **Toolbar "Label" button was a no-op** — `page.tsx` had no `"label"` case.
  The button now opens the label picker (the context menu hosting `LabelMenu`)
  for the selected message. (`EmailList.tsx`)
- [x] **Clicking a label didn't filter the inbox** — added `selectedLabel`
  store state + `selectLabel`, a `label` query param on `list_messages`
  (`:label = ANY(labels|categories)`), clickable label chips, and an active
  "Filtered by label … Clear" strip. (`emailStore.ts`, `api.ts`, `EmailList.tsx`,
  gateway `email.py`)
- Tests: `test_email_messages_filter.py` (gateway label-filter SQL builds the
  ANY clause). Frontend covered by Playwright in a later pass.

### Phase 1 — Assistant data model (Migration 26) — ✅ SHIPPED
Migration 26 added `personal_instructions`, `writing_style`, `draft_replies` to
`email_assistant_settings` and a new `email_knowledge` table. `learned_patterns`
deferred to Phase 7.

Add the storage the missing settings need:
- `email_assistant_settings`: `personal_instructions TEXT`, `writing_style TEXT`,
  `draft_replies BOOL`, `learn_patterns BOOL`.
- `email_knowledge (id, account_id, title, content, updated_at)` — Draft KB.
- `email_learned_patterns (id, account_id, kind, pattern, weight, updated_at)`.
- Extend `AssistantSettingsModel` + GET/PUT + Settings UI sections.
- Acceptance: settings round-trip all new fields; KB CRUD endpoints work.
- Tests: settings serialization round-trip; KB CRUD; migration idempotency.

### Phase 2 — Drafting overhaul (the email agent) — ✅ SHIPPED
Writing style + personal instructions + knowledge base injected into the drafter
(tagged blocks in the shared `about` context that feeds both the LLM drafter and
the MAF agent); a "Generate writing style from sent mail" endpoint; and a
first-class **needs-reply classifier** (Reply Zero, Migration 27): a sync-loop
job classifies threads NEEDS_REPLY / FYI / AWAITING and stores them, so the
needs-reply list excludes FYI/automated mail. The email **agent can now
configure all of this by chat** (install presets, set writing style / personal
instructions, manage the knowledge base — Chunk A).
- First-class **needs-reply classifier** (Reply Zero) independent of a rule
  existing; surfaces a "To Reply" set and feeds the drafter.
- Route **all** drafting through the MAF agent with context injected: writing
  style + personal instructions + knowledge base + memory + sibling agents.
- Flesh out `agent-email-assistant` instructions/tools to inbox-zero-equivalent
  architecture (rule mgmt, KB lookup, style, handoff).
- Acceptance: an email classified needs-reply produces a provider draft that
  visibly uses KB + style; non-needs-reply emails are not drafted.
- Tests: classifier picks needs-reply vs not (mocked LLM); drafter prompt
  includes KB/style/personal-instructions; draft action creates a draft only
  for needs-reply.

### Phase 3 — Follow-up reminders — ✅ SHIPPED
`follow_up_days` setting; awaiting threads older than the window are flagged
(`needs_follow_up` + `awaiting_days`) and surfaced in the Reply Zero "awaiting"
tab with a "Follow up · Nd" badge.
- Track sent mail awaiting a reply; resurface after a configurable window;
  optional digest/notification entry. Async (sync-loop driven).
- Acceptance: a sent email with no reply after N days appears in "awaiting" and
  generates a reminder entry.
- Tests: awaiting detection; reminder window logic; no reminder once replied.

### Phase 4 — Rules engine + rule UI/UX parity — 🟡 UI + PRESETS SHIPPED
Done: presets aligned to inbox-zero's system rules incl. FYI (To Reply, FYI,
Newsletter, Marketing, Calendar, Receipt, Notification, Cold Email); rule editor
rebuilt to the "When I get an email → Then…" shape with a full condition builder
(AI Prompt + From/To/Subject/Body), ALL/ANY operator, threads toggle, cc/bcc.
Still pending: multi-rule apply + drag-to-reorder priority (below).
- Multi-condition rules (AI instruction + static from/to/subject + category)
  with AND/OR; rule ordering/priority; optional multi-rule apply.
- **Default rule presets** matching inbox-zero (seed on first use / a "Add
  presets" button). Exact set from `reference/inbox-zero` (systemTypes):
  **To Reply, FYI, Newsletter, Marketing, Calendar, Receipt, Notification,
  Cold Email** (+ Reply Zero's **Awaiting Reply / Actioned**). Today our
  presets/labels differ — align names + default actions.
- **Rule add/edit UI/UX**: our create/edit form is much simpler than
  inbox-zero's (conditions builder, action rows, AI-instruction field, "Test"
  inline). Rebuild the form to match — reference
  `reference/inbox-zero/apps/web/app/(app)/[emailAccountId]/assistant/`
  (`RuleForm`, `ConditionSteps`, `examples.ts`).
- Acceptance: a rule with `AI AND category` only matches when both hold;
  ordering decides ties; the preset pack creates the 8 system rules.
- Tests: condition combinator truth table; ordering; category condition;
  preset-pack creation.

### Phase 5 — Categorization parity (historical + config)
- Historical backfill endpoint with **date range** ("how far back"); progress.
- Auto-categorize coverage report.
- Acceptance: backfill since a chosen date categorizes senders in that window.
- Tests: date-bounded selection; idempotent re-run.

### Phase 6 — History + Test parity — 🟡 MOSTLY SHIPPED
Done: History shows the AI rationale and an **Undo** (restore to inbox / remove
labels) on applied executions; the Test tab's recent-inbox preview shows the
match rationale per email. Pending: full per-message timeline view.
- History: per-message timeline with the rule, actions, **AI reasoning**, and
  **undo** of applied actions.
- Test: interactive run of rules against real recent emails (and a pasted
  email) showing which rule matches + why, without applying.
- Acceptance: undo reverses an applied archive/label; test shows reasoning.
- Tests: undo restores prior folder/flags; test endpoint returns match+reason
  without mutating.

### Phase 7 — Learned patterns + writing-style derivation — ✅ SHIPPED
Writing-style derivation (Phase 2) + learn-from-edits (Migration 28): the
assistant's draft is captured per thread (`email_ai_drafts`); on send, the sent
body is diffed and an LLM distils one durable preference into
`email_learned_patterns` (deduped/weighted), injected as `<learned_patterns>`
into the drafter and viewable/removable in Assistant → Settings.
- Derive writing style from sent mail; learn from user edits to drafts; feed
  back into the drafter.
- Acceptance: style summary generated from sent corpus; edited-draft deltas
  stored as patterns.
- Tests: style summarizer over a fixture corpus; pattern capture on edit.

### Phase 8 — Reply intelligence & advanced drafting/classification context
The drafter and classifier now match inbox-zero's *inputs*; this phase brings the
deeper learning/retrieval systems. Audit done 2026-06-24 against
`reference/inbox-zero/apps/web/utils/ai/{reply,choose-rule}`.

**✅ Shipped (2026-06-24):**
- Full **thread context** to the drafter (oldest→newest), at both the rule
  `DRAFT_EMAIL` action and the manual draft endpoint (`_fetch_thread_context`).
- **Similar-thread precedent** — a topic-focused Mem0 retrieval surfaces
  semantically similar past emails (inbox-zero `<email_history>`).
- **Past replies to this sender** — `_fetch_sender_reply_examples` mines Sent
  mail for tone/brevity mirroring (inbox-zero `<sender_reply_examples>`).
- **Today's date** passed to the drafter.
- (Already had: writing style, knowledge base, personal instructions, learned
  patterns — all injected via the enriched `about`.)
- **Classifier inputs parity** — To/Cc + owner address + about + date + the
  inbox-zero classification guidelines (Phase 4-adjacent, shipped 2026-06-24).

**Backlog — ALL SHIPPED 2026-06-24:**
- ✅ **Classification feedback as soft hints** — the classifier gets an advisory
  summary of how mail from this sender was classified before (from
  `email_executed_rules`, `_fetch_classification_hints`), distinct from the hard
  learned patterns. inbox-zero's `classificationFeedback`.
- ✅ **P1 · Scoped reply-memory system** — `email_learned_patterns` upgraded
  (migration 38) with kind (FACT/PROCEDURE/PREFERENCE) + scope
  (SENDER/DOMAIN/TOPIC/GLOBAL). `_llm_extract_reply_memories` extracts scoped
  memories from the draft→sent diff; GLOBAL inject via `about`
  (<learned_patterns>), SENDER/DOMAIN/TOPIC via `_fetch_reply_memories`
  (<reply_memories>, prioritised SENDER>DOMAIN>TOPIC). Mirrors `reply-memory.ts`.
- ✅ **P2 · Auto-refreshing learned writing style** — PREFERENCE memories accrue
  as style evidence; `_maybe_refresh_learned_style` regenerates
  `learned_writing_style` (migration 39) once enough new evidence lands, injected
  as advisory <learned_writing_style> (explicit writing_style outranks it).
- ✅ **P2 · Granular draft-confidence rubric** — the NO_DRAFT gate reasons with
  inbox-zero's HIGH/MEDIUM/LOW grounded-vs-assumption criteria.
- ✅ **P3 · `isPrimary` in multi-rule** — `_llm_pick_rules` marks one match
  primary (most specific); it's ordered first, then canonical order.

**Classification learned-patterns (email_rule_patterns) — parity audit 2026-06-24:**
- ✅ Storage (FROM/SUBJECT, include/exclude, per-rule), create-on-AI-match, Fix-flow
  teaching (FROM+SUBJECT), short-circuit use before the LLM.
- ✅ Matching parity (shipped): FROM is now *bidirectional* substring and SUBJECT
  matches with numbers/IDs/parens generalised away (`_generalize_subject`) —
  mirrors inbox-zero `find-matching-group.ts` + `generalizeSubject`.
- ✅ **Learn from manual labels in the email client (shipped 2026-06-24).** The
  incremental sync now diffs old-vs-new `categories` per message; a user-added
  category that maps to a rule (by rule name or its LABEL action) teaches a FROM
  **include** pattern (`source=LABEL_ADDED`), a removed one teaches **exclude**
  (`source=LABEL_REMOVED`) — via `_build_label_rule_map` + `_learn_from_label_changes`
  in `transport/sync.py`. Gated to incremental syncs (deep/full replay history).
  User vs rule changes separate automatically: rule-applied labels are written to
  local categories synchronously, so they don't show as a sync delta. Mirrors
  inbox-zero `process-label-added-event` / `record-label-removal-learning`.
- ⚠️ Design nuance: our auto-learn fires on every AI match (eager); inbox-zero
  gates on a *consistent* multi-email sender history + AI verification
  (`analyze-sender-pattern`). Ours is cruder but simpler.

**Deferred (bigger / dependency-gated):**
- **Calendar / scheduling context** in drafts (booking link + availability) —
  needs a calendar integration first.
- **PDF attachment context** — extract attached-PDF text into the draft context.
- **External MCP / CRM tools context** — inbox-zero pulls CRM/task-manager data;
  we approximate with the sales/task-manager specialist agents today and will
  wire real MCP tools in as Command Center's MCP integrations land.

### Cross-cutting
- Gmail Pub/Sub push parity (Outlook Graph push already shipped).
- Mirror BYOK block into non-streaming `run_agent`.

---

## 5. The email MAF agent (target architecture)

inbox-zero's assistant is a tool-using agent that manages rules and drafts.
Ours (`apps/agent-email-assistant`) must reach equivalence:

- **Model:** LiteLLM tier (default `tier-balanced` → DeepSeek), selectable per
  account via `agent_model`.
- **Instructions:** persona + drafting playbook (ground facts, plain text,
  match language, confidence, handoff). Extend with KB-lookup + style usage +
  needs-reply policy.
- **Tools (have):** list_accounts, search/read emails, find_urgent/needs_reply,
  overview, manage_inbox, draft_reply, categorize_senders, get_sender_categories,
  rules CRUD, update settings, suggest_unsubscribes.
- **Tools (add):** knowledge-base read/write, get_writing_style,
  get_personal_instructions, mark_needs_reply / list_to_reply.
- **Drafting path:** `_agent_draft_reply` → MAF agent with injected context
  (style + KB + personal instructions + memory + sibling agents).

---

## 6. "Which emails get drafted?"

Answer to the recurring question: **only emails the system decides need a
reply** — not every email. Today that's any email matching a *To Reply* rule.
Target (Phase 2): a dedicated needs-reply classifier (Reply Zero) marks the
set, and a "Draft replies" toggle (Phase 1) decides whether drafts are created
automatically for that set or only on demand.

---

## 7. Testing strategy (app-wide suite)

See [`tests/README.md`](../../tests/README.md) for structure. Principles:

- **Unit tests** (`tests/unit/`, CI-gated, no network/DB): mock provider + DB +
  LLM; test pure logic and dispatch. This is where email-feature tests live
  (`test_email_*.py`), matching existing conventions (`pytest-asyncio` auto,
  `AsyncMock` + `patch`, `TestClient` for routes).
- **Integration tests** (`tests/integration/`, `@pytest.mark.integration`,
  opt-in): require the docker stack; exercise real DB/provider paths.
- **Frontend e2e** (`workbench/control_plane/e2e/`, Playwright).
- **Every phase adds tests** for its acceptance criteria before it's "done".
- Run: `uv run pytest tests/unit/ -q` (fast) · `make cov` (coverage) ·
  CI runs `tests/unit/ -x -v` on PR.

Email coverage target by phase:

| Phase | Test files |
|---|---|
| 0 | `test_email_rules_engine.py`, `test_email_webhook.py`, `test_email_assistant_settings.py`, `test_email_categorization.py` |
| 1 | + `test_email_knowledge.py` |
| 2 | + `test_email_drafting.py`, `test_email_needs_reply.py` |
| 3 | + `test_email_followups.py` |
| 4 | + `test_email_rule_conditions.py` |
| 6 | + `test_email_history_undo.py` |

---

## 8. Backlog (post-parity)
Calendar tools in replies, AI "Clean" flow, attachment auto-filing, meeting
briefs, Slack / scheduled send. (Carried from `email_ai_assistant.md` §14.)

---

## 9. Deferred backend hardening (from the code review) — TODO later

These came out of the multi-agent code review. The **critical/high bugs were
already fixed and deployed** (DB-engine leak, Outlook delta token, digest
due-check, ai_chat IDOR, send_email token persistence, backfill body,
agent `follow_up_days`). **The items below do NOT affect current functionality**
at the present single-primary-user scale — they're robustness / scalability /
maintainability work to do before the email app is opened to many concurrent
users/accounts. Do the quick correctness wins first, then the structural ones as
a separate, tested pass.

### Quick correctness wins (low risk)
- **401-retry on mid-session token expiry** (`providers/outlook.py`,
  `providers/gmail.py`): the live `AsyncClient` freezes the access token when
  first built; a token expiring during a long sync 401s with no refresh-and-retry
  and flips the account to `error` even though the refresh token is valid. Fix:
  on 401, refresh + rebuild `_http` (or null it after refresh) and retry once.
- **`find_urgent` / OR-search** (`agents.py` + gateway `list_messages`): the
  agent sends `"urgent OR deadline OR …"` into `plainto_tsquery`, which ignores
  `OR` and ANDs all terms → almost never matches. Fix: `websearch_to_tsquery`
  for that path, or per-term searches merged.
- **Webhook `clientState` when unset** (`microsoft_webhook`): reject
  notifications when no `clientState` is stored (currently skips the check if
  NULL); use `secrets.compare_digest`.
- **`update_message`/`delete_message` best-effort blocks** re-raise provider
  `HTTPException`, failing a user action whose local DB change already committed.
  Don't re-raise inside the best-effort provider block.

### Scalability (do before multi-user scale)
- **OAuth `state` → Redis** (`email.py` `_oauth_states`): in-memory dict breaks
  multi-worker deploys and on restart; move to Redis + TTL (`_get_redis()` exists).
- **Don't hold a DB session across LLM/provider I/O** (`_run_rules_job`,
  `update_message`): release the connection before slow calls; re-acquire to
  write results. Prevents pool starvation under concurrency.
- **LLM batching + global concurrency cap**: rule-matching makes one LLM call
  *per email* (`_llm_pick_rule`), per cycle, per account, with no shared cap.
  Batch emails per call; bound concurrent LLM calls with a shared semaphore /
  per-account daily budget. Biggest cost/latency risk at scale.
- **N+1 queries + indexes**: `list_accounts` (unread per account), `_load_rules`
  (actions per rule, re-fetched per email in the match loop), `reorder_rules`
  (UPDATE per rule) → batch with aggregates / `LEFT JOIN` / `unnest`. Add index
  `email_messages(account_id, thread_id, received_at DESC)` for the
  `DISTINCT ON (thread_id)` reply-zero/classifier queries; add a FK + index on
  `email_thread_status.last_message_id` and make the reply-zero JOIN a LEFT JOIN.

### Maintainability (dev scalability)
- **Split `email.py`** (~5.6k lines) into a package: `routers/{accounts,messages,
  rules,senders,oauth,webhook}.py` (thin HTTP) + `services/{db,providers,
  rules_engine,classify,oauth_state}.py`. Centralize the duplicated
  provider-instantiation block (use the existing `_instantiate_provider`
  everywhere). Pair this with the shared session-factory.

### Minor / informational
- Return generic client errors (some handlers echo raw provider exception text
  that can embed tokens/URLs); sanitize `sync_error` before persisting; encode
  `Content-Disposition` filename (header-injection guard).
- IMAP is INBOX-only and its flag two-way-sync is a base no-op (documented
  limitation, not a regression) — namespace UIDs by folder before syncing
  Sent/Drafts.
- History tab: full per-message timeline view (Phase 6 remainder).
