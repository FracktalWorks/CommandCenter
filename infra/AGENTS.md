# Infrastructure

## Purpose
Docker Compose, Postgres schema, LiteLLM config, Redis.

## Key Files
- docker-compose.yml -- all services
- postgres/ -- schema files (00-08) + 09_app_user.sql (NextAuth users)
- litellm/config.yaml -- model routing, tier aliases, provider keys

## Conventions
- Postgres migrations are numbered SQL files
- LiteLLM model names follow tier1/tier2/tier3/copilot/ patterns
- Redis is vanilla alpine (redis-stack deferred)
- No Langfuse container (OTel-ready, backend TBD)

## Verification
- docker compose up must start all services
- LiteLLM must route to configured providers
- Postgres must have all schema files applied
