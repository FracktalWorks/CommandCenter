# Email AI Assistant — Project Plan

> **Product:** CommandCenter · **Feature:** Email AI Assistant App · **Updated:** 2026-06-20 · **Version:** 1.1
> **Status:** 🔄 In progress — UI, multi-account OAuth (Gmail/Outlook/IMAP), background sync, and AI chat shipped and live on the VPS.
> **Current state (2026-06-20):** Outlook end-to-end works after fixing five bugs that hid synced mail — doubled `/api/email` proxy path (404s), provider folders persisted as opaque IDs vs the canonical `inbox` key, the background sync scheduler crashing at boot (stdlib-logger kwargs `TypeError`), OAuth callback not storing client_id/secret/tenant (token refresh impossible), and Gmail `received_at` always null. Fixes in PR #4. **Remaining:** reconnect mailboxes post-deploy; Drafts/Junk sync; entity-graph linkage (email → CUSTOMER/DEAL) tracked under M3.

---

## 1. Overview

The Email AI Assistant is a **custom app** within the CommandCenter Control Plane that provides a full-featured email client with AI-powered assistance. It connects to multiple email providers (Gmail, Microsoft 365/Outlook, generic IMAP/SMTP), syncs emails into the CommandCenter data store, and provides a 4-panel UI: account switcher, email list, email detail, and AI chat assistant.

### User Intent (from Figma Mockup)

The Figma mockup (`Email Assistant AI Client`) shows a 4-panel email client:

1. **Left Sidebar** — Multi-account switcher (3 accounts: Gmail personal, Gmail work, Outlook personal), folder navigation (Inbox, Starred, Sent, Drafts, Archive, Labels, Trash), search bar, settings link
2. **Email List** — Middle-left panel with toolbar rows (Compose, Delete, Archive, Flag, Move / Reply, Reply All, Forward, Mark Read, Label), email thread list with sender, subject, preview, labels, timestamps
3. **Email Detail** — Main reading pane with full email content, sender info, attachments, and inline reply/forward composer
4. **AI Chat (Right Sidebar)** — AI assistant panel with quick actions (Summarize inbox, Find urgent emails, Draft reply, Unsubscribe suggestions), chat interface with streaming bot responses

### Key Requirements

- **R1** — Integrate multiple email providers: Gmail (Google Workspace / personal), Microsoft 365/Outlook
- **R2** — Support multiple accounts per provider (e.g., 2× Gmail, 1× Outlook)
- **R3** — Email integration managed from the Integrations page (uses existing credential store)
- **R4** — Multiple API keys / credentials per integration type (each account has its own OAuth tokens)
- **R5** — AI assistant can read emails, summarize, draft replies, find urgent items, suggest unsubscribes
- **R6** — Full email operations: read, send, reply, forward, archive, delete, flag, label, move
- **R7** — Real-time or near-real-time email sync (polling initially, webhook/push later)
- **R8** — Email search across all connected accounts

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONTROL PLANE (Next.js)                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  /email — Email AI Assistant App                         │   │
│  │  ┌─────────┬────────────┬──────────────┬──────────────┐  │   │
│  │  │Account  │ Email List │ Email Detail │  AI Chat     │  │   │
│  │  │Sidebar  │ + Toolbar  │ + Reply      │  Assistant   │  │   │
│  │  │         │            │              │              │  │   │
│  │  └─────────┴────────────┴──────────────┴──────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  /integrations — Email account setup (existing, extended)        │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP/SSE
┌──────────────────────────▼──────────────────────────────────────┐
│                     GATEWAY (FastAPI)                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  /email/accounts     — CRUD email account connections    │    │
│  │  /email/messages     — List, search, fetch emails        │    │
│  │  /email/send         — Compose and send                  │    │
│  │  /email/folders      — List folders/labels               │    │
│  │  /email/sync         — Trigger manual sync               │    │
│  │  /email/ai/chat      — AI assistant chat (→ orchestrator)│    │
│  │  /email/ai/actions   — Quick actions (summarize, etc.)   │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  /integrations (existing) — Email OAuth setup + credential CRUD  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                EMAIL INGESTION (apps/email_ingestion/)           │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Providers:                                              │    │
│  │  ├── GmailProvider      (Google Gmail API)               │    │
│  │  ├── OutlookProvider    (Microsoft Graph API)            │    │
│  │  └── IMAPProvider       (Generic IMAP + SMTP)            │    │
│  │                                                          │    │
│  │  Sync Engine:                                            │    │
│  │  ├── Polling sync (configurable interval per account)    │    │
│  │  ├── Incremental sync (historyId / deltaToken)           │    │
│  │  └── Webhook receiver (Gmail Pub/Sub, Outlook webhooks)  │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                     DATA STORE (Postgres)                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  email_accounts — Multi-account credentials (encrypted)  │    │
│  │  email_messages — Synced email cache                     │    │
│  │  email_folders   — Folder/label mappings                 │    │
│  │  email_attachments — Attachment metadata                 │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### Agent Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              EMAIL ASSISTANT AGENT (apps/agent-email-assistant/) │
│                                                                  │
│  Runtime: MAF (agent-framework-core)                             │
│  Model: GitHub Copilot SDK or LiteLLM BYOK                       │
│                                                                  │
│  Tools:                                                          │
│  ├── search_emails(query, folder, account) → Email[]             │
│  ├── get_email(id) → Email                                       │
│  ├── summarize_thread(thread_id) → str                           │
│  ├── draft_reply(email_id, tone, instructions) → str             │
│  ├── find_urgent() → Email[]                                     │
│  ├── suggest_unsubscribes() → Suggestion[]                       │
│  ├── send_email(to, subject, body) → bool                        │
│  └── manage_labels(email_ids, add[], remove[]) → bool            │
│                                                                  │
│  Injected tools (from executor):                                 │
│  ├── memory tools (remember, recall_timeline, save_memory, etc.) │
│  ├── web_search                                                  │
│  └── call_agent (inter-agent delegation)                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Multi-Account Credential Model

