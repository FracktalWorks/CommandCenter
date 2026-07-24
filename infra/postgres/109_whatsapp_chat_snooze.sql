-- ============================================================================
-- 109_whatsapp_chat_snooze.sql — snooze / "remind me later" on a chat (W6)
-- ============================================================================
-- A staple of every serious inbox: defer a conversation out of the triage queue
-- until a chosen time, then let it resurface on its own. Snooze is an ORTHOGONAL
-- overlay on Reply Zero — the chat keeps its real status (NEEDS_REPLY / AWAITING /
-- …); ``snoozed_until`` just hides it from the streams until the time passes (the
-- queue reads filter ``snoozed_until IS NULL OR snoozed_until <= now()``), so a
-- snooze auto-expires with no batch. A NEW inbound message clears the snooze in
-- recompute_chat_status (they wrote — surface it), so a snooze can never bury a
-- fresh reply.
--
-- Idempotent. Depends on 102_whatsapp.sql (wa_chat_status).
-- ============================================================================

ALTER TABLE wa_chat_status
    ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

-- The 'Snoozed' stream + the wake filter both key on this; partial so only the
-- handful of currently-snoozed chats are indexed.
CREATE INDEX IF NOT EXISTS idx_wa_chat_status_snoozed
    ON wa_chat_status(account_id, snoozed_until)
    WHERE snoozed_until IS NOT NULL;
