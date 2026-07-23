# WhatsApp Message Manager — plan & feature brainstorm

> **Product:** CommandCenter · **Feature:** WhatsApp channel vertical (channel #2, after email)
> **Created:** 2026-07-23 · **Status:** 🧠 **PLANNING** — feature set, value map, architecture
> options and UI mockups; no code yet.
> **Mockups:** `mockups/whatsapp_message_manager.html` (7 screens, control-plane visual language)
> **Anchors:** ADR-007 (WhatsApp via Meta Cloud API), `email_app_master_plan.md` (the vertical
> to mirror), `agent_registry.json` → `agent-triage` ("email / WhatsApp / meeting triage").

This doc is the "what and why" for managing WhatsApp the way the email app manages
mail: see what needs a reply, auto-handle the routine, digest the rest, categorize
senders — plus the things WhatsApp uniquely needs (groups, labels, voice notes,
multilingual threads) and an AI companion to run it hands-free. The audience is a
founder-CEO whose *actual* inbox is WhatsApp: in this business, customers, dealers,
vendors, service escalations, payments, the team, investors and family all arrive
on the same thread list, with no Cc, no folders and no off switch.

---

## 1. The problem, stated honestly

Email got fixed: the email vertical ships a ranked reply queue, sender categories,
learned rules, drafts in the user's voice, a daily digest-dashboard and an
assistant agent with 42 tools. WhatsApp — the channel where an Indian hardware
company actually transacts — still runs raw on a phone:

1. **It's an interrupt stream, not an inbox.** 200+ messages/day across 300+
   chats; the one ₹11 L purchase order sits between a dealer-group meme and a
   school parents' group. There is no triage surface at all.
2. **Groups bury the signal.** 18 dealer/team groups × dozens of messages; the
   one @mention that needed the founder dies above the fold.
3. **Promises evaporate.** "Installation by month-end" typed at a red light never
   becomes a task. Nobody chases what the *other* side promised either.
4. **Everything needs the founder because nothing carries context.** Only the
   founder knows this sender owes ₹3.2 L — the phone can't say so. So the phone
   *is* the CRM, and the CRM is a human.
5. **The routine eats the day.** Order-status asks, price-list requests,
   "location?" — identical answers, typed by hand, 40× a day.
6. **It never closes.** Family and VIP customers share one notification channel;
   the only options are "always on" or "missing things".

### The high-level value we sell (to ourselves)

| # | Value | One-line proof |
|---|---|---|
| V1 | **An obligation queue, not a chat list** | Open to 7 ranked "needs reply" items, not 300 unreads |
| V2 | **Hours back daily** | Routine asks answered from Odoo/price-list automatically, with an audit log |
| V3 | **No dropped promises — either direction** | Commitments extracted from both sides' messages, tracked into tasks, nudged |
| V4 | **Groups become one paragraph** | Per-group daily summaries; @mentions surface instantly |
| V5 | **The whole company standing behind every reply** | Zoho deal, Odoo ledger, ClickUp tasks, email history beside the thread |
| V6 | **Your voice at scale** | Drafts in the founder's WhatsApp register (short, warm, emoji-tolerant, Hinglish-aware) — never auto-sent to people who matter |
| V7 | **Calm by policy** | Per-category notification/escalation policy; digest catches the rest; Focus Shield holds pings |
| V8 | **Trust through visibility** | Every automated action listed, reviewable, revocable — same doctrine as email rules |

---

## 2. What already exists to build on (ecosystem fit)

The email vertical is the template; almost every hard part has a proven home.
This is the single strongest argument for building WhatsApp *inside*
CommandCenter rather than buying a WhatsApp inbox SaaS.

| WhatsApp need | Existing machinery to mirror/reuse | Where |
|---|---|---|
| Channel connector abstraction | `BaseEmailProvider` ABC + normalized message dataclasses + `factory.build_provider` | `apps/services/email_ingestion/email_ingestion/providers/` |
| Continuous sync per account | Per-account asyncio scheduler, incremental cursor, backoff, hot add/remove | `email_ingestion/scheduler.py` |
| One write path | Shared `upsert_message()` ON CONFLICT upsert | `email_ingestion/persist.py` |
| New-message pipeline | Post-sync hook registry (classify → thread status → digest → follow-ups), layering-inverted | `email_ingestion/post_sync.py` + `gateway/routes/email/scheduler_hooks.py` |
| Classifier | Deterministic learned patterns first, then tier-fast LLM rule pick with guidance/hints | `gateway/routes/email/automation/engine.py` |
| Needs-reply model | Reply Zero thread status (NEEDS_REPLY / AWAITING / FYI / DONE) | `automation/replyzero.py`, `email_thread_status` |
| Drafts in the user's voice | 5-layer voice priority (explicit style > voice profile > learned style), sender examples, quote-stripped learning | `automation/drafting.py`, `voice_profile.py` |
| Digest + dashboard | One `_generate_digest()` computation, two projections (mail + in-app dashboard) | `routes/email/digest.py` |
| Rules with nested learnings | `email_rules` + `_actions` + `_executed_rules` + `_rule_patterns` + `_rule_guidance`, one Rules screen | migrations 19/21/31/85/87 + `RulesTab.tsx` |
| Sender rollups | `email_senders` category projection + auto-learn with consent | `automation/senders.py` |
| Message → task | `TaskCaptureModal` + `routes/tasks/capture_email.py` (`origin.emailId` → `origin.waMessageId`) | tasks routes |
| Assistant with tools + HITL | `agent-email-assistant` (42 tools, `request_confirmation` fail-closed) | `apps/agents/agent-email-assistant/agents.py` |
| Outward-write approval | Action Broker approval queue — a WhatsApp send to 18 groups is exactly what it exists for | `apps/services/action_broker/` |
| Entity linking phone ↔ CRM | graphiti/mem0 + `skills/triage/entity_link` | `packages/acb_memory/`, skills |
| Credentials | Integration Registry + BYOK encrypted key store (ADR-022) | `packages/acb_llm/key_store` |
| Model tiering | `rule_model` tier-fast / `draft_model` tier-powerful / `chat_model` tier-balanced per account | `email_assistant_settings` pattern |

**What does *not* exist:** any messaging transport. The Slack/Telegram "coming
soon" UI in `RulesTab.tsx` is flagged dead code in the email master plan. WhatsApp
is greenfield channel #2 — we mirror the email vertical's *shape*, not its code
paths, and we resist inventing a premature generic "channels framework" until the
second messenger proves the abstraction (same doctrine the email app used:
single-provider first, generalize later).

---

## 3. Integration landscape → recommended architecture

### 3a. The field (researched 2026-07)

| Approach | What it is | Pros | Cons |
|---|---|---|---|
| **wacli** (openclaw) | Go CLI on **whatsmeow**: QR-pairs as a linked Web device, mirrors to SQLite+FTS5, send/search/webhooks, multi-account | Proven local-first mirror design; exactly our sync model; agent-friendly | Third-party protocol → **ban risk**; CLI, not a service |
| **whatsmeow** (library) | Go library speaking the multidevice Web protocol directly | Full access: all chats, groups, history backfill, media, label app-state; no browser | Same ban risk; we own protocol churn |
| **Baileys** | TypeScript equivalent of whatsmeow | Popular, active | Same risk; adds a Node runtime to a Python shop |
| **whatsapp-web.js** | Puppeteer-driven headless WhatsApp Web | Easy | Heaviest, most fragile, same risk |
| **WhatsApp MCP servers** (e.g. lharries/whatsapp-mcp) | whatsmeow bridge + MCP tool surface for agents | Validates the "agent runs your WhatsApp" UX | Personal-scale; no triage/store discipline |
| **WhatsApp Business Cloud API** | Meta's official API — the only official path for new integrations since Oct 2025 | ToS-safe, webhooks, templates, no ban risk | Business number only; 24 h customer-service window; per-template pricing; historically no chat history |
| **Cloud API + Coexistence** | Embedded-Signup QR links an **existing WhatsApp Business app number** to Cloud API; app keeps working | Official *and* rich: ~6 months history synced at onboarding, both-direction mirroring via webhooks (incl. messages typed on the phone), Business app labels stay usable on the phone | Business app numbers only; label objects live app-side (we mirror, see 4.2); regional availability caveats |

### 3b. Decision: two lanes, one pipeline (extends ADR-007)

ADR-007 already picked Meta Cloud API. Coexistence (which post-dates that ADR)
removes its biggest historical downside — the empty-history cold start — and is
how we "connect with the WhatsApp Business settings" the user already has.

- **Lane A — official, default, the company number.** WhatsApp Business Cloud
  API with **coexistence** via Embedded Signup. The founder's Business app keeps
  working on the phone; we get webhooks for everything (both directions), ~6
  months of history, template sends outside the 24 h window, zero ban risk.
  *This is the lane all business automation runs on.*
- **Lane B — linked-device bridge, opt-in, the personal number.** A small
  sidecar service (`apps/services/wa_bridge/` — Go, whatsmeow, wacli as the
  reference implementation) that QR-pairs as a linked device, mirrors messages
  into the same store, and can read/write label app-state. Runs with explicit
  ban-risk consent in the UI, per-number. *Read-mostly by default; sends from
  Lane B are rate-guarded and drafts-only unless the user opts up.*

Both lanes normalize into **one message store and one pipeline** — a
`WhatsAppProvider` implementing the same conceptual contract as
`BaseEmailProvider` (`sync_messages → SyncResult`, `send_message`, cursors), so
triage/drafts/digest/rules are transport-blind. A founder can run Lane A on the
company line and Lane B on the personal SIM; policies differ per account
(personal defaults to *surface-only*: no auto-replies, no auto-drafts to Family).

**Deliberate scope cuts for v1:** no multi-seat shared inbox (single-founder,
same as email's single-mailbox doctrine), no bulk marketing campaigns (that's a
BSP product and a spam vector), no payments-in-chat.

---

## 4. Feature set (ranked brainstorm)

### 4.1 The Reply Queue — WhatsApp Reply Zero ⭐ the core

- Every chat carries a status: **NEEDS_REPLY / AWAITING / FYI / DONE**
  (replyzero ported; clamps to AWAITING when we spoke last). Groups get a
  variant: **needs-you** only when @mentioned, directly addressed, or a
  question lands in a group where the founder is the obvious answerer.
- Dashboard ranks by `sender importance × intent × age × deadline language`
  ("by today", "client demo tomorrow") — same priority spirit as the email
  reply queue. Every row carries its prepared next action: ✍️ draft ready,
  → task hand-off, or open-thread.
- The five dashboard numbers: needs reply · commitments due · waiting on them ·
  auto-handled · muted. Unread count is deliberately absent (V1).

### 4.2 Categories = WhatsApp Business labels, upgraded to policy carriers ⭐

- **Two-way label sync.** Lane A: mirror labels via coexistence app-state
  where exposed; Lane B: whatsmeow reads/writes label app-state natively.
  Fallback (API gaps): labels import one-way at onboarding and we own the
  mapping table thereafter — the UI marks 🏷 synced vs local, and field staff
  using the phone's Business app keep seeing the same labels either way.
- A category answers four questions (this is the upgrade — labels become
  behavior): **notify** (instant / digest / @mention-only / never),
  **auto-reply** (never / holding reply / answer-from-system), **AI drafts**
  (always-ready / on-intent / never), **escalate if unanswered** (2 h → push…).
- Ships with defaults mapping the Business app's stock labels (New customer,
  Order, Pending payment, Paid) + ours (★ VIP, Team, Vendors, Dealer groups,
  Family, 🔇 Noise). `Uncategorized` is a state, not a label (email doctrine).
