# Shared Packages

## Purpose
Reusable Python packages shared across all CommandCenter services.

## Packages
- acb_skills/ -- Agent loading, skill management, tool injection. Org access control: `integrations.build_integrations(..., is_authorized=)` filters services the ACTING MEMBER may not use (agents declare a want, not an entitlement), and `memory_tools` gates org-scoped memory writes on `memory:write_org` via a run-scoped predicate ContextVar. Both default to unfiltered when no member is attached, so background runs are unchanged (agent_tools, web_tools, memory_tools, write_artifact, todo_tools, ask_tools, error_tools, note_tools, history_tools, github_tools, integrations, loader, registry)
- acb_llm/ -- LiteLLM integration, unified credential store (LLM + integration keys), model routing
- acb_memory/ -- Mem0 and Graphiti memory providers
- acb_graph/ -- Postgres entity graph (SQLAlchemy sessions)
- acb_common/ -- Shared settings, logging, activity/cost feed, utilities
- acb_audit/ -- Audit event recording
- acb_auth/ -- Authentication, roles, and org access control. Two guard styles coexist: the original coarse `require_role(UserRole.EXECUTIVE)` (unchanged) and `require_permission("feature:whatsapp")`, backed by DB roles + per-user allow/deny overrides (`permissions.py` is pure and testable; `access.py` does the I/O with a 60s cache). `require_authenticated(public=...)` is the app-wide default-deny guard (BO-2 #1) — authentication, not authorization. Two DISTINCT secrets: `GATEWAY_INTERNAL_TOKEN` is service identity (grants everything, never handed to agents) and `LITELLM_MASTER_KEY` is the /v1 API key agents hold, checked only by `require_llm_api_auth`. Spec: ai-company-brain/specs/org_access_control.md

## Conventions
- Each package has its own pyproject.toml
- Public API exported via __init__.py
- Settings via acb_common.get_settings()
- Logging via acb_common.get_logger()

## Child DOX Index
- packages/acb_skills/AGENTS.md
