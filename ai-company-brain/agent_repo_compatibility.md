# Agent Builder Guide — Skills + Scripts + CommandCenter Framework

> **Audience:** anyone building a new agent — from a brand-new GitHub Copilot Chat agent, to a production MAF agent running inside CommandCenter.
> **Framework:** DOE v2 — Skills / Orchestration / Execution.
> **CommandCenter contract source of truth:** `config.json` schema (§6), `agents.py` contract (§7). If this doc and the code disagree, the code wins — update this doc.
> **Date:** 2026-06-07 · **Version:** 3.0

---

## 0. TL;DR — the framework in one table

| Artefact | Must-have | Purpose |
|---|---|---|
| `config.json` | Yes | Declares agent name, skills, integrations, model tier. CommandCenter reads this to register and route the agent. |
| `agents.py` | Yes | MAF `build_agents()` entry point — exports `list[GitHubCopilotAgent]`. The Dynamic Agent Loader calls this to instantiate the agent at runtime. **`graph.py` is not supported** — LangGraph has been removed from CommandCenter. |
| `instructions.md` | Yes | Primary system prompt (agent identity, skills summary, rules). Loaded at build time by `agents.py`. |
| `skills/<name>/SKILL.md` | Per skill | Instructions for a skill domain: when to use, what scripts to call, expected outputs. |
| `skills/<name>/scripts/` | Per skill | Python scripts that do the actual work for that skill (called via subprocess by tool functions). |
| `scripts/` | Recommended | Shared utilities not belonging to a specific skill (data I/O, diagnostics, sync helpers). |
| `AGENTS.md` | Yes | Pointer file for AI coding agents (GitHub Copilot, Cursor, etc.) — persona summary + skill/script map. This is what a new Copilot agent reads to orient itself. |
| `.github/agents/<name>.agent.md` | For Copilot mode | VS Code Copilot Chat agent definition — frontmatter + persona. Required for the `/agent:name` slash command. |
| `execution/memory_bank.py` | Recommended | Working memory manager — read/write JSON files at session start/end. Part of the built-in memory system (§20). |
| `execution/memory_db.py` | Recommended | Long-term memory — SQLite + FTS5 for full-text search across all past interactions, facts, entities. (§20). |
| `memory/` | Recommended | Persistent storage directory: JSON files, SQLite database, Markdown insights. Survives across sessions. |
| `data/` | Recommended | Product catalogs, templates, reference PDFs, images. See `data/INDEX.md`. |
| `outputs/{slug}/` | At runtime | Per-campaign persistent JSON files written by scripts. |
| `.code-workspace` | Recommended | VS Code workspace file — configures Python interpreter, Copilot, and auto-setup tasks (§2). |
| `.vscode/tasks.json` | Recommended | VS Code tasks — includes `runOn: folderOpen` setup task so environment auto-activates on open. |
| `memories/repo/` | Recommended | Repository-scoped facts for AI coding agents working on this repo. |
| `.env` | Local only | API keys for local / VS Code Copilot Chat mode. Never committed. |
| `tests/` | Recommended | pytest suite; at minimum imports `agents.py` and calls `build_agents()`. |

This repo runs in **three modes simultaneously** with no conflicts:

| Mode | Entry point | When to use | Runtime in CommandCenter |
|---|---|---|---|
| **VS Code Copilot Chat** | `.github/agents/<name>.agent.md` | Local dev, rapid iteration, manually triggering pipeline steps | N/A (local only) |
| **CommandCenter — Copilot SDK agent** | `agents.py` + `config.json` | Production runs, event-driven triggers, Control Plane chat | Copilot SDK **directly** (bypasses MAF) — native BYOK via `SessionConfig.provider`. Set `agent_runtime: "github-copilot"` in the agent registry. |
| **CommandCenter — MAF agent** | `agents.py` + `config.json` | Production runs, event-driven triggers, Control Plane chat | MAF `Agent.run()` — BYOK via `OpenAIChatCompletionClient` injection. Set `agent_runtime: "maf"` in the agent registry. |
| **MAF standalone** | `agents.py` only (no CommandCenter) | Run the MAF agent directly via Python without the Control Plane | N/A (standalone) |

All modes use the same `instructions.md` + `skills/*/SKILL.md` source of truth. Adding any mode's entry-point does not break the others.

**Future:** When `agent-framework-github-copilot` supports `github-copilot-sdk >= 1.0.0`, Copilot SDK agents will move back under MAF (`GitHubCopilotAgent`) with BYOK passed via `default_options["provider"]`. The `agents.py` contract (`build_agents() → list[Agent]`) remains the same — no agent repo changes needed. See `project_plan.md` §Open Questions #9.

---

## 1. Workspace folder structure

```
agent-<name>/
├── config.json               # CommandCenter agent contract (§6)
├── agents.py                 # MAF build_agents() entry point (§7)
├── instructions.md           # Primary system prompt — loaded by agents.py
├── pyproject.toml            # Pip-installable package (deps)
├── AGENTS.md                 # AI coding agent orientation file (§13)
├── README.md
├── <name>.code-workspace     # VS Code workspace file (§2)
│
├── .github/
│   └── agents/
│       └── <name>.agent.md   # VS Code Copilot Chat agent definition (§2)
│
├── .vscode/
│   ├── tasks.json            # Auto-setup on folder open
│   └── settings.json         # Python interpreter + Copilot enable
│
├── skills/
│   ├── <skill-name>/
│   │   ├── SKILL.md          # Skill instructions + frontmatter (§3)
│   │   └── scripts/          # Python scripts for this skill
│   └── ...
│
├── execution/                # Shared execution scripts (callable by all skills)
│   ├── memory_bank.py        # Working memory: JSON read/write (§20)
│   ├── memory_db.py          # Long-term memory: SQLite FTS5 (§20)
│   └── ...                   # Other shared scripts (web_search, etc.)
│
├── memory/                   # Persistent memory storage (§20)
│   ├── agent_context.json    # Current state: projects, goals, active challenges
│   ├── interaction_log.json  # Past conversation summaries
│   ├── decision_journal.json # Decisions with timing + outcomes
│   ├── insights.md           # Accumulated wisdom (append-only)
│   └── agent_memory.db       # SQLite FTS5 database
│
├── scripts/                  # Shared utility scripts (not skill-specific)
│
├── data/
│   ├── INDEX.md              # Agent-readable manifest of data/ contents
│   └── ...
│
├── outputs/
│   └── {slug}/               # Per-campaign / per-run JSON files
│
├── memories/
│   └── repo/                 # Repo-scoped facts for AI coding agents
│
├── tests/
│   └── test_agents.py
│
└── .env                      # Local only — never commit
```

**Key rules:**
- `config.json` and `agents.py` MUST be at the repo root.
- `instructions.md` is the single source of truth for the agent system prompt. Do not duplicate it in `AGENTS.md`.
- Skill instructions live in `skills/*/SKILL.md` only. `agents.py` appends them automatically at build time.
- No credentials in the repo. Ever. Local mode reads `.env`; CommandCenter mode injects credentials from the Integration Registry.

