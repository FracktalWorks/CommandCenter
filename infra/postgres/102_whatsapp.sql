-- ============================================================================
-- 102_whatsapp.sql — WhatsApp Business channel (vertical #2, after email)
-- ============================================================================
-- The W0 foundation for the WhatsApp Message Manager: connected numbers, chats,
-- messages, media and contacts, plus the per-chat reply-status model that powers
-- the triage queue. Mirrors the SHAPE of the email vertical (17_email_accounts /
-- 27_email_reply_tracking) so triage, drafts, digest and rules can be ported as
-- transport-blind layers — WhatsApp is the proof the email vertical's shape was a
-- *channel* shape all along.
--
-- Official Meta WhatsApp Business Cloud API only (coexistence). No unofficial
-- linked-device transport (see ai-company-brain/specs/whatsapp_message_manager.md
-- §3). Credentials for the WABA / phone-number-id / system-user token are stored
-- as an AES-256-GCM encrypted JSONB blob, encrypted at the application layer, the
-- same as email_accounts.credentials_encrypted.
--
-- Idempotent (CREATE TABLE/INDEX IF NOT EXISTS): safe to re-run on every deploy.
-- Depends on: 00_create_databases.sql. Related: 17_email_accounts.sql (mirror).
-- ============================================================================

-- WhatsApp accounts — one row per connected WhatsApp Business number.
CREATE TABLE IF NOT EXISTS wa_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,                  -- CC user who owns this connection
    phone_number TEXT NOT NULL,             -- E.164 display, e.g. '+91801234442'
    phone_number_id TEXT NOT NULL,          -- Meta phone_number_id (webhook routing)
    waba_id TEXT,                           -- Meta WhatsApp Business Account id
    display_name TEXT,                      -- 'Fracktal Works'
    avatar_color TEXT DEFAULT '#25D366',    -- WhatsApp green fallback avatar
    credentials_encrypted TEXT NOT NULL,    -- AES-256-GCM encrypted JSON blob
    webhook_verify_token TEXT,              -- token echoed on Meta's GET verify
    quality_rating TEXT,                    -- Meta quality: 'GREEN'|'YELLOW'|'RED'
    sync_enabled BOOLEAN DEFAULT true,
    sync_status TEXT DEFAULT 'idle',        -- 'idle' | 'importing' | 'live' | 'error'
    sync_error TEXT,
    -- Coexistence history import runs in phases; surfaced on the Connect screen.
    history_import_phase INTEGER DEFAULT 0, -- 0=not started … 3=complete
    initial_sync_done BOOLEAN DEFAULT false,
    last_synced_at TIMESTAMPTZ,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, phone_number_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_accounts_user ON wa_accounts(user_id);
-- Webhook fan-in: Meta delivers events keyed by phone_number_id, so the receiver
-- resolves the owning account by this column on every inbound event.
CREATE INDEX IF NOT EXISTS idx_wa_accounts_phone_number_id
    ON wa_accounts(phone_number_id);

-- WhatsApp chats — one row per conversation (DM, group or broadcast).
CREATE TABLE IF NOT EXISTS wa_chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    wa_chat_id TEXT NOT NULL,               -- WhatsApp JID (contact wa_id or group id)
    kind TEXT NOT NULL DEFAULT 'dm',        -- 'dm' | 'group' | 'broadcast'
    name TEXT,                              -- contact display name or group subject
    participants JSONB DEFAULT '[]',        -- [{wa_id, name}] for groups
    category TEXT,                          -- resolved category name (VIP, Noise, …)
    -- The Cloud API 24h customer-service window: free-form replies are allowed
    -- until this instant; afterwards only approved templates. Null = never opened
    -- (no inbound yet). Surfaced as the composer's "session open · Nh" chip.
    service_window_expires_at TIMESTAMPTZ,
    is_muted BOOLEAN DEFAULT false,
    last_message_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, wa_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_chats_account_recent
    ON wa_chats(account_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_chats_category
    ON wa_chats(account_id, category);

-- WhatsApp messages — the synced message store (the central table).
CREATE TABLE IF NOT EXISTS wa_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES wa_chats(id) ON DELETE CASCADE,
    wa_message_id TEXT NOT NULL,            -- Meta message id (wamid.*) — dedupe key
    direction TEXT NOT NULL DEFAULT 'in',   -- 'in' | 'out'
    sender JSONB NOT NULL DEFAULT '{}',     -- {wa_id, name}
    kind TEXT NOT NULL DEFAULT 'text',      -- text|image|video|audio|voice|document
                                            -- |sticker|location|contact|reaction|system
    body_text TEXT,                         -- text body or caption
    transcript_text TEXT,                   -- voice-note transcription (W4)
    quoted_wa_message_id TEXT,              -- context.id when replying to a message
    mentions TEXT[] DEFAULT '{}',           -- wa_ids @mentioned (group needs-you)
    categories TEXT[] NOT NULL DEFAULT '{}',-- rule-engine applied labels (W2)
    intent TEXT,                            -- classifier intent (order_status, …)
    -- Outbound send regime: 'session' (free, inside 24h window) | 'template'
    -- (approved, priced). Null for inbound. template_name set for template sends.
    send_regime TEXT,
    template_name TEXT,
    sent_at TIMESTAMPTZ,                    -- message timestamp from Meta
    synced_at TIMESTAMPTZ DEFAULT now(),
    rules_processed_at TIMESTAMPTZ,         -- watermark: rules ran up to here (W2)
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, wa_message_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_chat
    ON wa_messages(chat_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_account_recent
    ON wa_messages(account_id, sent_at DESC);
-- Feeds the triage classifier backfill: messages not yet processed by the rules.
CREATE INDEX IF NOT EXISTS idx_wa_messages_unprocessed
    ON wa_messages(account_id, sent_at DESC)
    WHERE rules_processed_at IS NULL;

-- Full-text search over a message (body + transcript + sender name). The
-- expression MUST stay byte-for-byte in sync with the search predicate in the
-- gateway messages/search routes or the planner reverts to a seq scan (see the
-- email FTS note in 72_email_search_fts.sql).
CREATE INDEX IF NOT EXISTS idx_wa_messages_fts
    ON wa_messages
    USING GIN(
        to_tsvector('simple',
            coalesce(body_text, '') || ' ' ||
            coalesce(transcript_text, '') || ' ' ||
            coalesce(sender->>'name', '')
        )
    );

-- WhatsApp media metadata — one row per attachment on a message.
CREATE TABLE IF NOT EXISTS wa_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES wa_messages(id) ON DELETE CASCADE,
    wa_media_id TEXT,                       -- Meta media id (download handle, expires)
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    filename TEXT,
    size_bytes BIGINT,
    sha256 TEXT,                            -- Meta-provided hash (dedupe)
    storage_path TEXT,                      -- local/object path once downloaded
    ocr_text TEXT,                          -- extracted document/photo text (W4)
    transcription_status TEXT,              -- 'pending'|'done'|'skipped' (voice, W4)
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_media_message ON wa_media(message_id);

-- WhatsApp contacts — per-number identity + category + CRM entity link.
CREATE TABLE IF NOT EXISTS wa_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    phone_number TEXT NOT NULL,             -- E.164 of the counterparty
    wa_id TEXT,                             -- WhatsApp id (may differ from E.164)
    display_name TEXT,
    category TEXT,                          -- resolved category name
    category_source TEXT DEFAULT 'unknown', -- 'rule' | 'user' | 'label' | 'unknown'
    entity_ref TEXT,                        -- graphiti/Zoho contact link (W1)
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_wa_contacts_account ON wa_contacts(account_id);

-- WhatsApp labels — Business-app labels imported at onboarding, mirrored where
-- the coexistence API exposes label events. sync_state keeps the UI honest.
CREATE TABLE IF NOT EXISTS wa_labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    wa_label_id TEXT,                       -- Meta label id (null for local-only)
    name TEXT NOT NULL,
    color TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local', -- 'synced'|'local'|'import_only'
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_wa_labels_account ON wa_labels(account_id);

-- WhatsApp chat status — Reply Zero per-chat status powering the triage queue
-- (mirror of email_thread_status; WhatsApp keys on chat, not thread).
--   status: NEEDS_REPLY | AWAITING | FYI | DONE
CREATE TABLE IF NOT EXISTS wa_chat_status (
    account_id       UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    chat_id          UUID NOT NULL REFERENCES wa_chats(id) ON DELETE CASCADE,
    status           TEXT NOT NULL,         -- NEEDS_REPLY | AWAITING | FYI | DONE
    last_message_id  UUID,
    last_message_at  TIMESTAMPTZ,
    reason           TEXT,
    follow_up_reminded_at TIMESTAMPTZ,
    classified_at    TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (account_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_chat_status_account_status
    ON wa_chat_status(account_id, status);

-- WhatsApp sync log — audit trail of import / webhook-batch operations.
CREATE TABLE IF NOT EXISTS wa_sync_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    source TEXT NOT NULL DEFAULT 'webhook', -- 'webhook' | 'history_import' | 'manual'
    status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'error'
    messages_synced INTEGER DEFAULT 0,
    messages_skipped INTEGER DEFAULT 0,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_wa_sync_log_account
    ON wa_sync_log(account_id, started_at DESC);
