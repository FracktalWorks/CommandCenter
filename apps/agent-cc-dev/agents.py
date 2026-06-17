"""agent-cc-dev — CommandCenter developer agent.

Full-access agent for working on the CommandCenter repository itself.
Runs as a GitHub Copilot SDK agent with native file operations, shell
commands, and git tooling.  The working directory is the CC repo root
(/opt/acb/app on the VPS).

Exports:
    build_agents() -> list[GitHubCopilotAgent]
"""
from __future__ import annotations

from pathlib import Path

from agent_framework_github_copilot import GitHubCopilotAgent
from copilot.types import PermissionHandler

_INSTRUCTIONS_FILE = Path(__file__).parent / "instructions.md"
INSTRUCTIONS = (
    _INSTRUCTIONS_FILE.read_text(encoding="utf-8")
    if _INSTRUCTIONS_FILE.exists()
    else "You are the CommandCenter Developer agent."
)


def build_agents():
    """Return the CC Dev agent — a GitHubCopilotAgent with full repo access."""
    return [
        GitHubCopilotAgent(
            instructions=INSTRUCTIONS,
            default_options={
                "model": "tier-balanced",
                "on_permission_request": PermissionHandler.approve_all,
            },
        )
    ]
