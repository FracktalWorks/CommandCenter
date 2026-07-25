-- ============================================================================
-- 112_whatsapp_provider.sql — multi-transport: Cloud API + whatsmeow bridge (W15)
-- ============================================================================
-- The vertical was built behind a provider abstraction (whatsapp_ingestion.
-- providers) so a second transport can share the whole store + AI brain. This
-- column records which transport a connected number uses:
--   'cloud_api'  — the official Meta WhatsApp Business Cloud API (default).
--   'whatsmeow'  — a personal number paired by QR through the local whatsmeow
--                  bridge service (unofficial multi-device; see apps/services/
--                  whatsapp_bridge). Inbound arrives at /whatsapp/bridge/ingest
--                  and flows through the SAME persist + post-sync hooks.
--
-- Existing rows default to 'cloud_api', so this is a no-op for connected numbers.
-- Idempotent. Depends on 102_whatsapp.sql.
-- ============================================================================

ALTER TABLE wa_accounts
    ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'cloud_api';

-- The send path + the bridge routes filter by provider; index it.
CREATE INDEX IF NOT EXISTS idx_wa_accounts_provider
    ON wa_accounts(provider);