### Problem

The existing credential store uses flat `{service}:{suffix}` keys (e.g., `gmail:sa_json_path`). This works for single-account integrations. For multiple Gmail/Microsoft accounts, we need a new model.

### Solution: `email_accounts` Table

```sql
CREATE TABLE email_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,              -- CC user who owns this connection
    provider TEXT NOT NULL,             -- 'gmail' | 'microsoft' | 'imap'
    email_address TEXT NOT NULL,        -- e.g., 'alex.morgan@gmail.com'
    label TEXT,                         -- Display name e.g., 'Personal', 'Work'
    credentials_encrypted TEXT NOT NULL, -- AES-256-GCM encrypted JSON blob
    sync_enabled BOOLEAN DEFAULT true,
    sync_interval_secs INTEGER DEFAULT 300, -- 5 min default
    last_synced_at TIMESTAMPTZ,
    last_history_id TEXT,               -- Gmail: historyId | Outlook: deltaToken
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, provider, email_address)
);
```

### Credential Blob Structure (per provider)

**Gmail (OAuth 2.0):**
```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "access_token": "...",
  "token_expiry": "2026-06-17T12:00:00Z",
  "scopes": ["https://mail.google.com/"]
}
```

**Microsoft 365 (OAuth 2.0):**
```json
{
  "client_id": "...",
  "client_secret": "...",
  "tenant_id": "common",
  "refresh_token": "...",
  "access_token": "...",
  "token_expiry": "2026-06-17T12:00:00Z",
  "scopes": ["https://graph.microsoft.com/Mail.ReadWrite", "https://graph.microsoft.com/User.Read"]
}
```

**IMAP/SMTP:**
```json
{
  "imap_host": "imap.gmail.com",
  "imap_port": 993,
  "smtp_host": "smtp.gmail.com",
  "smtp_port": 587,
  "username": "user@gmail.com",
  "password_encrypted": "..."
}
```

### Integration Page Extension

The existing `/integrations` page already has an "Email" category with Gmail and SMTP setup guides. We extend it to support:
- **"Add Account"** button for each email provider
- OAuth flow initiation (redirect to Google/Microsoft consent screen)
- OAuth callback handling (store tokens in `email_accounts`)
- Account listing with status badges (connected, sync active, last synced)
- Per-account sync toggle and manual sync trigger

---

## 4. Email Sync Strategy

### Phase 1: Polling (M3 — initial release)

- Background task per account polls every N seconds (configurable, default 300s)
- Uses Gmail `history.list()` / Outlook `delta` queries for incremental sync
- Stores emails in `email_messages` table with full text search index
- Handles rate limits with exponential backoff

### Phase 2: Push Notifications (M4)

- Gmail: Google Cloud Pub/Sub push to webhook endpoint
- Microsoft: Outlook webhooks / change notifications
- Dramatically reduces latency and API quota usage

