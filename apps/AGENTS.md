# Application Services

## Purpose
FastAPI application services: gateway, orchestrator, ingestion, reconciler,
and dynamically loadable agent definitions.

## Services
- gateway/ -- FastAPI entry point, AG-UI chat, agent routes, OAuth, integration credential management (DB-backed, encrypted at rest), MCP server registry, plugin registry
- orchestrator/ -- Agent execution engine, mutation layer, MAF integration
- ingestion/ -- ClickUp/Zoho webhook receivers, MCP servers
- email_ingestion/ -- Multi-provider email sync engine (Gmail, Microsoft 365, IMAP/SMTP, aiosmtpd inbound, background scheduler)
- reconciler/ -- Nightly source-of-truth diff and escalation

## Agent Definitions (dynamically loaded at runtime)
- agent-orchestrator/ -- Wraps the built-in orchestrator Agent so it goes through the same `/agent/run/stream` path as all other agents. Eliminates the separate `/copilot/chat` code path in the frontend.
- agent-task-manager/ -- ClickUp task management
- agent-apis-config/ -- API discovery and configuration assistant
- agent-email-assistant/ -- Email AI assistant: read, search, summarize, draft replies across Gmail and Microsoft accounts
- skill-clickup-sync/ -- ClickUp read/write MCP skill

## Conventions
- Each service / agent has its own pyproject.toml
- Services communicate via Redis Streams (event bus)
- Gateway is the only internet-facing service
- All agents go through the unified `/agent/run/stream` endpoint (including orchestrator)
- The `/copilot/chat` endpoint in main.py is retained for backward compatibility but the workbench frontend no longer routes to it

## Child DOX Index
- apps/gateway/AGENTS.md
- apps/orchestrator/AGENTS.md
- apps/email_ingestion/AGENTS.md
