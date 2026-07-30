-- ============================================================================
-- 134_groups_and_session_participants.sql — the two shared primitives
-- ============================================================================
-- Spec: ai-company-brain/specs/groups_sessions_authority.md §1–§2
--       (answers org_access_control.md §10.2 collisions 1 and 2)
--
-- Two workstreams — access control Phase 2 ("modules/teams") and multiplayer
-- collaboration ("who is in this room") — need the same primitives. This
-- migration builds each ONCE:
--
--   org_group / org_group_member      what "the sales team" means, everywhere:
--                                     team-scoped grants (later), team agent
--                                     instancing (t:<slug>), session sharing
--                                     subjects (group:<slug>), shared mailboxes
--                                     (later).
--   chat_session.visibility           who can DISCOVER a session
--   chat_session_participant          who is IN it, and as what
--
-- Vocabulary decisions (the spec's, restated where they bite):
--   * visibility ∈ (private|people|org) — apps.visibility's exact values
--     (114_custom_apps), not a new set. 'people' means "the named subjects
--     below", matching how the Custom Apps sharing UI already reads.
--   * participant subject ∈ email | 'group:<slug>' | 'org' — app_grants'
--     subject vocabulary. Group subjects expand at READ time, so leaving a
--     group removes you from its rooms with no fan-out write.
--   * There is NO acting_identity column, deliberately: a shared run acts at
--     the INTERSECTION of all participants' access (spec §3), never as one
--     member. A column naming one member's authority would be the
--     actor-authority default the handoff warned against.
--
-- Groups are flat (no parent_group_id): nesting makes every membership check
-- a graph walk and every "why can they see this" unexplainable. Groups SCOPE,
-- they never AUTHORIZE — permissions stay in org_role/user_permission_override.
--
-- Idempotent. Depends on: 02_chat_history.sql, 130_org_access_control.sql.
-- ============================================================================

-- ── Groups ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS org_group (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    slug            TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    description     TEXT,
    created_by      TEXT,                     -- email; informational, not FK
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS org_group_member (
    group_id        UUID NOT NULL REFERENCES org_group(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    -- 'lead' manages this group's membership without admin:members:manage.
    -- It is a group-scoped role, not a permission bundle.
    role            TEXT NOT NULL DEFAULT 'member'
                      CHECK (role IN ('lead', 'member')),
    added_by        TEXT,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);

-- "Which groups is this person in" — the hot lookup for subject expansion.
CREATE INDEX IF NOT EXISTS org_group_member_user_idx
    ON org_group_member (user_id);

-- ── Session visibility + participants ───────────────────────────────────────

ALTER TABLE chat_session
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

-- CHECK added separately so re-running against a table that already has the
-- column doesn't fail, and so the constraint carries a stable name.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chat_session_visibility_check'
    ) THEN
        ALTER TABLE chat_session
            ADD CONSTRAINT chat_session_visibility_check
            CHECK (visibility IN ('private', 'people', 'org'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS chat_session_participant (
    session_id      TEXT NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    -- email | 'group:<slug>' | 'org' — the app_grants subject vocabulary.
    subject         TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member'
                      CHECK (role IN ('owner', 'member', 'viewer')),
    added_by        TEXT,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Late-joiner history waterline: feeds the EXISTING /reconnect?since=
    -- cursor and the chat_message timestamp filter (multiplayer README §4.3).
    join_stream_id  TEXT,
    join_message_ts BIGINT,
    last_seen_at    TIMESTAMPTZ,
    PRIMARY KEY (session_id, subject)
);

-- "Which rooms am I in" — the session-list query for a member.
CREATE INDEX IF NOT EXISTS chat_session_participant_subject_idx
    ON chat_session_participant (subject, added_at DESC);

-- ── Backfill: every session gets exactly one owner row ──────────────────────
-- chat_session.user_id keeps its meaning (creator); participation is additive.
-- Rows whose user_id is an email own themselves. The pre-auth literal
-- 'default' backfills to the org owner (the same bootstrap answer 128 gave):
-- those sessions predate authentication, and the deployment's owner is the
-- only principal with a defensible claim to them. Everything stays 'private',
-- so deploying this changes nobody's access.

INSERT INTO chat_session_participant (session_id, subject, role)
SELECT s.id, s.user_id, 'owner'
FROM chat_session s
WHERE s.user_id LIKE '%@%'
ON CONFLICT DO NOTHING;

INSERT INTO chat_session_participant (session_id, subject, role)
SELECT s.id, u.email, 'owner'
FROM chat_session s
CROSS JOIN LATERAL (
    SELECT au.email
    FROM user_role ur
    JOIN org_role r ON r.id = ur.role_id AND r.slug = 'owner'
    JOIN app_user au ON au.id = ur.user_id
    ORDER BY au.created_at
    LIMIT 1
) u
WHERE s.user_id NOT LIKE '%@%'
  AND NOT EXISTS (
      SELECT 1 FROM chat_session_participant p WHERE p.session_id = s.id
  )
ON CONFLICT DO NOTHING;
