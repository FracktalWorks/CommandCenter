-- ============================================================================
-- 135_room_authorship_and_agents.sql — a transcript that knows who said what
-- ============================================================================
-- Spec: ai-company-brain/specs/groups_sessions_authority.md §4 (the transcript
--       boundary) + docs/multiplayer/README.md §3.4, §4.3.
--
-- Migration 134 said WHO IS IN a session. This one makes the session's contents
-- legible to more than one reader:
--
--   chat_message.author_email     who produced this turn — a member's email or
--   chat_message.author_kind      an agent's registered name; kind separates the
--                                 two so the UI never has to guess from `role`.
--   chat_message.authority        the clearance the producing run acted under
--                                 (spec §4) — NULL for solo runs, so solo rows
--                                 cost nothing and read exactly as before.
--   chat_session_agent            WHICH AGENTS are in the room. A room is not
--                                 one agent's thread any more.
--   chat_session.floor_mode       who may drive the agents right now.
--   chat_session.history_visibility  what a late joiner may read.
--
-- Why `role` was not enough. `chat_message.role` is the MODEL's vocabulary
-- ('user'|'assistant'|'system') — it says which side of the conversation a
-- turn sits on, which is what the LLM needs. It cannot say WHICH human or
-- WHICH agent, and in a room those are the only interesting questions. The two
-- vocabularies stay separate: `role` keeps feeding the model, `author_*` feeds
-- the humans. Nothing reads `role` for attribution.
--
-- Why authority is JSONB and not a hash. The spec calls for "the intersected
-- set's hash", which identifies a clearance but cannot be TESTED against a
-- reader — you can only compare it to another hash. Replay has to answer "may
-- THIS person see THIS message", so the row carries the two facts that answer
-- it: who was in the room (`members`) and which scoped capabilities the run was
-- allowed to use (`caps`). A reader who was in the room sees it because they
-- already could; a reader who wasn't must hold every capability the run held.
-- `fp` keeps the hash for cheap equality checks and log correlation.
--
-- Idempotent. Depends on: 02_chat_history.sql, 134_groups_and_session_participants.sql.
-- ============================================================================

-- ── Message authorship ──────────────────────────────────────────────────────

ALTER TABLE chat_message
    ADD COLUMN IF NOT EXISTS author_email TEXT,
    ADD COLUMN IF NOT EXISTS author_kind  TEXT,
    ADD COLUMN IF NOT EXISTS authority    JSONB;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chat_message_author_kind_check'
    ) THEN
        ALTER TABLE chat_message
            ADD CONSTRAINT chat_message_author_kind_check
            CHECK (author_kind IS NULL
                   OR author_kind IN ('human', 'agent', 'system'));
    END IF;
END $$;

-- ── Which agents are in the room ────────────────────────────────────────────
-- Deliberately NOT chat_session_participant rows. Participants are access
-- PRINCIPALS: the intersection rule (spec §3) folds their EffectiveAccess and
-- an agent has none of its own — it acts at the room's. Putting agents in that
-- table would make the fold either crash on an unknown subject or, worse,
-- silently treat an agent as a person with no access and zero every room.
--
-- chat_session.agent_name stays the room's PRIMARY agent (every existing read
-- path uses it, and an unaddressed turn goes there). This table is additive:
-- the other agents a member may address with @name.

CREATE TABLE IF NOT EXISTS chat_session_agent (
    session_id  TEXT NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    agent_name  TEXT NOT NULL,
    -- 'primary' answers an unaddressed turn; 'mentioned' only answers when
    -- addressed by name. Exactly one primary per session is enforced in the
    -- application (a partial unique index would fight the backfill below).
    role        TEXT NOT NULL DEFAULT 'mentioned'
                  CHECK (role IN ('primary', 'mentioned')),
    added_by    TEXT,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, agent_name)
);

CREATE INDEX IF NOT EXISTS chat_session_agent_agent_idx
    ON chat_session_agent (agent_name);

-- ── Room controls ───────────────────────────────────────────────────────────

ALTER TABLE chat_session
    ADD COLUMN IF NOT EXISTS floor_mode TEXT NOT NULL DEFAULT 'open',
    ADD COLUMN IF NOT EXISTS history_visibility TEXT NOT NULL DEFAULT 'full';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chat_session_floor_mode_check'
    ) THEN
        ALTER TABLE chat_session
            ADD CONSTRAINT chat_session_floor_mode_check
            CHECK (floor_mode IN ('open', 'driver'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chat_session_history_visibility_check'
    ) THEN
        ALTER TABLE chat_session
            ADD CONSTRAINT chat_session_history_visibility_check
            CHECK (history_visibility IN ('full', 'since_join'));
    END IF;
END $$;

-- 'open' is the default because it IS today's behaviour: anyone who can reach
-- the thread may send, and the concurrent-run 409 (agent.py
-- _refuse_if_another_run_is_active) already stops a second sender from
-- destroying a live run. 'driver' adds the baton on top. Defaulting to
-- 'driver' would silently require a floor acquire on every existing solo
-- session — a migration that changes behaviour is a migration that breaks
-- production.

-- ── Backfill: attribute the history we can attribute exactly ────────────────
-- This is NOT a guess. Before rooms existed a session had exactly one human
-- (chat_session.user_id) and one agent (chat_session.agent_name), so every
-- 'user' turn is that human's and every 'assistant' turn is that agent's.
-- Sessions whose user_id is the pre-auth literal 'default' get a NULL
-- author_email with kind 'human': we know a person typed it, we do not know
-- which person, and inventing one would put a name on words nobody said.

UPDATE chat_message m
   SET author_kind  = 'human',
       author_email = NULLIF(s.user_id, 'default')
  FROM chat_session s
 WHERE m.session_id = s.id
   AND m.role = 'user'
   AND m.author_kind IS NULL;

UPDATE chat_message m
   SET author_kind  = 'agent',
       author_email = s.agent_name
  FROM chat_session s
 WHERE m.session_id = s.id
   AND m.role = 'assistant'
   AND m.author_kind IS NULL;

UPDATE chat_message
   SET author_kind = 'system'
 WHERE role = 'system'
   AND author_kind IS NULL;

-- Every session's existing agent becomes its primary agent, so "which agents
-- are in this room" is answerable for history too, not only for new rooms.
INSERT INTO chat_session_agent (session_id, agent_name, role)
SELECT id, agent_name, 'primary'
FROM chat_session
WHERE agent_name IS NOT NULL AND agent_name <> ''
ON CONFLICT DO NOTHING;

-- "Show me this room's turns by author" — the transcript render, and the
-- per-participant attribution the room header counts from.
CREATE INDEX IF NOT EXISTS chat_message_author_idx
    ON chat_message (session_id, author_email);