### Phase 3: Intelligent Sync (M5)

- AI-driven priority sync (sync important senders first)
- Attachment downloading on-demand
- Offline cache with conflict resolution

---

## 5. Email Messages Schema

```sql
CREATE TABLE email_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    provider_message_id TEXT NOT NULL,   -- Gmail message ID / Outlook immutableId
    thread_id TEXT,                      -- Gmail threadId / Outlook conversationId
    folder TEXT NOT NULL DEFAULT 'INBOX', -- e.g., 'INBOX', 'SENT', 'DRAFTS'
    labels TEXT[],                       -- Gmail labels / Outlook categories
    from_address JSONB NOT NULL,         -- {name, email}
    to_addresses JSONB NOT NULL,         -- [{name, email}]
    cc_addresses JSONB,                  -- [{name, email}]
    bcc_addresses JSONB,                 -- [{name, email}]
    subject TEXT,
    body_text TEXT,                      -- Plain text body
    body_html TEXT,                      -- HTML body
    snippet TEXT,                        -- Short preview (first ~200 chars)
    has_attachments BOOLEAN DEFAULT false,
    is_read BOOLEAN DEFAULT false,
    is_starred BOOLEAN DEFAULT false,
    is_flagged BOOLEAN DEFAULT false,
    received_at TIMESTAMPTZ,
    synced_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, provider_message_id)
);

CREATE INDEX idx_email_messages_account_folder ON email_messages(account_id, folder, received_at DESC);
CREATE INDEX idx_email_messages_thread ON email_messages(account_id, thread_id);
CREATE INDEX idx_email_messages_search ON email_messages USING GIN(to_tsvector('english', coalesce(subject,'') || ' ' || coalesce(body_text,'')));
```

---

## 6. API Endpoints

### Gateway Routes (`apps/gateway/gateway/routes/email.py`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/email/accounts` | List connected email accounts |
| `POST` | `/email/accounts` | Add a new email account (OAuth callback) |
| `DELETE` | `/email/accounts/{id}` | Remove an email account |
| `PATCH` | `/email/accounts/{id}` | Update account settings (sync toggle, label) |
| `GET` | `/email/accounts/{id}/folders` | List folders/labels for account |
| `GET` | `/email/messages` | List/search emails (query, folder, account, page) |
| `GET` | `/email/messages/{id}` | Get full email detail |
| `PATCH` | `/email/messages/{id}` | Update email (read, starred, labels, move) |
| `DELETE` | `/email/messages/{id}` | Delete/trash email |
| `POST` | `/email/send` | Send a new email |
| `POST` | `/email/sync` | Trigger manual sync for an account |
| `POST` | `/email/ai/chat` | AI assistant chat (streams SSE) |
| `POST` | `/email/ai/quick-action` | Trigger quick action (summarize, find urgent, etc.) |
| `GET` | `/email/oauth/{provider}/authorize` | Start OAuth flow for provider |
| `GET` | `/email/oauth/{provider}/callback` | OAuth callback handler |

### Frontend API Routes (Next.js proxy)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/email/accounts` | Proxy → gateway email accounts |
| `POST` | `/api/email/accounts` | Proxy → gateway |
| `GET` | `/api/email/messages` | Proxy → gateway |
| `GET` | `/api/email/ai/chat` | SSE proxy for AI chat streaming |

---

## 7. Frontend Component Tree

```
src/app/email/
├── page.tsx                    — Main layout: 4-panel email app
├── layout.tsx                  — Email app layout (no sidebar from AppShell)
├── components/
│   ├── AccountSidebar.tsx      — Multi-account switcher + folders
│   ├── EmailListToolbar.tsx    — Primary + secondary toolbar rows
│   ├── EmailList.tsx           — Email thread list
│   ├── EmailDetail.tsx         — Email reading pane
│   ├── EmailComposer.tsx       — New email / reply / forward composer
│   ├── AIChatPanel.tsx         — AI assistant chat sidebar
│   ├── QuickActions.tsx        — Quick action pills
│   ├── FolderTree.tsx          — Collapsible folder tree
│   ├── SearchBar.tsx           — Email search
│   └── MessageContent.tsx      — Email body renderer (HTML + plain text)
├── lib/
│   ├── types.ts                — TypeScript interfaces
│   ├── emailStore.ts           — Zustand state management
│   ├── api.ts                  — API client functions
│   └── utils.ts                — Date formatting, etc.
└── hooks/
    ├── useEmails.ts            — Email list/data fetching
    ├── useEmailAccounts.ts     — Account management
    └── useAIChat.ts            — AI chat hook (reuses useAgentChat pattern)
```

