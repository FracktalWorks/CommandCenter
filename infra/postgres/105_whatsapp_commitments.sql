-- ============================================================================
-- 105_whatsapp_commitments.sql — promises tracked both ways (W3)
-- ============================================================================
-- The "no dropped promises" pillar. A commitment is a future obligation stated
-- in a message — ours ("I'll send the quote by Friday") or theirs ("will share
-- the AWB tomorrow"). Extracting them lets the digest flag the promise that
-- never became a task, and the waiting-on strip chase the ones they owe us.
--
-- One commitment per message at most (UNIQUE on message_id) so the extractor is
-- idempotent; wa_messages.commitment_checked_at is the watermark so a message is
-- scanned once, never re-scanned on webhook redelivery.
--
-- Idempotent. Depends on 102_whatsapp.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS wa_commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES wa_chats(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES wa_messages(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,                -- 'ours' | 'theirs'
    text TEXT NOT NULL,                     -- the commitment phrase, bounded
    due_hint TEXT,                          -- raw deadline phrase ('by Friday'…)
    status TEXT NOT NULL DEFAULT 'open',    -- 'open' | 'done' | 'dismissed'
    gtd_item_id UUID,                       -- linked task once captured (W1.2)
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_commitments_open
    ON wa_commitments(account_id, direction, status)
    WHERE status = 'open';

-- The scan watermark: NULL = not yet checked for a commitment.
ALTER TABLE wa_messages
    ADD COLUMN IF NOT EXISTS commitment_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_wa_messages_commitment_unchecked
    ON wa_messages(account_id, sent_at DESC)
    WHERE commitment_checked_at IS NULL;