---

## 2. VS Code Copilot Chat — `.github/agents/<name>.agent.md`

Every agent that should be accessible as a GitHub Copilot Chat agent (the `/agent:name` command or the **Agents** picker in VS Code) needs a `.agent.md` file.

### File location and frontmatter

Create `.github/agents/<name>.agent.md`:

```markdown
---
name: my-agent
description: >
  One-line description of what this agent does and when to invoke it.
  Include trigger keywords so Copilot routes correctly. Max ~300 chars.
tools:
  - run_in_terminal
  - read_file
  - create_file
  - replace_string_in_file
  - file_search
  - grep_search
  - semantic_search
model: claude-sonnet-4-5
---

# My Agent — System Prompt

[Inline the contents of instructions.md here, OR have the agent read it on first turn]

You have access to the following skills:
- **skill-name** (`skills/skill-name/SKILL.md`) — brief description

## Memory Bank

You have a persistent memory bank that survives across sessions. **Use it.**

**Before every response:**
1. Read working memory: `python execution/memory_bank.py --read all`
2. If the question references a specific past event, person, or topic not in the JSON:
   `python execution/memory_db.py search "<keywords>"`

**After every substantive conversation:**
1. Log the interaction: `python execution/memory_bank.py --log-interaction --summary "..."`
2. Update context if the user shared new information:
   `python execution/memory_bank.py --update agent_context --data '{"key": "value"}'`
3. Add a durable fact: `python execution/memory_db.py add-fact "..." --category business --entity "Name"`
4. Add insight if you learned something reusable: `python execution/memory_db.py add-insight "..."`

Memory files in `memory/`:
- `agent_context.json` — current projects, goals, active challenges
- `interaction_log.json` — past conversation summaries
- `decision_journal.json` — decisions with timing and outcomes
- `insights.md` — accumulated wisdom (append-only, never delete)
- `agent_memory.db` — full-text searchable SQLite database

## How to use your tools
- Use `run_in_terminal` to run Python scripts: `python execution/memory_bank.py --read all`
- Use `read_file` to read SKILL.md files before executing a skill
- Use `create_file` / `replace_string_in_file` for output files or code edits
- Credentials are in `.env` — load them with python-dotenv or read the file directly

## Rules
1. **Read memory first.** Before answering any question, run `memory_bank.py --read all`.
2. Always read `skills/<name>/SKILL.md` before executing a skill for the first time in a session.
3. Never hardcode credentials. Read from `.env`.
4. Run scripts with `python execution/...py [args]` or `python skills/<skill>/scripts/<script>.py [args]`.
5. Log every substantive conversation to memory before ending the session.
6. Confirm outputs are written to `outputs/` before declaring a step complete.
```

### Which VS Code tools to enable

| Tool | When to include |
|---|---|
| `run_in_terminal` | **Always** — this is how Copilot mode runs scripts |
| `read_file`, `file_search`, `grep_search`, `semantic_search` | **Always** — reading skill instructions and data |
| `create_file`, `replace_string_in_file` | When the agent writes files (outputs, code edits) |
| `list_dir` | When the agent navigates the repo structure |

> **Tool calling in Copilot mode vs MAF mode:** Copilot runs VS Code built-in tools (`run_in_terminal`, `read_file`, etc.). MAF runs the `async def` Python functions declared in `agents.py`. Both approaches end up calling the same underlying scripts.

### `AGENTS.md` — AI coding agent orientation file

`AGENTS.md` (at the repo root) is the first file any AI coding agent reads when exploring the repo. Keep it under ~100 lines:

```markdown
# Agent Instructions — My Agent

> You are [brief persona — one sentence].

## Architecture
**Layer 1: Skills** (`skills/*/SKILL.md`) — instructions for each capability.
**Layer 2: Orchestration (YOU)** — read skills, call scripts in order, handle errors.
**Layer 3: Execution** (`skills/*/scripts/`, `scripts/`) — Python scripts that do the work.

## Skills

| Skill | SKILL.md | Purpose |
|---|---|---|
| my-skill | `skills/my-skill/SKILL.md` | Does X when the user asks about Y |

## Shared Scripts

| Script | Purpose |
|---|---|
| `scripts/util.py` | Common helper used by multiple skills |

## Quick Start
1. Read `instructions.md` for the full system prompt.
2. Read the relevant `skills/<name>/SKILL.md` before running any skill.
3. Run scripts via terminal: `python skills/<name>/scripts/<script>.py`
4. Credentials in `.env` — never commit, never hardcode.
```

### `.code-workspace` — open the agent directly in VS Code

Create `<name>.code-workspace` at the repo root. When a user opens this file in VS Code, the workspace opens with the correct Python interpreter and Copilot enabled. The `.agent.md` is then automatically visible in the Copilot agent picker.

```json
{
  "folders": [{ "path": "." }],
  "settings": {
    "python.defaultInterpreterPath": "${workspaceFolder}/.venv/Scripts/python.exe",
    "python.terminal.activateEnvironment": true,
    "github.copilot.enable": { "*": true, "python": true, "markdown": true },
    "editor.formatOnSave": true,
    "terminal.integrated.cwd": "${workspaceFolder}",
    "search.exclude": { "**/__pycache__": true, "**/.venv": true }
  },
  "extensions": {
    "recommendations": ["GitHub.copilot", "GitHub.copilot-chat", "ms-python.python"]
  }
}
```

### `.vscode/tasks.json` — auto-setup on folder open

The `runOn: folderOpen` task auto-activates the venv and initialises the memory database the first time a user opens the repo. This means the agent is ready to use immediately.

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Setup Agent Environment",
      "type": "shell",
      "command": "python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && python execution/memory_db.py status",
      "windows": {
        "command": "powershell",
        "args": ["-ExecutionPolicy", "Bypass", "-Command",
          "python -m venv .venv; .venv/Scripts/pip install -r requirements.txt; python execution/memory_db.py status"]
      },
      "group": { "kind": "build", "isDefault": true },
      "presentation": { "reveal": "always", "panel": "new" },
      "runOptions": { "runOn": "folderOpen" },
      "problemMatcher": []
    }
  ]
}
```

> **How Copilot finds the `.agent.md`:** VS Code scans `.github/agents/*.agent.md` in the open workspace. As long as the workspace is open (via the `.code-workspace` file or a direct folder open), the agent appears in the **Agents** picker (`@agent-name` or the dropdown). No registration needed — file presence is enough.

---

## 3. `SKILL.md` — anatomy and frontmatter

Every `skills/<name>/SKILL.md` requires YAML frontmatter:

```yaml
---
name: skill-name              # Required. Lowercase + hyphens. Must match folder name.
description: >
  What this skill does and WHEN to use it. Max 1024 chars.
  Include trigger keywords — this is the discovery surface for both
  the Copilot agent (reading SKILL.md) and MAF routing.
when_to_use: "Trigger conditions in plain English."
authority: read               # read | suggest | suggest_apply | autonomous
cost_tier: 1                  # 1 (cheap/fast) | 2 (standard) | 3 (heavy reasoning)
version: 0.1.0
---
```

Required: `name` + `description`. Everything else is optional but recommended.

### Body structure

````markdown
# Skill Name

One-line summary of what this skill accomplishes.

## When to Use
- Trigger condition A
- Trigger condition B

## Scripts

| Script | Purpose |
|--------|---------|
| `skills/<name>/scripts/main.py` | Does the heavy lifting |
| `skills/<name>/scripts/helper.py` | Utility used by main |

## Usage
```bash
python skills/<name>/scripts/main.py --help
python skills/<name>/scripts/main.py <action> [--arg value]
```

## Outputs
- `outputs/{slug}/step_N_<name>.json` — key fields: ...

## Required Environment Variables
- `MY_API_KEY` — from `.env` or Integration Registry

## Edge Cases
- What to do when X fails: try Y
````

### Skill loading in `agents.py`

`agents.py` builds the system prompt by concatenating:
1. `instructions.md` — agent identity and rules
2. Each `skills/*/SKILL.md` — appended as a `### Tool: <name>` block

