"""DEPRECATED — this file is kept only for backward compatibility.

All new tests live in ``test_agents.py``.
Run with:
    pytest tests/ -v
"""
# Re-export everything from test_agents so test collection still passes.
from test_agents import *  # noqa: F401, F403
