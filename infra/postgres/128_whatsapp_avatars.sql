-- ============================================================================
-- 132_whatsapp_avatars.sql — native WhatsApp profile pictures, synced (W17)
-- ============================================================================
-- Chats in the WhatsApp app render as colored initials — there was never a real
-- photo synced for anyone. The whatsmeow (personal-number) bridge can fetch a
-- contact/group's profile picture URL directly from WhatsApp; this gives it a
-- home so the inbox can render the real DP instead.
--
-- Keyed by (account_id, wa_chat_id) — the JID — rather than the wa_chats UUID,
-- same reasoning as wa_chat_labels (113/117): an avatar can be fetched before a
-- chat's first message has synced, so the association must not depend on the
-- chat row existing yet. The chats query LEFT JOINs this in.
--
-- avatar_url is WhatsApp's own CDN URL (not proxied/stored) — the same "read-only
-- mirror, no server-side copy" posture as labels. These URLs do rotate; the
-- bridge re-checks each contact on a TTL and overwrites the row when it changes.
--
-- Idempotent. Depends on 102_whatsapp.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS wa_chat_avatars (
    account_id  UUID NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
    wa_chat_id  TEXT NOT NULL,               -- WhatsApp JID (matches wa_chats.wa_chat_id)
    avatar_url  TEXT NOT NULL,               -- WhatsApp CDN URL (rotates; not cached locally)
    avatar_hash TEXT,                        -- whatsmeow's picture hash, for change detection
    updated_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (account_id, wa_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_chat_avatars_account
    ON wa_chat_avatars(account_id);