---

## 8. Implementation Phases

### Phase 1: Foundation (this PR) — Boilerplate

- [x] Project plan document (this file)
- [ ] Port Figma frontend components into workbench `/email`
- [ ] `email_accounts` + `email_messages` DB schema
- [ ] Gateway email routes skeleton
- [ ] Email provider abstraction (`apps/email_ingestion/`)
- [ ] Gmail OAuth flow skeleton
- [ ] Email assistant agent skeleton (`apps/agent-email-assistant/`)
- [ ] Integrations page extended for multi-account email

### Phase 2: Core Email Reading (M3)

- [ ] Gmail provider: full sync (history.list), message fetch, folder list
- [ ] Microsoft provider: full sync (delta), message fetch, folder list
- [ ] Email list/detail UI connected to real data
- [ ] Search across accounts
- [ ] Read/unread, star, label operations

### Phase 3: Email Sending + AI (M3)

- [ ] Compose and send via Gmail API + Microsoft Graph
- [ ] Reply, reply-all, forward
- [ ] AI assistant agent with email tools
- [ ] Quick actions: summarize, find urgent, draft reply
- [ ] AI chat panel connected to streaming agent

### Phase 4: Polish + Push (M4)

- [ ] Push notification webhooks (Gmail Pub/Sub, Outlook webhooks)
- [ ] Attachment handling
- [ ] Offline support
- [ ] Mobile-responsive email UI
- [ ] Email templates
- [ ] Scheduled send

---

## 9. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **`email_accounts` as a separate table** | The existing `provider_keys` table is 1:1 service→key. Multi-account needs N:1. A separate table with encrypted JSONB credentials is cleaner than trying to multiplex keys. |
| **Polling before push** | Gmail Pub/Sub and Outlook webhooks require additional cloud infra setup. Polling is simpler for the initial release and works everywhere. |
| **Sync to Postgres, not proxy** | Proxying live to Gmail/MS APIs for every UI render would be slow and rate-limited. Syncing to Postgres gives fast queries, full-text search, and offline access. |
| **Reuse existing agent infrastructure** | The email assistant agent uses the same MAF executor, streaming, mutation, and tool injection as all other agents. No special code path. |
| **OAuth flow through gateway** | The gateway handles OAuth token exchange server-side to keep client secrets secure. The frontend redirects to the gateway's authorize endpoint. |
| **One agent per email domain** | The email assistant is one MAF agent with all email tools injected, rather than separate agents per provider. Simpler routing, unified context. |

---

## 10. Dependencies & Risks

| Dependency | Status | Mitigation |
|------------|--------|------------|
| Gmail API quota (1B quota units/day free) | ✅ Available | Sync interval tuning, incremental sync |
| Microsoft Graph API quota | ✅ Available | Delta queries reduce calls |
| Google Cloud Console project setup | Manual per-deployment | Document setup steps in Integrations page |
| Microsoft Azure App Registration | Manual per-deployment | Document setup steps |
| OAuth redirect URI (HTTPS required) | Requires domain | Already have `api.commandcenter.fracktal.in` |
| Email storage growth | Monitor | Archive/delete policies, attachment on-demand loading |

---

## 11. Success Criteria

- [ ] User can connect 2+ Gmail accounts and 1+ Microsoft account
- [ ] Emails from all accounts appear in a unified inbox within 5 minutes of arrival
- [ ] AI assistant can summarize the last 20 unread emails correctly
- [ ] AI assistant can draft a professional reply that the user would send with minor edits
- [ ] Email send/reply/forward works through connected accounts
- [ ] Full-text search returns results across all accounts in < 2 seconds
- [ ] Mobile-responsive layout works on iOS and Android

---

## 12. Competitive Analysis — Inbox Zero (elie222/inbox-zero)

*Analysis date: 2026-06-17*

### Overview

[Inbox Zero](https://github.com/elie222/inbox-zero) is the leading open-source AI email assistant
(11.3k stars, 1.4k forks). It's a TypeScript monorepo (Next.js + Prisma + Tailwind +
shadcn/ui + Turborepo) supporting Gmail and Microsoft 365 via OAuth.

