# Agent Builder Guide — Skills + Scripts + CommandCenter Framework

> **Audience:** AI coding agents and developers building new CommandCenter agents.
> **Reference implementation:** `sales-prospector` repo — canonical pattern for all new agents.
> **Framework:** DOE v2 — Skills / Orchestration / Execution.
> **Date:** 2026-06-13 · **Version:** 4.0

---

## 1. Canonical Folder Structure

All new agents MUST follow this layout (sales-prospector is the reference):

```
agent-<name>/
├── agents.py                        # MAF build_agents() entry point — Required
├── config.json                      # CommandCenter contract — Required
├── AGENTS.md                        # AI coding agent orientation — Required
├── pyproject.toml
├── README.md
├── <name>.code-workspace            # VS Code workspace file (optional but recommended)
│
├── .github/
│   ├── agents/
│   │   └── <name>.agent.md          # VS Code Copilot Chat agent definition
│   ├── prompts/
│   │   ├── system.md                # Primary system prompt (replaces instructions.md)
│   │   └── *.prompt.md              # Task-specific prompts for VS Code Copilot Chat
│   └── skills/
│       └── <skill-name>/
│           ├── SKILL.md             # Skill instructions + frontmatter
│           └── scripts/             # Python scripts for this skill
│
├── scripts/                         # Shared utilities used across multiple skills
├── data/                            # Reference data, templates, catalogs
├── outputs/                         # Per-run output files (never committed)
├── tests/
│   └── test_agents.py
└── .env                             # Local only — never commit
```

**Key rules:**
- Skills live in `.github/skills/<name>/` — NOT in a top-level `skills/` folder.
- System prompt lives in `.github/prompts/system.md` — NOT in `instructions.md` at root.
- Skill scripts live in `.github/skills/<name>/scripts/` — scripts shared across skills go in `scripts/` at root.
- `agents.py` and `config.json` MUST be at the repo root.
- `graph.py` is NOT supported. CommandCenter only calls `build_agents()`.
- No credentials in the repo. Local mode reads `.env`; CommandCenter injects from Integration Registry.

---

## 2. `config.json` — Required Schema

```json
{
  "name": "agent-my-agent",
  "description": "One-line description with trigger keywords. The orchestrator routes using this.",
  "version": "0.1.0",
  "skill_repos": [],
  "integrations": ["clickup", "zoho-crm"],
  "optional_integrations": [],
  "model_tier": "tier-balanced",
  "execution_budget": {
    "max_runtime_seconds": 300,
    "max_llm_calls": 20,
    "max_tool_calls": 40
  },
  "authority": "suggest",
  "max_mutation_attempts": 1,
  "tags": ["sales", "outbound"]
}
```

| Field | Notes |
|---|---|
| `name` | Bare agent name shown in the Control Plane. |
| `description` | **Routing signal** — include trigger keywords and domain. Be specific. |
| `max_mutation_attempts` | **MUST be `1`.** Non-negotiable. |
| `integrations` | Keys from Integration Registry — injected as env vars before the agent runs. |
| `model_tier` | Use `tier-fast`, `tier-balanced`, or `tier-powerful`. |

---

## 3. `agents.py` — Canonical Template

`build_agents()` must be **synchronous, zero-argument, pure** and return `list[GitHubCopilotAgent]`.

