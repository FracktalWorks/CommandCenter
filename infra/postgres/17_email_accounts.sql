-- ============================================================================
-- 17_email_accounts.sql — Multi-account email infrastructure
-- ============================================================================
-- Supports multiple email accounts per user across Gmail, Microsoft 365,
-- and generic IMAP/SMTP providers.  Credentials are stored as an AES-256-GCM
-- encrypted JSONB blob (encryption handled at the application layer).
--
-- Depends on: 00_create_databases.sql (database must exist)
-- Related:    08_provider_keys.sql (single-account credential store)
--             11_integration_credentials.sql (flat integration keys)
-- ============================================================================

-- Email accounts — one row per connected email account
CREATE TABLE IF NOT EXISTS email_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,               -- CC user who owns this connection
    provider TEXT NOT NULL,               -- 'gmail' | 'microsoft' | 'imap'
    email_address TEXT NOT NULL,          -- e.g. 'alex.morgan@gmail.com'
    label TEXT,                           -- Display name: 'Work', 'Personal', etc.
    avatar_color TEXT DEFAULT '#6366f1',  -- Hex color for avatar fallback
    credentials_encrypted TEXT NOT NULL,  -- AES-256-GCM encrypted JSON blob
    sync_enabled BOOLEAN DEFAULT true,
    sync_interval_secs INTEGER DEFAULT 300, -- 5-minute default polling interval
    last_synced_at TIMESTAMPTZ,
    last_history_id TEXT,                 -- Gmail: historyId | Outlook: deltaToken
    sync_status TEXT DEFAULT 'idle',      -- 'idle' | 'syncing' | 'error'
    sync_error TEXT,                      -- Last sync error message
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, provider, email_address)
);

CREATE INDEX IF NOT EXISTS idx_email_accounts_user ON email_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_provider ON email_accounts(provider);
CREATE INDEX IF NOT EXISTS idx_email_accounts_sync ON email_accounts(sync_enabled, last_synced_at)
    WHERE sync_enabled = true;

-- Email messages — synced email cache
CREATE TABLE IF NOT EXISTS email_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    provider_message_id TEXT NOT NULL,    -- Gmail message ID / Outlook immutableId
    thread_id TEXT,                       -- Gmail threadId / Outlook conversationId
    folder TEXT NOT NULL DEFAULT 'INBOX', -- 'INBOX', 'SENT', 'DRAFTS', 'TRASH', etc.
    labels TEXT[] DEFAULT '{}',           -- Gmail labels / Outlook categories
    from_address JSONB NOT NULL,          -- {name, email}
    to_addresses JSONB NOT NULL,          -- [{name, email}]
    cc_addresses JSONB DEFAULT '[]',      -- [{name, email}]
    bcc_addresses JSONB DEFAULT '[]',     -- [{name, email}]
    subject TEXT,
    body_text TEXT,                       -- Plain text body
    body_html TEXT,                       -- HTML body (optional)
    snippet TEXT,                         -- First ~200 chars preview
    has_attachments BOOLEAN DEFAULT false,
    is_read BOOLEAN DEFAULT false,
    is_starred BOOLEAN DEFAULT false,
    is_flagged BOOLEAN DEFAULT false,
    importance TEXT NOT NULL DEFAULT 'normal',  -- 'high' | 'normal' | 'low'
    categories TEXT[] NOT NULL DEFAULT '{}',    -- Outlook user categories
    received_at TIMESTAMPTZ,
    synced_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, provider_message_id)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_email_messages_account_folder
    ON email_messages(account_id, folder, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread
    ON email_messages(account_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_received
    ON email_messages(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_unread
    ON email_messages(account_id, is_read, received_at DESC)
    WHERE is_read = false;

-- Full-text search index (English)
-- Handles: subject search, body text search, sender name search
CREATE INDEX IF NOT EXISTS idx_email_messages_fts
    ON email_messages
    USING GIN(
        to_tsvector('english',
            coalesce(subject, '') || ' ' ||
            coalesce(snippet, '') || ' ' ||
            coalesce(from_address->>'name', '') || ' ' ||
            coalesce(from_address->>'email', '')
        )
    );

-- Email attachments metadata
CREATE TABLE IF NOT EXISTS email_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes BIGINT,
    provider_attachment_id TEXT,          -- Gmail attachmentId / Outlook attachment id
    download_url TEXT,                    -- Pre-signed or proxy URL
    storage_path TEXT,                    -- Local/object storage path if downloaded
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_attachments_message
    ON email_attachments(message_id);

-- Email folders/labels — per-account folder metadata
CREATE TABLE IF NOT EXISTS email_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    provider_folder_id TEXT NOT NULL,     -- Gmail label ID / Outlook folder ID
    name TEXT NOT NULL,                   -- Display name
    type TEXT NOT NULL DEFAULT 'user',    -- 'system' (INBOX, SENT, etc.) | 'user' (custom labels)
    message_count INTEGER DEFAULT 0,
    unread_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, provider_folder_id)
);

CREATE INDEX IF NOT EXISTS idx_email_folders_account
    ON email_folders(account_id);

-- Email sync log — audit trail of sync operations
CREATE TABLE IF NOT EXISTS email_sync_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'error'
    messages_synced INTEGER DEFAULT 0,
    messages_skipped INTEGER DEFAULT 0,
    error_message TEXT,
    provider_history_id TEXT              -- Snapshot of the historyId/deltaToken used
);

CREATE INDEX IF NOT EXISTS idx_email_sync_log_account
    ON email_sync_log(account_id, started_at DESC);
