"""Skills catalog — WS-23 S1 (specs/skills_registry.md §4, read-only).

GET /integrations/skills
    The skill-family catalog (``acb_skills.skill_families.SKILL_FAMILIES``)
    with per-family MEASURED token cost — each family's marginal system-prompt
    addendum (rendered by the real ``_build_injected_tools_addendum``) plus
    its tools' JSON schemas, counted with the same tokenizer
    ``assemble_run_context`` uses — and a per-agent matrix of which families
    each registered agent's declared ``config.json: tool_scope`` intersects.

Read-only by design: S1 changes NOTHING about what is injected into a run.
Toggles (settings table + PUT) are S2. Gated exactly like the sibling
``/integrations`` endpoints: router-level ``require_feature_router
("integrations")`` + the app-wide default-deny auth, ``get_current_user`` on
the endpoint.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from acb_auth import UserContext, get_current_user, require_feature_router
from acb_common import get_logger
from fastapi import APIRouter, Depends

_log = get_logger("gateway.integrations_skills")

router = APIRouter(
    prefix="/integrations", tags=["integrations"],
    dependencies=[require_feature_router("integrations")],
)


# ── Seams (module-level so tests patch the SUT submodule, hermetically) ─────

def _platform_tools_by_name() -> dict[str, Any]:
    """name → callable for every statically injectable platform tool.

    The static set from ``_collect_injectable_platform_tools`` plus the
    workflow trio (injected per-agent but with fixed names/signatures).
    Dynamic ``app_<slug>_<action>`` tools are per-grant and excluded.
    """
    out: dict[str, Any] = {}
    try:
        from orchestrator._tool_injection import (  # noqa: PLC0415
            _collect_injectable_platform_tools,
        )
        for fn in _collect_injectable_platform_tools():
            out[getattr(fn, "__name__", "")] = fn
    except Exception:  # noqa: BLE001 — orchestrator not importable here
        _log.warning("skills.platform_tools_unavailable")
    try:
        from orchestrator.workflow_tools import (  # noqa: PLC0415
            get_workflow_run, list_workflows, run_workflow,
        )
        for fn in (list_workflows, run_workflow, get_workflow_run):
            out[fn.__name__] = fn
    except Exception:  # noqa: BLE001
        pass
    out.pop("", None)
    return out


def _addendum_for_scope(scope: frozenset[str] | None) -> str:
    """Render the real injected-tools addendum for an effective scope."""
    from orchestrator._tool_injection import (  # noqa: PLC0415
        _build_injected_tools_addendum,
    )
    return _build_injected_tools_addendum(effective_scope=scope)


def _count_tokens(text: str) -> int:
    """Same tokenizer as ``assemble_run_context`` (acb_llm.context)."""
    from acb_llm.context import count_message_tokens  # noqa: PLC0415
    return count_message_tokens([{"role": "system", "content": text}])


def _core_tool_names() -> frozenset[str]:
    from orchestrator._tool_injection import (  # noqa: PLC0415
        _CORE_STANDARD_TOOL_NAMES,
    )
    return frozenset(_CORE_STANDARD_TOOL_NAMES)


def _list_agents() -> list[dict[str, Any]]:
    """Every registered agent (static registry + dynamic table), best-effort."""
    try:
        from gateway.routes.agent import (  # noqa: PLC0415
            _AGENT_REGISTRY, _load_dynamic_agents,
        )
        dynamic = _load_dynamic_agents()
        dyn_names = {a.get("name") for a in dynamic}
        return [a for a in _AGENT_REGISTRY if a.get("name") not in dyn_names] + dynamic
    except Exception:  # noqa: BLE001
        _log.warning("skills.agent_registry_unavailable")
        return []


def _declared_tool_scope(
    agent_name: str, local_path: str | None = None,
) -> list[str] | None:
    """Read ``config.json: tool_scope`` the same way the executor's loader
    sees it — clone/workspace first, then the ``local_path`` source (the
    ``_declared_runtime`` convention in routes/agent.py). ``None`` = the agent
    declares no scope (injection is fail-open: it receives everything)."""
    candidates: list[Path] = []
    try:
        from gateway.routes.workspace import (  # noqa: PLC0415
            _agent_workspace_dir,
        )
        ws = _agent_workspace_dir(agent_name)
        if ws is not None:
            candidates.append(Path(ws) / "config.json")
    except Exception:  # noqa: BLE001
        pass
    if local_path:
        candidates.append(Path(local_path) / "config.json")
    for cfg_path in candidates:
        try:
            if cfg_path.is_file():
                data = json.loads(
                    cfg_path.read_text(encoding="utf-8", errors="replace")
                )
                scope = data.get("tool_scope")
                if isinstance(scope, list) and scope:
                    return [str(s) for s in scope]
                return None  # config found, no scope declared
        except Exception:  # noqa: BLE001
            continue
    return None


# ── Endpoint ────────────────────────────────────────────────────────────────

@router.get("/skills")
async def skills_catalog(
    user: UserContext = Depends(get_current_user),
) -> dict[str, Any]:
    """The read-only skills catalog + per-agent family matrix (S1)."""
    from acb_skills import skill_families  # noqa: PLC0415
    from orchestrator._tool_injection import (  # noqa: PLC0415
        _resolve_injected_scope,
    )

    catalog = skill_families.build_catalog(
        tools_by_name=_platform_tools_by_name(),
        addendum_for_scope=_addendum_for_scope,
        count_tokens=_count_tokens,
        core_tool_names=_core_tool_names(),
    )

    agents_out: list[dict[str, Any]] = []
    for a in _list_agents():
        name = (a.get("name") or "").strip()
        if not name:
            continue
        scope = _declared_tool_scope(name, a.get("local_path"))
        resolved = _resolve_injected_scope(scope)
        fams = skill_families.families_for_scope(
            scope,
            resolved_scope=frozenset(resolved) if resolved is not None else None,
        )
        agents_out.append({
            "name": name,
            "description": a.get("description", ""),
            "tool_scope_declared": scope is not None,
            "families": fams,
            # No tool_scope ⇒ injection is fail-open today (spec rule 3):
            # the agent receives every family.
            "all_families": scope is None,
        })

    return {**catalog, "agents": agents_out}