```python
"""agent-<name> — MAF Agent definitions.

Exports:
    build_agents() -> list[GitHubCopilotAgent]   (Dynamic Agent Loader entry point)
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from agent_framework_github_copilot import GitHubCopilotAgent
from copilot.types import PermissionHandler

# ── Paths ─────────────────────────────────────────────────────────────────────
AGENT_DIR   = Path(__file__).parent.resolve()
PROMPTS_DIR = AGENT_DIR / ".github" / "prompts"
SKILLS_DIR  = AGENT_DIR / ".github" / "skills"
SCRIPTS_DIR = AGENT_DIR / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


# ── Subprocess env (adds scripts/ to PYTHONPATH for shared utilities) ─────────

def _run_env() -> dict[str, str]:
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    scripts = str(SCRIPTS_DIR)
    env["PYTHONPATH"] = f"{scripts}{os.pathsep}{existing}" if existing else scripts
    return env


async def _run(args: list[str]) -> str:
    result = await asyncio.to_thread(
        subprocess.run, args,
        capture_output=True, text=True,
        cwd=str(AGENT_DIR), env=_run_env(),
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or f"Script exited {result.returncode}")
    return result.stdout or "(no output)"


# ── System prompt ─────────────────────────────────────────────────────────────

def _build_system_prompt() -> str:
    """Load .github/prompts/system.md + append each .github/skills/*/SKILL.md."""
    parts: list[str] = []
    system_md = PROMPTS_DIR / "system.md"
    if system_md.exists():
        parts.append(system_md.read_text(encoding="utf-8", errors="replace"))
        if SKILLS_DIR.exists():
            skill_sections: list[str] = []
            for skill_md in sorted(SKILLS_DIR.glob("*/SKILL.md")):
                content = skill_md.read_text(encoding="utf-8", errors="replace")
                skill_sections.append(f"\n### Tool: {skill_md.parent.name}\n\n{content}")
            if skill_sections:
                parts.append("\n\n---\n\n## Registered Skill Tool Descriptions\n")
                parts.extend(skill_sections)
    else:
        # Fallback if system.md is absent
        agents_md = AGENT_DIR / "AGENTS.md"
        if agents_md.exists():
            parts.append(agents_md.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(parts)


SYSTEM_PROMPT = _build_system_prompt()


# ── Tool functions ─────────────────────────────────────────────────────────────
#
# Each async def is a callable tool. The docstring IS the routing signal —
# write "Use this when the user asks about X / wants to do Y."
# Return str. Raise on failure — never swallow exceptions.
#
# Pattern A — subprocess (script in .github/skills/<name>/scripts/):
#
# async def do_something(arg: str) -> str:
#     "Describe what this does and when to call it."
#     return await _run([sys.executable,
#         str(SKILLS_DIR / "my-skill" / "scripts" / "main.py"), arg])
#
# Pattern B — shared script in scripts/:
#
# async def sync_sheet(sheet_id: str) -> str:
#     "Sync results to Google Sheets. Use after any scrape or data operation."
#     return await _run([sys.executable,
#         str(SCRIPTS_DIR / "append_to_sheet.py"), "--sheet-id", sheet_id])

async def example_tool(action: str) -> str:
    """Run the example skill. Use when the user asks about [domain]. action: one of list|summary|run."""
    return await _run([sys.executable,
        str(SKILLS_DIR / "example-skill" / "scripts" / "main.py"), action])


# ── LiteLLM provider ──────────────────────────────────────────────────────────

def _llm_provider() -> dict[str, Any]:
    base_url = os.environ.get("LITELLM_BASE_URL", "http://127.0.0.1:8080")
    api_key  = os.environ.get("LITELLM_MASTER_KEY", "sk-local")
    return {"type": "openai", "base_url": f"{base_url}/v1", "api_key": api_key}


# ── Agent factory ─────────────────────────────────────────────────────────────

def build_agent() -> GitHubCopilotAgent:
    return GitHubCopilotAgent(
        instructions=SYSTEM_PROMPT,
        tools=[
            example_tool,
            # Add more async def tool functions here
        ],
        default_options={
            "model": "tier-balanced",
            "provider": _llm_provider(),
            "mcp_servers": {},
            "on_permission_request": PermissionHandler.approve_all,
        },
    )


def build_agents() -> list[GitHubCopilotAgent]:
    """Dynamic Agent Loader entry point. Synchronous, zero-argument, pure."""
    return [build_agent()]


__all__ = ["build_agents", "build_agent", "SYSTEM_PROMPT"]
```

**Hard rules:**
- `build_agents()` is synchronous, zero-argument, no I/O at import time.
- `tools=[...]` must not be empty — an agent with no tools only apologises.
- Tool functions must be `async def` and return `str`. Raise on failure.
- Use `sys.executable`, not `"python"`, in subprocess calls.
- `on_permission_request` must be `PermissionHandler.approve_all`.

---

## 4. `SKILL.md` — Anatomy

Every `.github/skills/<name>/SKILL.md` needs YAML frontmatter:

```yaml
---
name: skill-name
description: >
  What this skill does and WHEN to use it. Include trigger keywords.
  Max 1024 chars.
when_to_use: "Trigger conditions in plain English."
authority: read
cost_tier: 1
version: 0.1.0
---
```

Body structure:

```markdown
# Skill Name

One-line summary.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/main.py` | Does the heavy lifting |

## Usage
\`\`\`bash
python .github/skills/<name>/scripts/main.py --help
\`\`\`

## Required Environment Variables
- `MY_API_KEY` — from `.env` or Integration Registry
```

Updating a `SKILL.md` is reflected on the next CommandCenter run without touching `agents.py`.

---

## 5. `.github/prompts/system.md` — System Prompt

This is the primary system prompt loaded by `agents.py`. Keep it under ~300 lines.

```markdown
# Agent Name — System Prompt

## Purpose
[One paragraph — what the agent does, integrations, who it serves.]

## Available Tools

| Tool | When to use |
|------|-------------|
| `example_tool` | User asks about X |

## Rules
1. Always call the relevant tool — never answer from memory alone.
2. Report tool errors explicitly.
3. Do NOT fabricate data.

## Output Format
- Short intro (1 sentence)
- Results in bullet points or a table
```

---

## 6. `.github/agents/<name>.agent.md` — VS Code Copilot Chat

```markdown
---
name: my-agent
description: >
  One-line description. Include trigger keywords. Max ~300 chars.
tools:
  - runCommands
  - codebase
  - editFiles
  - search
model: claude-sonnet-4-5
---

# My Agent

[Inline contents of .github/prompts/system.md here, or have the agent read it on first turn]

## Skills
- **skill-name** (`.github/skills/skill-name/SKILL.md`) — brief description

## How to Use
- Read `SKILL.md` before running a skill: use the `codebase` tool
- Run scripts: `python .github/skills/<name>/scripts/main.py [args]`
- Credentials in `.env` — never commit
```

