# Apps

## Purpose
Three distinct kinds of unit, grouped by lifecycle into subfolders. The split
is load-bearing: **services** are deployed processes; **agents** and **skills**
are *loaded by* a service at runtime and are never deployed on their own.

## `services/` — deployed FastAPI processes
- gateway/ -- FastAPI entry point, AG-UI chat, agent routes, OAuth, integration credential management (DB-backed, encrypted at rest), MCP server registry, plugin registry
- orchestrator/ -- Agent execution engine, mutation layer, MAF integration
- ingestion/ -- ClickUp/Zoho webhook receivers, MCP servers
- email_ingestion/ -- Multi-provider email sync engine (Gmail, Microsoft 365, IMAP/SMTP, aiosmtpd inbound, background scheduler)
- reconciler/ -- Nightly source-of-truth diff and escalation
- action_broker/ -- Approval-gated source-of-truth write executor: authority-tier disposition + fail-closed handler registry. **Decision core exists but ships with zero handlers and is not yet wired into the write path** — tracked as BO-1 (see `FOUNDATION_BUILDOUT_CHECKLIST.md`)

## `agents/` — agent definitions (dynamically loaded at runtime)
Identity + system prompt + tool set + integrations. Loaded via `build_agents()`
and a `local_path` entry in `agent_registry.json` / the gateway `_AGENT_REGISTRY`.
Run *inside* the orchestrator/gateway process — no server of their own.
- agent-orchestrator/ -- Wraps the built-in orchestrator Agent so it goes through the same `/agent/run/stream` path as all other agents. Eliminates the separate `/copilot/chat` code path in the frontend.
- agent-task-manager/ -- ClickUp task management
- agent-apis-config/ -- API discovery and configuration assistant
- agent-email-assistant/ -- Email AI assistant: read, search, summarize, draft replies across Gmail and Microsoft accounts

## `skills/` — importable tool packages
Capabilities (tools) an agent picks up. No identity, no server. Python packages
imported as tool providers. (Distinct from the repo-root `skills/` folder, which
holds SKILL.md + subprocess-script skills for the DOE-v2 registry agents.)
- skill-clickup-sync/ -- ClickUp read/write MCP skill
- skill-task-gtd/ -- GTD task tools (capture/clarify/organize/engage) over the gateway `/tasks` API

## Conventions
- Each service / agent / skill has its own pyproject.toml and is a uv workspace member (`apps/services/*`, `apps/agents/*`, `apps/skills/*` — see root `pyproject.toml`)
- Moving a dir between groups means updating its `local_path` (registry + gateway `_AGENT_REGISTRY`) — Python imports are by package name and are unaffected
- Services communicate via Redis Streams (event bus)
- Gateway is the only internet-facing service
- All agents go through the unified `/agent/run/stream` endpoint (including orchestrator)
- The `/copilot/chat` endpoint in main.py is retained for backward compatibility but the workbench frontend no longer routes to it

## Child DOX Index
- apps/services/gateway/AGENTS.md
- apps/services/orchestrator/AGENTS.md
- apps/services/email_ingestion/AGENTS.md