Updating a `SKILL.md` is immediately reflected in the next CommandCenter run without touching `agents.py`.

---

## 4. Skills as pip-installable packages

For skills shared across multiple agents (e.g. a ClickUp connector, a CRM tool), package them as standalone pip-installable packages rather than inline scripts.

### Package structure

```
skill-<name>/
├── pyproject.toml
├── SKILL.md                  # Same frontmatter format as inline SKILL.md
├── skill_<name>/
│   ├── __init__.py           # Exports the tool functions directly
│   └── client.py             # API client / business logic
└── tests/
    └── test_skill.py
```

### `__init__.py` — export tool functions

Tool functions in the package must be `async def`, accept typed parameters, and return `str`. They are imported directly into `agents.py`:

```python
# skill_<name>/__init__.py
import asyncio
import os
import httpx

async def get_task_status(task_id: str) -> str:
    '''Fetch the status, assignees, and due date for a task by ID.

    Use this when the user asks about a specific task by ID or name.
    '''
    token = os.environ["MY_API_TOKEN"]
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"https://api.example.com/tasks/{task_id}",
            headers={"Authorization": token},
        )
        resp.raise_for_status()
        data = resp.json()
    return f"Task: {data['name']}\nStatus: {data['status']}"
```

### `pyproject.toml` for the skill package

```toml
[project]
name = "skill-<name>"
version = "0.1.0"
description = "Short description — one skill, shareable across agents"
requires-python = ">=3.12"
dependencies = ["httpx>=0.27"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["skill_<name>"]
```

### Importing the package in `agents.py`

```python
try:
    from skill_<name> import get_task_status, list_project_tasks
    _SKILL_TOOLS = [get_task_status, list_project_tasks]
except ImportError:
    # skill not installed — agent still boots, tools unavailable
    _SKILL_TOOLS = []
```

Register the package in `config.json`:

```json
{ "skill_repos": ["skill-<name>"] }
```

CommandCenter installs all `skill_repos` packages before running the agent.

---

## 5. `instructions.md` — the primary system prompt

Use `instructions.md` (at the repo root) as the single source of truth for the agent's system prompt. This file is read by both `agents.py` (MAF/CommandCenter mode) and directly referenced in the `.agent.md` (Copilot mode).

```markdown
# <Agent Name> — Agent Instructions

## Purpose
[One paragraph — what the agent does, what integrations it uses, who it serves.]

## Available Tools

| Tool | When to use |
|------|-------------|
| `tool_function_name` | User asks about X |
| `another_tool` | User wants to do Y |

## Rules
1. Always call the relevant tool — never answer from memory alone.
2. Include source URLs / task links in every response when available.
3. Use bullet points for lists; keep answers concise.
4. If a tool returns an error, report it explicitly and suggest what to check.
5. Do NOT fabricate data. Only use what the tools return.

## Output Format
- Short intro (1 sentence)
- Results in bullet points or a table
- Cite sources / task URLs as plain links

## Example Queries
- "What is the status of task ABC-123?"
- "Summarise open tasks for the Alpha project"
```

**Keep it under ~300 lines.** `agents.py` appends all `SKILL.md` files after it; a bloated `instructions.md` pushes skills out of context.

---

## 6. `config.json` — canonical schema

Minimal:

```json
{
  "name": "my-agent",
  "description": "One-line description. Include trigger keywords. Used by the orchestrator for routing.",
  "version": "0.1.0",
  "runtime": "maf",
  "skill_repos": [],
  "max_mutation_attempts": 1
}
```

Full (all fields CommandCenter reads):

