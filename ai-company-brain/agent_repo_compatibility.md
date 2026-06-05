# Agent Builder Guide — Skills + Scripts + CommandCenter Framework

> **Audience:** anyone building a new agent using this workspace as a template, or migrating an existing agent to the `skills/ + scripts/ + prompts/` pattern.
> **Framework:** DOE v2 — Skills / Orchestration / Execution.
> **CommandCenter contract source of truth:** `config.json` schema (§5), `agents.py` contract (§6). If this doc and the code disagree, the code wins — update this doc.
> **Date:** 2026-06-05 · **Version:** 2.1

---

## 0. TL;DR — the framework in one table

| Artefact | Must-have | Purpose |
|---|---|---|
| `config.json` | Yes | Declares agent name, skills, integrations, model tier. |
| `agents.py` | Yes | MAF `build_agents()` definition — exports `list[BaseAgent]`; each `GitHubCopilotAgent` loads the system prompt, declares tools and MCP server config. **`graph.py` is not supported** — LangGraph has been removed from CommandCenter. |
| `prompts/system.md` | Yes | Primary system prompt (agent identity, pipeline overview, communication rules). |
| `skills/<name>/SKILL.md` | Per skill | Instructions for a skill domain: when to use, what scripts to call, expected outputs. |
| `skills/<name>/scripts/` | Per skill | Python scripts that do the actual work for that skill. |
| `scripts/` | Yes | Shared utilities (Google Sheets sync, diagnostics, memory manager, product catalog). |
| `AGENTS.md` | Yes | Pointer file for AI coding agents — persona summary + skill/script map. |
| `data/` | Recommended | Product catalogs, templates, reference PDFs, images. See `data/INDEX.md`. |
| `outputs/{slug}/` | At runtime | Per-campaign persistent JSON files written by scripts. |
| `memories/repo/` | Recommended | Repository-scoped facts for AI coding agents working on this repo. |
| `.env` | Local only | API keys for local / VS Code Copilot Chat mode. Never committed. |
| `tests/` | Recommended | pytest suite; at minimum imports `agents.py` and calls `build_agents()`. |

This repo runs in **two modes simultaneously** with no conflicts:

| Mode | Entry point | When to use |
|---|---|---|
| **VS Code Copilot Chat** | `.github/agents/<name>.agent.md` | Local dev, rapid iteration, manually triggering pipeline steps |
| **CommandCenter orchestrator** | `agents.py` + `config.json` | Production runs, event-driven triggers, Control Plane chat |

---

## 1. Workspace folder structure

```
agent-<name>/
├── config.json               # CommandCenter agent contract
├── agents.py               # MAF build_agents() definition — exports list[BaseAgent]
├── pyproject.toml            # Pip-installable package (deps)
├── AGENTS.md                 # AI coding agent instructions
├── README.md
├── compatibility.md          # This file
│
├── prompts/
│   └── system.md             # PRIMARY system prompt for CommandCenter / Anthropic mode
│
├── skills/
│   ├── <skill-name>/
│   │   ├── SKILL.md          # Instructions + frontmatter (when to use, what to call)
│   │   └── scripts/          # Python scripts for this skill
│   └── ...
│
├── scripts/                  # Shared utility scripts (not skill-specific)
│   ├── append_to_sheet.py
│   ├── campaign_data_manager.py
│   ├── self_anneal_diagnostics.py
│   └── ...
│
├── data/
│   ├── INDEX.md              # Agent-readable manifest of data/ contents
│   ├── products_catalog.json
│   └── ...
│
├── outputs/
│   ├── _memory/              # Long-term memory store (JSON + FTS5)
│   └── {campaign-slug}/      # Per-campaign step JSONs
│
├── memories/
│   └── repo/                 # Repo-scoped facts for AI coding agents
│
├── tests/
│   └── test_agents.py
│
└── .env                      # Local only — never commit
```

**Rules:**
- `config.json` and `agents.py` MUST be at the repo root.
- `prompts/system.md` is the single source of truth for the agent system prompt. Do not duplicate it in `AGENTS.md`.
- Skill instructions live in `skills/*/SKILL.md` only. Shared knowledge between skills goes in `AGENTS.md` or `prompts/system.md`.
- No credentials in the repo. Ever. Local mode reads `.env`; CommandCenter mode injects credentials via `mcp_servers=` config (§8).

