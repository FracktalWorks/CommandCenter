"""Todo-list tracking (VS Code Copilot parity).

Extracted from ``executor.py`` (foundation maintainability refactor) — no
behaviour change. The Copilot CLI manages the agent's plan via its built-in
``sql`` tool against a ``todos`` table (``INSERT INTO todos ...`` /
``UPDATE todos SET status``). VS Code renders its Todos panel by tracking those
mutations; we do the same: parse the SQL in TOOL_CALL args and emit structured
TODO_LIST events the frontend can render.

Also hosts ``_unwrap_json_param`` — the double-wrap unwrapper the manage_todo_list
tool path uses — since it lives with the same feature.
"""
from __future__ import annotations

import json
import re
from typing import Any

_TODO_INSERT_RE = re.compile(
    r"INSERT\s+INTO\s+todos\b.*?VALUES\s*(.+)",
    re.I | re.S,
)
_TODO_ROW_RE = re.compile(
    r"\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*,"
    r"\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*\)",
    re.S,
)
_TODO_UPDATE_RE = re.compile(
    r"UPDATE\s+todos\s+SET\s+status\s*=\s*'([^']+)'"
    r"(?:.*?WHERE\s+id\s*(?:=\s*'([^']+)'|IN\s*\(([^)]+)\)))?",
    re.I | re.S,
)


class _TodoTracker:
    """Accumulates todo state from the CLI's sql-tool mutations."""

    def __init__(self) -> None:
        self.items: dict[str, dict[str, str]] = {}
        self.order: list[str] = []

    def feed(self, tool_name: str, args: Any) -> bool:
        """Parse a tool call; return True if todo state changed."""
        if tool_name != "sql":
            return False
        query = ""
        if isinstance(args, dict):
            query = str(args.get("query") or "")
        elif isinstance(args, str):
            try:
                query = str(json.loads(args).get("query") or "")
            except (json.JSONDecodeError, AttributeError):
                query = args
        if "todos" not in query.lower():
            return False
        changed = False
        m = _TODO_INSERT_RE.search(query)
        if m:
            for row in _TODO_ROW_RE.finditer(m.group(1)):
                tid, title, _desc, status = (
                    v.replace("''", "'") for v in row.groups()
                )
                if tid not in self.items:
                    self.order.append(tid)
                self.items[tid] = {"id": tid, "title": title,
                                   "status": status or "pending"}
                changed = True
        for m in _TODO_UPDATE_RE.finditer(query):
            status, single_id, in_list = m.groups()
            ids: list[str] = []
            if single_id:
                ids = [single_id]
            elif in_list:
                ids = [s.strip().strip("'") for s in in_list.split(",")]
            else:
                ids = list(self.order)  # UPDATE without WHERE = all
            for tid in ids:
                if tid in self.items:
                    self.items[tid]["status"] = status
                    changed = True
        return changed

    def snapshot(self) -> list[dict[str, str]]:
        return [self.items[tid] for tid in self.order if tid in self.items]


def _unwrap_json_param(raw: Any, param_name: str) -> Any:
    """Parse a tool parameter that may be a JSON string with double-wrapping.

    Our injected tools take ``str`` parameters that are themselves JSON
    (e.g. ``manage_todo_list(todoList: str)``).  The LLM naturally
    constructs ``{"todoList": [...]}`` and passes it as the string value
    of the ``todoList`` parameter, creating a double-wrap:

        _tc_args = {"todoList": '{"todoList": [...]}' }

    This helper detects the pattern, JSON-parses the outer string, and if
    the result is a dict containing only the param_name key, unwraps it.

    Returns the unwrapped value (list, dict, or parsed primitive), or the
    original raw value if no unwrapping was needed.
    """
    if not isinstance(raw, str) or not raw.strip():
        return raw
    try:
        parsed = json.loads(raw)
    except Exception:  # noqa: BLE001
        return raw
    # Double-wrap: LLM passed param_name=json_string where the JSON
    # itself is a dict with a param_name key containing the real data.
    if isinstance(parsed, dict) and param_name in parsed:
        inner = parsed[param_name]
        if isinstance(inner, (list, dict)):
            return inner
    return parsed
