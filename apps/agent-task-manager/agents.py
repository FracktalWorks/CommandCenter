"""agent-task-manager — the GTD Task Manager agent.

The agent behind the /tasks app (spec: ai-company-brain/specs/
task_manager_app.md §3.1): captures thoughts, clarifies the inbox through
the GTD decision tree, organizes items toward LOCAL or a connected PM
workspace (ClickUp first), and answers status/progress/workload questions.

Tool surface:
  skill-task-gtd     — the GTD engine over the gateway /tasks API
  skill-clickup-sync — legacy direct ClickUp status Q&A (transition-era)

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
# Tools
#   skill-task-gtd     — capture/clarify/organize over the gateway /tasks API
#                        (provider-agnostic; the interface layer resolves the
#                        connector)
#   skill-clickup-sync — legacy direct ClickUp status Q&A, kept during the
#                        transition (spec §3.1)
# ---------------------------------------------------------------------------

_TOOLS: list = []

try:
    from skill_task_gtd import (
        gtd_accounts,
        gtd_capture,
        gtd_capture_many,
        gtd_clarify,
        gtd_inbox_insights,
        gtd_list,
        gtd_list_projects,
        gtd_organize,
        gtd_people,
        gtd_update,
    )
    _TOOLS += [
        gtd_capture, gtd_capture_many, gtd_list, gtd_list_projects,
        gtd_accounts, gtd_people, gtd_inbox_insights, gtd_clarify,
        gtd_organize, gtd_update,
    ]
except ImportError:
    # skill-task-gtd not installed yet — agent still boots.
    pass

try:
    from skill_clickup_sync import get_task_status, list_project_tasks
    _TOOLS += [get_task_status, list_project_tasks]
except ImportError:
    # skill-clickup-sync not installed yet — agent still boots.
    pass


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
            "model": "tier-balanced",
            "provider": _llm_provider(),
            "mcp_servers": {},
            "on_permission_request": PermissionHandler.approve_all,
        },
    )


def build_agents() -> list[GitHubCopilotAgent]:
    """Dynamic Agent Loader entry point."""
    return [build_agent()]


__all__ = ["INSTRUCTIONS", "build_agent", "build_agents"]
