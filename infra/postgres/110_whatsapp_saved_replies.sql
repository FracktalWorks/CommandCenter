-- ============================================================================
-- 110_whatsapp_saved_replies.sql — founder-defined canned snippets (W8)
-- ============================================================================
-- The answers a founder types ten times a day — price list, address, GST number,
-- catalogue link, "we'll ship tomorrow". DISTINCT from wa_templates: templates
-- are Meta-approved messages for OUTSIDE the 24h window; a saved reply is a plain
-- free-form snippet the founder drops into the composer inside the window. An
-- optional '/shortcut' makes it recall-able by name; unique per account.
--
-- Idempotent. Depends on 102_whatsapp.sql (wa_accounts).
-- ============================================================================

CREATE TABLE IF NOT EXISTS wa_saved_replies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    title TEXT NOT NULL,                     -- short label shown in the picker
    body TEXT NOT NULL,                      -- the snippet inserted into the composer
    shortcut TEXT,                           -- optional '/slug' recall (per-account unique)
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_saved_replies_account
    ON wa_saved_replies(account_id, sort_order);

-- A shortcut, when set, is unique within the account so recall is unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_saved_replies_shortcut
    ON wa_saved_replies(account_id, shortcut)
    WHERE shortcut IS NOT NULL;
