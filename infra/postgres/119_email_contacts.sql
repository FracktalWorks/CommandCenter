-- 119_email_contacts.sql — the people directory the mail app learns by itself.
--
-- What: adds `email_contacts`, one row per (account, address) the user
--   corresponds with, holding what we know ABOUT the person rather than about
--   their mail: display name, job title, organisation, phone numbers, links.
-- Why: the contact card (GET /email/contacts/card) already derives these from
--   the sender's own signature block on every open. Deriving is cheap for one
--   card and useless for anything else — a Contacts VIEW, a "who do we know at
--   this company" query, or a people picker cannot scan every mailbox body on
--   demand. Persisting what the parse learns turns a per-card lookup into an
--   accumulating directory, built with no data entry and no external service.
--
-- Provenance and precedence
--   `source` records where a row's values came from ('signature' = parsed from
--   the person's own sign-off, 'user' = typed by a human, 'import' = reserved
--   for a future directory sync). `manual_fields` names the columns a human has
--   edited by hand; the signature writer must SKIP those, forever. Without that
--   list, the next mail from the person silently reverts a correction — the one
--   failure that would make a contacts view untrustworthy.
--
--   Everything else stays derived and is deliberately NOT stored here: message
--   counts, first/last seen, unread — those are a live query over
--   email_messages and would be wrong the moment mail arrives.
--
-- Scope: rows are per email ACCOUNT (not per user) and cascade with it, so the
--   same person known through two mailboxes is two rows. That matches how
--   email_senders / email_newsletters already scope, and keeps a mailbox
--   disconnect from deleting knowledge that belonged to another one.
--
-- Depends on: 17_email_accounts.sql (email_accounts). ADDITIVE + idempotent.

CREATE TABLE IF NOT EXISTS email_contacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,              -- lowercased address
    display_name    TEXT,
    title           TEXT,                       -- job title, e.g. "Head of Partnerships"
    organization    TEXT,
    phones          TEXT[] NOT NULL DEFAULT '{}',
    links           TEXT[] NOT NULL DEFAULT '{}',
    -- Where the CURRENT values came from.
    source          TEXT NOT NULL DEFAULT 'signature'
                    CHECK (source IN ('signature', 'user', 'import')),
    -- Column names a human edited; the signature writer never overwrites these.
    manual_fields   TEXT[] NOT NULL DEFAULT '{}',
    -- The message whose signature produced the current values, and when it ran.
    source_message_id UUID,
    parsed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, email)
);

-- The card's read path: one address in one mailbox.
CREATE INDEX IF NOT EXISTS idx_email_contacts_account_email
    ON email_contacts (account_id, LOWER(email));

-- The future Contacts view browses/sorts by organisation.
CREATE INDEX IF NOT EXISTS idx_email_contacts_org
    ON email_contacts (account_id, organization)
    WHERE organization IS NOT NULL;
