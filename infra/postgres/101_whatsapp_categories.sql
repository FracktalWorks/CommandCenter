-- ============================================================================
-- 101_whatsapp_categories.sql — categories as policy carriers (W2)
-- ============================================================================
-- Categories are first-class rows (not just a text label) because in this
-- product a category CARRIES BEHAVIOUR: it decides how loudly a chat notifies,
-- whether the AI may auto-reply, whether a draft is prepared, and when silence
-- escalates. This is the upgrade over the WhatsApp Business app's plain labels.
--
-- Business-app labels imported into wa_labels (99) map onto these by name; a
-- category may carry a wa_label_id when it mirrors a synced label, or stand
-- alone (VIP, Family, Noise are ours). Chats/contacts reference a category by
-- NAME (wa_chats.category / wa_contacts.category), so a rename is a data move,
-- not a schema change — matching the email vertical's category-as-string model.
--
-- Idempotent. Depends on 99_whatsapp.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS wa_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                     -- 'VIP' | 'Pending payment' | …
    icon TEXT,                              -- optional glyph for the UI
    wa_label_id TEXT,                       -- Meta label id when mirroring a label
    -- The four policy axes (the reason a category exists):
    notify_policy TEXT NOT NULL DEFAULT 'digest',
        -- 'instant' | 'digest' | 'mention_only' | 'never'
    auto_reply_policy TEXT NOT NULL DEFAULT 'never',
        -- 'never' | 'holding' | 'answer_from_system'
    draft_policy TEXT NOT NULL DEFAULT 'on_intent',
        -- 'always' | 'on_intent' | 'never'  (never = AI hands off, e.g. Family)
    escalate_after_mins INTEGER,            -- NULL = never escalate on silence
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_wa_categories_account
    ON wa_categories(account_id, sort_order);
