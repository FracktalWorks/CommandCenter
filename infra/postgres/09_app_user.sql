-- Application-level user table for NextAuth Google SSO (WBS 1.7).
-- Separate from the business `person` table (which tracks ClickUp/Zoho/Odoo
-- entities).  This table stores the identity that the Control Plane uses for
-- authentication, role assignment, and chat session ownership.
--
-- Role assignment:
--   - 'employee'  — default (every @fracktal.in user)
--   - 'executive' — manually set via SQL or the EXECUTIVE_EMAILS env var
--
-- The role is stored in the JWT session token by the NextAuth session callback
-- and forwarded to the gateway as X-User-Role on every proxied request.

CREATE TABLE IF NOT EXISTS app_user (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT UNIQUE NOT NULL,
    display_name    TEXT,
    avatar_url      TEXT,
    role            TEXT NOT NULL DEFAULT 'employee'
                        CHECK (role IN ('executive', 'employee')),
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup by email (used on every sign-in).
CREATE INDEX IF NOT EXISTS app_user_email_idx ON app_user (email);
