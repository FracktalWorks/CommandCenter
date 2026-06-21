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

### Phase 2 — Drafting overhaul (the email agent) — 🟡 PARTLY SHIPPED
Done: writing style + personal instructions + knowledge base now injected into
the drafter (tagged blocks in the shared `about` context that feeds both the LLM
drafter and the MAF agent); `_llm_draft_reply` prompt honors them; a
"Generate writing style from sent mail" endpoint. Still pending below: the
first-class needs-reply (Reply Zero) classifier independent of a rule.
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

### Phase 3 — Follow-up reminders
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

### Phase 6 — History + Test parity
- History: per-message timeline with the rule, actions, **AI reasoning**, and
  **undo** of applied actions.
- Test: interactive run of rules against real recent emails (and a pasted
  email) showing which rule matches + why, without applying.
- Acceptance: undo reverses an applied archive/label; test shows reasoning.
- Tests: undo restores prior folder/flags; test endpoint returns match+reason
  without mutating.

### Phase 7 — Learned patterns + writing-style derivation
- Derive writing style from sent mail; learn from user edits to drafts; feed
  back into the drafter.
- Acceptance: style summary generated from sent corpus; edited-draft deltas
  stored as patterns.
- Tests: style summarizer over a fixture corpus; pattern capture on edit.

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
