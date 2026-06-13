# Application Services

## Purpose
FastAPI application services: gateway, orchestrator, ingestion, reconciler.

## Services
- gateway/ -- FastAPI entry point, AG-UI chat, agent routes, OAuth, integration credential management (DB-backed, encrypted at rest)
- orchestrator/ -- Agent execution engine, mutation layer, MAF integration
- ingestion/ -- ClickUp/Zoho webhook receivers, MCP servers
- reconciler/ -- Nightly source-of-truth diff and escalation

## Conventions
- Each service has its own pyproject.toml
- Services communicate via Redis Streams (event bus)
- Gateway is the only internet-facing service

## Child DOX Index
- apps/gateway/AGENTS.md
- apps/orchestrator/AGENTS.md
