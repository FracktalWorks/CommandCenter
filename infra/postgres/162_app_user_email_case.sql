-- 162 — one address is one person, case-insensitively (WS-29, D-MT-1).
--
-- ⚠️ FOUND BY A LIVE RUN, and it contradicted a claim the multi-tenant design
-- was resting on.
--
-- `multi_tenancy.md` §1.1 said one person belongs to one organization
-- **structurally**, because `app_user.email` is UNIQUE. That index is
-- `UNIQUE (email)` — BYTE-EXACT — while every lookup in this codebase matches
-- `lower(email)` (house rule R10, case-insensitive on both sides). The two
-- disagree, and the gap is not theoretical:
--
--     INSERT app_user ('Casey@Alpha.Example', org A)   -- ok
--     INSERT app_user ('casey@alpha.example', org B)   -- ALSO ok
--     -- one human, two rows, two organizations
--
-- Reproduced against a real database before this file was written. The
-- consequence is worse than a duplicate row: `resolve_organization_id` — which
-- WS-29b made the answer to "which tenant is this caller", and which S1-1 then
-- made the answer for the whole admin plane — matches on `lower(email)` and
-- returns whichever row the planner hands back. **A person's tenant becomes
-- non-deterministic**, and so therefore does everything scoped by it.
--
-- WS-29's S1-1 closed this in application code, in the one write path that
-- could reach it (`provision_member`). That guard is correct and it stays, but
-- it is a guard on ONE path: any future insert into `app_user` bypasses it, and
-- "remember to lower-case here" is the class of discipline that produced 137
-- unscoped tables. The index is the version that cannot be forgotten.
--
-- **Idempotent**, like every migration in this tree: `IF NOT EXISTS` on the
-- create, and the drop names the constraint it is replacing rather than
-- assuming it is present.

BEGIN;

-- The functional index first, so there is never a window with neither.
--
-- NOT `CREATE INDEX CONCURRENTLY`: that cannot run inside a transaction block,
-- and `app_user` is a table of colleagues — tens of rows, not millions. The
-- brief exclusive lock is cheaper than the two-phase dance and its INVALID-index
-- failure mode.
CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_lower_key
    ON app_user (lower(email));

-- Only now retire the byte-exact one it subsumes. Dropped rather than kept
-- because two unique indexes on the same column say two different things about
-- the same fact, and the weaker one is the one somebody would later "fix" a
-- constraint violation against.
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_email_key;

COMMIT;

-- ── What this does NOT do ───────────────────────────────────────────────────
--
-- It does not normalise existing addresses to lower case. Stored spelling is
-- how a person's name appears in an invitation and in every audit row that
-- names them, and rewriting it would be a cosmetic change with a real cost:
-- `created_by`, `assignee`, `subject` and `updated_by` are bare address strings
-- across a dozen tables (D-PM-4), none of them foreign keys, so a normalising
-- UPDATE here would silently orphan them.
--
-- Matching is already case-insensitive everywhere by R10, so the stored casing
-- is presentation. This index makes that assumption enforceable rather than
-- merely conventional.
--
-- ── If this migration FAILS ─────────────────────────────────────────────────
--
-- It fails only if two rows already differ by case alone, which means the
-- deployment already has the bug and one of the rows is a person's second
-- identity. Do not resolve it by deleting the newer row: check which
-- organization each belongs to first, because under D-MT-1 that is the
-- question, and merging the wrong direction moves somebody between tenants.
-- Verified clean on this checkout before the file was written.
