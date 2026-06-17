"""Todo-list management tool — auto-injected into every loaded agent.

Provides ``manage_todo_list``, a structured todo-list tracker that mirrors
the VS Code Copilot Chat "Manage and track to-do items" tool.  The agent
calls this whenever it plans multi-step work, and the Control Plane renders
a live "Todos (n/m)" panel above the chat input that updates in real time.

Design (VS Code parity)
-----------------------
- The tool accepts the **complete** todo list on every call (not incremental
  patches).  This keeps the agent and UI in sync without reconciliation.
- Each item has an integer ``id``, a short ``title`` (3-7 words), an
  optional ``description``, and a ``status`` of ``"not-started"``,
  ``"in-progress"``, or ``"completed"``.
- The tool supports an optional ``operation`` field: ``"write"`` (default)
  updates the list; ``"read"`` returns the current list as markdown.
- The tool pushes a ``TODO_LIST`` AG-UI event into the active SSE queue so
  the frontend Todopanel updates immediately, even mid-stream.
- Warnings are returned to the LLM for small lists (<3 items), large lists
  (>10 items), and bulk status changes (>3 items modified at once).
- The same function is callable from both MAF agents (in-process) and
  GitHub Copilot SDK agents (via the Copilot CLI callback mechanism).

Usage by agents::

    await manage_todo_list(json.dumps({
        "todoList": [
            {"id": 1, "title": "Fetch pipeline data", "status": "in-progress"},
            {"id": 2, "title": "Analyse blockers", "status": "not-started"},
            {"id": 3, "title": "Draft summary report", "status": "not-started"},
        ]
    }))
"""
from __future__ import annotations

import json as _json


# Module-level store for the last-written todo list per session.
# VS Code's ChatTodoListService persists per session; we approximate this
# with a module-level dict keyed by thread id.  The 'read' operation
# returns the last known state.
_todo_store: dict[str, list[dict]] = {}


def _get_session_id() -> str:
    """Resolve the current agent session id from context vars or env."""
    try:
        from orchestrator.executor import _stream_relay_thread_id
        tid = _stream_relay_thread_id.get(None)
        if tid:
            return tid
    except Exception:  # noqa: BLE001
        pass
    import os
    return os.environ.get("RUN_ID", "default")


