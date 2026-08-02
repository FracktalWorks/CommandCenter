# Shared Packages

## Purpose
Reusable Python packages shared across all CommandCenter services.

## Packages
- acb_skills/ -- Agent loading, skill management, tool injection. Org access control: `integrations.build_integrations(..., is_authorized=)` filters services the ACTING MEMBER may not use (agents declare a want, not an entitlement), and `memory_tools` gates org-scoped memory writes on `memory:write_org` via a run-scoped predicate ContextVar. Both default to unfiltered when no member is attached, so background runs are unchanged (agent_tools, web_tools, memory_tools, write_artifact, todo_tools, ask_tools, error_tools, note_tools, history_tools, github_tools, integrations, loader, registry)
- acb_llm/ -- LiteLLM integration, unified credential store (LLM + integration keys), model routing
- acb_memory/ -- Mem0 and Graphiti memory providers. `compartments.py` owns the scope vocabulary (`scope_key`/`scope_kind`: a bare email, `prefs:<email>`, `room:<thread_id>`, `agent:<name>`, `org:global`) and `resolve_clearance` — WHICH compartments a run may read and the ONE it may write (spec: docs/multiplayer/memory-clearance.md §3). Solo resolves to exactly the three scopes and the write target it always had; a shared run swaps the actor's private compartment for the room's and keeps their prefs. The point is that an excluded compartment's scope key is never passed to `search()` — a boundary, not a request in a system prompt. Dependency-free on purpose: the CALLER decides `shared` (the gateway has `resolve_room_access`), which keeps acb_memory below acb_auth and the gateway in the import graph. `session_cache` keys on the clearance fingerprint as well as the thread — without it a thread cached while solo keeps serving the owner's private block after it is shared.
- acb_graph/ -- Postgres entity graph (SQLAlchemy sessions)
- acb_common/ -- Shared settings, logging, activity/cost feed, utilities. `_log.py` owns the run-correlation stamp: `_RUN_CONTEXT_KEYS` = `(run_id, thread_id, agent, user, source, instance)` — decision D1's attribution four-tuple plus the thread. Binds are **additive and non-empty-only**, so a caller may top up one field later (the executor resolves `instance` only after the agent config loads) and the shared partition `''` binds nothing rather than an empty value. `activity.py::_INHERIT` copies the same keys onto any event whose emitter omits them — which is why a model call inside a run is attributed with no change at its call site. Extend those two tuples together or attribution silently half-lands (`tests/unit/test_observability.py::test_inherit_and_run_context_keys_match` drift-fails if you don't). `instance` names the partition of the run that RESOLVED it — inheritance means a delegated sub-run carries its caller's key while writing blobs under the shared partition, so the stamp is not a join key onto `agent_blob` without knowing which run emitted it. The presence key (`cc:activity:live:{run_id}`) is written once from the `phase="start"` body, so a field resolved after start reaches `/observability/active` only via `activity.refresh_run_presence`. Spec: ai-company-brain/specs/observability_e2.md §7
- acb_audit/ -- Audit event recording
- acb_auth/ -- Authentication, roles, and org access control. Two guard styles coexist: the original coarse `require_role(UserRole.EXECUTIVE)` (unchanged) and `require_permission("feature:whatsapp")`, backed by DB roles + per-user allow/deny overrides (`permissions.py` is pure and testable; `access.py` does the I/O with a 60s cache). `require_authenticated(public=...)` is the app-wide default-deny guard (BO-2 #1) — authentication, not authorization. Two DISTINCT secrets: `GATEWAY_INTERNAL_TOKEN` is service identity (grants everything, never handed to agents) and `LITELLM_MASTER_KEY` is the /v1 API key agents hold, checked only by `require_llm_api_auth`. Spec: ai-company-brain/specs/org_access_control.md

## Conventions
- Each package has its own pyproject.toml
- Public API exported via __init__.py
- Settings via acb_common.get_settings()
- Logging via acb_common.get_logger()

## Child DOX Index
- packages/acb_skills/AGENTS.md
