# WhatsApp Message Manager — plan & feature brainstorm

> **Product:** CommandCenter · **Feature:** WhatsApp channel vertical (channel #2, after email)
> **Created:** 2026-07-23 · **Revised:** 2026-07-23 (v3 — calm-UI pass grounded in a prior-art
> study; v2 — official WhatsApp Business Platform only, per founder decision; unofficial
> linked-device routes dropped)
> **Status:** 🧠 **PLANNING** — feature set, value map, architecture and UI mockups; no code yet.
> **Mockups:** `mockups/whatsapp_message_manager.html` (7 screens + build notes, control-plane shell,
> rebuilt around a single organizing spine — see §7)
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

1. **It's an interrupt stream, not an inbox.** 200+ messages/day across 200+
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
| V1 | **An obligation queue, not a chat list** | Open to 7 ranked "needs reply" items, not 200 unreads |
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
| Outward-write approval | Action Broker approval queue — a WhatsApp broadcast to 18 groups is exactly what it exists for | `apps/services/action_broker/` |
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

## 3. Integration — the official WhatsApp Business Platform, only

**Decision (2026-07-23):** build exclusively on Meta's **WhatsApp Business Cloud
API** — the only supported path for new integrations since Oct 2025 — using
**coexistence** so the founder's existing WhatsApp Business app keeps working on
the phone. This confirms and extends ADR-007. Unofficial protocol bridges
(wacli / whatsmeow / Baileys / whatsapp-web.js) are **rejected**: they violate
WhatsApp's ToS and risk a permanent ban of the number — unacceptable for the
company line, and not worth maintaining a second transport for. Should Meta ever
open an official path for personal numbers, that becomes a new decision.

### 3a. What the official platform gives us

| Capability | How |
|---|---|
| Connect without losing the phone app | **Embedded Signup + coexistence**: scan a QR from the WhatsApp Business app; the number becomes API-enabled while the app keeps working |
| History | ~6 months of chat history synced at onboarding (delivered in phases — the Connect screen shows progress honestly) |
| Real-time, both directions | Webhooks mirror inbound *and* outbound — including messages the founder types on the phone — so the store is complete from day one |
| Labels | Business-app labels import at onboarding; mirrored two-way where the API exposes label events, `sync_state` per label keeps the UI honest (🏷 synced vs local) |
| Sends | Free-form replies inside each chat's **24 h customer-service window**; outside it, pre-approved **template messages** (per-message pricing) |
| Media | Documents, images, voice notes in and out via the media API |
| Trust | ToS-compliant, no ban risk, quality rating visible; business verification badge |

### 3b. Constraints we design around (not against)

| Constraint | Design response |
|---|---|
| 24 h service window | Window state is ambient UI: a header pill on every thread ("session open · replies free · 21 h left") and the composer switches to template mode automatically. Nudges/chases outside the window use an approved template set, with cost shown before send |
| Template approval latency | The standing-rules that need templates (payment chase, follow-up nudge) ship with a small pre-approved template library created at onboarding |
| Business numbers only — no personal SIMs | Personal WhatsApp is **out of scope for v1**. The business line is where the business runs; family/personal contacts who message it get a hands-off category (surfaced, never AI-touched) |
| Label API coverage is partial/evolving | Import-once is the floor; two-way sync where events exist; per-label `sync_state` so the UI never lies about what's mirrored |
| Webhook delivery is at-least-once and can burst | Ingestion lands webhooks on a queue → the shared upsert path (idempotent on `wa_message_id`); a periodic reconcile job backfills gaps |
| Meta platform churn (coexistence is new) | All Meta specifics live behind the provider seam; worst case we degrade to standard Cloud API behavior (no history import) without touching triage/AI layers |

### 3c. Rejected alternatives (for the record)

wacli's architecture (QR-paired linked device via whatsmeow, local SQLite+FTS
mirror, webhook fan-out) remains a useful *design reference* for the sync/store
shape — but as a transport it is third-party protocol emulation: WhatsApp
actively bans numbers using it, bans are permanent, and no triage feature is
worth the founder's number. Baileys and whatsapp-web.js share the same
disqualifier. WhatsApp MCP bridges validate the "agent runs your WhatsApp" UX we
want, but with none of the store, triage or HITL discipline this plan requires.

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

- **Label import + mirror.** Business-app labels import at onboarding and
  mirror two-way where the coexistence API exposes label events; `sync_state`
  per label (🏷 synced vs local) keeps the UI honest, and field staff using
  the phone's Business app keep seeing the same labels either way.
