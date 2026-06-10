"""agent-task-manager — MAF agent for ClickUp task management.

Answers questions about task status, project progress, and team workload.
Uses skill-clickup-sync for ClickUp data retrieval.

Exports:
    build_agents() -> list[GitHubCopilotAgent]   (Dynamic Agent Loader entry point)
    build_agent()  -> GitHubCopilotAgent
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from agent_framework_github_copilot import GitHubCopilotAgent
from copilot.types import PermissionHandler

_INSTRUCTIONS_FILE = Path(__file__).parent / "instructions.md"
INSTRUCTIONS = _INSTRUCTIONS_FILE.read_text(encoding="utf-8") if _INSTRUCTIONS_FILE.exists() else (
    "You are the task-manager agent. Answer questions about tasks and projects "
    "using the provided tools. Always cite the task URL when available."
)


# ---------------------------------------------------------------------------
# Tools (imported from skill-clickup-sync installed as a package)
# ---------------------------------------------------------------------------

try:
    from skill_clickup_sync import get_task_status, list_project_tasks
    _TOOLS = [get_task_status, list_project_tasks]
except ImportError:
    # skill-clickup-sync not installed yet — agent still boots, tools are unavailable.
    _TOOLS = []


# ---------------------------------------------------------------------------
# Agent factory
# ---------------------------------------------------------------------------

def _llm_provider() -> dict[str, Any]:
    """Return BYOK provider config pointing at the gateway's /v1 endpoint.

    The gateway uses the litellm Python SDK directly — no separate proxy.
    """
    base_url = os.environ.get("LITELLM_BASE_URL", "http://127.0.0.1:8080")
    api_key = os.environ.get("LITELLM_MASTER_KEY", "sk-local")
    return {"type": "openai", "base_url": f"{base_url}/v1", "api_key": api_key}


def build_agent() -> GitHubCopilotAgent:
    return GitHubCopilotAgent(
        instructions=INSTRUCTIONS,
        tools=_TOOLS,
        default_options={
            "model": "tier2-sonnet",
            "provider": _llm_provider(),
            "mcp_servers": {},
            "on_permission_request": PermissionHandler.approve_all,
        },
    )


def build_agents() -> list[GitHubCopilotAgent]:
    """Dynamic Agent Loader entry point."""
    return [build_agent()]


__all__ = ["build_agents", "build_agent", "INSTRUCTIONS"]