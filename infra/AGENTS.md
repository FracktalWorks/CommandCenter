# Infrastructure

## Purpose
Docker Compose, Postgres schema, LiteLLM config (legacy — LLM routing is via gateway /v1 endpoint; no proxy files remain).

## Key Files
- docker-compose.yml -- core services (Postgres 16 + pgvector, Redis 7)
- postgres/ -- schema files (00-08) + 09_app_user.sql (NextAuth users)

## Conventions
- Postgres migrations are numbered SQL files
- LiteLLM model names follow tier1/tier2/tier3/copilot/ patterns
- **LiteLLM uses Prisma internally → `DATABASE_URL` MUST be `postgresql://` (plain, no `+psycopg` suffix)**
- All LLM calls go through the gateway `/v1/chat/completions` endpoint (Python litellm SDK, no proxy)
- Redis is vanilla alpine (redis-stack deferred)
- No Langfuse container (OTel-ready, backend TBD)

## Verification
- docker compose up must start all services
- LiteLLM must route to configured providers
- Postgres must have all schema files applied
