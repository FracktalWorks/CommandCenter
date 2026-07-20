-- 85: learned classification patterns get a review state.
--
-- A learned pattern is the strongest thing in the system: it SHORT-CIRCUITS the
-- classifier entirely, and it is the first and highest-confidence evidence the
-- Email Cleaner projects across the mailbox — on top of which the Cleaner offers
-- archive, unsubscribe and delete. One wrong FROM pattern therefore mislabels
-- every message from that sender, for free, forever.
--
-- Measured on the live account: 45 patterns, ALL of them source='AI' — none from
-- Fix, none from a label added in the mail client, none authored by hand. Every
-- pattern in the system was inferred by the machine from its own agreement with
-- itself (_sender_consistent_for_rule requires 3 matches to one rule, which
-- measures consistency, not correctness), and not one had ever been looked at.
--
--   "The learning patterns should drive cleanup, but first they must be
--    populated by categorizing most emails and obtaining user approval to
--    confirm their accuracy before proceeding with inbox cleaning."  — 2026-07-20
--
-- approved_at   a human has confirmed this pattern.
-- rejected_at   a human has said it is wrong. The row is KEPT rather than
--               deleted so the auto-learner cannot immediately re-learn it —
--               deleting it would make rejection futile.
--
-- Patterns the user authored are approved by definition: FIX (the Fix flow),
-- USER (typed into a rule), LABEL_ADDED / LABEL_REMOVED (a label the user
-- changed in their own mail client). Only 'AI' is left unreviewed, which is what
-- the review queue is for.
--
-- Idempotent. Depends on 31_email_rule_patterns.sql.

ALTER TABLE email_rule_patterns
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

UPDATE email_rule_patterns
   SET approved_at = created_at
 WHERE approved_at IS NULL
   AND rejected_at IS NULL
   AND source IN ('FIX', 'USER', 'LABEL_ADDED', 'LABEL_REMOVED');

-- The cleaner asks "which patterns may I project?" on every sweep.
CREATE INDEX IF NOT EXISTS idx_email_rule_patterns_review
    ON email_rule_patterns (account_id)
    WHERE rejected_at IS NULL AND approved_at IS NULL;