- **Auto-learn with consent:** classifier proposes homes for new senders
  (message content + phone-number ↔ Zoho/Odoo contact match); acceptances
  become visible learned patterns under the Rules screen.
- **AI stays out of Family by default.** Surfaced, never drafted. This line
  buys more founder trust than any feature.

### 4.3 Drafts in your WhatsApp voice ⭐

- Reuses the 5-layer voice stack, but learns a **separate register per
  channel and per relationship**: WhatsApp ≠ email (shorter, warmer, emoji,
  "🙏", Hinglish code-switching); dealer ≠ investor ≠ service engineer.
- **Reply in the sender's language.** Detect Hindi/Kannada/Tamil/English (or
  mixed), draft in kind, one-tap switch. This is table stakes for the dealer
  network and something no US-built inbox tool does well.
- Variant chips on every draft: shorter · warmer · drop-the-ask · translate.
- Never auto-sent on VIP/Family; elsewhere per the category's autonomy setting.

### 4.4 Standing rules + the autonomy ladder

- Office-hours autoresponder with an URGENT escape hatch that pages the founder.
- **Answer-from-system rules:** order status from Odoo (live status + AWB),
  price-list PDF on request, catalog/spec-sheet sends. Read-only answers may
  fully automate; anything committing money/dates/reputation is drafts-only.
  The ladder is per-rule and visible.
