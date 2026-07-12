-- 65_gtd_item_origin.sql — where a capture came from (email → task, §2.1).
--
-- What: gtd_items.origin JSONB — source linkage for captures created from
--       another app, e.g. {"kind": "email", "account_id": …, "email_id": …,
--       "subject": …, "from_name": …, "from_email": …}.
-- Why:  GTD ubiquitous capture: an email becomes an inbox item WITH a link
--       back to its source, so Clarify has the context and the UI can jump
--       to the original. Also the idempotency key for capture-from-email
--       (capturing the same email twice returns the existing item).
-- Depends on: 48_task_manager_gtd.sql (gtd_items).
-- Idempotent: ADD COLUMN IF NOT EXISTS; re-runs safely on every deploy.

ALTER TABLE gtd_items ADD COLUMN IF NOT EXISTS origin JSONB;

-- Fast idempotency lookup for email-origin captures.
CREATE INDEX IF NOT EXISTS idx_gtd_items_origin_email
    ON gtd_items((origin->>'email_id')) WHERE origin IS NOT NULL;
