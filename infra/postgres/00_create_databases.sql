-- Create additional databases needed by services that share this Postgres instance.
-- Runs once on first container boot (docker-entrypoint-initdb.d).
-- The main "acb" database is already created by POSTGRES_DB env var.

-- LiteLLM: dedicated database to avoid Prisma schema conflicts.
SELECT 'CREATE DATABASE litellm'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm')
\gexec
