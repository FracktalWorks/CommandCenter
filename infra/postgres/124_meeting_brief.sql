-- 124_meeting_brief.sql — the context a copilot needs to be useful.
--
-- What: `meeting.copilot_brief` — a short, user-written briefing for a meeting
--   ("Pricing negotiation with Acme. They churned in 2024, price-sensitive.
--   Goal: land the annual contract."), plus `live_session.deep_context` marking
--   whether this session may fan out to other agents for background.
-- Why: a copilot watching only the transcript can observe *that* an objection
--   was raised but knows nothing about who raised it or which deal it concerns,
--   so its suggestions stay generic. Context is what makes it specific. The
--   user-written brief is the highest-value, zero-dependency source — it needs
--   no connector and no inference, and it is usually the thing only the human
--   knows (the goal of the meeting).
-- Why deep_context is opt-in per session: fanning out to CRM/task/email agents
--   costs real tokens BEFORE the meeting produces a word. A quick internal
--   standup shouldn't trigger a CRM sweep, so it's off unless asked for.
-- Depends on: 95_note_taker.sql (meeting), 120_live_session.sql. ADDITIVE.
-- Spec: ai-company-brain/specs/live_meeting_copilot.md §5 (business context).

ALTER TABLE meeting
    ADD COLUMN IF NOT EXISTS copilot_brief TEXT;

ALTER TABLE live_session
    ADD COLUMN IF NOT EXISTS deep_context BOOLEAN NOT NULL DEFAULT FALSE;
