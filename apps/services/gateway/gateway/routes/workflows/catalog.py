"""The node palette catalog — served, never hard-coded (spec F3, D7).

Agents come from the live agent registry (the same one ``/agent/run``
resolves against), integrations from ``acb_skills``'s registry with a live
availability probe, tools from the workflow tool registry, modules from the
org module library. The palette can only offer what the platform has.
"""

from __future__ import annotations

from typing import Any

from acb_auth import UserContext, get_current_user
from fastapi import Depends
from gateway.routes.workflows.core import _get_db, _log, iso, router
from gateway.routes.workflows.tools import list_tools
from sqlalchemy import text

#: Static metadata for the non-capability node types (Logic / Output).
NODE_TYPE_META = [
    {
        "type": "trigger",
        "category": "trigger",
        "label": "Trigger",
        "description": "Where the workflow starts: manual, webhook, schedule, or event.",
    },
    {
        "type": "agent",
        "category": "agent",
        "label": "Agent",
        "description": "Run a registered CommandCenter agent with a message.",
    },
    {
        "type": "tool",
        "category": "tool",
        "label": "Integration action",
        "description": "Invoke a typed integration action or HTTP request.",
    },
    {
        "type": "module",
        "category": "module",
        "label": "Module",
        "description": "Run a Module Studio code module (pure transform).",
    },
    {
        "type": "condition",
        "category": "logic",
        "label": "Condition",
        "description": "Branch on a comparison — true/false handles.",
    },
    {
        "type": "set",
        "category": "logic",
        "label": "Set variables",
        "description": "Assign values into the run's variables.",
    },
    {
        "type": "output",
        "category": "output",
        "label": "Output",
        "description": "Yield the run's result.",
    },
]

CONDITION_OPS = [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "gt",
    "gte",
    "lt",
    "lte",
    "is_empty",
    "not_empty",
    "truthy",
]


def known_agent_names() -> set[str]:
    """Every runnable agent name (static registry + dynamic), best-effort.

    Import is deferred and failure-tolerant: catalog and publish validation
    degrade to skipping the agent-existence check rather than breaking.
    """
    names: set[str] = set()
    try:
        from gateway.routes.agent import _AGENT_REGISTRY

        names.update(str(a.get("name")) for a in _AGENT_REGISTRY if a.get("name"))
    except Exception:
        pass
    try:
        from gateway.routes.agent import _load_dynamic_agents

        names.update(str(a.get("name")) for a in _load_dynamic_agents() if a.get("name"))
    except Exception:
        pass
    return names


def _agent_entries() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    try:
        from gateway.routes.agent import _AGENT_REGISTRY

        for agent in _AGENT_REGISTRY:
            entries.append(
                {
                    "name": agent.get("name"),
                    "description": agent.get("description", ""),
                    "tags": agent.get("tags", []),
                    "integrations": agent.get("integrations", []),
                }
            )
    except Exception as exc:
        _log.warning("workflows.catalog_agents_failed", error=str(exc)[:120])
    try:
        from gateway.routes.agent import _load_dynamic_agents

        seen = {e["name"] for e in entries}
        for agent in _load_dynamic_agents():
            if agent.get("name") and agent["name"] not in seen:
                entries.append(
                    {
                        "name": agent.get("name"),
                        "description": agent.get("description", ""),
                        "tags": agent.get("tags", []),
                        "integrations": agent.get("integrations", []),
                    }
                )
    except Exception:
        pass
    return entries


def _integration_entries() -> list[dict[str, Any]]:
    """All registered integrations + whether credentials resolve right now."""
    try:
        from acb_common import get_settings
        from acb_skills.integrations import build_integrations, list_registered

        services = list_registered()
        resolved, unavailable = build_integrations([], services, get_settings())
    except Exception as exc:
        _log.warning("workflows.catalog_integrations_failed", error=str(exc)[:120])
        return []
    tools_by_integration: dict[str, list[dict[str, Any]]] = {}
    for spec in list_tools():
        if spec.integration:
            tools_by_integration.setdefault(spec.integration, []).append(_tool_entry(spec))
    return [
        {
            "service": service,
            "available": service in resolved,
            "unavailable_reason": unavailable.get(service),
            "actions": tools_by_integration.get(service, []),
        }
        for service in sorted(services)
    ]


def _tool_entry(spec: Any) -> dict[str, Any]:
    return {
        "action": spec.action,
        "label": spec.label,
        "description": spec.description,
        "integration": spec.integration,
        "args_schema": spec.args_schema,
        "read_only": spec.read_only,
        "destructive": spec.destructive,
        "open_world": spec.open_world,
    }


@router.get("/catalog")
async def get_catalog(
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    db = await _get_db()
    try:
        modules = (
            await db.execute(
                text(
                    "SELECT id, name, description, input_schema, output_schema, "
                    "status, updated_at FROM workflow_modules "
                    "WHERE status != 'disabled' ORDER BY name"
                ),
            )
        ).fetchall()
    finally:
        await db.close()
    from gateway.routes.workflows.core import parse_jsonb

    return {
        "node_types": NODE_TYPE_META,
        "condition_ops": CONDITION_OPS,
        "agents": _agent_entries(),
        "integrations": _integration_entries(),
        "tools": [_tool_entry(s) for s in list_tools()],
        "modules": [
            {
                "id": str(m.id),
                "name": m.name,
                "description": m.description or "",
                "input_schema": parse_jsonb(m.input_schema, {}),
                "output_schema": parse_jsonb(m.output_schema, {}),
                "status": m.status,
                "updated_at": iso(m.updated_at),
            }
            for m in modules
        ],
    }