---

## 2. `SKILL.md` — anatomy and frontmatter

Every `skills/<name>/SKILL.md` requires YAML frontmatter:

```yaml
---
name: skill-name              # Required. Lowercase + hyphens. Must match folder name.
description: 'What this skill does and WHEN to use it. Max 1024 chars. This is the discovery surface — include trigger keywords.'
argument-hint: 'Optional hint shown when invoked as slash command'
user-invocable: true          # Default true. Set false to suppress slash-command listing.
disable-model-invocation: false # Default false. Set true to require explicit slash invocation only.
---
```

Required: `name` + `description`. Everything else is optional.

### Body structure (recommended)

```markdown
# Skill Name

One-line summary of what this skill accomplishes.

## When to Use
- Trigger condition A
- Trigger condition B

## Scripts
| Script | Purpose |
|--------|---------|
| `scripts/main_script.py` | Does the heavy lifting |
| `scripts/helper.py` | Utility used by main |

## Steps
1. Run `python skills/<name>/scripts/main_script.py --help` to confirm options.
2. ...

## Outputs
- `outputs/{slug}/step_N_<name>.json` — key fields: ...

## Edge Cases
- What to do when X fails
```

### Skill loading in `agents.py`

`agents.py` builds the system prompt by concatenating:
1. `prompts/system.md` — agent identity and pipeline overview (~6 k tokens)
2. Each `skills/*/SKILL.md` — appended as a "Tool: `<name>`" block

Updating a `SKILL.md` is immediately reflected in the next CommandCenter run without touching `agents.py`.

---

## 3. `prompts/system.md` — the primary system prompt

- Concise agent identity (who the agent is, what it does)
- Pipeline overview (numbered steps, which skill to use at each step)
- Self-annealing rules and communication rules
- References to individual `skills/*/SKILL.md` files for deep detail

**Keep it under ~400 lines.** The `agents.py` loader appends all SKILL.md files after it; a bloated `system.md` pushes skills out of context.

**Do not duplicate** skill-level detail here. Write "See `skills/research/SKILL.md`" and put the detail there.

---

## 4. `scripts/` — shared utilities

Scripts in `scripts/` are added to `sys.path` by `agents.py` at run-start, making them importable from any skill script:

```python
from self_anneal_diagnostics import run_check
from campaign_data_manager import load_step, save_step
```

Use `scripts/` for:
- Google Sheets sync (`append_to_sheet.py`, `update_sheet.py`, etc.)
- Campaign data I/O (`campaign_data_manager.py`)
- Diagnostics (`self_anneal_diagnostics.py`)

Do **not** put API-calling scripts in `scripts/` if they belong to a specific skill domain — those go in `skills/<name>/scripts/`.

---

## 5. `config.json` — canonical schema

Minimal:

```json
{
  "name": "my-agent",
  "description": "One-line description shown in the Control Plane picker.",
  "version": "0.1.0",
  "skill_repos": [],
  "max_mutation_attempts": 1
}
```

Full (all fields CommandCenter reads):

