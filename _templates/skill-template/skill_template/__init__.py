"""{{ skill_name }} — skill entry point.

Exports every callable that should be registered as a MAF FunctionTool by the
consuming agent.  The Dynamic Agent Loader imports this package and calls each
exported async function, so:

  - Only export functions you want the LLM to call directly.
  - Keep function signatures typed; docstrings are critical — they become tool
    descriptions shown to the LLM, so be precise.
  - Any helper / internal functions should live in ``core.py`` and NOT be
    exported here.
"""
from __future__ import annotations

from skill_template.core import run

__all__ = ["run"]
