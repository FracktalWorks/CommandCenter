"""commandcenter — Self-anneal agent for the CommandCenter platform.

A GitHub Copilot SDK agent that works on the CommandCenter repository itself.
Uses the Copilot SDK's native file operations, shell commands, and git tooling
to read, edit, test, and improve the CC codebase.

The executor injects platform tools (call_agent, web_search, write_artifact,
memory, todo, etc.) at runtime — this file only needs to define the agent's
identity and system prompt.

Exports:
    build_agents() -> list[GitHubCopilotAgent]
"""
from __future__ import annotations

from pathlib import Path

AGENT_DIR = Path(__file__).parent.resolve()
PROMPTS_DIR = AGENT_DIR / ".github" / "prompts"

_SYSTEM_MD = PROMPTS_DIR / "system.md"
if _SYSTEM_MD.exists():
    SYSTEM_PROMPT = _SYSTEM_MD.read_text(encoding="utf-8", errors="replace")
else:
    # Fallback — load the root AGENTS.md as a minimal system prompt.
    _AGENTS_MD = AGENT_DIR / "AGENTS.md"
    SYSTEM_PROMPT = (
        _AGENTS_MD.read_text(encoding="utf-8", errors="replace")
        if _AGENTS_MD.exists()
        else "You are the CommandCenter self-anneal agent."
    )


def build_agent():
    """Return a GitHubCopilotAgent configured for the CommandCenter repo."""
    from agent_framework_github_copilot import GitHubCopilotAgent  # type: ignore[import]  # noqa: PLC0415
    from copilot.types import PermissionHandler  # type: ignore[import]  # noqa: PLC0415

    return GitHubCopilotAgent(
        name="commandcenter",
        description=(
            "Self-anneal agent for the CommandCenter orchestration platform "
            "— edit code, run tests, debug issues, review agent repos, "
            "and improve the CC platform itself."
        ),
        instructions=SYSTEM_PROMPT,
        tools=[],
        default_options={
            "model": "tier-balanced",
            "on_permission_request": PermissionHandler.approve_all,
        },
    )


def build_agents() -> list:
    """Dynamic Agent Loader entry point. Synchronous, zero-argument, pure."""
    return [build_agent()]


__all__ = ["build_agents", "build_agent", "SYSTEM_PROMPT"]