```json
{
  "name": "my-agent",
  "description": "One-line description.",
  "version": "0.1.0",
  "skill_repos": [],
  "integrations": ["anthropic", "zoho-crm", "apollo"],
  "model_tier": "tier-2",
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
  "tags": ["sales", "outbound"]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | str | Yes | Bare agent name, must match `agent-<name>` repo. |
| `description` | str | Yes | One line; shown in the Control Plane picker. |
| `version` | semver str | Yes | Bump on every breaking change. |
| `skill_repos` | `list[str]` | Yes (may be `[]`) | External pip-installable skill packages to inject. |
| `integrations` | `list[str]` | Yes (may be `[]`) | Credential keys from the Integration Registry. |
| `model_tier` | `"tier-1"\|"tier-2"\|"tier-3"` | Recommended | Routing hint. |
| `execution_budget` | object | Recommended | Enforced by the long-run supervisor. |
| `authority` | `"read"\|"suggest"\|"suggest_apply"\|"autonomous"` | Recommended | Default ceiling for writes via the Action Broker. |
| `max_mutation_attempts` | int | Yes | **MUST be `1`.** Constraint C-01. |

---

## 6. `agents.py` — required contract

`build_agents()` must be a **synchronous, zero-argument, pure function** returning `list[BaseAgent]`. The Dynamic Agent Loader calls it and runs the returned agents via the MAF workflow engine.

> **Critical:** `tools=[]` being empty or commented out means the agent is text-only — it will apologise instead of acting. Every capability in your `skills/*/scripts/` must be wired as a tool function or the LLM cannot call it.

### Complete template (tools-only agent — recommended)

```python
"""my-agent — MAF Agent definitions."""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────
AGENT_DIR   = Path(__file__).parent.resolve()
PROMPTS_DIR = AGENT_DIR / "prompts"
SKILLS_DIR  = AGENT_DIR / "skills"
SCRIPTS_DIR = AGENT_DIR / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


# ── System prompt builder ─────────────────────────────────────────────────

def _build_system_prompt() -> str:
    parts: list[str] = []
    system_md = PROMPTS_DIR / "system.md"
    if system_md.exists():
        parts.append(system_md.read_text(encoding="utf-8"))
        if SKILLS_DIR.exists():
            parts.append("\n\n---\n\n## Registered Skill Tool Descriptions\n")
            for skill_md in sorted(SKILLS_DIR.glob("*/SKILL.md")):
                parts.append(
                    f"\n### Tool: {skill_md.parent.name}\n\n"
                    f"{skill_md.read_text(encoding='utf-8')}"
                )
    else:
        agents_md = AGENT_DIR / "AGENTS.md"
        if agents_md.exists():
            parts.append(agents_md.read_text(encoding="utf-8"))
        if SKILLS_DIR.exists():
            for skill_md in sorted(SKILLS_DIR.glob("*/SKILL.md")):
                parts.append(f"\n\n{skill_md.read_text(encoding='utf-8')}")
    return "\n".join(parts)


# ── Tool functions ────────────────────────────────────────────────────────
#
# Each tool is an async function that calls an existing script in the repo.
# TWO patterns — use whichever fits the script:
#
# Pattern A — subprocess (best for scripts with their own dependencies / env):
#
#   async def zoho_pipeline_summary() -> str:
#       """Get the full sales pipeline summary from Zoho CRM."""
#       result = await asyncio.to_thread(
#           subprocess.run,
#           ["python", str(AGENT_DIR / "skills/crm-ops/scripts/zoho_crm.py"),
#            "pipeline-summary"],
#           capture_output=True, text=True, cwd=str(AGENT_DIR)
#       )
#       return result.stdout or result.stderr
#
#   async def zoho_search(module: str, criteria: str) -> str:
#       """Search Zoho CRM. module: Leads/Contacts/Deals. criteria: 'Field:equals:Value'"""
#       result = await asyncio.to_thread(
#           subprocess.run,
#           ["python", str(AGENT_DIR / "skills/crm-ops/scripts/zoho_crm.py"),
#            "search", "--module", module, "--criteria", criteria],
#           capture_output=True, text=True, cwd=str(AGENT_DIR)
#       )
#       return result.stdout or result.stderr
#
# Pattern B — direct import (best for scripts with simple deps already installed):
#
#   async def append_to_sheet(spreadsheet_id: str, range_: str, data: list) -> str:
#       """Append rows to a Google Sheet."""
#       from append_to_sheet import append_rows   # scripts/append_to_sheet.py on sys.path
#       return await asyncio.to_thread(append_rows, spreadsheet_id, range_, data)
#
# Rules:
#   - async def + descriptive docstring (the docstring IS the tool description shown to the LLM)
#   - Return a string — stdout, JSON dump, or a human-readable summary
#   - Raise on failure — do not swallow exceptions; the executor routes failures to Self_Mutation_Node
#   - Credentials arrive via os.environ — the executor injects them from the Integration Registry
#     for every integration declared in config.json["integrations"]. Scripts that call
#     os.getenv("ZOHO_CLIENT_ID") etc. work unchanged.

