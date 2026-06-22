"""Parse ``.github/agents/<name>.agent.md`` — the Copilot SDK agent definition.

GitHub Copilot Chat (and the Copilot SDK) author an agent's identity in a
single Markdown file under ``.github/agents/``:

    ---
    name: CommandCenter
    description: >
      Self-anneal agent for the CommandCenter platform...
    model: claude-sonnet-4-5
    tools:
      - runCommands
      - editFiles
      - terminal
    ---
    # CommandCenter Self-Anneal Agent
    You are a senior software engineer...        <- inline system prompt

CommandCenter wraps Copilot SDK agents inside MAF, so historically the
runtime built each agent from ``agents.py`` / ``instructions.md`` and the
``.agent.md`` file was only consumed by VS Code — never by the deployment.

This module gives the runtime a defensive reader for that file so a live
chat (or any agent run) honours the agent's authored instructions, model,
and (advisory) tool list.  The ``tools`` field uses VS Code Copilot's
vocabulary (``editFiles``/``terminal``/...) which does not map 1:1 onto
CommandCenter's platform-injected tools, so it is surfaced as advisory
metadata only — it never restricts what the agent can actually call.

Parsing mirrors :mod:`acb_skills.registry`'s frontmatter conventions:
``---``-delimited YAML, UTF-8-SIG tolerant, never raises on malformed input.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

_DELIM = "---"


@dataclass
class AgentMd:
    """Parsed ``.github/agents/<name>.agent.md`` definition."""

    name: str
    description: str = ""
    model: str | None = None
    tools: list[str] = field(default_factory=list)
    body: str = ""          # the inline system prompt (markdown after frontmatter)
    path: Path | None = None


def _split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Split a ``---``-delimited YAML frontmatter block off the top of *text*.

    Returns ``({}, text)`` when no frontmatter is present.  Never raises on
    malformed YAML — a bad block yields an empty mapping.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != _DELIM:
        return {}, text
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == _DELIM:
            end = i
            break
    if end is None:
        return {}, text
    try:
        fm = yaml.safe_load("\n".join(lines[1:end])) or {}
    except yaml.YAMLError:
        fm = {}
    if not isinstance(fm, dict):
        fm = {}
    body = "\n".join(lines[end + 1:]).lstrip("\n")
    return fm, body


def _coerce_tools(raw: Any) -> list[str]:
    """Normalise the ``tools`` frontmatter value to a list of strings."""
    if isinstance(raw, str):
        return [raw.strip()] if raw.strip() else []
    if isinstance(raw, (list, tuple)):
        return [str(t).strip() for t in raw if str(t).strip()]
    return []


def parse_agent_md(text: str, *, path: Path | None = None) -> AgentMd | None:
    """Parse the raw contents of an ``.agent.md`` file into an :class:`AgentMd`.

    Returns ``None`` when the file has no usable identity (no ``name`` and no
    body) so callers can treat "nothing to apply" uniformly.
    """
    fm, body = _split_frontmatter(text)
    name = str(fm.get("name") or "").strip()
    body = (body or "").strip()
    if not name and not body:
        return None
    model = fm.get("model")
    return AgentMd(
        name=name or (path.stem.replace(".agent", "") if path else ""),
        description=str(fm.get("description") or "").strip(),
        model=str(model).strip() if model else None,
        tools=_coerce_tools(fm.get("tools")),
        body=body,
        path=path,
    )


def find_agent_md(agent_dir: Path | str, agent_name: str | None = None) -> Path | None:
    """Locate the best ``.agent.md`` for *agent_name* under *agent_dir*.

    Search order inside ``<agent_dir>/.github/agents/``:
      1. ``<agent_name>.agent.md`` (exact filename match)
      2. a file whose frontmatter ``name`` matches *agent_name* (case-insensitive)
      3. the sole ``*.agent.md`` file if exactly one exists
      4. the first ``*.agent.md`` file alphabetically

    Returns ``None`` when the directory or any matching file is absent.
    """
    agents_dir = Path(agent_dir) / ".github" / "agents"
    if not agents_dir.is_dir():
        return None
    candidates = sorted(agents_dir.glob("*.agent.md"))
    if not candidates:
        return None

    norm = (agent_name or "").strip().lower()
    if norm:
        # 1. exact filename (<name>.agent.md), tolerant of an "agent-" prefix.
        for stem in (norm, norm.removeprefix("agent-")):
            exact = agents_dir / f"{stem}.agent.md"
            if exact in candidates:
                return exact
        # 2. frontmatter name match.
        for cand in candidates:
            try:
                fm, _ = _split_frontmatter(cand.read_text(encoding="utf-8-sig"))
            except OSError:
                continue
            if str(fm.get("name") or "").strip().lower() == norm:
                return cand

    # 3 & 4. sole file, else first alphabetically.
    return candidates[0]


def load_agent_md(agent_dir: Path | str, agent_name: str | None = None) -> AgentMd | None:
    """Load and parse the ``.agent.md`` for *agent_name*, or ``None``.

    Fully defensive: a missing directory, unreadable file, or malformed
    frontmatter all yield ``None`` so the caller never has to guard a run.
    """
    md_path = find_agent_md(agent_dir, agent_name)
    if md_path is None:
        return None
    try:
        text = md_path.read_text(encoding="utf-8-sig")
    except OSError:
        return None
    return parse_agent_md(text, path=md_path)
