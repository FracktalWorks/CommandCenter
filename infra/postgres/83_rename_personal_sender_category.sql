-- 83: sender category "Personal" → "Conversation".
--
-- ``email_senders.category`` is a SENDER-level rollup, never a label on a
-- message and never synced to the provider — so this is a pure local rename
-- with nothing upstream to keep in step.
--
-- "Personal" was wrong twice over. It implied private-life mail, while every
-- sender it matched on the live account was a work colleague or client. And it
-- collided with Cold Email, which is also one human writing to another — the
-- difference between them is not that one is a person, it is that a reply came
-- back. "Conversation" names that, and matches the labels it is derived from
-- (Reply / Awaiting Reply / FYI / Done).
--
-- This one DOES rewrite rows, unlike migrations 81/82: the value is a derived
-- rollup that the categorize job recomputes on its own schedule, not a setting
-- anybody chose. Leaving the old string would strand those senders under a name
-- no code produces any more — invisible to the "important emails" boost, which
-- matches on the category text.
--
-- Idempotent: re-running matches nothing.

UPDATE email_senders
   SET category = 'Conversation', updated_at = now()
 WHERE category = 'Personal';
