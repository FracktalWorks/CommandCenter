-- "Reply" → "Needs Reply": the conversation-status label finally says what it
-- means (a bare "Reply" read as a verb/button, not a state). Code maps legacy
-- values at ingest (persist._RENAMED_LABELS) because the categories-authoritative
-- provider re-asserts message categories every sync; this migration rewrites
-- everything WE own. Idempotent.

-- The system rule (seeded presets may carry system_type NULL — match by name too).
UPDATE email_rules
   SET name = 'Needs Reply'
 WHERE name = 'Reply';

-- Its LABEL action (and any other action labelling the old value).
UPDATE email_actions
   SET label = 'Needs Reply'
 WHERE label = 'Reply';

-- The local category mirror. Provider-side old values are canonicalised at
-- ingest from now on, so this rewrite sticks.
UPDATE email_messages
   SET categories = array_replace(categories, 'Reply', 'Needs Reply'),
       updated_at = now()
 WHERE 'Reply' = ANY(categories);
