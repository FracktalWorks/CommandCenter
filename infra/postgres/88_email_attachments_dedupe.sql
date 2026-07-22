-- 88: email attachments stop duplicating on every re-hydration.
--
-- All three attachment inserts (the sync persist path and the two on-demand
-- hydration paths) used a BARE `ON CONFLICT DO NOTHING`. With no arbiter that
-- clause fires on *any* unique constraint — but the only one on the table is
-- the primary key on `id`, which is a fresh gen_random_uuid() every insert and
-- so never conflicts. The DO NOTHING was therefore dead: every time a message's
-- attachments were re-fetched (open it twice, or a body-hydrate after an
-- attachment-hydrate) the same files were inserted again. The row count grew
-- without bound and the UI showed each attachment N times.
--
-- Give the table a real dedupe key: UNIQUE (message_id, provider_attachment_id),
-- which the inserts now name as their ON CONFLICT arbiter. provider_attachment_id
-- is the provider's stable per-attachment id (present for Graph and Gmail); the
-- rare NULL case (an attachment with no provider id) stays un-deduped, exactly
-- as before, because NULLs are distinct under a unique index.
--
-- Idempotent: the DELETE matches nothing once duplicates are gone, and the index
-- is created IF NOT EXISTS.

-- 1) Collapse existing duplicates, keeping one row per (message, provider id).
--    ctid is the physical row identity — keeping the lowest is arbitrary but
--    stable, and the rows are byte-identical anyway (same file metadata).
DELETE FROM email_attachments a
      USING email_attachments b
      WHERE a.provider_attachment_id IS NOT NULL
        AND a.message_id = b.message_id
        AND a.provider_attachment_id = b.provider_attachment_id
        AND a.ctid > b.ctid;

-- 2) The dedupe key + ON CONFLICT arbiter the inserts reference.
CREATE UNIQUE INDEX IF NOT EXISTS email_attachments_message_provider_uq
    ON public.email_attachments (message_id, provider_attachment_id);