async def example_tool(action: str, extra_args: list[str] | None = None) -> str:
    """Run the example script. action: one of 'search', 'list', 'summary'.

    Use this tool when the user asks about X. Always prefer it over answering from memory.
    """
    cmd = ["python", str(AGENT_DIR / "skills/my-skill/scripts/main.py"), action]
    cmd += extra_args or []
    result = await asyncio.to_thread(
        subprocess.run, cmd, capture_output=True, text=True, cwd=str(AGENT_DIR)
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[:500] or "Script exited non-zero")
    return result.stdout or "(no output)"


# ── Agent factory ─────────────────────────────────────────────────────────

def build_agents():
    """Return MAF agents for this repo.

    Called by the Dynamic Agent Loader at runtime. Must be synchronous,
    zero-argument, and pure — no I/O at module import time.
    """
    from agent_framework import Agent
    from agent_framework.openai import OpenAIChatCompletionClient

    # LiteLLM proxy — credentials injected by the executor from Integration Registry.
    client = OpenAIChatCompletionClient(
        base_url=os.environ.get("LITELLM_BASE_URL", "http://litellm:4000") + "/v1",
        api_key=os.environ.get("LITELLM_API_KEY", ""),
        model="tier2-sonnet",
    )
    return [Agent(
        name="my-agent",
        instructions=_build_system_prompt(),
        tools=[
            example_tool,
            # Add every skill script here as an async tool function.
            # CommandCenter auto-detects new scripts and adds them on the next pull.
        ],
        model_client=client,
    )]
