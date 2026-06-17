"""Repo-scoped memory tools — agents persist notes across sessions.

Provides ``save_note`` and ``recall_notes``, inspired by VS Code Copilot's
3-tier memory system (/memories/user, /memories/session, /memories/repo).
These tools let agents maintain a durable, file-based working memory within
the agent workspace that survives session resets and context compaction.

Design
------
- ``save_note(path, fact)`` — Append a dated bullet to a markdown notes file
  under ``agent-data/``.  Creates the file if it doesn't exist.
- ``recall_notes(path, query?)`` — Read back a notes file, optionally
  filtering lines that match a query string.
- Notes files are plain markdown, human-readable, and visible in the
  Control Plane Files sidebar.
- The canonical working-memory file is ``agent-data/NOTES.md`` — agents are
  instructed to read it at session start.

Usage by agents::

    await save_note("NOTES.md", "Closed ABC Corp deal at ₹50L")
    await save_note("leads.md", "New lead: XYZ Ltd, contact Priya")
    history = await recall_notes("NOTES.md")
    leads = await recall_notes("leads.md", "XYZ")
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path


def _get_agent_dir() -> str:
    """Resolve the agent's workspace root."""
    try:
        from acb_skills.write_artifact import \
            _WRITE_ARTIFACT_CONTEXT  # noqa: PLC0415
        root = _WRITE_ARTIFACT_CONTEXT.get("workspace_root", "")
        if root:
            return root
    except Exception:  # noqa: BLE001
        pass
    return os.getcwd()


async def save_note(path: str, fact: str) -> str:
    """Append a dated fact to a notes file in the agent workspace.

    The file is created under ``agent-data/`` if *path* does not already
    start with ``agent-data/``, ``inputs/``, or ``outputs/``.  Each fact
    is prefixed with an ISO-8601 date and written as a bullet point.

    Use this to persist important facts, decisions, and discoveries across
    sessions.  The ``NOTES.md`` file is your canonical working memory —
    read it at the start of every session.

    Args:
        path: Relative path to the notes file, e.g. ``"NOTES.md"`` or
              ``"leads.md"``.  Defaults to ``agent-data/`` if no visible
              workspace prefix is present.
        fact: The fact to record.  Keep it concise — one line per fact.

    Returns:
        ``"Saved to agent-data/NOTES.md"`` or similar confirmation.

    Example::

        await save_note("NOTES.md", "Vijay prefers summaries on Monday mornings")
        await save_note("deals.md", "ABC Corp: closed at ₹50L, Q2 2026")
    """
    root = Path(_get_agent_dir())

    # Normalise path — ensure it lands in a visible workspace dir.
    clean = path.replace("\\", "/").lstrip("/.")
    _visible = frozenset({"inputs", "outputs", "agent-data"})
    in_visible = any(
        clean == d or clean.startswith(d + "/") for d in _visible
    )
    if not in_visible:
        clean = f"agent-data/{clean}"

    target = root / clean
    target.parent.mkdir(parents=True, exist_ok=True)

    # Build the dated bullet.
    ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
    line = f"- {ts}: {fact.strip()}\n"

    existing = target.read_text(encoding="utf-8") if target.exists() else ""
    target.write_text(existing + line, encoding="utf-8")

    return f"Saved to {clean}"


async def recall_notes(path: str, query: str = "") -> str:
    """Read back a notes file, optionally filtered by a search query.

    Args:
        path: Relative path to the notes file (e.g. ``"NOTES.md"``).
        query: Optional case-insensitive filter string.  Only lines
               containing *query* are returned.  Empty = return all lines.

    Returns:
        The file contents (or filtered lines), or ``"(empty)"`` if the
        file doesn't exist or has no matching lines.

    Example::

        all_notes = await recall_notes("NOTES.md")
        abc_notes = await recall_notes("leads.md", "ABC Corp")
    """
    root = Path(_get_agent_dir())
    clean = path.replace("\\", "/").lstrip("/.")
    target = root / clean

    if not target.exists():
        return f"{clean}: (file not found)"

    content = target.read_text(encoding="utf-8")
    if not query.strip():
        return content if content.strip() else f"{clean}: (empty)"

    q = query.strip().lower()
    filtered = [line for line in content.splitlines() if q in line.lower()]
    if not filtered:
        return f"{clean}: no lines matching {query!r}"
    return "\n".join(filtered)
