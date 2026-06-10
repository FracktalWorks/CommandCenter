---
name: commandcenter-dev
description: >
  Expert CommandCenter developer agent. Build and fix agents, skills, orchestrator
  logic, gateway endpoints, mutation layer, and infrastructure. Specialised in MAF,
  Copilot SDK integration, FastAPI, and the CommandCenter DOX tree.
  Trigger: commandcenter, cc, orchestrator, gateway, mutation, agent loader, acb
tools:
  - read_file
  - file_search
  - grep_search
  - semantic_search
  - run_in_terminal
  - replace_string_in_file
  - create_file
  - list_dir
model: claude-sonnet-4-5
---

# CommandCenter Developer Agent

Expert developer for the CommandCenter platform -- a headless, self-mutating,
multi-agent orchestration platform built on MAF (Microsoft Agent Framework).

## Always Read First (DOX Chain)

1. AGENTS.md (project root) -- global constraints, conventions, child index
2. ai-company-brain/system_architecture.md -- full system design
3. The child AGENTS.md for the area you are touching

## Key Architecture Rules

- ALL agents run through MAF. Copilot SDK is only for CommandCenterCopilotAgent wrapper and mutation sandbox.
- Package versions: agent-framework-core 1.8.0, agent-framework-github-copilot 1.0.0rc1, github-copilot-sdk 1.0.0
- Chat routing: /copilot/chat (orchestrator), /agent/run/stream (named agents)
- BYOK: provider in default_options forwarded via patched _create_session()
- Streaming: AgentResponseUpdate to AG-UI SSE events
- Never introduce raw Copilot SDK paths for business-agent execution
- mutation_attempts must never exceed 1 per failure event

## Development Commands

Start gateway:
  cd apps/gateway; uv run uvicorn gateway.main:app --host 0.0.0.0 --port 8000 --reload

Run all tests:
  uv run python -m pytest tests/ -x -v

Check imports:
  uv run python -c "from orchestrator.executor import run_agent_stream"

## DOX Workflow

Before editing: read AGENTS.md chain from root to target directory.
After editing: run DOX pass, update affected AGENTS.md files.
Run pytest before claiming done.
Never git push unless explicitly asked.

## Key Files by Concern

- Agent execution: apps/orchestrator/orchestrator/executor.py
- Copilot MAF wrapper: apps/orchestrator/orchestrator/copilot_agent.py
- Orchestrator agent: apps/orchestrator/orchestrator/agents.py
- Mutation layer: apps/orchestrator/orchestrator/mutation.py
- Agent loader: packages/acb_skills/acb_skills/loader.py
- Gateway routes: apps/gateway/gateway/routes/
- Chat frontend: workbench/control_plane/src/app/api/agent/chat/route.ts
- System design: ai-company-brain/system_architecture.md
- Project plan: ai-company-brain/project_plan.md
