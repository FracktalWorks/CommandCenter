-- ============================================================================
-- 106_whatsapp_ai_drafts.sql — cached AI reply drafts (W3)
-- ============================================================================
-- When the auto-reply engine (automation/rules.py) decides a chat warrants a
-- DRAFT, the LLM generates a reply in the founder's WhatsApp voice and it is
-- cached here for the composer's "✦ Suggested reply" chip. One draft per chat
-- (PK on account_id+chat_id), replaced when regenerated. Mirrors the email
-- vertical's email_ai_drafts.
--
-- Idempotent. Depends on 102_whatsapp.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS wa_ai_drafts (
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES wa_chats(id) ON DELETE CASCADE,
    draft_text TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',    -- BCP-47 the reply is written in
    register TEXT,                          -- tone note, e.g. 'dealer' | 'vip'
    generated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (account_id, chat_id)
);
