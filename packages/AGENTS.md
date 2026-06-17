# Shared Packages

## Purpose
Reusable Python packages shared across all CommandCenter services.

## Packages
- acb_skills/ -- Agent loading, skill management, tool injection (agent_tools, web_tools, memory_tools, write_artifact, todo_tools, ask_tools, error_tools, note_tools, history_tools, github_tools, integrations, loader, registry)
- acb_llm/ -- LiteLLM integration, unified credential store (LLM + integration keys), model routing
- acb_memory/ -- Mem0 and Graphiti memory providers
- acb_graph/ -- Postgres entity graph (SQLAlchemy sessions)
- acb_common/ -- Shared settings, logging, utilities
- acb_schemas/ -- Pydantic data models
- acb_audit/ -- Audit event recording
- acb_auth/ -- Authentication and role-based access

## Conventions
- Each package has its own pyproject.toml
- Public API exported via __init__.py
- Settings via acb_common.get_settings()
- Logging via acb_common.get_logger()

## Child DOX Index
- packages/acb_skills/AGENTS.md
