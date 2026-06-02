# Command Center

> Fracktal Works · a self-hosted, browser-accessible **multi-agent platform** (codename **Command Center**). Built top-down in four levels: a cloud IDE with copilots → a multi-agent workspace → an automation/workflow engine → a company-intelligence co-pilot over ClickUp, Zoho, and Odoo. **Jannet** is one of the built-in AI agents that runs inside Command Center.

**Start here:** [`ai-company-brain/project_plan.md`](ai-company-brain/project_plan.md) (the v1.0 platform plan) and [`ai-company-brain/product_requirements.md`](ai-company-brain/product_requirements.md) (the PRD).

## The four levels

```
Level 4 — Company Intelligence   Agentic layer over ClickUp/Zoho/Odoo + org memory; the "company co-pilot"
Level 3 — Automation & Workflows Agent-native workflow engine; webhook/schedule triggers; HITL over email/WhatsApp
Level 2 — Multi-Agent Workspace  Many named agents, switchable; create agents+skills; shared skills; long-term memory
Level 1 — Cloud IDE + Copilot    Browser IDE (forked Theia) + copilot UX + config plane (keys/MCP/OAuth/models) + sessions
```

Each level is independently valuable and shippable. **L1 is the first milestone.** Detailed scope per level is in the PRD; build sequence in the project plan.

## Key platform decisions

| # | Decision |
|---|---|
| PD-01 | **IDE shell = forked Eclipse Theia** (extensions-first; patch core only when forced). Not a VS Code fork — same Open VSX access, none of the rebase tax. |
| PD-02 | **OpenHands** = sandboxed code exec/deploy backend, not the shell. |
| PD-03 | **No n8n.** Our own **agent-native workflow engine**. |
| PD-04 | **Workflows = Git-versioned specs**, visualised on **React Flow (`@xyflow`)** inside Theia. |
| PD-05 | **Integrations via MCP servers + skills** first. |
| PD-06 | **Reuse** `acb_llm`/LiteLLM, `acb_*` packages, `skills/` + `SKILL.md`, `evals/`. |

See [`project_plan.md`](ai-company-brain/project_plan.md) §2 for the full decision table.

## Repo layout

The active platform (L1–L2) lives at the repo root. The Level-4 company-intelligence
subtree is self-contained under [`level4/`](level4) and comes online when L4 work begins.

```
ide/                     # Theia platform shell + custom extensions (scaffolding)
  extensions/            #   Command Center Theia extensions (branding, config plane, agent UX)
  README.md              #   How the fork is structured + built
ai-company-brain/        # Planning docs. project_plan.md + product_requirements.md = CURRENT.
                         #   system_architecture.md / wbs.md / research_summary.md / risk_register.md
                         #   / gantt_chart.md / references.md = Level-4 reference.
packages/                # Active shared Python libs (uv workspace members)
  acb_common/            #   Settings, logging, OTel bootstrap
  acb_llm/               #   LiteLLM client + tiered routing  (L1 model-selection backend)
  acb_schemas/           #   Pydantic models
  acb_audit/             #   Append-only audit log
  acb_skills/            #   SKILL.md loader
  acb_auth/              #   RBAC / user context
skills/                  # Anthropic SKILL.md registry (examples + upstream sync)
deploy/openhands/        # OpenHands self-host (L1 execution backend) — reused
evals/                   # Promptfoo + Inspect AI eval harness — reused
workbench/control_plane/ # Next.js app — candidate for the L1 config/admin plane (TBD)
infra/                   # docker-compose, Postgres init SQL, LiteLLM config, Langfuse compose
scripts/                 # Platform ops scripts (bootstrap, infra check)
tests/                   # Platform tests
level4/                  # Shelved company-brain subtree — reused at Level 4
  apps/                  #   gateway, orchestrator, ingestion, reconciler, action_broker, escalation_ui
  packages/acb_graph/    #   Graph access + entity resolver
  skills/                #   Company skills (sales, delivery, reconciler, triage)
  scripts/               #   Zoho/ClickUp sync, reconciler, demo seed
  tests/                 #   Company-brain unit + integration tests
  workflows/             #   Legacy n8n exports (superseded by PD-03)
```

> **Level 4** is kept intact under `level4/` as a uv-workspace member, so it still
> builds and tests in the same `.venv`. It is reference/reuse material until L4 begins.

## Prerequisites

- **Node 20+** and **Yarn 1.x** (for `ide/` — the Theia shell)
- **Python 3.12+** and [uv](https://docs.astral.sh/uv/) ≥ 0.4 (for `packages/` and `apps/`)
- **Docker + Docker Compose** (infra stack, OpenHands execution backend)

## First-run

### L1 — Theia IDE shell (`ide/`)

```powershell
cd ide
# scaffolding in progress — see ide/README.md for the current bring-up steps
```

### Python workspace (`packages/`, `level4/`)

```powershell
uv sync                              # install the workspace into one .venv
Copy-Item .env.example .env          # then fill in values
docker compose -f infra/docker-compose.yml up -d   # Postgres, Redis, LiteLLM, Langfuse
```

## Common Python commands

| Task | Command |
|---|---|
| Lint | `uv run ruff check .` |
| Format | `uv run ruff format .` |
| Type-check | `uv run mypy packages level4` |
| Tests | `uv run pytest` |
| Add dep to a package | `uv add --package <name> <dep>` |
| Upgrade lockfile | `uv lock --upgrade` |

See [`Makefile`](Makefile) for the same targets in shell form.

## Conventions

- **Git is the source of truth** for agent definitions, skills, and workflow specs; promotion via PR + eval gate.
- **One execution model:** agents + skills (`SKILL.md`) orchestrated by our engine — including workflows. No second runtime (no n8n).
- **Every LLM call** goes through `acb_llm` → LiteLLM. No direct provider SDK calls in app code.
- **Theia customisation = extensions** in [`ide/extensions/`](ide/extensions); core patches are a tracked, minimised metric.
- **Skills** follow the Anthropic `SKILL.md` format; examples in [`skills/examples`](skills/examples).
- *(Level 4)* Source of truth = ClickUp/Zoho/Odoo; never write back without going through `action_broker` (approval-gated).

## Status

Platform reframe complete (planning docs at v1.0). **L1 Theia fork scaffolding in progress** — see [`ide/README.md`](ide/README.md).
