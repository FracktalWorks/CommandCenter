# Email AI Assistant — Project Plan

> **Product:** CommandCenter · **Feature:** Email AI Assistant App · **Date:** 2026-06-17 · **Version:** 1.0
> **Status:** 🔲 Planned — Boilerplate integrated

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