```

> **Using `GitHubCopilotAgent` instead?** If you need Copilot-specific models, replace the `Agent` block with `GitHubCopilotAgent(name=..., instructions=..., tools=[...])`. CommandCenter automatically sets `on_permission_request = PermissionHandler.approve_all` — you do not need to configure it.

### How MAF maps tools and the system prompt to the LLM

On every `agent.run(message)` call, MAF automatically:

1. Builds tool schemas from each `async def` function: **function name** → tool name, **docstring** → description the LLM reads to decide when to call it, **type hints** → parameter schema.
2. Sends `instructions` (system prompt + all SKILL.md blocks) + all tool schemas in a single API request to LiteLLM.
3. When the LLM returns a tool call, MAF executes the Python function and feeds the result back.

**The docstring is the routing signal.** Write it as: "Use this tool when the user asks about X / wants to do Y." The LLM reads nothing else when choosing which tool to invoke.

### Hard rules

- `build_agents()` is synchronous, zero-argument, pure. No I/O at import time.
- Must return `list[BaseAgent]` containing at least one MAF agent (`Agent` or `GitHubCopilotAgent`).
- **Use `Agent` + `OpenAIChatCompletionClient` for tools-only agents** — no permission gate, any LiteLLM-routed model. Use `GitHubCopilotAgent` only when Copilot-specific models are required.
- **`agents.py` is required. `graph.py` is not supported** — the CommandCenter executor only calls `build_agents()`. LangGraph (`graph.py` / `build_graph()`) has been removed from the stack.
- **`tools=[...]` must not be empty** if the agent is supposed to act. The LLM routes to tools based on their docstrings; an empty list means text-only.
- Tool functions must be `async def`. The **docstring is the routing signal** — the LLM reads it to decide when to call the tool. Make it describe what the tool does AND when to use it.
- Tool functions must return a `str`. Return stdout, a JSON dump, or a human-readable summary.
- On failure in a tool, **raise** — do not swallow. The MAF orchestrator routes to `Self_Mutation_Node`.
- Credentials arrive via `os.environ` — the executor injects them from the Integration Registry for every key in `config.json["integrations"]`. Scripts that call `os.getenv(...)` work unchanged.
- Do not instantiate agents at module level — `build_agents()` is the single entry point.
- **`on_permission_request` is set automatically by CommandCenter** — do not configure it. Applies to `GitHubCopilotAgent` only.
- **`agents.py` is auto-maintained by CommandCenter.** After every `git pull`, new scripts in `skills/*/scripts/` are auto-wired as tools and committed directly to the repo.

---

## 7. Memory pattern — `memories_to_save` via `<mem>` tag

Agents use the **Anthropic stateless memory pattern**:

1. Executor injects prior memories into the system prompt via `state["context"]["memories"]`.
2. The LLM emits durable facts wrapped in `<mem>...</mem>` tags anywhere in its response.
3. `agents.py` extracts those tags from tool output, strips them from the visible reply, and returns them as `memories_to_save` for the MAF orchestrator to persist.
4. The executor persists them; they appear as context in future runs.

```
# Raw LLM output:
"Manu is interested in silicone printing. <mem>Dr Manu Srinivas prefers in-person demos at Fracktal office</mem>"

# After stripping:
result.content  →  "Manu is interested in silicone printing."
memories_to_save → [{"text": "Dr Manu Srinivas prefers in-person demos at Fracktal office", ...}]
```

Rules: ≤ 2 `<mem>` tags per turn · each ≤ 200 chars · `category ∈ {fact, preference, decision, open_question}`.

The `skills/agent-memory/` skill provides a parallel **local** memory store in `outputs/_memory/` (JSON + FTS5 SQLite) for cross-campaign search within this agent.

---

## 8. Integrations — credential flow

**CommandCenter mode:** credentials are injected by the Dynamic Agent Loader from the Integration Registry into the MCP server process environment (via `mcp_servers=` config in `GitHubCopilotAgent`). Skill scripts read `os.getenv(...)` as normal.

**Local / VS Code mode:** credentials come from `.env` (loaded by `python-dotenv`).

Skill scripts always read `os.getenv(...)` — works in both modes unchanged.

Integration name → `.env` variable mapping for `agent-sales-assistant`:

| Integration key | `.env` variable(s) |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `apollo` | `APOLLO_API_KEY` |
| `serpapi` | `SERPAPI_API_KEY` |
| `apify` | `APIFY_API_TOKEN` |
| `anymailfinder` | `ANYMAILFINDER_API_KEY` |
| `instantly` | `INSTANTLY_API_KEY` |
| `zoho-crm` | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` |
| `google-sheets` | `GOOGLE_SHEETS_CREDENTIALS_FILE` |

---

## 9. Chat-mode contract (Control Plane chat surface)

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

## 10. Dual-mode operation

Both modes share the same source of truth: `prompts/system.md` + `skills/*/SKILL.md`.

| | VS Code Copilot Chat | CommandCenter |
|---|---|---|
| Entry point | `.github/agents/<name>.agent.md` | `agents.py` + `config.json` |
| System prompt | Agent reads files directly via tools | `agents.py` `_build_system_prompt()` |
| Credentials | `.env` / `python-dotenv` | MCP server env injection via `mcp_servers=` config |
| Scripts | Run via VS Code terminal tools | Run as subprocess or imported via `sys.path` |
| Outputs | `outputs/{slug}/` (local disk) | `outputs/{slug}/` (persistent clone on executor) |
| Memory | `outputs/_memory/` (local JSON/FTS5) | `memories_to_save` list returned from tool → DTS orchestration context |

**Rule:** Adding `agents.py` and `config.json` does not touch any existing file. VS Code Copilot Chat continues to work exactly as before.

---

## 11. `AGENTS.md` — pointer file for AI coding agents

Template:

```markdown
# Agent Instructions — My Agent

> You are a [brief persona description].

## Architecture (3-layer DOE v2)

**Layer 1: Skills (`skills/*/SKILL.md`)** — instructions for each capability domain.
**Layer 2: Orchestration (YOU)** — read skills, call scripts in the right order, handle errors.
**Layer 3: Execution (`skills/*/scripts/`, `scripts/`)** — Python scripts that do the work.

## Skills

| Skill | SKILL.md | Purpose |
|---|---|---|
| my-skill | `skills/my-skill/SKILL.md` | Does X |

## Shared Scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `campaign_data_manager.py` | Load/save step JSON files |
| `self_anneal_diagnostics.py` | Health checks + learnings log |

## File Organisation

- `outputs/{slug}/` — per-campaign step JSONs
- `data/` — product catalogs, templates (see `data/INDEX.md`)
- `.env` — API keys (local only, never commit)
```

---

## 12. `outputs/` — persistent campaign data

```
outputs/
├── _memory/
│   ├── agent_long_term_memory.json
│   ├── agent_memory_index.json
│   └── learnings_log.json
└── {campaign-slug}/
    ├── step_1_product_analysis.json
    ├── step_2_competitive_analysis.json
    ├── step_3_industry_targeting.json
    ├── step_4_company_prospects.json
    ├── step_5_decision_makers.json
    ├── step_6_outreach_sequences.json
    ├── step_7_campaign_tracker.json
    └── campaign_config.json