- **Payment-chase cadence** on 🏷 Pending payment: 7d polite → 14d firmer +
  accounts CC'd via email (cross-channel!) → 21d escalation pack to founder.
- **Plain-language rule compiler** ("when a dealer asks for the edu deck, send
  the latest PDF and label them Edu-pipeline") → compiled rule shown for
  approval — same `email_rules.instructions` pattern.
- **Hard guardrails (not AI-editable):** never auto-send to VIP/Family; no
  prices outside the published list; never promise delivery dates; ≤20
  auto-replies/hour; personal number drafts-only; every send audit-logged.
  Rules show honest stats ("41 handled, 0 corrections") — trust is earned.

### 4.5 Digest + dashboard (projection pattern)

- WhatsApp section joins the existing morning digest email and in-app
  dashboard: ≤3 "needs you first" items with prepared actions, commitment
  watch, group roll-up, the trust ledger (handled + muted, sample-checked).
- Same `_generate_digest`-style single computation, two projections.

### 4.6 Commitment & waiting-on tracking (both directions) ⭐

- Extract commitments from **our outbound** ("installation by month-end") →
  reconcile against `gtd_items`/calendar → digest flags the promise that never
  became work → one tap creates the task (`origin.waMessageId`).
- Extract **their** promises ("will send AWB tomorrow") → waiting-on strip with
  aging + one-tap ✍️ nudge drafts (email's per-thread Nudge, ported).
- Silence triggers: "remind me if no reply in 2 days" armed from any thread.

### 4.7 Group intelligence

- Per-group daily/weekly AI summaries (dealer sentiment, questions asked,
  decisions made); quiet groups report as "nothing for you".
- @mention/direct-address detection promotes a group into the reply queue.
- **Broadcast composer:** summarize-then-respond ("draft a monsoon delay update
  to all dealer groups") — always through the Action Broker approval gate.

### 4.8 The person, cross-channel ⭐ the moat

- Context rail beside every thread: Zoho deal stage & lifetime value, Odoo
  invoices (overdue!), ClickUp open loops, recent email, past commitments.
  Phone-number ↔ contact entity linking via graphiti + `entity_link` skill.
- The killer save: AI reads the incoming PO (4.10), sees the overdue invoice,
  and the draft confirms specs *and* nudges payment — before the founder
  extended more credit by reflex.
- One-tap: chat → ClickUp task, → CRM note, → email thread continuation.

### 4.9 AI companion — run WhatsApp by talking ⭐

- Not a new app: the existing Control-Plane chat (and its mobile PWA) gains a
  `wa.*` toolset on `agent-triage` / a new `agent-whatsapp-assistant`,
  mirroring the email agent's tool families: read/triage (`wa_find_needs_reply`,
  `wa_summarize_group`, `wa_query`), actions (`wa_draft_reply`, `wa_send` —
  HITL-gated), categories (`wa_categorize`), rules, digest.
- The scenarios that matter: *"What did I miss during the board meeting?"* ·
  *"Reply to Rajesh — confirm specs, keep the payment ask warm"* · *"What is
  the dealer network saying about monsoon delays? Draft a broadcast."* ·
  *"Who am I ignoring?"* · *"Mute Dealer North till Monday."*
- Voice-first works because the agent holds the queue + drafts + context; the
  founder supplies one sentence of judgment from a cab.

### 4.10 Media understanding

- POs/invoices/screenshots → OCR + structured extraction (amount, items,
  delivery terms) feeding drafts and CRM notes.
- Voice notes → transcription (acb_stt exists for the Note Taker) → searchable,
  summarized, triaged like text. Dealer voice notes are a way of life.

### 4.11 Search & memory

- FTS + semantic search across all WhatsApp history (wacli's SQLite+FTS5
  validates the shape; we land in Postgres + pgvector like email).
- "What did we quote Meher in March?" answers across WhatsApp *and* email.

### 4.12 Focus integration

- WhatsApp joins the Focus Shield: pings held during focus blocks, released at
  breaks. **WhatsApp windows** (like Email windows) become schedulable calendar
  blocks — the digest's "clear in 10 min ▸" deep-links into one.

---

## 5. AI implementation notes

| Concern | Approach |
|---|---|
| Intent classification | Mirror `engine.py`: learned deterministic patterns short-circuit → tier-fast LLM picks rule/intent with guidance + history hints. Intent taxonomy: `order_status · quote_request · payment · service_issue · scheduling · social · spam/promo` |
| Chat status | replyzero port; per-chat not per-thread (WhatsApp has no threads); group needs-you detection adds @mention/direct-address/answerable-question signals |
| Drafting | `drafting.py` pattern: thread history + sender examples + semantically-near past sends + system context (Odoo/Zoho blocks when intent warrants) on `draft_model` (tier-powerful); LLM failure returns sentinel, never a fake draft |
| Voice | `voice_profile.py` extended with `channel` + `audience` dimensions; learned from the user's own past WhatsApp sends (quote-stripped, their side only) |
| Language | Detect per-message; draft in the thread's language; translation layer for the founder's reading pane (auto-translate toggle) |
| Commitments | Extraction prompt over outbound+inbound at classify time; writes candidate commitments; reconciler-style nightly diff against tasks/calendar |
| Cost control | Groups classified as digest-tier by default (batch summarization, not per-message LLM); Noise category exits the pipeline after cheap pattern checks; per-role model overrides as in `email_assistant_settings` |
| HITL | All sends via `request_confirmation` fail-closed; broadcast + bulk actions via Action Broker queue; autonomy ladder only ever widened by the human |
| Auditability | `wa_executed_rules` mirror + the dashboard trust ledger; every auto-send links to the rule that caused it |

---

## 6. Data model (mirrors email migrations 17→94)

```
wa_accounts        id, user_id, phone_number, display_name, lane('cloud_api'|'bridge'),
                   credentials_encrypted, sync_enabled, sync_status, last_sync_cursor,
                   webhook fields (lane A) / device session blob (lane B), initial_sync_done
wa_chats           id, account_id, wa_chat_id (JID), kind('dm'|'group'|'broadcast'|'community'),
                   name, participants jsonb, category_id, is_muted_upstream, UNIQUE(account_id, wa_chat_id)
wa_messages        id, account_id, chat_id, wa_message_id, direction, sender jsonb, kind
                   ('text'|'image'|'video'|'audio'|'voice'|'document'|'sticker'|'location'|
                    'contact'|'reaction'|'system'), body_text, transcript_text, media_ref,
                   quoted_wa_message_id, mentions text[], categories text[], intent,
                   sent_at, synced_at, rules_processed_at, UNIQUE(account_id, wa_message_id)
                   + FTS index + embeddings (pgvector)
wa_media           message_id, mime_type, size_bytes, storage_path, ocr_text, transcription_status
wa_contacts        account_id, phone_number, display_name, category_id, category_source,
                   entity_ref (graphiti/Zoho link), UNIQUE(account_id, phone_number)
wa_labels          account_id, wa_label_id, name, color, sync_state('synced'|'local'|'import_only')
wa_chat_status     PK(account_id, chat_id), status(NEEDS_REPLY|AWAITING|FYI|DONE),
                   reason, last_message_at, follow_up_reminded_at
wa_commitments     id, account_id, chat_id, message_id, direction('ours'|'theirs'), text,
                   due_hint, status(open|done|dismissed), gtd_item_id nullable
wa_rules / wa_actions / wa_executed_rules / wa_rule_patterns / wa_rule_guidance
                   — structural mirrors of the email quintet
wa_ai_drafts       (account_id, chat_id), draft_text, language, register
wa_assistant_settings
                   per-account: autonomy defaults, office_hours, guardrails, digest config,
                   rule_model/draft_model/chat_model, family_hands_off bool (default true)
```

Categories live as first-class rows (not just `text[]`) because they carry
policy: `wa_categories(id, account_id, name, icon, wa_label_id nullable,
notify_policy, auto_reply_policy, draft_policy, escalate_after_mins)`.

---

## 7. UI/UX — the seven screens (see mockups)

| # | Screen | What it proves |
|---|---|---|
| 1 | **Connect** | Two honest paths (QR linked-device w/ visible ban-risk vs Cloud API coexistence), multi-number, one pipeline |
| 2 | **Dashboard** | Obligation queue + category chips (🏷 = synced label) + waiting-on strip + auto-handled trust ledger |
| 3 | **Conversation + copilot** | WhatsApp-familiar thread; context rail (Zoho/Odoo/ClickUp/email); AI-read attachments; draft-in-voice composer with variant chips + language toggle |
| 4 | **Categories** | Labels as policy carriers (notify/auto-reply/drafts/escalation), AI suggestions with accept-all |
| 5 | **Rules** | Standing behaviors + nested learnings + honest stats + hard guardrails + plain-language compiler |
| 6 | **Digest** | Needs-you-first ≤3, commitment watch, group roll-up, trust ledger, "clear in 10 min" |
| 7 | **Companion chat** | Triage-by-conversation on mobile PWA; broadcast with approval gate |

Placement in the control plane: a `/whatsapp` route sharing the email app's
three-pane skeleton and automation-overlay pattern (`AutomationView` host with
chat / settings / digest-dashboard / analytics features), so muscle memory and
components (QuickFilters, LabelChip, TaskCaptureModal) transfer.

---

## 8. Competitive positioning (why not buy?)

| Tool | What it is | Why it doesn't solve this |
|---|---|---|
| Periskope, TimelinesAI, Cooby | WhatsApp shared inboxes / CRM syncers for teams | Team-inbox economics, generic AI, no founder-personal triage, and none can see your ERP ledger, tasks, calendar or email while drafting |
| WATI / Interakt / BSP suites | Cloud-API marketing + support bots | Campaign/bot-first, not inbox-management; nothing for the founder's own thread list |
| whatsapp-mcp and kin | Agent bridges | Right instinct (agent runs your WhatsApp), no store, no triage discipline, no HITL, no trust ledger |
| **Us** | The founder's whole company (CRM/ERP/tasks/email/calendar/memory) standing behind every WhatsApp reply, with email-grade triage doctrine | The moat is the context graph + the already-earned trust patterns, not any single feature |

---

## 9. Risks & open questions

| # | Risk / question | Position |
|---|---|---|
| R1 | **Lane B ban risk** (unofficial protocol; bans are permanent) | Opt-in with explicit in-UI consent; personal number only; read-mostly; rate-guarded sends; never the company line. Revisit if Meta expands coexistence to personal numbers |
| R2 | **Label API coverage** in coexistence is partial/evolving | Design assumes import-once + local ownership as the floor; two-way sync where the API allows; `sync_state` per label keeps the UI honest |
| R3 | **24 h window + template pricing** on Lane A | Auto-replies are session messages (free, inside window); proactive nudges outside the window need approved templates — the nudge composer must know which regime it's in and show it |
| R4 | **Privacy: this pipes personal life through LLMs** | Family/personal categories are hands-off by default (surface, never draft, never auto-handle); per-category AI opt-out; all processing through the gateway's existing BYOK/routing; audit log |
| R5 | **India DPDP / consent** for storing counterparty messages | Same posture as email (we store our own correspondence); document retention policy; deletion honored via reconcile pass |
| R6 | **Group consent optics** (summarizing communities) | Summaries are private to the founder — no content leaves; broadcast sends always human-approved |
| R7 | **Meta platform churn** (coexistence is new) | Transport isolated behind the provider seam; worst case Lane A degrades to standard Cloud API (no history) and Lane B carries history |
| R8 | Where does `wa_bridge` run? | Sidecar container in the compose stack (Go, whatsmeow), speaking signed webhooks to ingestion — wacli's architecture, service-ified. Decide build-vs-embed at W1 |

---

## 10. Suggested phasing

- **W0 — Pipe + store (no AI):** `wa_bridge` sidecar (Lane B, personal or test
  number) → `wa_accounts/chats/messages/media` + upsert + FTS; read-only
  three-pane UI; Connect screen. *Exit: founder reads & searches all WhatsApp
  history in the control plane.*
- **W1 — Official lane + send:** Cloud API + coexistence onboarding (Embedded
  Signup), history import, label import, webhook mirroring; send with HITL;
  message → task capture. *Exit: company number lives in both the phone app and
  CommandCenter; replies sent from the dashboard.*
- **W2 — Triage brain:** classifier + chat status + categories-as-policy +
  reply queue dashboard + digest section + auto-handled ledger. *Exit: the
  founder stops opening the phone app to find out what matters.*
- **W3 — Voice + automation:** drafting with WhatsApp voice profile +
  multilingual replies; standing rules (office hours, order-status
  answer-from-Odoo, payment cadence); commitment/waiting-on extraction +
  nudges. *Exit: ≥50% of routine asks auto-handled with 0 corrections/wk.*
- **W4 — Companion + groups:** `wa.*` agent tools in control-plane chat + mobile
  PWA; group summaries + broadcast-with-approval; media OCR + voice-note
  transcription; Focus Shield / WhatsApp windows. *Exit: a full day managed
  from the companion without opening WhatsApp.*

Each phase lands behind the existing patterns (provider seam, hook registry,
rules quintet, HITL) so nothing here forks the architecture — WhatsApp is the
proof that the email vertical's shape was a *channel* shape all along.
