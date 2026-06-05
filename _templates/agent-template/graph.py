"""DEPRECATED — backward-compatibility shim.

This file is kept only for repos that have not yet migrated to ``agents.py``.
New agent repos should use ``agents.py`` exclusively.

The Core executor now calls ``build_agents()`` from ``agents.py`` (MAF).  If
your repo still exports ``build_graph()`` the executor will raise an
``AgentLoadError`` and ask you to migrate.
"""
from __future__ import annotations

import warnings

from agents import build_agent, build_agents  # noqa: F401  re-export

__all__ = ["build_agents", "build_agent"]


def build_graph() -> None:  # type: ignore[return]
    """Deprecated — use agents.py / build_agents() instead."""
    warnings.warn(
        "build_graph() is removed. Migrate to agents.py and export build_agents().",
        DeprecationWarning,
        stacklevel=2,
    )
    raise NotImplementedError(
        "LangGraph StateGraph is no longer supported. "
        "Export build_agents() -> list[Agent] from agents.py instead."
    )