```

---

## 13. Self-annealing pattern

Every agent built on this framework implements the self-annealing loop via `skills/self-annealing/SKILL.md`:

```
DETECT → DIAGNOSE → FIX → TEST → RECORD → UPDATE → STRONGER
```

Mandatory health checks (via `python scripts/self_anneal_diagnostics.py`):

| When | Check |
|---|---|
| Before any campaign | `--check api_health` |
| Before Step 4 | `--check web_scraping` |
| After each step | `--check step_validation --step N` |
| After Steps 4-5-6 | `--check data_quality` |
| Before user review | `--check all` |

---

## 14. `tests/` — minimum viable test

```python
# tests/test_agents.py

def test_build_agents_importable():
    from agents import build_agents
    agents = build_agents()
    assert isinstance(agents, list)
    assert len(agents) >= 1

def test_agent_has_name_and_instructions():
    from agents import build_agents
    agent = build_agents()[0]
    assert hasattr(agent, "name") and agent.name
    # instructions may be exposed as .instructions or ._instructions depending on MAF version
    assert hasattr(agent, "instructions") or hasattr(agent, "_instructions")
```

---

## 15. Anti-patterns

- `os.environ["..."]` reads for secrets inside `agents.py` tools (use MCP server env injection instead).
- `requests.get(...)` or any I/O at module import time.
- `build_agents()` that takes arguments or performs I/O.
- Instantiating `GitHubCopilotAgent` outside of `build_agents()` (the function is the factory).
- `max_mutation_attempts > 1` or missing.
- Mutable module-level state used to cache results across runs (use DTS orchestration context).
- Agent persona duplicated in both `prompts/system.md` AND `AGENTS.md` — one source of truth.
- Skill instructions in `prompts/system.md` — put them in `skills/<name>/SKILL.md`; `agents.py` appends them automatically.
- Catching `Exception` and returning `{"error": ...}` instead of raising.
- **`tools=[]` empty or omitted** — the agent will apologise instead of acting. Every script in `skills/*/scripts/` that the agent should use must be wired as an `async def` tool function.

---

## 16. Building a new agent — checklist

1. Copy this repo as a template. Rename to `agent-<name>`.
2. Edit `config.json` — update `name`, `description`, `integrations`, `tags`.
3. Edit `prompts/system.md` — agent identity, pipeline overview, communication rules.
4. Edit `AGENTS.md` — persona summary + skill/script map for AI coding agents.
5. Create `skills/<name>/` for each capability:
   - `SKILL.md` with frontmatter + body
   - `scripts/` with Python scripts for that skill
6. Edit `agents.py` — wire the initial tools using the subprocess pattern from §6. New scripts added later are detected and wired automatically by CommandCenter on the next run — you do not need to manually update `agents.py` for each new skill script.
7. Edit `pyproject.toml` — update `name` and `dependencies`.
8. Add `tests/test_agents.py` with the `build_agents()` import test.
9. Smoke test: `python -c "from agents import build_agents; print(build_agents())"`.
10. Register in CommandCenter: go to **http://localhost:3001/agents** → **Add Agent** → paste the GitHub repo URL. The Control Plane auto-fetches `config.json` and registers the agent. It appears in the chat picker immediately. Do **not** add the agent to `_KNOWN_AGENTS` in `apps/gateway/gateway/routes/agent.py` — that list is for built-in agents shipped with CommandCenter Core only.

---

## 17. This agent (`agent-sales-assistant`) — quick reference

**9 skills:**

| Skill | SKILL.md | Description |
|---|---|---|
| `prospect-pipeline` | `skills/prospect-pipeline/SKILL.md` | 7-step outbound pipeline |
| `research` | `skills/research/SKILL.md` | Web + academic + document research |
| `proposal` | `skills/proposal/SKILL.md` | Proposal authoring and rendering |
| `crm-ops` | `skills/crm-ops/SKILL.md` | Zoho CRM + Instantly integration |
| `lead-scraping` | `skills/lead-scraping/SKILL.md` | Google Maps, SERP, Apify lead discovery |
| `gem-competition` | `skills/gem-competition/SKILL.md` | GeM tender strategy for Indian OEM/MSME |
| `agent-memory` | `skills/agent-memory/SKILL.md` | Two-tier memory (JSON + FTS5) |
| `sales-methodology` | `skills/sales-methodology/SKILL.md` | Tracy, Blount, Cardone, Ross, Weinberg, Rackham |
| `self-annealing` | `skills/self-annealing/SKILL.md` | Error recovery + continuous improvement |

**Integrations:** `anthropic`, `apollo`, `serpapi`, `apify`, `anymailfinder`, `instantly`, `zoho-crm`, `google-sheets`

**Migration status:** The repo now has `agents.py`. If the agent still doesn’t behave correctly (e.g. `tools=[]` still empty), CommandCenter will automatically open a self-repair PR — see §19.

**Dual-mode:** VS Code Copilot Chat (`.github/agents/agent-sales-assistant.agent.md`) + CommandCenter (`agents.py` / `config.json`) — both read the same `prompts/system.md` + `skills/*/SKILL.md` source of truth. Adding `agents.py` does not touch any existing file; VS Code Copilot Chat continues to work as-is.

---

## 18. Versioning

Breaking changes get a version bump in `config.json` and an entry in `CHANGELOG.md`.
For CommandCenter Core questions, open an issue on `CommandCenter-Core` with label `agent-spec`.

---

## 19. Automatic self-repair and skill sync

CommandCenter maintains agent repos automatically — no PR workflow, no manual intervention.

### Proactive skill sync (runs on every git pull)

Before each run, CommandCenter:
1. Pulls the latest code (`git pull --ff-only`)
2. Scans `skills/*/scripts/*.py` for scripts whose stem doesn’t appear in `agents.py`
3. For each new script, injects an `async def` subprocess wrapper and adds it to `tools=[...]`
4. Commits and pushes directly to the current branch

**Result:** Add a new skill script file to the repo — on the next run, CommandCenter auto-wires it as a callable tool. No manual `agents.py` edit needed.

### Incompatibility repair (runs on AgentLoadError)

| Incompatibility | What CommandCenter does |
|---|---|
| No `agents.py` in repo | Spawns Copilot SDK sandbox to generate a compliant `agents.py` |
| `agents.py` exists but fails to import | Sandbox fixes the import error |
| Any `AgentLoadError` on first or subsequent runs | Sandbox generates a fix and commits directly |

```
CommandCenter attempts to load agent repo
            │
            ▼
    AgentLoadError (incompatibility)
            │
            ▼
    Copilot SDK mutation container spawned
      • Receives the full error + this compatibility guide
      • Inspects the cloned repo (already authenticated)
      • Generates compliant agents.py with tools=[...] from existing scripts
      • Runs smoke test: python -c "from agents import build_agents; assert build_agents()"
      • Runs pytest if tests/ exists
      • git commit + git push origin HEAD  (direct commit, no PR)
            │
            ▼
    Next run: CommandCenter pulls the fix, agent runs successfully
```

### What the sandbox generates

The Copilot SDK agent receives:
1. The exact `AgentLoadError` message
2. The full contents of this `agent_repo_compatibility.md` guide
3. The cloned repo with all existing scripts visible

It generates `agents.py` with:
- `_build_system_prompt()` reading `prompts/system.md` + all `skills/*/SKILL.md`
- An `async def` tool wrapper for every script in `skills/*/scripts/`
- All wrappers registered in `tools=[...]`
- `graph.py` and all other files left untouched

### Safety and rollback

- **One fix per failure event** (`max_mutation_attempts = 1`) — never loops
- **Direct commit** — no PR, no review gate. The fix is live on the next run.
- **To revert:** `git log` to find the commit hash, then `git revert <hash>` and push. CommandCenter will pull the revert on the next run.
- Proactive sync commits are atomic single-file commits (`agents.py` only) and are trivially revertable.

### After any auto-commit

No restart needed. On the next chat message or webhook event, CommandCenter pulls the latest commit, loads the updated `agents.py`, and the agent runs with all tools active.
