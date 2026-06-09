-- Create additional databases needed by services that share this Postgres instance.
-- Runs once on first container boot (docker-entrypoint-initdb.d).
-- The main "acb" database is already created by POSTGRES_DB env var.

-- LiteLLM database removed (ADR-008: using litellm SDK directly, no proxy).
-- Provider keys are stored in the main "acb" database (provider_keys table).
