"""Session-history query tool — agents can recall past conversations.

Provides ``query_history`` which mirrors VS Code Copilot's ``session_store_sql``
tool.  The agent can query the chat session database to recall what was
discussed in prior sessions with the same user.

Design
------
- Accepts a SQL ``SELECT`` query against the ``chat_session`` and
  ``chat_message`` tables.
- Returns a JSON array of matching rows, truncated for safety.
- Only SELECT queries are allowed; any write attempt is rejected.
- The tool requires Postgres access via ``acb_graph``.

Usage by agents::

    await query_history(
        "SELECT role, content FROM chat_message "
        "WHERE thread_id = 'abc123' ORDER BY created_at DESC LIMIT 5"
    )
"""
from __future__ import annotations

import json as _json


async def query_history(query: str) -> str:
    """Query past conversation history from the chat database.

    Call this when you need context from earlier conversations — what was
    discussed last week, what decisions were made, what tasks were pending.

    **Available tables:**
    - ``chat_session`` — columns: ``id``, ``thread_id``, ``agent_name``,
      ``user_id``, ``title``, ``created_at``, ``updated_at``
    - ``chat_message`` — columns: ``id``, ``thread_id``, ``role``,
      ``content``, ``created_at``, ``tool_events``

    **Use this tool when:**
    - The user references a past conversation or decision
    - You need to recall what was discussed or decided previously
    - You are resuming work on a known thread

    **Safety:** Only ``SELECT`` queries are allowed.  Results are capped at
    20 rows and content is truncated to 500 chars per row.

    Args:
        query: A SQL ``SELECT`` statement.  Must start with ``SELECT``
               (case-insensitive).  ``INSERT``, ``UPDATE``, ``DELETE``,
               ``DROP``, and other mutations are rejected.

    Returns:
        JSON array of matching rows, or an error message.

    Example::

        await query_history(
            "SELECT role, content, created_at FROM chat_message "
            "WHERE thread_id = (SELECT id FROM chat_session "
            "WHERE user_id = 'vijay@fracktal.in' "
            "ORDER BY updated_at DESC LIMIT 1) "
            "ORDER BY created_at ASC LIMIT 10"
        )
    """
    q = query.strip()
    if not q.upper().startswith("SELECT"):
        return (
            "Error: only SELECT queries are allowed. "
            "Got: " + q[:50] + ("..." if len(q) > 50 else "")
        )

    # Reject dangerous keywords even in SELECT.
    dangerous = {"INSERT", "UPDATE", "DELETE", "DROP", "ALTER",
                 "CREATE", "TRUNCATE", "EXEC", "EXECUTE"}
    q_upper = q.upper()
    for kw in dangerous:
        if kw in q_upper:
            return f"Error: keyword {kw} is not allowed in query_history"

    # Also reject multi-statement queries (semicolons outside strings).
    # Simple heuristic: split on ; and check each part.
    parts = q.split(";")
    non_empty = [p.strip() for p in parts if p.strip()]
    if len(non_empty) > 1:
        return "Error: only one SQL statement is allowed"

    try:
        from acb_graph import get_session  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415
        with get_session() as s:
            result = s.execute(text(q))
            rows = result.fetchmany(20)
            columns = list(result.keys())
    except Exception as exc:  # noqa: BLE001
        return f"query_history failed: {exc}"

    if not rows:
        return "[]"

    # Format as JSON with content truncation.
    output: list[dict] = []
    for row in rows:
        entry: dict = {}
        for i, col in enumerate(columns):
            val = row[i]
            if isinstance(val, str) and len(val) > 500:
                val = val[:500] + "..."
            # Convert non-serializable types.
            try:
                _json.dumps(val)
            except (TypeError, ValueError):
                val = str(val)
            entry[col] = val
        output.append(entry)

    return _json.dumps(output, indent=2, default=str)
