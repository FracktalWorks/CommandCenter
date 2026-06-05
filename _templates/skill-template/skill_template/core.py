"""{{ skill_name }} — core business logic.

This module contains the actual implementation.  Keep it free of MAF / agent
framework imports so it is testable offline with no LLM calls.

Entry contract
--------------
Every skill MUST export at least one ``async def`` function that:
  - accepts only JSON-serialisable keyword arguments
  - returns a ``str`` (plain text the agent embeds directly in context)
    OR a JSON-serialisable ``dict``

Functions exported from ``__init__.py`` are auto-discovered by the
Dynamic Agent Loader and registered as MAF ``FunctionTool`` objects on the
consuming agent.  Document them carefully — the docstring becomes the tool
description shown to the LLM.
"""
from __future__ import annotations

from typing import Any


async def run(payload: dict[str, Any]) -> str:
    """Execute the skill's primary action.

    Args:
        payload: Arbitrary input dictionary passed in by the agent.

    Returns:
        A plain-text summary of the result suitable for the agent's context window.
    """
    # TODO: implement skill logic here
    return f"(skill_template) received payload with keys: {sorted(payload.keys())}"