- A category answers four questions (this is the upgrade — labels become
  behavior): **notify** (instant / digest / @mention-only / never),
  **auto-reply** (never / holding reply / answer-from-system), **AI drafts**
  (always-ready / on-intent / never), **escalate if unanswered** (2 h → push…).
- Ships with defaults mapping the Business app's stock labels (New customer,
  Order, Pending payment, Paid) + ours (★ VIP, Team, Vendors, Dealer groups,
  Family & personal, 🔇 Noise). `Uncategorized` is a state, not a label
  (email doctrine).
- **Auto-learn with consent:** classifier proposes homes for new senders
  (message content + phone-number ↔ Zoho/Odoo contact match); acceptances
  become visible learned patterns under the Rules screen.
- **AI stays out of Family & personal by default.** Surfaced, never drafted,
  never auto-handled. This line buys more founder trust than any feature.

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
  Outside the 24 h window the cadence uses the approved `payment_reminder`
  template — cost surfaced at the rule level.
- **Plain-language rule compiler** ("when a dealer asks for the edu deck, send
  the latest PDF and label them Edu-pipeline") → compiled rule shown for
  approval — same `email_rules.instructions` pattern.
- **Hard guardrails (not AI-editable):** never auto-send to ★ VIP or Family;
  no prices outside the published list; never promise delivery dates; ≤20
  auto-replies/hour; templates only from the approved set; every send
  audit-logged. Rules show honest stats ("41 handled, 0 corrections") —
  trust is earned.

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
  `wa_*` toolset on `agent-triage` / a new `agent-whatsapp-assistant`,
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

- FTS + semantic search across the synced WhatsApp history, landing in
  Postgres + pgvector exactly like email.
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
| Voice | `voice_profile.py` extended with `channel` + `audience` dimensions; learned from the founder's own past WhatsApp sends (quote-stripped, their side only) — the coexistence history import is what makes this possible on day one |
| Language | Detect per-message; draft in the thread's language; translation layer for the founder's reading pane (auto-translate toggle) |
| Commitments | Extraction prompt over outbound+inbound at classify time; writes candidate commitments; reconciler-style nightly diff against tasks/calendar |
| Cost control | Groups classified as digest-tier by default (batch summarization, not per-message LLM); Noise category exits the pipeline after cheap pattern checks; per-role model overrides as in `email_assistant_settings` |
| Send regimes | Every outbound decorated with its regime: `session` (free, inside 24 h window) vs `template` (₹, approved set only). Rules and the composer both surface this; templates are never improvised by the LLM |
| HITL | All sends via `request_confirmation` fail-closed; broadcast + bulk actions via Action Broker queue; autonomy ladder only ever widened by the human |
| Auditability | `wa_executed_rules` mirror + the dashboard trust ledger; every auto-send links to the rule that caused it |

---

## 6. Data model (mirrors email migrations 17→94)

```
wa_accounts        id, user_id, phone_number, display_name, waba_id, phone_number_id,
                   credentials via Integration Registry (BYOK), webhook_verify_token,
                   sync_status, history_import_phase, initial_sync_done, quality_rating
wa_chats           id, account_id, wa_chat_id (JID), kind('dm'|'group'|'broadcast'),
                   name, participants jsonb, category_id, service_window_expires_at,
                   UNIQUE(account_id, wa_chat_id)
wa_messages        id, account_id, chat_id, wa_message_id, direction, sender jsonb, kind
                   ('text'|'image'|'video'|'audio'|'voice'|'document'|'sticker'|'location'|
                    'contact'|'reaction'|'system'), body_text, transcript_text, media_ref,
                   quoted_wa_message_id, mentions text[], categories text[], intent,
                   template_name nullable (outbound template sends), send_regime,
                   sent_at, synced_at, rules_processed_at, UNIQUE(account_id, wa_message_id)
                   + FTS index + embeddings (pgvector)
wa_media           message_id, mime_type, size_bytes, storage_path, ocr_text, transcription_status
wa_contacts        account_id, phone_number, display_name, category_id, category_source,
                   entity_ref (graphiti/Zoho link), UNIQUE(account_id, phone_number)
wa_labels          account_id, wa_label_id, name, color, sync_state('synced'|'local'|'import_only')
wa_templates       account_id, name, language, body, meta_status('approved'|'pending'|'rejected'),
                   cost_hint — the approved template library rules draw from
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

## 7. UI/UX — the calm design (see mockups v3)

### 7a. Prior-art study (what the mockups are grounded in)

Before v3 the mockups were feature-complete but cluttered — five stat cards, a
dense chip row, 3–4 pills + two buttons on every queue row, an always-on
multi-card context rail. A prior-art pass across paid and open-source WhatsApp
inboxes and the "calm/fast inbox" tradition showed that clutter is not a polish
problem, it's an information-architecture one, and that the fix is well-trodden.

**The tools reviewers call "clean, near-zero training":** Cooby (tabs +
inbox-zero over WhatsApp Web), Rasayel and WATI (clean three-pane), SleekFlow and
Kommo ("clutter-free", single spine), plus the calm-inbox canon — Superhuman
(one accent, keyboard-first, almost no visible buttons), HEY (Imbox/Feed/Paper
Trail — categories are *destinations*, not filters), Missive/Front/Shortwave
(context and AI summoned, not resident), and Chatwoot (the OSS reference: a
four-zone shell, Copilot-as-a-thread).

**The tools reviewers call "cluttered / steep learning curve":** Periskope,
Interakt, Gallabox, Trengo, Respond.io — and the specific complaints (too many
pills per row, a busy always-on rail, a KPI dashboard bolted onto the workspace,
multiple organizers stacked on one screen) were an exact description of our v2.

The convergent lesson — **one organizing spine, not five** — drove the rebuild.

### 7b. The six calm principles (now the house rules for this vertical)

1. **One spine.** Triage streams live in the nav; there is no stat wall and no
   chip cloud. The five numbers that were stat cards became stream counts —
   same data, clickable, one active at a time (HEY / Cooby / Rasayel).
2. **One triage number.** It's just the active stream's count. Volume, response
   time and other metrics live in a separate analytics view you visit on purpose.
3. **Quiet rows, revealed actions.** A row is avatar · name · one line · time ·
   at most one red dot ("needs you"); hover or keys surface reply/snooze/done.
   Inside a stream, rows don't re-state the category (Superhuman / WATI / Cooby).
4. **Two panes by default; context on demand.** List → thread; the CRM/ERP
   context is a "Details ▸" drawer (accordion'd, one section open), not a
   permanent rail (Missive / Front / Chatwoot).
5. **AI at the point of writing.** One "✦ Suggested reply" chip above the
   composer, expandable to a copilot thread — never a standing AI column
   (SleekFlow / Shortwave / WATI).
6. **One accent, greyscale rest.** Cyan = active/primary/AI; WhatsApp green =
   send & outbound only; a single red dot = needs you; gold ★ = VIP (a glyph,
   not a fill); amber only for real payment aging, in context. Everything else
   stays grey until it earns attention (Superhuman).

**The governing constraint for every future feature:** it lands as a new stream
in the nav, on a settings surface, or as a hover/drawer affordance — *never* as
another always-on element on the queue or the thread. That single rule is what
the cluttered tools violated, per their own reviews.

### 7c. The screens

Every screen renders inside the real control-plane shell (icon rail → streams nav
→ main) so layout, tokens and components translate 1:1 into
`workbench/control_plane/src/app/whatsapp/`. Screen 8 is a build-notes sheet:
the principle→screen→prior-art map, color-as-signal legend, and a component map
(mockup element → existing email/control-plane component to reuse → net-new).

| # | Screen | What it proves |
|---|---|---|
| 1 | **Connect** | Embedded Signup + coexistence stepper; observable phased import; one quiet capability card stating the 24 h window, template pricing and label caveats up front |
| 2 | **The queue** | The whole home is two panes: triage-streams nav (the single spine, replacing v2's stat cards + chip row) and quiet near-textual rows with a single "needs you" dot and hover-revealed actions |
| 3 | **Conversation** | List + thread; 24 h window as a quiet header chip + `/` template picker; AI as one "Suggested reply" chip in the composer; the CRM/ERP moat in an on-demand accordion drawer (the overdue-invoice interception) |
| 4 | **Categories** | A settings surface (depth allowed): labels as policy rows (notify / auto-reply / drafts / escalation), only the meaningful cell bright, Family "AI hands off", uncategorized drained by evidence-backed suggestions |
| 5 | **Rules** | Rule cards with honest stats + nested learnings, the autonomy ladder visible per rule, template costs surfaced, an un-editable hard-guardrails card, plain-language compiler |
| 6 | **Digest** | ≤3 "needs you first" with prepared actions; commitment watch both ways; sections divided by whitespace + one label color, not six filled cards |
| 7 | **Companion** | Mobile PWA chat with quiet genUI queue/draft cards; approve-&-send as the only send |
| 8 | **Build notes** | Principles→screens→prior-art map, color-as-signal legend, component reuse map — the implementation checklist |

---

## 8. Competitive positioning (why not buy?)

| Tool | What it is | Why it doesn't solve this |
|---|---|---|
| Periskope, TimelinesAI, Cooby | WhatsApp shared inboxes / CRM syncers for teams | Team-inbox economics, generic AI, no founder-personal triage, and none can see your ERP ledger, tasks, calendar or email while drafting |
| WATI / Interakt / BSP suites | Cloud-API marketing + support bots | Campaign/bot-first, not inbox-management; nothing for the founder's own thread list |
| WhatsApp MCP bridges | Agent access to WhatsApp | Right instinct, wrong transport (unofficial) and no store, no triage discipline, no HITL, no trust ledger |
| **Us** | The founder's whole company (CRM/ERP/tasks/email/calendar/memory) standing behind every WhatsApp reply, with email-grade triage doctrine, on the official API | The moat is the context graph + the already-earned trust patterns, not any single feature |

---

## 9. Risks & open questions

| # | Risk / question | Position |
|---|---|---|
| R1 | **Label API coverage** in coexistence is partial/evolving | Import-once + local ownership is the floor; two-way sync where the API allows; `sync_state` per label keeps the UI honest |
| R2 | **24 h window + template pricing** | Auto-replies are session messages (free, inside window); proactive nudges outside the window use the approved template library; regime + cost are ambient UI (thread pill, rule cards, draft cards) |
| R3 | **Privacy: business chats pipe through LLMs** | Family & personal category is hands-off by default (surface, never draft, never auto-handle); per-category AI opt-out; all processing through the gateway's existing BYOK/routing; audit log |
| R4 | **India DPDP / consent** for storing counterparty messages | Same posture as email (we store our own correspondence); document retention policy; deletion honored via reconcile pass |
| R5 | **Group consent optics** (summarizing groups) | Summaries are private to the founder — no content leaves; broadcast sends always human-approved |
| R6 | **Meta platform churn** (coexistence is new; history/label sync phases may change) | All Meta specifics behind the provider seam; worst case degrade to standard Cloud API (no history import) without touching triage/AI layers |
| R7 | **The personal SIM stays unmanaged in v1** | Accepted consequence of official-only. Practical mitigation: business traffic migrates to the business number over time (the Business app makes this natural); revisit only if Meta opens an official personal-number path |
| R8 | **Coexistence availability** (region/tier gating by Meta/BSP) | Verify eligibility for our WABA early in W0 — it's the plan's only hard external dependency; fallback is standard Cloud API onboarding with forward-only history |

---

## 10. Suggested phasing

- **W0 — Pipe + store (no AI):** Cloud API onboarding via Embedded Signup +
  coexistence; webhook ingestion → queue → idempotent upsert into
  `wa_accounts/chats/messages/media`; history + label import with observable
  progress; FTS; read-only chat UI + Connect screen. *Exit: the founder reads
  and searches the company number's WhatsApp in the control plane.*
- **W1 — Send + hand-offs:** session-window-aware sends with HITL; template
  library bootstrap + approval tracking; message → task capture; contact ↔
  Zoho/Odoo entity linking. *Exit: replies sent from the dashboard; every chat
  shows its CRM context.*
- **W2 — Triage brain:** classifier + chat status + categories-as-policy +
  reply queue dashboard + digest section + auto-handled ledger. *Exit: the
  founder stops opening the phone app to find out what matters.*
- **W3 — Voice + automation:** drafting with WhatsApp voice profile +
  multilingual replies; standing rules (office hours, order-status
  answer-from-Odoo, payment cadence via templates); commitment/waiting-on
  extraction + nudges. *Exit: ≥50% of routine asks auto-handled with 0
  corrections/wk.*
- **W4 — Companion + groups:** `wa_*` agent tools in control-plane chat + mobile
  PWA; group summaries + broadcast-with-approval; media OCR + voice-note
  transcription; Focus Shield / WhatsApp windows. *Exit: a full day managed
  from the companion without opening WhatsApp.*

Each phase lands behind the existing patterns (provider seam, hook registry,
rules quintet, HITL) so nothing here forks the architecture — WhatsApp is the
proof that the email vertical's shape was a *channel* shape all along.

---

## 11. Build status (2026-07-23)

**W0 — pipe + store — BUILT.**
- `infra/postgres/99_whatsapp.sql`: `wa_accounts / wa_chats / wa_messages /
  wa_media / wa_contacts / wa_labels / wa_chat_status / wa_sync_log` + FTS.
- `apps/services/whatsapp_ingestion/`: provider seam (normalized dataclasses,
  `WhatsAppCloudProvider`, `parse_webhook` total parser, factory), the
  idempotent `persist` path, and the `post_sync` hook registry.
- `apps/services/gateway/gateway/routes/whatsapp/`: accounts, chats + `/streams`
  counts, messages + FTS search, window-aware send, and the public webhook
  (verify + receive → persist → hooks); registered in `main.py`.
- `workbench/control_plane/src/app/whatsapp/`: the calm read surface (streams
  nav, quiet queue, conversation) + the `/api/whatsapp` proxy + nav entry.

**W1 — send + hand-offs — BUILT (send/templates/capture/context).**
- `infra/postgres/100_whatsapp_templates.sql` + `transport/templates.py`: the
  approved template library (list / upsert / bootstrap default set).
- `transport/capture.py`: `/whatsapp/capture-task` — message → GTD inbox item,
  idempotent on `origin.wa_message_id`.
- `transport/context.py`: `/whatsapp/chats/{id}/context` — contact + entity ref
  + open loops + stats (live Zoho/Odoo fields deferred, degrades honestly).
- Frontend: window-aware composer (text / template picker), Details drawer,
  per-message capture affordance.

**W2 — triage brain — BUILT (backend, wired end-to-end).**
- `automation/replyzero.py`: the Reply Zero chat-status classifier
  (NEEDS_REPLY/AWAITING/FYI/DONE, DM vs group @mention) + `classify_chats` hook.
- `automation/intent.py`: a deterministic Hinglish-aware intent classifier
  (order_status/quote/payment/service/scheduling/social/spam) + the
  `on_new_messages` hook (idempotent via the `rules_processed_at` watermark).
- `101_whatsapp_categories.sql` + `automation/categories.py`: categories as
  policy carriers (notify/auto-reply/draft/escalate) with the default set
  (Family hands-off, Noise silent) + list/bootstrap/patch route.
- `digest.py`: the `/whatsapp/digest` projection (≤3 needs-you + calm counts).
- `scheduler_hooks.py` + `main.py`: the hooks are registered at startup and the
  webhook fires them, so an inbound message now flows webhook → persist → intent
  → chat-status → surfaces in `/streams`, the queue and the digest. The frontend
  stream counts light up from this automatically (no UI change needed).

**W3 — automation engine — BUILT (deterministic core, backend).**
- `automation/rules.py`: `decide_action` — the pure auto-reply autonomy ladder
  (answer_from_system / holding_reply / draft / none) with `requires_approval` +
  `via_template`, enforcing the hard guardrails first (VIP + Family never
  auto-send; Family hands off; social/spam muted). `/whatsapp/rules/preview`
  dry-runs it over needs-reply chats — what WOULD happen, no sends.
- `102_whatsapp_commitments.sql` + `automation/commitments.py`: promises tracked
  both ways. `extract_commitment` is pure + conservative (a promise verb is
  required), Hinglish/curly-quote tolerant, with a verbatim due hint;
  `apply_commitments` runs in the on_new_messages pipeline (watermarked on
  `commitment_checked_at`), tagging ours (digest watch) vs theirs (chase).
  `/whatsapp/commitments` lists them.
- `digest.py`: the brief now carries the commitment watch (our open promises,
  with a "never became a task" flag) + a waiting-on count.
- `103_whatsapp_ai_drafts.sql` + `automation/drafting.py`: AI drafting in the
  founder's WhatsApp voice (short/warm/emoji-tolerant, reply in the thread's own
  language via a pure Devanagari-vs-Latin detector), with the email drafter's
  two doctrines — conversation-as-DATA and sentinel-on-failure (NO_DRAFT / LLM
  error → no fabricated draft). Cached in wa_ai_drafts; generate/get routes. The
  composer gains a "✦ Suggest reply" chip (AI at the point of writing).

**Tests:** 146 backend unit tests (`pytest -k whatsapp`) — webhook parser,
persist, post-sync registry, route helpers (signature/window/regime), templates,
capture, context, Reply Zero, intent (21 cases), categories, digest + hook
wiring, the auto-reply ladder (12), and commitment extraction (15). All new code
`ruff`-clean.

**Not yet validated in this environment:** the numbered migrations (99–101) need
`scripts/apply_migrations.sh` against a running Postgres; the Next.js frontend
needs `npm ci && npm run build` (the control-plane `node_modules` isn't
installed here — the code mirrors the known-good email proxy/page patterns).

**Next (W2 frontend → W3):** the Categories + Rules settings screens and a
digest view in the UI (backend ready); LLM refinement layered onto the
deterministic intent/status classifiers; drafting with a WhatsApp voice profile +
multilingual replies; standing rules (office hours, answer-from-Odoo, payment
cadence) on top of the categories-as-policy engine; Embedded Signup onboarding UI
+ real coexistence history import; routing sends through the Action Broker.