```json
{
  "name": "my-agent",
  "description": "One-line description. Include trigger keywords and domain name.",
  "version": "0.1.0",
  "runtime": "maf",
  "skill_repos": ["skill-clickup-sync"],
  "integrations": ["clickup", "zoho-crm"],
  "optional_integrations": [],
  "model_tier": "tier2-sonnet",
  "mcp_servers": {},
  "execution_budget": {
    "max_runtime_seconds": 300,
    "max_llm_calls": 20,
    "max_tool_calls": 40
  },
  "triggers": {
    "cron": [],
    "webhooks": [{ "source": "zoho", "event_type": "deal.stageChange" }]
  },
  "authority": "suggest",
  "max_mutation_attempts": 1,
  "tags": ["tasks", "sales"]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | str | Yes | Bare agent name shown in the Control Plane picker. |
| `description` | str | Yes | **Used as the routing signal** — the orchestrator LLM routes to the right agent based on this alone. Be specific: include trigger keywords, domain, integrations. |
| `version` | semver str | Yes | Bump on every breaking change. |
| `runtime` | `"maf"` | Yes | Always `"maf"` — LangGraph runtime has been removed. |
| `skill_repos` | `list[str]` | Yes (may be `[]`) | Pip-installable skill package names to install before running. |
| `integrations` | `list[str]` | Yes (may be `[]`) | Credential keys from the Integration Registry. Injected as env vars. |
| `optional_integrations` | `list[str]` | Recommended | Integrations that enhance the agent but are not required to boot. |
| `mcp_servers` | `dict` | Recommended | MCP server config passed to `GitHubCopilotAgent`. Empty `{}` is valid. |
| `model_tier` | str | Recommended | LiteLLM model alias — see §9. |
| `execution_budget` | object | Recommended | Enforced by the long-run supervisor. |
| `authority` | `"read"\|"suggest"\|"suggest_apply"\|"autonomous"` | Recommended | Default ceiling for writes via the Action Broker. |
| `max_mutation_attempts` | int | Yes | **MUST be `1`.** Constraint C-01. |
| `tags` | `list[str]` | Recommended | Used for filtering in the Control Plane UI. |

---

## 7. `agents.py` — required contract

`build_agents()` must be a **synchronous, zero-argument, pure function** returning `list[GitHubCopilotAgent]`. The Dynamic Agent Loader calls it at runtime.

> **Critical:** `tools=[]` empty means the agent is text-only — it will apologise instead of acting. Every capability must be wired as a tool function.

### Canonical template

This is the exact pattern used by built-in agents (e.g. `apps/agent-task-manager/agents.py`):

```python
"""my-agent — MAF agent definitions.

Exports:
    build_agents() -> list[GitHubCopilotAgent]   (Dynamic Agent Loader entry point)
    build_agent()  -> GitHubCopilotAgent
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

# ---- Paths ---------------------------------------------------------------
AGENT_DIR   = Path(__file__).parent.resolve()
SKILLS_DIR  = AGENT_DIR / "skills"
SCRIPTS_DIR = AGENT_DIR / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

# ---- System prompt -------------------------------------------------------
# Read instructions.md as the base; append each SKILL.md block.
_instructions_file = AGENT_DIR / "instructions.md"
_INSTRUCTIONS_BASE = (
    _instructions_file.read_text(encoding="utf-8")
    if _instructions_file.exists()
    else "You are my-agent. Use the provided tools to answer questions."
)


def _build_instructions() -> str:
    parts = [_INSTRUCTIONS_BASE]
    if SKILLS_DIR.exists():
        for skill_md in sorted(SKILLS_DIR.glob("*/SKILL.md")):
            parts.append(
                f"\n\n---\n\n### Tool: {skill_md.parent.name}\n\n"
                f"{skill_md.read_text(encoding='utf-8')}"
            )
    return "\n".join(parts)


INSTRUCTIONS = _build_instructions()

# ---- Tool functions ------------------------------------------------------
#
# PATTERN A - Subprocess (best for scripts with their own dependencies)
#
# async def run_pipeline_summary() -> str:
#     "Get the sales pipeline summary. Use when the user asks about pipeline status."
#     result = await asyncio.to_thread(
#         subprocess.run,
#         [sys.executable, str(AGENT_DIR / "skills/crm/scripts/pipeline.py"), "summary"],
#         capture_output=True, text=True, cwd=str(AGENT_DIR),
#     )
#     if result.returncode != 0:
#         raise RuntimeError(result.stderr[:500] or "Script exited non-zero")
#     return result.stdout or "(no output)"
#
# PATTERN B - Direct import from a skill package (best for pip-installed skills)
#
# try:
#     from skill_clickup_sync import get_task_status, list_project_tasks
#     _TOOLS_CLICKUP = [get_task_status, list_project_tasks]
# except ImportError:
#     _TOOLS_CLICKUP = []
#
# Rules:
#   - async def + descriptive docstring -- the docstring IS the routing signal
#   - Return str (stdout, JSON dump, or human-readable summary)
#   - Raise on failure -- do not swallow; MAF routes failures to Self_Mutation_Node
#   - Use sys.executable (not "python") in subprocess calls
#   - Credentials come from os.environ -- injected by CommandCenter from Integration Registry
#   - For skill packages: import tools directly; fall back gracefully on ImportError

# ---- Example tool (replace with real tools) ------------------------------

async def run_example(action: str) -> str:
    "Run an example skill script. action: one of 'list', 'summary', 'search'."
    "Use this when the user asks about [your domain]. Always prefer this over answering from memory."
    cmd = [sys.executable, str(AGENT_DIR / "skills/my-skill/scripts/main.py"), action]
    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, cwd=str(AGENT_DIR)
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[:500] or "Script exited non-zero")
    return result.stdout or "(no output)"


# ---- Built-in memory tools (include whenever the agent has a memory/ dir) --
#
# These wrap execution/memory_bank.py and execution/memory_db.py.
# If you are not using the memory system, delete this block.

async def memory_read(memory_type: str = "all") -> str:
    "Read the agent memory bank. memory_type: 'all' (default) or one of: agent_context, interaction_log, decision_journal, insights."
    "Always call this at the start of every session before answering."
    result = await asyncio.to_thread(
        subprocess.run,
        [sys.executable, str(AGENT_DIR / "execution/memory_bank.py"), "--read", memory_type],
        capture_output=True, text=True, cwd=str(AGENT_DIR),
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[:300] or "memory_bank.py failed")
    return result.stdout or "(memory empty)"


async def memory_search(query: str) -> str:
    "Search the long-term memory database. Use when the user references a past event, person, company, or decision not visible in current context."
    result = await asyncio.to_thread(
        subprocess.run,
        [sys.executable, str(AGENT_DIR / "execution/memory_db.py"), "search", query],
        capture_output=True, text=True, cwd=str(AGENT_DIR),
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[:300] or "memory_db.py failed")
    return result.stdout or "(no results)"


async def memory_log_interaction(summary: str, topics: str = "", advice: str = "", follow_ups: str = "") -> str:
    "Log a conversation to memory. Call at the end of every substantive session. topics/advice/follow_ups are comma-separated strings."
    cmd = [
        sys.executable, str(AGENT_DIR / "execution/memory_bank.py"),
        "--log-interaction", "--summary", summary,
    ]
    if topics:
        cmd += ["--topics", topics]
    if advice:
        cmd += ["--advice", advice]
    if follow_ups:
        cmd += ["--follow-ups", follow_ups]
    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, cwd=str(AGENT_DIR)
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[:300] or "log-interaction failed")
    return result.stdout or "Logged."


async def memory_add_fact(content: str, category: str = "general", entity: str = "", tags: str = "") -> str:
    "Store a discrete fact in long-term memory. category: business | personal | market | team | product | general. entity: the primary person/company this fact is about."
    cmd = [
        sys.executable, str(AGENT_DIR / "execution/memory_db.py"),
        "add-fact", content, "--category", category,
    ]
    if entity:
        cmd += ["--entity", entity]
    if tags:
        cmd += ["--tags", tags]
    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, cwd=str(AGENT_DIR)
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[:300] or "add-fact failed")
    return result.stdout or "Stored."


async def memory_update_context(key: str, value: str) -> str:
    "Update a key in the agent's current context. key uses dot notation: e.g. 'project.status'. value is a string or JSON."
    result = await asyncio.to_thread(
        subprocess.run,
        [sys.executable, str(AGENT_DIR / "execution/memory_bank.py"),
         "--update", "agent_context", "--key", key, "--value", value],
        capture_output=True, text=True, cwd=str(AGENT_DIR),
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[:300] or "update-context failed")
    return result.stdout or "Updated."


# ---- LiteLLM provider helper ---------------------------------------------

def _litellm_provider() -> dict[str, Any]:
    base_url = os.environ.get("LITELLM_BASE_URL", "http://litellm:4000")
    api_key  = os.environ.get("LITELLM_API_KEY", "")
    return {"type": "openai", "base_url": f"{base_url}/v1", "api_key": api_key}


# ---- Agent factory -------------------------------------------------------

def build_agent() -> GitHubCopilotAgent:
    return GitHubCopilotAgent(
        instructions=INSTRUCTIONS,
        tools=[
            # Memory tools — include if this agent uses the memory system (§20)
            memory_read,
            memory_search,
            memory_log_interaction,
            memory_add_fact,
            memory_update_context,
            # Skill tools — add one async def per capability
            run_example,
            # CommandCenter auto-detects new scripts and wires them on the next pull.
        ],
        default_options={
            "model": "tier2-sonnet",
            "provider": _litellm_provider(),
            "mcp_servers": {},
            "on_permission_request": PermissionHandler.approve_all,
        },
    )


def build_agents() -> list[GitHubCopilotAgent]:
    """Dynamic Agent Loader entry point. Must be synchronous and zero-argument."""
    return [build_agent()]


__all__ = ["build_agents", "build_agent", "INSTRUCTIONS"]
```

### `pyproject.toml` for the agent package

```toml
[project]
name = "agent-my-agent"
version = "0.1.0"
description = "Short description"
requires-python = ">=3.12"
dependencies = [
    "agent-framework-github-copilot",
    "httpx>=0.27",
    # Add skill packages here:
    # "skill-clickup-sync",
]

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-asyncio>=0.24"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = []   # agents.py is at root, not in a package

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

### Calling another agent as a sub-task

Every agent automatically receives two extra tools at run time — no imports needed:

| Tool | Behaviour |
|---|---|
| `call_agent(agent_name, message)` | Delegates to another registered agent and **awaits the full result** (sequential). |
| `call_agent_background(agent_name, message)` | Dispatches and **returns immediately** (fire-and-forget). |

```python
# Optional explicit import for IDE auto-complete.
from acb_skills.agent_tools import call_agent, call_agent_background

async def get_deal_tasks(deal_name: str) -> str:
    "Find all ClickUp tasks linked to a deal. Use when the user asks about task status for a deal."
    return await call_agent(
        "task-manager",
        f"List all tasks tagged with or mentioning '{deal_name}'. Include assignee, due date, status.",
    )
```

`agent_name` must match a name registered in the Control Plane. Calling a non-existent agent returns an error string (never raises).

> **Avoid infinite loops:** never call `call_agent` with your own agent name. CommandCenter does not prevent this.

### How MAF maps tools to the LLM

On every `agent.run(message)` call, MAF:
1. Derives **function name** → tool name, **docstring** → description, **type hints** → parameter schema.
2. Sends `instructions` + all tool schemas in one API request to LiteLLM.
3. When the LLM returns a tool call, MAF executes the Python function and feeds the result back.

**The docstring is the routing signal.** Write: "Use this tool when the user asks about X / wants to do Y."

### Hard rules

- `build_agents()` is synchronous, zero-argument, pure. No I/O at import time.
- Must return `list[GitHubCopilotAgent]` with at least one agent.
- **`tools=[...]` must not be empty** if the agent needs to act.
- Tool functions must be `async def` and return `str`.
- On failure, **raise** — do not swallow exceptions.
- Use `sys.executable` (not `"python"`) in subprocess calls.
- Credentials arrive via `os.environ`. Never hardcode them.
- Do not instantiate agents at module level — `build_agents()` is the factory.
- `on_permission_request` must be `PermissionHandler.approve_all` (imported from `copilot.types`).
- **`graph.py` is not supported.** The CommandCenter executor only calls `build_agents()`.
- **`agents.py` is auto-maintained by CommandCenter.** After every `git pull`, new scripts in `skills/*/scripts/` are auto-wired as tools and committed directly to the repo.

---

## 8. Running without CommandCenter — MAF standalone

If you want to run the MAF agent directly (no CommandCenter Control Plane), call `build_agents()` yourself:

```python
# run_agent.py — standalone MAF runner (no CommandCenter needed)
import asyncio
import os
from dotenv import load_dotenv

load_dotenv()  # reads .env for local credentials

from agents import build_agents


async def main():
    agents = build_agents()
    agent = agents[0]
    response = await agent.run("List all open tasks in the Alpha project")
    print(response)


asyncio.run(main())
```

**Requirements for standalone mode:**
- Install `agent-framework-github-copilot` and all skill packages: `pip install -e .`
- Set `LITELLM_BASE_URL` + `LITELLM_API_KEY` (or configure LiteLLM locally)
- Set all integration credentials in `.env`

Use standalone mode for:
- Local testing without spinning up the full Control Plane
- CI integration tests
- Embedding agents in other Python applications

---

## 9. LiteLLM model tiers

The LiteLLM proxy (running at `LITELLM_BASE_URL`, default `http://litellm:4000`) defines three tier aliases:

| Alias | Default model | Use for |
|---|---|---|
| `tier1-local-qwen3` | `gemini/gemini-2.5-flash-lite` | Cheap, fast: classification, triage, extraction |
| `tier2-sonnet` | `gemini/gemini-2.5-flash` | Standard: structured tasks, drafting, tool calling |
| `tier3-opus` | `gemini/gemini-2.5-pro` | Heavy reasoning, multi-hop, strategy |

GitHub Copilot fallbacks (activated automatically if Gemini is unavailable):

| Tier | Copilot fallback |
|---|---|
| `tier1-local-qwen3` | `copilot/gpt-4o-mini` |
| `tier2-sonnet` | `copilot/gpt-4o` |
| `tier3-opus` | `copilot/o3-mini` |

Use `"model": "tier2-sonnet"` in `default_options` for most agents. Use `tier3-opus` only for agents that need deep reasoning — it is significantly more expensive.

---

## 10. Integrations — credential flow

**CommandCenter mode:** the Dynamic Agent Loader injects credentials from the Integration Registry as environment variables before running the agent. Any `os.getenv(...)` call in tool functions or scripts works unchanged.

**Local / VS Code / Standalone mode:** credentials come from `.env` (loaded by `python-dotenv`).

Scripts always call `os.getenv(...)` — it works in all modes unchanged.

Common integration keys → env variable mapping:

| Integration key | Environment variable(s) |
|---|---|
| `clickup` | `CLICKUP_API_TOKEN`, `CLICKUP_WORKSPACE_ID` |
| `zoho-crm` | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` |
| `apollo` | `APOLLO_API_KEY` |
| `serpapi` | `SERPAPI_API_KEY` |
| `apify` | `APIFY_API_TOKEN` |
| `anymailfinder` | `ANYMAILFINDER_API_KEY` |
| `instantly` | `INSTANTLY_API_KEY` |
| `google-sheets` | `GOOGLE_SHEETS_SA_JSON_PATH` |
| `litellm` | `LITELLM_BASE_URL`, `LITELLM_API_KEY` |

---

## 11. Memory pattern — `<mem>` tags

Agents use the stateless memory pattern:

1. CommandCenter injects prior memories into the system prompt via `state["context"]["memories"]`.
2. The LLM emits durable facts wrapped in `<mem>...</mem>` tags anywhere in its response.
3. MAF post-processing strips the tags from the visible reply and returns them as `memories_to_save`.
4. CommandCenter persists them; they appear as context on future runs.

```
Raw LLM output:
  "The deal is in Awaiting PO. <mem>Fracktal: Manu prefers office demos</mem>"

After stripping:
  result.content  ->  "The deal is in Awaiting PO."
  memories_to_save -> [{"text": "Fracktal: Manu prefers office demos"}]
```

Rules: ≤ 2 `<mem>` tags per turn · each ≤ 200 chars · `category ∈ {fact, preference, decision, open_question}`.

---

## 12. Control Plane chat contract

`POST /agent/run` per turn:

```json
{
  "agent": "my-agent",
  "payload": {
    "mode": "chat",
    "message": "<latest user message>",
    "messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}],
    "session_id": "<stable session uuid>"
  },
  "thread_id": "<session uuid>"
}
```

Read `state["event_payload"]["messages"]` + `state["event_payload"]["message"]`. Return:

```python
state["result"] = {"role": "assistant", "content": "<text>"}
```

Stay idempotent on retry — the gateway may replay the same `run_id`.

---

## 13. `AGENTS.md` — AI coding agent orientation file

`AGENTS.md` is the first file any AI coding agent (Copilot, Cursor, etc.) reads when working in this repo. It must answer: *Who am I? What can I do? Where are my scripts?*

Template:

```markdown
# Agent Instructions — My Agent

> You are a [brief persona description — one sentence].

## Architecture (DOE v2)

**Layer 1: Skills** (`skills/*/SKILL.md`) — instructions for each capability domain.
**Layer 2: Orchestration (YOU)** — read skills, call scripts in order, handle errors.
**Layer 3: Execution** (`skills/*/scripts/`, `scripts/`) — Python scripts that do the work.

## Skills

| Skill | SKILL.md | Purpose |
|---|---|---|
| my-skill | `skills/my-skill/SKILL.md` | Does X when the user asks about Y |

## Shared Scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `util.py` | Common helper |

## Quick Start
1. Read `instructions.md` — full system prompt and rules.
2. Read the relevant `skills/<name>/SKILL.md` before running any skill.
3. Run scripts: `python skills/<name>/scripts/<script>.py [args]`
4. Credentials are in `.env` — never commit, never hardcode.

## File Organisation
- `outputs/{slug}/` — per-run JSON files written by scripts
- `data/` — reference data (see `data/INDEX.md`)
- `.env` — API keys (local only)
```

---

## 14. `tests/` — minimum viable test suite

```python
# tests/test_agents.py

def test_build_agents_returns_list():
    from agents import build_agents
    result = build_agents()
    assert isinstance(result, list)
    assert len(result) >= 1


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

## 15. Three-mode comparison

| | VS Code Copilot Chat | CommandCenter | MAF Standalone |
|---|---|---|---|
| Entry point | `.github/agents/<name>.agent.md` | `agents.py` + `config.json` | `agents.py` only |
| How tools run | VS Code built-ins (`run_in_terminal`, `read_file`, etc.) | `async def` Python functions in `agents.py` | `async def` Python functions in `agents.py` |
| System prompt | Inline in `.agent.md` (or read via `read_file`) | `_build_instructions()` in `agents.py` | `_build_instructions()` in `agents.py` |
| Credentials | `.env` via `python-dotenv` | Integration Registry → env vars | `.env` via `python-dotenv` |
| Script execution | `run_in_terminal` → `python skills/.../script.py` | `subprocess.run` inside `async def` tool | `subprocess.run` inside `async def` tool |
| Outputs | `outputs/{slug}/` on local disk | `outputs/{slug}/` on executor clone | `outputs/{slug}/` on local disk |
| Memory | `outputs/_memory/` (JSON/FTS5) | `memories_to_save` → orchestration context | `outputs/_memory/` (JSON/FTS5) |
| Registration needed? | No — file presence is enough | Yes — register via Control Plane `/agents` UI | No — run directly via Python |

**Rule:** Adding `agents.py` and `config.json` does not touch any existing file. VS Code Copilot Chat continues working as before.

---

## 16. Anti-patterns

- `os.environ["KEY"]` (KeyError on missing) inside tool functions — use `os.getenv("KEY")` with a default or let CommandCenter inject it.
- `requests.get(...)` or any network I/O at module import time — kills fast boot.
- `build_agents()` that takes arguments or performs I/O.
- Instantiating `GitHubCopilotAgent` outside of `build_agents()`.
- `max_mutation_attempts > 1` or missing from `config.json`.
- Mutable module-level state used to cache results across runs.
- Agent persona duplicated in both `instructions.md` AND `AGENTS.md` — one source of truth.
- Skill instructions in `instructions.md` — put them in `skills/<name>/SKILL.md`; `agents.py` appends them automatically.
- Catching `Exception` and returning `{"error": ...}` instead of raising.
- **`tools=[]` empty or omitted** — the agent will only apologise.
- Using `"python"` (bare string) in subprocess calls — use `sys.executable`.
- Adding agents to `_KNOWN_AGENTS` in `apps/gateway/gateway/routes/agent.py` — that list is for CommandCenter Core built-ins only. External agents register via the Control Plane UI.

---

## 17. Building a new agent — checklist

1. **Scaffold** the repo with the folder structure from §1. Name it `agent-<name>`.
2. **`config.json`** — fill in `name`, `description` (trigger keywords!), `integrations`, `skill_repos`, `tags`.
3. **`instructions.md`** — agent identity, tool table, rules, example queries (keep under ~300 lines).
4. **`AGENTS.md`** — persona one-liner + skills table + quick start (for AI coding agents reading the repo).
5. **`.github/agents/<name>.agent.md`** — frontmatter with `tools:` list + inline system prompt + memory protocol for VS Code Copilot Chat.
6. **`.code-workspace` + `.vscode/tasks.json`** — workspace file and auto-setup task so the agent opens ready-to-use in VS Code (§2).
7. **Memory system (optional but recommended)** — copy `execution/memory_bank.py` + `execution/memory_db.py` from the reference agent (§20). Seed `memory/agent_context.json`. Add memory protocol to `instructions.md`.
8. **Skills** — for each capability, create `skills/<name>/SKILL.md` + `skills/<name>/scripts/*.py`.
9. **`agents.py`** — wire memory tools + skill tool functions using the canonical template (§7). Import from skill packages via `try/except ImportError`; use subprocess for inline scripts.
10. **`pyproject.toml`** — add `agent-framework-github-copilot` and skill package deps.
11. **`tests/test_agents.py`** — add the three tests from §14.
12. **Smoke test**: `uv run python -c "from agents import build_agents; a = build_agents(); print([t.__name__ for t in a[0].tools])"` — verify tools list is non-empty and memory tools appear.
13. **Register in CommandCenter**: Control Plane → **Agents** → **Add Agent** → paste the GitHub repo URL. The Control Plane auto-fetches `config.json`. The agent appears in the chat picker immediately.

---

## 18. Automatic self-repair and skill sync

CommandCenter maintains agent repos automatically — no PR workflow required.

### Proactive skill sync (runs on every git pull)

Before each run, CommandCenter:
1. Pulls the latest code (`git pull --ff-only`)
2. Scans `skills/*/scripts/*.py` for scripts whose stem doesn't appear in `agents.py`
3. For each new script, injects an `async def` subprocess wrapper and adds it to `tools=[...]`
4. Commits and pushes directly to the current branch

**Result:** Add a new skill script → on the next run, CommandCenter auto-wires it as a callable tool. No manual `agents.py` edit needed.

### Incompatibility repair (runs on AgentLoadError)

| Incompatibility | What CommandCenter does |
|---|---|
| No `agents.py` in repo | Spawns Copilot SDK sandbox to generate a compliant `agents.py` |
| `agents.py` exists but fails to import | Sandbox fixes the import error |
| `build_agents()` returns empty list or wrong type | Sandbox generates a fix and commits directly |

```
CommandCenter attempts to load agent repo
            │
            ▼
    AgentLoadError (incompatibility)
            │
            ▼
    Copilot SDK mutation container spawned
      • Receives the exact AgentLoadError + this compatibility guide
      • Inspects the cloned repo (already authenticated)
      • Generates compliant agents.py with tools=[...] from existing scripts
      • Runs: python -c "from agents import build_agents; assert build_agents()"
      • Runs pytest if tests/ exists
      • git commit + git push origin HEAD  (direct commit, no PR)
            │
            ▼
    Next run: CommandCenter pulls the fix, agent runs successfully
```

### What the sandbox generates

The sandbox generates `agents.py` with:
- `INSTRUCTIONS` reading `instructions.md` (or `AGENTS.md` as fallback) + all `skills/*/SKILL.md`
- An `async def` tool wrapper for every script in `skills/*/scripts/`
- All wrappers registered in `tools=[...]`
- All other files left untouched

### Safety and rollback

- **One fix per failure event** (`max_mutation_attempts = 1`) — never loops.
- **Direct commit** — no PR, no review gate.
- **To revert:** `git revert <hash>` and push. CommandCenter pulls the revert on the next run.
- Proactive sync commits are atomic single-file commits (`agents.py` only) and are trivially revertable.

### After any auto-commit

No restart needed. On the next chat message or webhook event, CommandCenter pulls the latest commit and the agent runs with all tools active.

---

## 19. Built-in memory system

Every agent built on this framework can include a **two-tier persistent memory system** that makes the agent smarter with every conversation. Memory survives across sessions and is searchable via SQLite full-text search.

### Architecture overview

```
Tier 1 — Working Memory (JSON + Markdown)          Tier 2 — Long-Term Memory (SQLite FTS5)
────────────────────────────────────               ─────────────────────────────────────────
memory/agent_context.json    current state         memory/agent_memory.db
memory/interaction_log.json  recent convos             tables: interactions, facts, entities,
memory/decision_journal.json decisions                          insights, context, profile
memory/insights.md           accumulated wisdom        FTS5 indexes with porter stemming
                                                        Trigger-maintained (auto-sync)
Loaded at session start                           Queried on demand
~60KB, zero latency                               ~400KB+, ~1s per search
```

**When to use each tier:**
- Use **Tier 1** (JSON) for current state, active projects, recent interactions, ongoing relationships
- Use **Tier 2** (SQLite) when the user asks about a specific past event, person, or decision not in the loaded JSON

### `memory/` directory — what to initialise

```
memory/
├── agent_context.json        # Current state: projects, goals, active challenges, team
├── interaction_log.json      # Summaries of past conversations
├── decision_journal.json     # Decisions made with context, timing, and outcomes
├── insights.md               # Accumulated wisdom — append-only, never delete entries
└── agent_memory.db           # SQLite FTS5 database (auto-created by memory_db.py)
```

Seed `agent_context.json` with relevant initial state before the first session:

```json
{
  "agent_name": "my-agent",
  "domain": "describe the agent's domain",
  "active_projects": [],
  "key_relationships": [],
  "current_goals": [],
  "active_challenges": [],
  "_last_updated": null
}
```

### `execution/memory_bank.py` — working memory script

Place this script at `execution/memory_bank.py`. It handles all JSON read/write operations.

```python
#!/usr/bin/env python3
"""Working memory manager — reads/writes JSON memory files.

