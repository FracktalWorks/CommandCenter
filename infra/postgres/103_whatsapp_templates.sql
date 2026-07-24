-- ============================================================================
-- 103_whatsapp_templates.sql — the approved template library (W1)
-- ============================================================================
-- WhatsApp Cloud API messages sent OUTSIDE the 24h customer-service window must
-- use a Meta-approved template. This table mirrors those templates so the
-- composer's `/` picker and the standing rules (payment chase, follow-up nudge)
-- can reference them by name and surface their approval state + cost before a
-- send. Templates are authored/approved in Meta's dashboard; we mirror the
-- catalog here (and seed a default set on connect).
--
-- Idempotent. Depends on 102_whatsapp.sql (wa_accounts).
-- ============================================================================

CREATE TABLE IF NOT EXISTS wa_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                     -- Meta template name (snake_case)
    language TEXT NOT NULL DEFAULT 'en',    -- BCP-47 code, e.g. 'en' | 'hi'
    category TEXT DEFAULT 'UTILITY',        -- Meta: UTILITY | MARKETING | AUTHENTICATION
    body TEXT NOT NULL DEFAULT '',          -- the body text (with {{1}} placeholders)
    -- Named placeholders in body order, for the picker to prompt the sender:
    -- e.g. ["invoice_no", "amount"]. Empty for a no-variable template.
    variables JSONB NOT NULL DEFAULT '[]',
    meta_status TEXT NOT NULL DEFAULT 'pending', -- 'approved' | 'pending' | 'rejected'
    cost_hint TEXT,                         -- human note, e.g. 'utility · ~₹0.35'
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(account_id, name, language)
);

CREATE INDEX IF NOT EXISTS idx_wa_templates_account
    ON wa_templates(account_id, meta_status);
