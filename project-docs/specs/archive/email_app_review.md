# Email App — Build Log (Milestone History)

> **Updated:** 2026-06-29 · **Scope:** `workbench/control_plane/src/app/email`,
> `apps/gateway/gateway/routes/email/`, `apps/email_ingestion`, `apps/agent-email-assistant`,
> `infra/postgres/[17–43]_email_*.sql`
>
> This is the **chronological record of what shipped**, newest first. For the current classified
> **feature inventory** see [`email_ai_assistant.md`](./email_ai_assistant.md); for **remaining work**
> see [`email_inbox_zero_parity_plan.md`](./email_inbox_zero_parity_plan.md).
>
> *(This file previously held a point-in-time bug-fix review from 2026-06-20. Those fixes are now
> long-shipped and folded into the inventory; the original review is captured as the M1 entry below.)*

---

## M9 — Reply Zero accuracy + Outlook-style threading (2026-06-29)
- Outlook-style **trailing-mail collapse**, **per-message reply**, and **quote-safe AI compose**.
- Reply Zero: accurate **To Reply → Awaiting/Actioned** the moment you reply; just-sent reply shows in
  the thread and flips the chip immediately; archiving a thread drops it from active buckets; trashed
  threads hidden; stale labels cleared on Mark Done/Reopen.
- Follow-up clock **anchored to the reply time** (not the inbound message); auto-nudge uses the nudge
  prompt; badge matches the label window.

## M8 — Email chat as a full scene + rich cards + Inbox Cleaner (2026-06-27 → 2026-06-28)
- AI chat **moved from the side rail to a full scene**; opens full-screen on mobile (not a drawer).
- **Confirm-before-send** in chat — approve the actual send; rich chat cards: clickable inbox lists
  that open the email, inline body expansion, `read_email` body card, `manage_inbox` (action + count),
  `apply_labels` (coloured chips), rule cards (When→Then), in-chat triage (archive/mark-read).
- **Inbox Cleaner**: merged Unsubscriber + Archiver into one scene; **real one-click unsubscribe** +
  provider filters; auto-categorize; mobile Actions menu; stricter Newsletters filter; age-sweep footer.
- **Settable label colours** synced to Gmail/Outlook (25-preset palette).
- **Dual-surface parity**: email-assistant chat runs identically in the Chat app + Email app
  (shared `AgentChat` + persona + memories); routed all gateway calls through one `_request` helper.
- Nav restructure: automation above folders + 4-tab mobile bar; drafts saved to Drafts; chat runs on
  the configured model. Perf: stopped per-delta refetch, parallelized bulk ops.

## M7 — Model roles + reply intelligence + classification learning (2026-06-24 → 2026-06-26)
- **Three per-account task-specific models** (rule/draft/chat) replacing agent+fallback; **JSON mode
  everywhere**; native MAF email agent honors the selected LiteLLM tier (fixed the 404 — Chat
  Completions client, not Responses API).
- Reply Zero made a **projection of the rules pipeline**; full-thread inbound status determination;
  mutually-exclusive conversation labels on re-evaluation; AI-determined thread status on reply.
- **Scoped reply-memory system** (migration 38), **learned writing style** (39), granular draft
  **confidence** rubric + robust NO_DRAFT gate, multi-rule **`isPrimary`**.
- Drafter gets **full thread context** + **similar-thread precedent** + **past-replies-to-sender** +
  **classification-feedback** soft hints + To/Cc/about/date parity.
- Classification **learned patterns**: bidirectional FROM + number-generalised SUBJECT,
  consistency-gated auto-learn, **learn from manual labels in the client**, Fix-flow teaching.
- **Follow-ups**: business-day windows + fractional days. **Send attachments** end-to-end.
- Rules: canonical rule order (dropped user reorder/`sort_order`); Outlook `MailboxSettings.ReadWrite`
  so rules can create labels; History parity ("matched via", action issues, view-rule, re-run).

## M6 — Inbox-zero automation parity (2026-06-23)
- Auto-run switch + **auto-draft replies**; History ordering/popover/Fix-dialog + learned-pattern parity.
- **Drafts**: Gmail-style **auto-save**, in-thread editing, **native send**; delete leftover thread
  drafts on send; PUT proxy handler added; DraftCard send-error handling.
- Live progress indicator for process-past runs; e2e guard for reading-pane open + reply auto-save.
- Outlook paging via `@odata.nextLink` (fixed the 100/folder cap).

## M5 — Email Automation suite shipped (2026-06-21)
Broad inbox-zero parity: Assistant (rules/test/history/settings) with plain-English + static +
category conditions, AND/OR, per-rule Auto/Manual, default-rule installer, Test, History + approval
queue, auto-run on arrival; sender categorization + cold-email blocker; Reply Zero + follow-up
drafting; bulk unsubscribe + bulk archive; analytics; AI drafting via the `email-assistant` MAF agent
(Mem0 + handoff to sales/task-manager); assistant chat with the full tool surface; model selection
(default tier-balanced → DeepSeek, BYOK via gateway `/v1`); digests. Tables: migrations 19–24.

## M2–M4 — Two-way sync, threading, reading pane (2026-06-20)
- Lazy full-message fetch + **sandboxed HTML rendering** (`MessageContent`); body hydration on demand.
- **Two-way write-back** (`apply_flags` / `move_to_folder`) for Gmail + Outlook (best-effort).
- Real provider folder/label tree in the sidebar (system + user folders); multi-folder initial sync.
- Outlook importance + categories captured end-to-end (migration 18); wired sidebar search.

## M1 — Reading-pane + sync bug-fix pass (2026-06-20, original review)
The headline bug — clicking an email showed a blank reading pane — was two compounding issues:
Outlook sync stored no body (only `bodyPreview`), and `EmailDetail` only rendered plain text. Fixed
with the sandboxed-iframe body renderer, lazy full-message fetch, and gateway on-demand body
hydration. Same pass: actions stayed local (added provider write-back), folders weren't really pulled
(real provider folder tree), only Inbox+Sent synced (multi-folder initial sync), Outlook
importance/categories dropped (captured end-to-end), sidebar search did nothing (wired). *All of the
"known limitations / next phase" noted at the time — flat threading, no server-side drafts, placeholder
Move/Label buttons, Gmail label names — have since shipped (see M6–M9).*

## M0 — Foundation (2026-06-17)
Project plan; Figma frontend ported to `/email`; `email_accounts` + `email_messages` schema (17);
gateway email routes skeleton; provider abstraction (`apps/email_ingestion`); Gmail + Outlook
providers; OAuth skeleton; `apps/agent-email-assistant` skeleton; mobile-responsive layout.