**Tech stack:** Next.js App Router, Prisma (Postgres), Upstash Redis, Tinybird (analytics),
OpenAI / Anthropic / Google AI / Groq / Ollama for AI, Resend for transactional email.

**Key reference files:**
- [`ARCHITECTURE.md`](https://github.com/elie222/inbox-zero/blob/main/ARCHITECTURE.md) — full system architecture
- [`apps/web/prisma/schema.prisma`](https://github.com/elie222/inbox-zero/blob/main/apps/web/prisma/schema.prisma) — complete DB schema (1839 lines)
- [`apps/web/utils/ai/`](https://github.com/elie222/inbox-zero/tree/main/apps/web/utils/ai) — all AI/LLM logic
- [`apps/web/utils/gmail/`](https://github.com/elie222/inbox-zero/tree/main/apps/web/utils/gmail) — all Gmail API integration
- [`LICENSE`](https://github.com/elie222/inbox-zero/blob/main/LICENSE) — AGPLv3 + additional terms

**License:** AGPL v3 + commercial restrictions. Since CommandCenter is also free
and open source (AGPLv3-compatible), we **CAN reuse their code** under the copyleft
terms — any modifications we make must also be released under AGPLv3.

### Porting Strategy: TypeScript → Python

### Feature Comparison

| Feature | Inbox Zero | Our Email App (Planned) | Priority to Add |
|---------|-----------|------------------------|-----------------|
| Multi-account Gmail | ✅ | ✅ | — |
| Microsoft 365 support | ✅ | ✅ | — |
| AI email classification | ✅ AI Rules engine | ❌ | HIGH |
| Cold email blocker | ✅ LLM-based detection | ❌ | HIGH |
| Bulk unsubscribe | ✅ One-click unsub+archive | ❌ Quick action only | HIGH |
| Bulk archive | ✅ Archive old emails | ❌ | MEDIUM |
| Reply tracking | ✅ (Reply Zero) | ❌ | HIGH |
| AI reply drafting | ✅ Tone-aware drafts | 🔲 Skeleton | HIGH |
| Meeting briefs | ✅ Email+calendar context | ❌ | LOW (later) |
| Smart attachment filing | ✅ → Google Drive/OneDrive | ❌ | LOW (later) |
| Email analytics | ✅ Trends, activity stats | ❌ | MEDIUM |
| Slack/Telegram integration | ✅ Chat from messaging apps | ❌ | MEDIUM |
| Gmail Pub/Sub webhooks | ✅ Real-time push | 🔲 Polling first | MEDIUM |

### Code Files to Port (TypeScript → Python)

Since CommandCenter is AGPLv3 free software, we can directly port the following
Inbox Zero modules. Listed by priority with our Python destination.

| Inbox Zero File | Our Python Destination | Lines | Value |
|-----------------|----------------------|-------|-------|
| [`categorize-sender/ai-categorize-single-sender.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/categorize-sender/ai-categorize-single-sender.ts) | `email_ingestion/providers/ai_categorize.py` | ~80 | Cold email LLM classification |
| [`choose-rule/ai-choose-rule.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/choose-rule/ai-choose-rule.ts) | `email_ingestion/providers/ai_rules.py` | ~120 | Rule matching engine |
| [`choose-rule/match-rules.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/choose-rule/match-rules.ts) | `email_ingestion/providers/ai_rules.py` | ~90 | Static rule matching (from/to/subject) |
| [`choose-rule/execute.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/choose-rule/execute.ts) | `email_ingestion/providers/ai_rules.py` | ~100 | Execute matched actions |
| [`reply/draft-reply.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/reply/draft-reply.ts) | `agent-email-assistant/agents.py` | ~150 | AI reply drafting with context |
| [`reply/reply-context-collector.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/reply/reply-context-collector.ts) | `email_ingestion/providers/ai_reply.py` | ~80 | Gather thread context for replies |
| [`clean/draft-cleanup.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/clean/draft-cleanup.ts) | `email_ingestion/providers/email_cleanup.py` | ~60 | Auto-cleanup old drafts |
| [`gmail/mail.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/gmail/mail.ts) | `email_ingestion/providers/gmail.py` | ~200 | Gmail send/reply/forward with retry |
| [`gmail/batch.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/gmail/batch.ts) | `email_ingestion/providers/gmail.py` | ~80 | Batch Gmail operations |
| [`gmail/decode.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/gmail/decode.ts) | `email_ingestion/providers/email_decode.py` | ~60 | MIME decoding + HTML→text |
| [`gmail/watch.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/gmail/watch.ts) | `email_ingestion/providers/gmail.py` | ~70 | Gmail Pub/Sub watch setup |
| [`choose-rule/bulk-process-emails.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/choose-rule/bulk-process-emails.ts) | `email_ingestion/providers/ai_rules.py` | ~60 | Bulk rule evaluation |

#### Prisma Schema → Our Postgres Schema

Key tables from Inbox Zero's Prisma schema that map to our existing/new tables:

| Inbox Zero Prisma Model | Our Postgres Table | Status |
|------------------------|-------------------|--------|
| `EmailAccount` | `email_accounts` | ✅ Exists |
| `EmailMessage` | `email_messages` | ✅ Exists |
| `Rule` + `Action` | `email_rules` + `email_actions` | 🔲 New — see §13.1 |
| `ExecutedRule` + `ExecutedAction` | `email_executed_rules` + `email_executed_actions` | 🔲 New |
| `Newsletter` | `email_newsletters` | 🔲 New |
| `ColdEmail` (deprecated — migrating to GroupItem) | `email_cold_senders` | 🔲 New |
| `ThreadTracker` | `email_thread_trackers` | 🔲 New |
| `Group` + `GroupItem` | `email_sender_groups` + `email_sender_group_items` | 🔲 New |
| `Category` | `email_sender_categories` | 🔲 New |
| `Knowledge` | (use Mem0 memory tools) | ✅ Exists |
| `ReplyMemory` | (use Mem0 memory tools) | ✅ Exists |
| `CleanupJob` + `CleanupThread` | `email_cleanup_jobs` | 🔲 New |

### New Tables to Add (Porting from Inbox Zero Schema)

#### `email_rules` + `email_actions`

```sql
CREATE TABLE email_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    instructions TEXT,               -- Natural language rule description
    enabled BOOLEAN DEFAULT true,
    run_on_threads BOOLEAN DEFAULT false,
    conditional_operator TEXT DEFAULT 'AND', -- 'AND' | 'OR'
    -- Static conditions
    from_pattern TEXT,               -- regex or exact match
    to_pattern TEXT,
    subject_pattern TEXT,
    body_pattern TEXT,
    -- AI conditions (instructions field above)
    -- Category filter
    category_filter_type TEXT,       -- 'INCLUDE' | 'EXCLUDE'
    system_type TEXT,                -- 'REPLY_ZERO' | 'COLD_EMAIL' | etc.
    prompt_text TEXT,                -- Natural language representation for prompt file sync
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, name)
);

CREATE TABLE email_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES email_rules(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    type TEXT NOT NULL,              -- 'ARCHIVE' | 'LABEL' | 'REPLY' | 'SEND_EMAIL' | 'FORWARD' | 'DRAFT_EMAIL' | 'MARK_SPAM' | 'MARK_READ' | 'STAR' | 'MOVE_FOLDER' | 'CALL_WEBHOOK'
    label TEXT,                      -- Label name or ID
    subject TEXT,                    -- For reply/send actions
    content TEXT,                    -- Reply/send body template
    to_address TEXT,
    cc_address TEXT,
    bcc_address TEXT,
    url TEXT,                        -- For CALL_WEBHOOK
    folder_name TEXT,                -- For MOVE_FOLDER
    delay_minutes INT,               -- Delay before executing
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

#### `email_newsletters` and `email_cold_senders`

```sql
CREATE TABLE email_newsletters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,             -- Sender email
    name TEXT,                       -- Sender display name
    status TEXT DEFAULT 'APPROVED',  -- 'APPROVED' | 'UNSUBSCRIBED' | 'AUTO_ARCHIVED'
    category_id UUID,                -- Optional category
    pattern_analyzed BOOLEAN DEFAULT false,
    last_analyzed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, email)
);

CREATE TABLE email_cold_senders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    from_email TEXT NOT NULL,
    status TEXT DEFAULT 'AI_LABELED_COLD', -- 'AI_LABELED_COLD' | 'USER_REJECTED_COLD'
    reason TEXT,                     -- LLM classification reason
    thread_id TEXT,
    message_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, from_email)
);
```

#### `email_thread_trackers`

```sql
CREATE TABLE email_thread_trackers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'NEEDS_REPLY', -- 'NEEDS_REPLY' | 'AWAITING_REPLY' | 'NEEDS_ACTION'
    sent_at TIMESTAMPTZ NOT NULL,
    resolved BOOLEAN DEFAULT false,
    follow_up_applied_at TIMESTAMPTZ,
    follow_up_draft_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, thread_id, message_id)
);
CREATE INDEX idx_email_thread_trackers_unresolved
    ON email_thread_trackers(account_id, resolved, type, sent_at)
    WHERE resolved = false;
