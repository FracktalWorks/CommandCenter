# AI Company Brain

> Fracktal Works · internal multi-agent operating layer over ClickUp, Zoho CRM, Odoo ERP, Gmail, WhatsApp, and meetings. Read-mostly mirror, approval-gated writes, self-improving via Hermes-style annealing.

Planning artefacts live in [`ai-company-brain/`](ai-company-brain/) — start with [`project_plan.md`](ai-company-brain/project_plan.md), [`system_architecture.md`](ai-company-brain/system_architecture.md), [`wbs.md`](ai-company-brain/wbs.md).

## Repo layout

```
ai-company-brain/        # Planning docs (project plan, architecture, WBS, risks, refs)
apps/                    # Deployable services (each container = one app)
  gateway/               # FastAPI + Google SSO — pull queries, push, approvals (WBS 0.6)
  orchestrator/          # LangGraph + Deep Agents harness, tiered router (WBS 0.5, 0.7)
  ingestion/             # ClickUp / Zoho / Gmail / WhatsApp / meeting workers (WBS 0.3, 1.x, 2.x)
  reconciler/            # Nightly diff + escalation queue (WBS 0.4)
  action_broker/         # Approval queue + audit + source-of-truth writes (WBS 3.1)
packages/                # Shared Python libs (uv workspace members)
  acb_common/            # Settings, logging, OTel bootstrap
  acb_schemas/           # Pydantic models for the entity graph
  acb_graph/             # Postgres + pgvector + Apache AGE access layer
  acb_llm/               # LiteLLM client + tiered routing helper + Langfuse hooks
  acb_audit/             # Append-only audit log (input for the Annealer)
infra/                   # docker-compose, Postgres init SQL, LiteLLM config, Langfuse compose
skills/                  # Anthropic SKILL.md registry (will move to ai-company-brain-skills repo at Phase 0.5)
workbench/               # Next.js Control Plane (Phase 0.5 placeholder)
scripts/                 # One-off ops / migration scripts
tests/                   # Cross-cutting integration tests
.vscode/                 # Workspace settings + recommended extensions
```

## Prerequisites

- Python 3.12+ (3.13 OK)
- [uv](https://docs.astral.sh/uv/) ≥ 0.4
- Docker + Docker Compose (for the infra stack — Postgres, Redis, Langfuse, LiteLLM)
- Node 20+ (only when working on `workbench/`, Phase 0.5+)

## First-run (developer)

```powershell
# 1. Install the entire workspace into a single .venv
uv sync

# 2. Copy env template
Copy-Item .env.example .env   # then fill in values

# 3. Boot infra (Postgres+pgvector+AGE, Redis, LiteLLM, Langfuse)
docker compose -f infra/docker-compose.yml up -d

# 4. Run the gateway (Phase 0 entry point)
uv run uvicorn gateway.main:app --reload --host 0.0.0.0 --port 8080
```

Then `GET http://localhost:8080/health` should return `{"status":"ok"}`.

## Phase-0 acceptance (from `wbs.md`)

> Executive can ask "where are we on Project X?" and get a cited answer. Reconciler flags drift between graph and ClickUp; zero silent divergence over 7 days. All LLM calls routed through the tier router; cost dashboard live.

## Common commands

| Task | Command |
|---|---|
| Lint | `uv run ruff check .` |
| Format | `uv run ruff format .` |
| Type-check | `uv run mypy apps packages` |
| Tests | `uv run pytest` |
| Add dep to a package | `uv add --package <name> <dep>` |
| Upgrade lockfile | `uv lock --upgrade` |

See [`Makefile`](Makefile) for the same targets in shell form.

## Conventions

- **Source of truth = ClickUp/Zoho/Odoo.** Never write back without going through `action_broker` (approval-gated).
- **Every LLM call** goes through `acb_llm` → LiteLLM proxy → tiered router. No direct provider SDK calls in app code.
- **Every agent output** must cite graph node IDs; `acb_llm.guardrails` enforces this.
- **Git is the source of truth** for prompts, skills, LangGraph workflow definitions, LiteLLM config (ADR-015).
- **Skills** follow the Anthropic `SKILL.md` format (ADR-013); examples in [`skills/examples`](skills/examples).

## Status

Phase 0 scaffolding (this commit). See [`ai-company-brain/wbs.md`](ai-company-brain/wbs.md) for the live WBS.
