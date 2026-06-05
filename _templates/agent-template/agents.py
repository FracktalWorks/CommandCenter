"""{{ agent_name }} — MAF agent definition.

Every agent repo MUST export a zero-argument `build_agents()` function that
returns a `list[Agent]` (MAF agents).  The Core executor's Dynamic Agent Loader
calls this function to obtain agents at event time.

Quickstart
----------
1. Update `INSTRUCTIONS` below (or keep the default that reads from
   `instructions.md` at import time).
2. Add your tool functions in the Tools section.
3. Add any `skill_repos` your agent depends on to `config.json`.
4. Keep `build_agents()` free of side-effects — it may be called multiple
   times during a single execution in retry scenarios.

Required environment variables
-------------------------------
LITELLM_BASE_URL  — e.g. http://litellm:4000
LITELLM_API_KEY   — LiteLLM master key (from secrets vault)

Optional
--------
REDIS_URL         — only needed if you set `with_history=True`
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from agent_framework_github_copilot import GitHubCopilotAgent


# ---------------------------------------------------------------------------
# System instructions
# ---------------------------------------------------------------------------

_INSTRUCTIONS_FILE = Path(__file__).parent / "instructions.md"

# Load from instructions.md at import time; fall back to inline default.
if _INSTRUCTIONS_FILE.exists():
    INSTRUCTIONS = _INSTRUCTIONS_FILE.read_text(encoding="utf-8")
else:
    INSTRUCTIONS = "You are {{ agent_name }}, a helpful AI assistant."


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

async def sample_tool(query: str) -> str:
    """Sample tool — replace with real business logic.

    Args:
        query: A natural-language question or directive from the user.

    Returns:
        A plain-text result to include in the agent's context.
    """
    # TODO: implement real tool logic here
    return f"(sample_tool called with: {query!r})"


# ---------------------------------------------------------------------------
# Agent factory
# ---------------------------------------------------------------------------

def _litellm_provider() -> dict[str, Any]:
    """Return the LiteLLM BYOK provider config for GitHubCopilotAgent."""
    base_url = os.environ.get("LITELLM_BASE_URL", "http://litellm:4000")
    api_key = os.environ.get("LITELLM_API_KEY", "")
    return {
        "type": "openai",
        "base_url": f"{base_url}/v1",
        "api_key": api_key,
    }


def build_agent() -> GitHubCopilotAgent:
    """Build and return the MAF GitHubCopilotAgent for this repo.

    Called by `build_agents()`.  Construct one agent per logical role; if
    this repo needs multiple specialist agents, create them here and return all
    of them from `build_agents()`.
    """
    return GitHubCopilotAgent(
        instructions=INSTRUCTIONS,
        tools=[sample_tool],
        default_options={
            # Route ALL inference through LiteLLM so every call is metered in
            # Langfuse and goes through the project's tier-2 model alias.
            "model": "tier2-sonnet",
            "provider": _litellm_provider(),
            # MCP servers — add Integration Registry credentials here.
            # See config.json `mcp_servers` for the credential mapping.
            # Example:
            #   "mcp_servers": {
            #       "clickup": {
            #           "command": "uvx",
            #           "args": ["mcp-clickup"],
            #           "env": {"CLICKUP_API_KEY": os.environ["CLICKUP_API_KEY"]},
            #       },
            #   },
            "mcp_servers": {},
        },
    )


def build_agents() -> list[GitHubCopilotAgent]:
    """Dynamic Agent Loader entry point.

    Returns a list of MAF agents exported by this repo.  The Core executor
    calls this function with no arguments at event dispatch time.
    """
    return [build_agent()]


__all__ = ["build_agents", "build_agent", "INSTRUCTIONS", "sample_tool"]