Usage:
    python execution/memory_bank.py --read all
    python execution/memory_bank.py --read agent_context
    python execution/memory_bank.py --update agent_context --key "projects.alpha.status" --value "active"
    python execution/memory_bank.py --update agent_context --data '{"new_project": {"name": "Beta"}}'
    python execution/memory_bank.py --log-interaction --summary "Discussed Q3 strategy" --topics "strategy,roadmap" --advice "Focus on retention"
    python execution/memory_bank.py --log-decision --decision "Delay launch to Q4" --context "Market conditions"
    python execution/memory_bank.py --add-insight "Enterprise deals close 2x faster with exec sponsor"
    python execution/memory_bank.py --search "funding"
"""

import os
import sys
import json
import argparse
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_ROOT = SCRIPT_DIR.parent
MEMORY_DIR = PROJECT_ROOT / "memory"

MEMORY_FILES = {
    "agent_context":    "agent_context.json",
    "interaction_log":  "interaction_log.json",
    "decision_journal": "decision_journal.json",
    "insights":         "insights.md",
}


def ensure_memory_dir():
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)


def read_memory(memory_type: str):
    if memory_type not in MEMORY_FILES:
        raise ValueError(f"Unknown memory type '{memory_type}'. Options: {list(MEMORY_FILES)}")
    filepath = MEMORY_DIR / MEMORY_FILES[memory_type]
    if not filepath.exists():
        return {} if filepath.suffix == ".json" else ""
    if filepath.suffix == ".json":
        content = filepath.read_text(encoding="utf-8").strip()
        return json.loads(content) if content else {}
    return filepath.read_text(encoding="utf-8")


def read_all_memory() -> dict:
    return {k: read_memory(k) for k in MEMORY_FILES}


def write_memory(memory_type: str, data):
    ensure_memory_dir()
    filepath = MEMORY_DIR / MEMORY_FILES[memory_type]
    if filepath.suffix == ".json":
        filepath.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    else:
        filepath.write_text(data, encoding="utf-8")
    print(f"Updated: {memory_type}")


def deep_merge(base: dict, override: dict) -> dict:
    result = base.copy()
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def set_nested(d: dict, key_path: str, value):
    keys = key_path.split(".")
    cur = d
    for k in keys[:-1]:
        cur = cur.setdefault(k, {})
    try:
        cur[keys[-1]] = json.loads(value) if isinstance(value, str) else value
    except (json.JSONDecodeError, TypeError):
        cur[keys[-1]] = value


def update_memory(memory_type: str, key=None, value=None, data=None):
    current = read_memory(memory_type)
    if isinstance(current, str):
        write_memory(memory_type, current + (f"\n{data}" if data else ""))
        return
    if data:
        current = deep_merge(current, json.loads(data) if isinstance(data, str) else data)
    elif key and value is not None:
        set_nested(current, key, value)
    current["_last_updated"] = datetime.now().isoformat()
    write_memory(memory_type, current)


def log_interaction(summary: str, topics=None, advice=None, follow_ups=None):
    log = read_memory("interaction_log")
    if not isinstance(log, dict):
        log = {}
    log.setdefault("interactions", []).append({
        "date": datetime.now().isoformat(),
        "interaction_number": len(log.get("interactions", [])) + 1,
        "summary": summary,
        "topics": topics or [],
        "advice_given": advice or [],
        "follow_ups": follow_ups or [],
    })
    write_memory("interaction_log", log)
    print(f"Logged interaction #{len(log['interactions'])}: {summary[:60]}")


def log_decision(decision: str, context="", timing=""):
    journal = read_memory("decision_journal")
    if not isinstance(journal, dict):
        journal = {}
    journal.setdefault("decisions", []).append({
        "date": datetime.now().isoformat(),
        "decision": decision,
        "context": context,
        "timing_context": timing,
        "status": "pending",
        "outcome": None,
    })
    write_memory("decision_journal", journal)
    print(f"Logged decision: {decision[:80]}")


def add_insight(text: str):
    insights = read_memory("insights")
    entry = f"\n## {datetime.now().strftime('%Y-%m-%d')}\n{text}\n"
    write_memory("insights", insights + entry)
    print(f"Added insight: {text[:80]}")


def search_memory(query: str):
    """Simple in-memory search across all JSON files."""
    q = query.lower()
    results = []
    for k in MEMORY_FILES:
        data = str(read_memory(k))
        if q in data.lower():
            # Find surrounding context
            idx = data.lower().find(q)
            snippet = data[max(0, idx-100):idx+200].replace("\n", " ")
            results.append(f"[{k}] ...{snippet}...")
    if not results:
        print("No results found.")
    else:
        print("\n".join(results))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--read", metavar="TYPE", help="Read memory (type or 'all')")
    parser.add_argument("--update", metavar="TYPE", help="Update a memory file")
    parser.add_argument("--key", help="Dot-notation key to set")
    parser.add_argument("--value", help="Value to set")
    parser.add_argument("--data", help="JSON data to merge")
    parser.add_argument("--log-interaction", action="store_true")
    parser.add_argument("--log-decision", action="store_true")
    parser.add_argument("--add-insight", metavar="TEXT")
    parser.add_argument("--search", metavar="QUERY")
    parser.add_argument("--summary", default="")
    parser.add_argument("--topics", default="")
    parser.add_argument("--advice", default="")
    parser.add_argument("--follow-ups", default="")
    parser.add_argument("--decision", default="")
    parser.add_argument("--context", default="")
    parser.add_argument("--timing", default="")
    args = parser.parse_args()

    if args.read:
        if args.read == "all":
            data = read_all_memory()
            print(json.dumps(data, indent=2, ensure_ascii=False))
        else:
            data = read_memory(args.read)
            print(json.dumps(data, indent=2, ensure_ascii=False) if isinstance(data, (dict, list)) else data)
    elif args.update:
        update_memory(args.update, key=args.key, value=args.value, data=args.data)
    elif args.log_interaction:
        log_interaction(args.summary,
                        topics=args.topics.split(",") if args.topics else [],
                        advice=args.advice.split(",") if args.advice else [],
                        follow_ups=args.follow_ups.split(",") if args.follow_ups else [])
    elif args.log_decision:
        log_decision(args.decision, context=args.context, timing=args.timing)
    elif args.add_insight:
        add_insight(args.add_insight)
    elif args.search:
        search_memory(args.search)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
```

### `execution/memory_db.py` — long-term SQLite FTS5 memory

Place this script at `execution/memory_db.py`. It provides full-text search across all past interactions, facts, entities, insights, and context via SQLite FTS5 with porter stemming.

**Key commands agents use:**

```bash
# Universal search (the main command — use this when JSON doesn't have the answer)
python execution/memory_db.py search "funding round Ragupathi"
python execution/memory_db.py search "Honda tooling" --type facts
python execution/memory_db.py search "board dynamics" --after 2026-03-01

# Store atomic facts
python execution/memory_db.py add-fact "Honda interested in RapidTool for fixture automation" \
    --category business --entity "Honda" --tags "enterprise,customer"

# Log interactions (in addition to memory_bank.py)
python execution/memory_db.py log-interaction --summary "Discussed Series A timing" \
    --topics "funding,strategy" --advice "Wait for Q3 numbers"

# Log decisions with outcomes
python execution/memory_db.py log-decision --decision "Delay fundraise to Q3" \
    --context "Market conditions" --timing "Saturn transit 10th house"
python execution/memory_db.py update-outcome 1 "Good call - raised at better terms"

# Store entities (people, companies, concepts)
python execution/memory_db.py add-entity "Jane Smith" --type person \
    --details "VP Engineering at Acme. Ex-Google. Decision maker on tooling."

# Store insights
python execution/memory_db.py add-insight "Enterprise deals need exec sponsor to close" \
    --category business

# Current state
python execution/memory_db.py context set "deal.acme.stage" "pilot"
python execution/memory_db.py context show

# Database health
python execution/memory_db.py status
python execution/memory_db.py rebuild-fts
```

**Schema (tables):** `interactions` · `decisions` · `facts` · `entities` · `insights` · `context` · `profile`

**FTS5 virtual tables** mirror each content table with porter stemming. Triggers keep them in sync automatically.

For the full implementation, copy `execution/memory_db.py` from the `startup-guru` reference agent at `C:\Users\VijayRaghavVarada\Documents\Github\DOE Framework Agentic AI\outputs\startup-guru\execution\memory_db.py`. It is ~600 lines and production-tested.

### Memory session protocol

Include this protocol in `instructions.md` and in the `.agent.md` body:

```markdown
## Memory Protocol

**Before every response:**
1. Read working memory: `python execution/memory_bank.py --read all`
2. If the question references a specific past event, person, or topic not visible in the JSON:
   `python execution/memory_db.py search "<keywords>"`

**After every substantive conversation (before ending the session):**
1. Log interaction summary:
   `python execution/memory_bank.py --log-interaction --summary "..." --topics "..." --advice "..."`
2. Update context with any new information shared by the user:
   `python execution/memory_bank.py --update agent_context --key "key.path" --value "value"`
3. Store discrete facts worth remembering long-term:
   `python execution/memory_db.py add-fact "..." --category business --entity "EntityName"`
4. Add insight if you learned something generalisable:
   `python execution/memory_db.py add-insight "..."`
5. Log any decisions made:
   `python execution/memory_bank.py --log-decision --decision "..." --context "..."`
```

### Wiring memory into `agents.py` for CommandCenter

The five `async def memory_*` functions shown in §7 cover all memory operations. Include them in `tools=[...]` alongside your skill tools. The docstrings tell the LLM when to call each one — the critical rule is:

- `memory_read` → call at the start of every session (the LLM will call it on the first message)
- `memory_search` → call when user references something not in current context
- `memory_log_interaction` → call at the end of every substantive session
- `memory_add_fact` → call when discrete durable facts are learned
- `memory_update_context` → call when current state changes (project status, relationships, goals)

### What to add to `requirements.txt`

The memory system only uses Python stdlib — no additional dependencies needed:

```
# Memory system uses only stdlib: sqlite3, json, pathlib, argparse, datetime
```

---

## 20. Versioning

Breaking changes get a version bump in `config.json` and an entry in `CHANGELOG.md`.
For CommandCenter Core questions, open an issue on `CommandCenter-Core` with label `agent-spec`.
