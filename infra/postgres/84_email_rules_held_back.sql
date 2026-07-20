-- 84: separate "held back from the model" from "the rules have run over this".
--
-- "Clean older mail" (#93) downloads years of history and must stop the
-- scheduled rule run from classifying all of it with a model. It did that by
-- stamping rules_processed_at, which is the ONE column meaning "the rules have
-- already decided about this message". Overloading it broke two things:
--
--   1. Process past emails skips rules_processed_at IS NOT NULL, so every
--      backfilled message became permanently invisible to AI categorization —
--      and the UI reported it as "already processed", which was false. That is
--      the opposite of what the user asked for:
--
--        "Ensure this does not interfere with AI categorization of past
--         emails."                                          — 2026-07-20
--
--   2. Anything else reasoning about rules_processed_at (the re-sync category
--      guard in persist.py, the Reply Zero backfill, the already_processed
--      tally) silently inherited the wrong meaning.
--
-- Two different states need two columns:
--
--   rules_processed_at   the rules ran over this message. Unchanged.
--   rules_held_back_at   downloaded as history; deliberately never sent to the
--                        model, but still eligible if the user asks for it.
--
-- The live rule run skips both. Process past emails skips only the first, so a
-- deliberate, bounded, user-initiated AI run still reaches history.
--
-- The partial index mirrors the live run's predicate. Without it, a full
-- backfill leaves ~36,000 held-back rows inside idx_email_messages_unprocessed
-- and every 5-minute cycle scans them all to find 50 candidates.
--
-- Idempotent. Depends on 21_email_rules_automation.sql.

ALTER TABLE email_messages
    ADD COLUMN IF NOT EXISTS rules_held_back_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_email_messages_rules_eligible
    ON email_messages (account_id)
    WHERE rules_processed_at IS NULL AND rules_held_back_at IS NULL;
