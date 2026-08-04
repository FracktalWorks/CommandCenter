-- ============================================================================
-- 143_access_request.sql — the sign-in queue (WS-24 / N6a)
-- ============================================================================
-- Spec: ai-company-brain/specs/colleague_onboarding.md §6.
--
-- Before this table, an authenticated stranger who reached the app produced
-- exactly one artefact: a `access_unprovisioned_signin` warning in journald.
-- Nothing read it back, so the owner's only way to learn that a colleague was
-- locked out was for that colleague to say so. One address knocked 53 times
-- over 18 hours on 2026-08-03/04 and the system told nobody.
--
-- Why a SEPARATE table rather than a fifth `app_user.status` (spec §6
-- DECISION): an `app_user` row IS the org's member record — it carries
-- `organization_id`, and `user_role`, the members list and the people
-- listings all join against it. `is_active = false` protects the *auth* path,
-- not every query that reads the roster. Somebody who merely knocked must not
-- acquire a row a future join can surface. Approval creates the real
-- `app_user` through the same `_provision_member` helper `POST /admin/members`
-- uses, so there is one provisioning path, not two.
--
-- What bounds the rows: `resolve_access` only reaches the recording branch for
-- an identity the IdP already authenticated, and
-- `AUTH_MICROSOFT_ENTRA_ID_TENANT` pins the issuer to the Fracktal directory.
-- Volume is bounded again by the resolver's 60s cache — one row-touch per
-- person per minute at worst, not one per request.
--
-- Idempotent. Depends on: nothing (additive, standalone table).
-- ============================================================================

CREATE TABLE IF NOT EXISTS access_request (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Stored as it arrived; uniqueness and every lookup are on lower(email),
    -- the same normalisation resolve_access applies before querying app_user.
    email           TEXT NOT NULL,
    display_name    TEXT NOT NULL DEFAULT '',
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- How many times they knocked. The number is the point: "53" is what makes
    -- a queue entry legible as somebody stuck, not somebody curious.
    attempt_count   INTEGER NOT NULL DEFAULT 1,
    -- pending | approved | denied. A decided request stays in the table as the
    -- record of the decision; a denied address that keeps signing in bumps
    -- last_seen_at/attempt_count but never returns to pending.
    status          TEXT NOT NULL DEFAULT 'pending',
    decided_by      TEXT NOT NULL DEFAULT '',
    decided_at      TIMESTAMPTZ
);

-- One row per person, case-insensitively — the upsert's conflict target.
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_request_email
    ON access_request (lower(email));

-- The Requests tab reads pending rows newest-knock-first, and the badge counts
-- them; the partial index keeps both cheap as decided rows accumulate.
CREATE INDEX IF NOT EXISTS idx_access_request_pending
    ON access_request (last_seen_at DESC)
    WHERE status = 'pending';