async def manage_todo_list(todoList: str) -> str:
    """Update the live task-tracking panel shown above the chat input.

    The panel mirrors the VS Code Copilot Chat "Todos (n/m)" widget and is
    visible to both you and the user.  Use this tool VERY frequently to
    ensure task visibility and proper planning.

    **When to use this tool:**
    - Complex multi-step work requiring planning and tracking
    - When the user provides multiple tasks or requests
      (numbered / comma-separated)
    - After receiving new instructions that require multiple steps
    - BEFORE starting work on any todo (mark it ``"in-progress"``)
    - IMMEDIATELY after completing each todo (mark it ``"completed"``
      individually — do NOT batch completions)
    - When breaking down larger tasks into smaller actionable steps
    - To give users visibility into your progress and planning

    **When NOT to use:**
    - Single, trivial tasks that can be completed in one step
    - Purely conversational / informational requests
    - When just reading files or performing simple searches

    **CRITICAL workflow:**
    1. Plan tasks by writing todo list with specific, actionable items
    2. Mark ONE todo as ``"in-progress"`` before starting work
    3. Complete the work for that specific todo
    4. Mark that todo as ``"completed"`` IMMEDIATELY after finishing
    5. Move to next todo and repeat

    Args:
        todoList: JSON string with the following shape:
            {
              "todoList": [
                {"id": 1, "title": "Do X", "status": "in-progress"},
                ...
              ],
              "operation": "write"
            }
            - ``todoList`` (array, required for write): The COMPLETE list.
              Must include ALL items — both existing and new.
              Each item has:
                - ``id`` (number): Unique identifier. Sequential from 1.
                - ``title`` (string): Concise label, 3-7 words.
                - ``status`` (string): ``"not-started"``,
                  ``"in-progress"``, or ``"completed"``.
            - ``operation`` (string, optional): ``"write"`` (default) or
              ``"read"``.  ``"read"`` returns the current list without
              modifying it.

    Returns:
        A confirmation message with count summary and any warnings, e.g.
        ``"Successfully wrote todo list (3 items)."``
    """
    # Parse the outer JSON object.
    try:
        raw = _json.loads(todoList)
    except (_json.JSONDecodeError, TypeError):
        return (
            "Error: todoList must be valid JSON, e.g. "
            '\'{"todoList":[{"id":1,"title":"Do X","status":"in-progress"}]}\''
        )

    # Accept both the wrapped object and bare array (backward compat).
    if isinstance(raw, list):
        operation = "write"
        todos_raw = raw
    elif isinstance(raw, dict):
        operation = str(raw.get("operation", "write")).strip().lower()
        todos_raw = raw.get("todoList", [])
    else:
        return "Error: input must be a JSON object or array"

    # Handle read operation.
    if operation == "read":
        sid = _get_session_id()
        current = _todo_store.get(sid, [])
        if not current:
            return "No todo list found."
        lines = ["# Todo List"]
        for t in current:
            s = t.get("status", "not-started")
            checkbox = {  # markdown task list
                "completed": "[x]",
                "in-progress": "[-]",
            }.get(s, "[ ]")
            lines.append(f"- {checkbox} {t.get('title', '')}")
        return "\n".join(lines)

    # Write: validate todoList.
    if not isinstance(todos_raw, list):
        return "Error: todoList must be a JSON array"

    valid_statuses = frozenset({"not-started", "in-progress", "completed"})
    cleaned: list[dict] = []
    warnings: list[str] = []

    for i, t in enumerate(todos_raw):
        if not isinstance(t, dict):
            return f"Error: item {i} is not an object"
        tid = t.get("id", i + 1)
        title = str(t.get("title", f"Task {tid}")).strip()
        if not title:
            return f"Error: item {i} has an empty title"
        status = str(t.get("status", "not-started")).strip()
        if status not in valid_statuses:
            return (
                f"Error: item {i} has invalid status {status!r}. "
                f"Must be one of: not-started, in-progress, completed"
            )
        cleaned.append({
            "id": str(tid),
            "title": title[:120],
            "status": status,
        })

    # VS Code parity: warnings for bad usage patterns.
    if len(cleaned) < 3:
        warnings.append(
            "Warning: Small todo list (<3 items). "
            "This task might not need a todo list."
        )
    elif len(cleaned) > 10:
        warnings.append(
            "Warning: Large todo list (>10 items). "
            "Consider keeping the list focused and actionable."
        )

    # Detect bulk status changes by comparing with stored list.
    sid = _get_session_id()
    old_list = _todo_store.get(sid, [])
    old_map: dict[str, str] = {t["id"]: t["status"] for t in old_list}
    changes = 0
    for t in cleaned:
        old_status = old_map.get(t["id"])
        if old_status is None or old_status != t["status"]:
            changes += 1
    # Also count removals.
    new_ids = {t["id"] for t in cleaned}
    old_ids = {t["id"] for t in old_list}
    changes += len(old_ids - new_ids)

    if changes > 3:
        warnings.append(
            "Warning: Did you mean to update so many todos at the "
            "same time? Consider working on them one by one."
        )

    # Persist to module-level store.
    _todo_store[sid] = cleaned

    # Push TODO_LIST event into the active SSE queue.
    try:
        from orchestrator.executor import _active_run_queue  # noqa: PLC0415
        queue = _active_run_queue.get(None)
        if queue is not None:
            await queue.put({
                "type": "TODO_LIST",
                "todos": cleaned,
            })
    except Exception:  # noqa: BLE001
        pass

    # Build summary.
    counts: dict[str, int] = {
        "not-started": 0, "in-progress": 0, "completed": 0,
    }
    for t in cleaned:
        s = t["status"]
        if s in counts:
            counts[s] += 1

    total = len(cleaned)
    done = counts["completed"]
    active = counts["in-progress"]
    pending = counts["not-started"]

    parts: list[str] = [f"Successfully wrote todo list ({total} items)"]
    if done:
        parts.append(f"{done} done")
    if active:
        parts.append(f"{active} in progress")
    if pending:
        parts.append(f"{pending} pending")

    result = ", ".join(parts) + "."
    if warnings:
        result += "\n\n" + "\n".join(warnings)
    return result
