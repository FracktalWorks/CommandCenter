# Infrastructure

## Purpose
Docker Compose, Postgres schema, LiteLLM tier config. LLM routing is via the gateway `/v1` endpoint (in-process litellm SDK, no proxy process). The legacy proxy files `litellm/config.yaml` + `litellm/tier_overrides.yaml` are **still on disk but vestigial** — only their tier rows are read; retiring them is tracked as BO-16.

## Key Files
- docker-compose.yml -- core services (Postgres 16 + pgvector, Redis 7)
- postgres/ -- schema files (00-10) + 09_app_user.sql (NextAuth users) + 11_integration_credentials.sql (unified credential store) + 130_org_access_control.sql (organization, membership lifecycle on app_user, org_role/org_role_permission/user_role, user_permission_override, feature_catalog — spec: ai-company-brain/specs/org_access_control.md) + 131_integration_memory_permissions.sql (additive: grants `integrations:use:*` + org-memory permissions to the seeded roles; `member` reads org memory but does not write it) + 143_access_request.sql (the sign-in queue — one row per address that authenticated with no `app_user` row, unique on `lower(email)`; deliberately a SEPARATE table and not a fifth `app_user.status`, because an `app_user` row IS the org's member record and a stranger who merely knocked must not acquire one that a future join can surface — spec: ai-company-brain/specs/colleague_onboarding.md §6)

## Conventions
- Postgres migrations are numbered SQL files
- Access control: `app_user.role` (executive/employee) is RETAINED and dual-written alongside the org role model, so `require_role()` and any not-yet-migrated route keep working. Do not drop it without migrating every `require_role` call site first
- **Provider keys table (08) stores ALL credentials encrypted at rest: LLM provider keys (credential_type='llm') AND business integration keys (credential_type='integration')** — migrated in 11_integration_credentials.sql
- LiteLLM model names follow tier1/tier2/tier3/copilot/ patterns
- **LiteLLM uses Prisma internally → `DATABASE_URL` MUST be `postgresql://` (plain, no `+psycopg` suffix)**
- All LLM calls go through the gateway `/v1/chat/completions` endpoint (Python litellm SDK, no proxy)
- Redis is vanilla alpine (redis-stack deferred)
- Langfuse container is defined but **opt-in behind `--profile obs`** and dormant (no OTLP export wired by default; the `langfuse` Python package is not installed). Distributed tracing is tracked as BO-5.
- Compose profiles: `core` (postgres+redis), `memory` (neo4j, for Graphiti), `obs` (langfuse + postgres/redis), `sandbox`

## Verification
- docker compose up must start all services
- LiteLLM must route to configured providers
- Postgres must have all schema files applied
