-- 127: Action-item dispatch — meeting follow-ups become real work automatically.
--
-- The summariser now classifies each extracted action item by WHAT KIND of
-- follow-up it is (a task to do, an email someone promised to send, a document
-- someone promised to write), and the new dispatcher (routes/notes/dispatch.py)
-- routes approved items to the matching system: gtd_items, the user's live
-- email account, or the note-taker agent's document workspace.
--
-- `resulting_task_id` stays task-only (it FKs the legacy task table by name);
-- non-task dispatches record their destination in `dispatch_ref` instead:
--   kind=task      → dispatch_ref = gtd_items.id (same value as resulting_task_id)
--   kind=email     → dispatch_ref = 'sent:<provider msg id>' | 'draft:<draft id>'
--   kind=document  → dispatch_ref = 'artifact:<agent>/<path>'
--
-- Auto-dispatch is user-configurable per kind in copilot_config; emails are
-- ONLY auto-sent when the recipient resolves to a known attendee address —
-- otherwise the dispatcher falls back to a provider draft (never guesses).

ALTER TABLE action_item
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'task';

ALTER TABLE action_item
    ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE action_item
    ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

ALTER TABLE action_item
    ADD COLUMN IF NOT EXISTS dispatch_ref TEXT;

ALTER TABLE action_item
    ADD COLUMN IF NOT EXISTS dispatch_error TEXT;

-- Per-kind auto-dispatch switches (Notes settings UI). Tasks and documents
-- default ON; email auto-send also defaults ON but is recipient-gated in code.
ALTER TABLE copilot_config
    ADD COLUMN IF NOT EXISTS auto_dispatch_tasks BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE copilot_config
    ADD COLUMN IF NOT EXISTS auto_dispatch_emails BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE copilot_config
    ADD COLUMN IF NOT EXISTS auto_dispatch_docs BOOLEAN NOT NULL DEFAULT TRUE;

-- The copilot's business-systems fan-out (CRM + tasks agents) was gated behind
-- a per-session flag that defaulted OFF, so in practice the copilot never
-- consulted other agents. New sessions now start with deep context ON; the
-- per-session toggle still turns it off.
ALTER TABLE live_session
    ALTER COLUMN deep_context SET DEFAULT TRUE;