```

### Prototype Architecture Patterns

#### 1. AI Rules Engine — Plain English → Structured Rules

Inbox Zero's approach: user writes plain English rules in a "prompt file" →
parsed into structured database rules → LLM evaluates conditions → executes
static actions. This two-layer design (human-readable prompt → machine-executable
rules) is the right architecture for explainable AI email handling.

**Our adaptation (porting from [`choose-rule/`](https://github.com/elie222/inbox-zero/tree/main/apps/web/utils/ai/choose-rule)):**
- Port [`match-rules.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/choose-rule/match-rules.ts) → Python: static rule matching (from/to/subject/body patterns)
- Port [`ai-choose-rule.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/choose-rule/ai-choose-rule.ts) → Python: LLM-based rule selection with structured output
- Port [`execute.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/choose-rule/execute.ts) → Python: execute matched actions (archive, label, reply, forward, webhook)
- MAF agent `agent-email-assistant` gets a `process_rules` tool

#### 2. Cold Email Blocker — First-Time Sender LLM Classification

Inbox Zero monitors incoming emails, checks if sender has ever been replied to,
and if not, runs the email through an LLM to classify as cold/spam. This is
separate from their main AI rules engine.

**Our adaptation (porting from [`categorize-sender/`](https://github.com/elie222/inbox-zero/tree/main/apps/web/utils/ai/categorize-sender)):**
- Port [`ai-categorize-single-sender.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/categorize-sender/ai-categorize-single-sender.ts) → Python: LLM classification of sender type
- Port [`format-categories.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/categorize-sender/format-categories.ts) → Python: structured category formatting
- `email_messages` table already tracks `from_address` — can query reply history
- New tool: `detect_cold_email(email_id)` → calls LLM with structured prompt
- Automatically labels cold emails; user can whitelist senders
- Whitelist stored in `email_cold_senders` table (ported from `ColdEmail` model)

#### 3. Bulk Unsubscribe — Newsletter Detection + One-Click Actions

Inbox Zero uses Tinybird analytics to identify newsletter patterns (frequency,
engagement), then presents a UI to unsubscribe and archive in bulk.

**Our adaptation (without Tinybird):**
- SQL query on `email_messages` to find senders with >5 emails, 0 replies, low
  open rates → classify as "newsletter"
- `suggest_unsubscribes` tool already exists — enhance with sender frequency data
- Bulk action: select multiple senders → generate unsubscribe requests / auto-archive

#### 4. Reply Tracking (Reply Zero)

Inbox Zero tracks emails that need a response and those awaiting responses.
Implemented as a special AI rule type.

**Our adaptation (porting from [`reply/`](https://github.com/elie222/inbox-zero/tree/main/apps/web/utils/ai/reply)):**
- Port [`draft-reply.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/reply/draft-reply.ts) → Python: AI reply drafting with tone parameters
- Port [`reply-context-collector.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/reply/reply-context-collector.ts) → Python: gather thread context for replies
- Port [`determine-thread-status.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/reply/determine-thread-status.ts) → Python: classify thread as needs-reply vs awaiting-reply
- Port [`draft-follow-up.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/ai/reply/draft-follow-up.ts) → Python: generate follow-up nudge emails
- SQL query on `email_thread_trackers`: unresolved threads needing response
- New tool: `find_needing_reply(days=3)` → returns prioritized list
- Integrates with `draft_reply` — one click from "needs reply" to draft

#### 5. Gmail Pub/Sub Watch — Real-Time Notifications

Inbox Zero uses Gmail's `users.watch()` API to receive push notifications via
Google Cloud Pub/Sub when new emails arrive, rather than polling.

**Our adaptation (porting from [`gmail/watch.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/gmail/watch.ts)):**
- Gmail provider already has watch scaffolding
- Port watch.ts → Python: Gmail `users.watch()` API setup + Pub/Sub topic management
- Need: Google Cloud Pub/Sub topic + subscription → webhook endpoint
- Gateway route: `POST /email/webhook/gmail` — receives Pub/Sub push
- On push: trigger incremental sync for that account
- Benefit: near-instant email delivery, zero polling API quota usage

#### 6. Batch Gmail Operations

Inbox Zero has robust batching for archive/delete/label operations
(`batch.ts`, `batch-with-retry.ts`) with exponential backoff.

**Our adaptation (porting from [`gmail/`](https://github.com/elie222/inbox-zero/tree/main/apps/web/utils/gmail)):**
- Port [`mail.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/gmail/mail.ts) → Python: send/reply/forward with proper MIME construction + retry logic
- Port [`batch.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/gmail/batch.ts) → Python: batch Gmail API calls with exponential backoff
- Port [`batch-with-retry.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/gmail/batch-with-retry.ts) → Python: retry wrapper for 429/503 errors
- `bulk_archive(message_ids)` — batch modify with remove INBOX label
- `bulk_label(message_ids, add_labels, remove_labels)` — batch label changes

#### 7. Email Content Decoding

Inbox Zero handles quoted-printable, base64, multipart MIME, and HTML email
bodies robustly (`decode.ts`, `content-sanitizer.ts`).

**Our adaptation (porting from [`gmail/decode.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/gmail/decode.ts)):**
- Port [`decode.ts`](https://github.com/elie222/inbox-zero/blob/main/apps/web/utils/gmail/decode.ts) → Python `email_decode.py`: base64, quoted-printable, multipart MIME
- Port content sanitization: HTML→text for AI processing (strip tags, decode entities)
- Enhance `GmailProvider._parse_gmail_message()` with proper MIME parsing
- Handle multipart/alternative (prefer text/plain, fallback to text/html→text)

#### 8. Prompt Engineering Patterns

Inbox Zero uses structured, use-case-specific LLM prompts with clear output
schemas. Key prompts to study:
- `choose-rule/` — matching emails to user-defined rules
- `categorize-sender/` — classifying sender types
- `reply/` — drafting replies with tone/style options
- `digest/` — generating email summaries

**Our adaptation:**
- Already defined in `instructions.md` — enhance with structured output formats
- Add JSON output schemas for rule matching: `{matched: bool, rule_id: str, confidence: float}`
- Add tone/style parameters to `draft_reply` tool (formal/casual/concise/detailed)

---

## 13. Revised Implementation Phases

### Phase 1: Foundation ✅ COMPLETE (2026-06-17)

- [x] Project plan document
- [x] Port Figma frontend into workbench `/email`
- [x] `email_accounts` + `email_messages` DB schema
- [x] Gateway email routes skeleton
- [x] Email provider abstraction (`apps/email_ingestion/`)
- [x] Gmail + Outlook provider implementations
- [x] Gmail OAuth flow skeleton
- [x] Email assistant agent skeleton (`apps/agent-email-assistant/`)
- [x] Mobile-responsive layout with global bottom nav
- [x] DOX chain updated

### Phase 2: Core Email Reading + AI Classification (target: M3)

- [ ] Real Gmail OAuth: Google Cloud Console project → live OAuth flow
- [ ] Real Microsoft OAuth: Azure App Registration → live OAuth flow
- [ ] Live email sync: Gmail history.list + Outlook delta queries → Postgres
- [ ] **Cold email blocker**: first-time sender LLM classification
- [ ] **Bulk unsubscribe**: newsletter detection + one-click unsubscribe suggestions
- [ ] Email list/detail connected to real data (replace mock)
- [ ] Search across accounts via Postgres FTS

### Phase 3: AI Reply + Actions (target: M3)

- [ ] **AI reply drafting**: tone-aware drafts with email context
- [ ] **Reply tracking**: find emails needing response, track awaiting replies
- [ ] Send/reply/forward via Gmail API + Microsoft Graph
- [ ] **AI Rules Engine (v1)**: simple NL rules → label/archive actions
- [ ] Batch operations: bulk archive, bulk label, bulk mark-read
- [ ] AI chat panel connected to live agent streaming

### Phase 4: Real-Time + Polish (target: M4)

- [ ] **Gmail Pub/Sub push notifications** → instant sync
- [ ] Outlook webhooks → instant sync
- [ ] Attachment handling (download, preview, save to Drive)
- [ ] Email analytics dashboard (volume, response time, top senders)
- [ ] Slack integration: manage inbox from Slack
- [ ] Email templates + scheduled send
- [ ] Offline support (service worker cache)
