-- Inbox-zero parity: per-field AI-vs-manual model on rule actions.
--
-- Upstream models every action field as {value, ai, setManually}. We adopt a
-- pragmatic subset of two explicit flags that drive both the rule editor's
-- toggles ("Use prompt"/"Use label", "Set content manually"/"Use AI draft")
-- and apply-time behavior:
--   * label_ai       — the LABEL action's `label` is an AI prompt ({{...}})
--                      the assistant resolves per-email, not a fixed label.
--   * content_manual — a draft/reply uses the authored `content` template
--                      (false = the AI writes the body from history/knowledge).
-- Idempotent (02+ auto-applied on deploy).

ALTER TABLE email_actions
    ADD COLUMN IF NOT EXISTS label_ai BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE email_actions
    ADD COLUMN IF NOT EXISTS content_manual BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing draft/reply/forward actions that carry non-empty content
-- were authored templates, so preserve that behavior under the explicit flag.
UPDATE email_actions
   SET content_manual = true
 WHERE content IS NOT NULL
   AND btrim(content) <> ''
   AND type IN ('REPLY', 'FORWARD', 'DRAFT_EMAIL');
