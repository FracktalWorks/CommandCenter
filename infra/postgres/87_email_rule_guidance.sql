-- 87: corrections that teach the CLASSIFIER, as first-class rows.
--
-- Until now a Fix could only produce a learned pattern — a hard sender→rule
-- pin that SKIPS the classifier. So correcting a mistake never made the AI
-- better at anything; it removed one sender from the AI's reach and left the
-- same misunderstanding in place for every other sender. Every one of the live
-- account's 21 patterns was machine-inferred; not one encoded something the
-- user had actually taught.
--
-- These rows are the other half: free-text guidance attached to a rule and
-- injected into the classification prompt. They change how the model REASONS,
-- so one correction about "vendor product digests are Newsletter, not Cold
-- Email" generalises to every vendor, not just the one that was wrong.
--
-- WHY A TABLE AND NOT AN EDIT TO email_rules.instructions:
--
--   * Auditable. The user can see exactly what was added, when, and from which
--     email. An LLM rewrite of the rule's own text destroys the sentence they
--     wrote and leaves nothing to compare against.
--   * Revertible. One row, one delete. Un-editing a paragraph is not.
--   * Separable. The Learned Patterns screen splits into "improves the AI"
--     (these) and "replaces the AI" (email_rule_patterns), which is only
--     possible if the two are stored apart.
--
-- rule_id is nullable: guidance that isn't about one rule ("mail from our own
-- domain is never Cold Email") applies to the whole classification prompt.

CREATE TABLE IF NOT EXISTS email_rule_guidance (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    rule_id      UUID REFERENCES email_rules(id) ON DELETE CASCADE,
    guidance     TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'FIX',   -- FIX | USER
    reason       TEXT,
    -- Provenance: the message that prompted the correction, so the user can see
    -- what they were looking at when they wrote it.
    message_id   UUID REFERENCES email_messages(id) ON DELETE SET NULL,
    thread_id    TEXT,
    active       BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ DEFAULT now(),
    updated_at   TIMESTAMPTZ DEFAULT now()
);

-- The classifier reads this on every uncached classification, per rule.
CREATE INDEX IF NOT EXISTS idx_email_rule_guidance_lookup
    ON email_rule_guidance (account_id, rule_id)
    WHERE active;

-- Saying the same thing twice teaches nothing and costs prompt budget on every
-- classification. Case-insensitive so "Zoho digests are newsletters" does not
-- land twice with different capitalisation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_rule_guidance_text
    ON email_rule_guidance (account_id, COALESCE(rule_id, '00000000-0000-0000-0000-000000000000'::uuid), LOWER(TRIM(guidance)));