---

## 7. `scripts/` — Shared Utilities

Scripts shared across multiple skills live at `scripts/` (root), not inside any skill folder.

```
scripts/
├── append_to_sheet.py       # Write results to Google Sheets
├── normalize_leads.py       # Data normalisation helpers
├── retry_utils.py           # Exponential backoff, safe API calls
└── ...
```

`agents.py` adds `scripts/` to `PYTHONPATH` via `_run_env()` so skill scripts can import shared utilities directly (`from retry_utils import safe_get`).

---

## 8. `pyproject.toml`

```toml
[project]
name = "agent-my-agent"
version = "0.1.0"
description = "Short description"
requires-python = ">=3.11"
dependencies = [
    "agent-framework-github-copilot>=1.0.0rc1",
    "httpx>=0.27",
]

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-asyncio>=0.24"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

---

## 9. `tests/test_agents.py` — Minimum Suite

```python
def test_build_agents_returns_list():
    from agents import build_agents
    result = build_agents()
    assert isinstance(result, list) and len(result) >= 1

def test_agent_has_instructions():
    from agents import build_agents
    agent = build_agents()[0]
    instructions = getattr(agent, "instructions", None) or getattr(agent, "_instructions", None)
    assert instructions and len(instructions) > 50

def test_agent_has_tools():
    from agents import build_agents
    agent = build_agents()[0]
    tools = getattr(agent, "tools", None) or getattr(agent, "_tools", None) or []
    assert len(tools) > 0, "Agent has no tools — it will only apologise"
```

Run with: `uv run pytest tests/ -v`

---

## 10. Build Checklist

1. **Scaffold** the repo as `agent-<name>` using the folder structure in §1.
2. **`config.json`** — fill in `name`, `description` (trigger keywords!), `integrations`, `tags`. Set `max_mutation_attempts: 1`.
3. **`.github/prompts/system.md`** — agent identity, tool table, rules (≤ 300 lines).
4. **`AGENTS.md`** — persona one-liner + skills table + quick start.
5. **`.github/agents/<name>.agent.md`** — frontmatter + inline system prompt for VS Code Copilot Chat.
6. **Skills** — for each capability: `mkdir .github/skills/<name>`, create `SKILL.md` + `scripts/*.py`.
7. **`scripts/`** — add any utilities shared across skills.
8. **`agents.py`** — use the canonical template (§3). Wire one `async def` tool per skill.
9. **`pyproject.toml`** — add `agent-framework-github-copilot` and skill package deps.
10. **`tests/test_agents.py`** — add the three tests from §9.
11. **Smoke test:**
    ```bash
    uv run python -c "from agents import build_agents; a = build_agents(); print([t.__name__ for t in a[0].tools])"
    ```
    Verify tools list is non-empty.
12. **Register in CommandCenter:** Control Plane → **Agents** → **Add Agent** → paste GitHub repo URL.

---

## 11. Integration Credentials

CommandCenter injects credentials from the Integration Registry as env vars before running the agent. Scripts always call `os.getenv(...)` — works identically in local (`.env`) and CommandCenter modes.

| Integration key | Environment variable(s) |
|---|---|
| `clickup` | `CLICKUP_API_TOKEN`, `CLICKUP_WORKSPACE_ID` |
| `zoho-crm` | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` |
| `apollo` | `APOLLO_API_KEY` |
| `serpapi` | `SERPAPI_API_KEY` |
| `apify` | `APIFY_API_TOKEN` |
| `instantly` | `INSTANTLY_API_KEY` |
| `google-sheets` | `GOOGLE_SHEETS_SA_JSON_PATH` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `litellm` | `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY` |

---

## 12. Anti-Patterns

- Putting skills in `skills/` (root) — they belong in `.github/skills/`.
- Putting the system prompt in `instructions.md` (root) — use `.github/prompts/system.md`.
- `tools=[]` empty or omitted — the agent will only apologise.
- Using `"python"` (bare string) in subprocess calls — use `sys.executable`.
- `max_mutation_attempts > 1` — hard constraint, never exceed 1.
- I/O at module import time in `agents.py` — kills fast boot.
- Instantiating `GitHubCopilotAgent` outside of `build_agents()`.
- Adding `graph.py` — LangGraph is not supported, CommandCenter only calls `build_agents()`.
- Credentials hardcoded anywhere — always use `os.getenv()`.
- Catching `Exception` and returning `{"error": ...}` — raise instead so MAF can handle failures.

---

## 13. Self-Mutation and Auto-Repair

CommandCenter auto-maintains agent repos:

- **Proactive skill sync:** After every `git pull`, new scripts in `.github/skills/*/scripts/` that don't appear in `agents.py` are auto-wired as tool functions and committed.
- **AgentLoadError repair:** If `agents.py` fails to import or `build_agents()` returns wrong types, a Copilot SDK mutation sandbox generates a fix, runs `pytest`, and commits directly. Max 1 attempt per failure event.

To revert any auto-commit: `git revert <hash>` and push.