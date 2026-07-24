-- 107: opt-in "morning brief" — an LLM one-liner atop the dashboard and the
-- emailed digest ("2 urgent: X's quote, Y's contract"). OFF by default: it
-- costs a model call per dashboard load / digest send, so the user turns it on.
ALTER TABLE email_assistant_settings
  ADD COLUMN IF NOT EXISTS morning_brief_enabled boolean DEFAULT false;
