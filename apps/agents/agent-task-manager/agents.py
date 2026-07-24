"""agent-task-manager — the GTD Task Manager agent.

The agent behind the /tasks app (spec: ai-company-brain/specs/
task_manager_app.md §3.1): captures thoughts, clarifies the inbox through
the GTD decision tree, organizes items toward LOCAL or a connected PM
workspace (ClickUp first), and answers status/progress/workload questions.

Tool surface:
  skill-task-gtd     — the GTD engine over the gateway /tasks API. Every ClickUp
                       read/stage goes through the gateway's provider interface
                       layer, which resolves the RIGHT per-workspace connector
                       from the user's ``task_accounts`` rows (multi-workspace,
                       per-account encrypted token).

The legacy ``skill-clickup-sync`` tools (``get_task_status`` /
``list_project_tasks``) were RETIRED from this agent (2026-07-05): they read a
single process-global ``CLICKUP_API_TOKEN`` (System A), which can only ever see
one workspace and contradicts the multi-workspace architecture. Status/progress
questions are now answered through the per-account GTD store — ``gtd_list``
(SYNCED provider tasks, with URLs) and ``gtd_list_projects`` — so one clean,
multi-workspace-correct credential path serves the whole agent.

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
#   skill-task-gtd — capture/clarify/organize/list/sync over the gateway
#                    /tasks API (provider-agnostic; the interface layer
#                    resolves the per-workspace connector). This is the ONLY
#                    ClickUp path the agent uses — the legacy direct-REST
#                    skill-clickup-sync tools were retired (see module docstring).
# ---------------------------------------------------------------------------

_TOOLS: list = []

try:
    from skill_task_gtd import (
        gtd_accounts,
        gtd_add_subtasks,
        gtd_archive,
        gtd_capture,
        gtd_capture_many,
        gtd_clarify,
        gtd_complete,
        gtd_day_digest,
        gtd_delegate,
        gtd_detail,
        gtd_estimate_stats,
        gtd_inbox_insights,
        gtd_list,
        gtd_list_projects,
        gtd_list_schedule,
        gtd_move,
        gtd_organize,
        gtd_people,
        gtd_plan_day,
        gtd_plan_project,
        gtd_replan_day,
        gtd_rollover,
        gtd_schedule,
        gtd_set_one_thing,
        gtd_set_stage,
        gtd_subtasks,
        gtd_sync,
        gtd_unschedule,
        gtd_update,
    )
    _TOOLS += [
        gtd_capture, gtd_capture_many, gtd_list, gtd_list_projects,
        gtd_accounts, gtd_people, gtd_inbox_insights, gtd_clarify,
        gtd_organize, gtd_update, gtd_sync, gtd_plan_project,
        gtd_schedule, gtd_unschedule, gtd_list_schedule,
        # Manage existing tasks — the app's full action surface over chat
        # (complete/reopen, buckets, stage, delegate, subtasks, archive, detail)
        gtd_complete, gtd_move, gtd_detail, gtd_set_stage, gtd_delegate,
        gtd_subtasks, gtd_add_subtasks, gtd_archive,
        # AI day-management (planner over chat) — calendar_ai_review.md §4.2/4.4
        gtd_plan_day, gtd_replan_day, gtd_rollover, gtd_day_digest,
        gtd_estimate_stats, gtd_set_one_thing,
    ]
except ImportError:
    # skill-task-gtd not installed yet — agent still boots.
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
