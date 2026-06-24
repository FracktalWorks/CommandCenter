-- ============================================================================
-- 39_email_learned_writing_style.sql — auto-derived writing style (Phase 8 P2)
-- ============================================================================
-- A writing style the assistant *learns* (vs. the user-set `writing_style`),
-- regenerated from accumulated PREFERENCE reply memories as the user edits
-- drafts — inbox-zero's learnedWritingStyle. It's injected as advisory context
-- (lower priority than an explicit writing_style). The evidence-count column
-- tracks how many style-evidence memories existed at the last refresh so we only
-- regenerate when enough new ones have accrued.
--
-- Idempotent. Depends on 26_email_knowledge_style.sql, 38_email_reply_memory_scopes.sql.
-- ============================================================================

ALTER TABLE email_assistant_settings
    ADD COLUMN IF NOT EXISTS learned_writing_style TEXT,
    ADD COLUMN IF NOT EXISTS learned_style_evidence_count INTEGER NOT NULL DEFAULT 0;
