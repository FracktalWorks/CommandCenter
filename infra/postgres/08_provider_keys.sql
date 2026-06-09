-- AI Company Brain — Encrypted provider API key store (ADR-008 migration).
-- Replaces infra/.env + LiteLLM proxy key injection.
-- Keys are AES-256-GCM encrypted at rest; decrypted in-memory by the gateway
-- using a single ACB_MASTER_KEY (never stored in the database).

CREATE TABLE IF NOT EXISTS provider_keys (
    provider    TEXT PRIMARY KEY,           -- e.g. "openai", "anthropic", "deepseek"
    encrypted   TEXT NOT NULL,              -- AES-256-GCM ciphertext (base64)
    label       TEXT,                       -- human label (e.g. "Production key")
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys (provider);
