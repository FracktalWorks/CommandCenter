-- ============================================================================
-- 117_whatsapp_labels_sync.sql — native WhatsApp labels/lists, synced (W16)
-- ============================================================================
-- The founder's personal number (whatsmeow bridge) already has the labels/lists
-- they created inside WhatsApp — "Clients", "Suppliers", "Follow up", etc. Those
-- live in WhatsApp's *app-state* (the `regular` collection), and whatsmeow emits
-- them as LabelEdit + LabelAssociationChat events. This migration gives them a
-- home so we can MIRROR them read-only into the triage inbox (chips + a filter),
-- distinct from wa_categories, which are OUR policy carriers.
--
-- Two shapes:
--   • wa_labels        — one row per label the user made (id, name, colour, type)
--   • wa_chat_labels   — which chats carry which label, keyed by JID so an
--                        association can land before the chat's messages sync.
--
-- Associations key on wa_chat_id (the JID) rather than the wa_chats UUID on
-- purpose: a chat can be labelled in WhatsApp with no recent messages, so the
-- label may arrive before (or without) a wa_chats row. Serving joins on the JID.
--
-- Idempotent. Depends on 102_whatsapp.sql.
-- ============================================================================

-- wa_labels already exists (102) as a thin stub. Widen it to carry the fields
-- whatsmeow's LabelEditAction exposes, so the UI can render the real colour and
-- we can tell a user label ('CUSTOM'/'PREDEFINED') from a system list.
ALTER TABLE wa_labels ADD COLUMN IF NOT EXISTS color_index  INTEGER;      -- raw whatsmeow palette index
ALTER TABLE wa_labels ADD COLUMN IF NOT EXISTS list_type    TEXT;         -- CUSTOM|PREDEFINED|LEAD|…
ALTER TABLE wa_labels ADD COLUMN IF NOT EXISTS predefined_id INTEGER;     -- set for Meta's predefined labels
ALTER TABLE wa_labels ADD COLUMN IF NOT EXISTS sort_order   INTEGER NOT NULL DEFAULT 100;
ALTER TABLE wa_labels ADD COLUMN IF NOT EXISTS active       BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE wa_labels ADD COLUMN IF NOT EXISTS deleted      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE wa_labels ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT now();

-- The original (account_id, name) unique blocks a rename (WhatsApp keeps the id
-- stable while the name changes). Drop it and make the WhatsApp label id the
-- upsert key instead — that's what the sync actually dedupes on.
ALTER TABLE wa_labels DROP CONSTRAINT IF EXISTS wa_labels_account_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_labels_account_walabel
    ON wa_labels(account_id, wa_label_id)
    WHERE wa_label_id IS NOT NULL;

-- Which chats carry which label. Keyed by JID (see header) so it is robust to
-- association-before-message ordering; a label id references wa_labels.wa_label_id.
CREATE TABLE IF NOT EXISTS wa_chat_labels (
    account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    wa_chat_id  TEXT NOT NULL,               -- WhatsApp JID (matches wa_chats.wa_chat_id)
    wa_label_id TEXT NOT NULL,               -- matches wa_labels.wa_label_id
    created_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (account_id, wa_chat_id, wa_label_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_chat_labels_label
    ON wa_chat_labels(account_id, wa_label_id);
CREATE INDEX IF NOT EXISTS idx_wa_chat_labels_chat
    ON wa_chat_labels(account_id, wa_chat_id);
