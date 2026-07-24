-- ============================================================================
-- 108_whatsapp_group_summaries.sql — per-group AI summaries (W4)
-- ============================================================================
-- "Groups become one paragraph" (value pillar V4). A founder is in 18 dealer/
-- team groups; the one @mention that needed them dies above the fold. This
-- caches ONE latest AI summary per group chat — what was discussed, the
-- sentiment, whether the founder was addressed, and the ≤N points worth their
-- eye — so the digest and a Groups view can show a paragraph instead of a
-- firehose. Regenerated on demand / on a schedule (NOT in the hot webhook path,
-- since summarization is an LLM call); ``covered_through`` is the watermark so a
-- quiet group isn't re-summarized.
--
-- Idempotent. Depends on 102_whatsapp.sql (wa_accounts, wa_chats).
-- ============================================================================

CREATE TABLE IF NOT EXISTS wa_group_summaries (
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES wa_chats(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    sentiment TEXT,                          -- positive | neutral | negative | mixed
    mentions_you BOOLEAN NOT NULL DEFAULT false,
    -- The ≤N questions / decisions worth the founder's attention: [str].
    key_points JSONB NOT NULL DEFAULT '[]',
    message_count INTEGER NOT NULL DEFAULT 0,-- messages the summary covered
    covered_through TIMESTAMPTZ,             -- newest message included (watermark)
    generated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (account_id, chat_id)
);

-- The digest leads with groups that need the founder — index the flag.
CREATE INDEX IF NOT EXISTS idx_wa_group_summaries_mentions
    ON wa_group_summaries(account_id, mentions_you);
