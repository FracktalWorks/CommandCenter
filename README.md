# CommandCenter v2

> **Fracktal Works** — a distributed, self-mutating agent platform. Every specialist agent lives in its own GitHub repository. Every skill is a pip-installable Python package in its own repo. The Core engine dynamically clones agent and skill repos at runtime, executes tasks in ephemeral OpenHands sandboxes, and — when errors occur — opens a GitHub PR against the failing agent's own repo so humans can review and merge the fix.

---

## What is CommandCenter?

CommandCenter is the operating system for Fracktal Works. It coordinates a fleet of specialist AI agents (sales, triage, delivery, billing, reconciler, strategy) over company data in ClickUp, Zoho CRM, Odoo ERP, Gmail, WhatsApp, and meetings — with full human-in-the-loop approval for all writes.

**Architecture in one sentence:** A FastAPI Core server listens for events, dynamically clones the target `agent-<name>` repository and its declared `skill-<name>` dependencies, imports the agent's `graph.py` at runtime via `importlib`, and runs a LangGraph `StateGraph` inside short-lived OpenHands sandboxes.

**Self-mutation:** when a skill or agent fails, a `Self_Mutation_Node` in the LangGraph clones the failing agent's own repo, reads the error telemetry, proposes a code fix, runs tests, and opens a GitHub PR. `max_mutation_attempts = 1` per failure event. A human must merge the PR before the live system adopts the change.

**No in-app editor:** agents and skills are developed in VS Code (locally or via GitHub Codespaces), committed to their respective repos, and merged through the standard PR flow. The Control Plane is for chat, HITL approvals, and observability — not editing.

---

## Distributed Repo Layout

```
FracktalWorks/CommandCenter-Core        ← This repo: Core engine + infra
FracktalWorks/agent-task-manager        ← Agent: ClickUp task management
FracktalWorks/agent-sales               ← Agent: Zoho CRM sales workflows
FracktalWorks/agent-delivery            ← Agent: project delivery + push
FracktalWorks/agent-triage              ← Agent: email/WhatsApp/meeting triage
FracktalWorks/agent-reconciler          ← Agent: nightly source-of-truth diff
FracktalWorks/agent-strategy            ← Agent: weekly digest + planning
FracktalWorks/skill-clickup-sync        ← Skill: ClickUp read/write via MCP
FracktalWorks/skill-zoho-ingest         ← Skill: Zoho CRM webhooks + REST
FracktalWorks/skill-gmail-capture       ← Skill: Gmail Pub/Sub ingest
FracktalWorks/skill-whatsapp-send       ← Skill: WhatsApp Meta Cloud API
FracktalWorks/skill-meeting-transcribe  ← Skill: Vexa + WhisperX + Pyannote
FracktalWorks/skill-graph-write         ← Skill: entity graph upsert
FracktalWorks/skill-action-broker       ← Skill: approval queue + audit writes
```

Each **agent repo** contains: `config.json` (model tier, budget, triggers, required skills), `graph.py` (LangGraph StateGraph), `instructions.md` (persona), `tests/`, `evals/`.

Each **skill repo** is a Python package — pip-installable, single well-typed entry function, `tests/`, `evals/`.

---

## Architecture overview

```
[ Webhook / Cron Event ]
         │
         ▼
┌─────────────────────────────────────────────────┐
│  1. Core Engine: FastAPI (CommandCenter-Core)   │
│  • Listens for events                           │
│  • Clones agent-<name> + skill repos from GitHub│
│  • Imports graph.py via importlib at runtime    │
└────────────────────────┬────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────┐
│  2. Orchestration: LangGraph + PostgresSaver    │
│  • Runs agent's StateGraph workflow             │
│  • Persists state + error telemetry to Postgres │
│  • Routes to Self_Mutation_Node on failure      │
└────────────────────────┬────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────┐
│  3. Runtime: OpenHands SDK (ephemeral sandboxes)│
│  • Worker containers execute agent skills       │
│  • Dev sandbox: agent fixes own code → opens PR│
│  • All containers destroyed after each run      │
└─────────────────────────────────────────────────┘
```

**Key principles:**
- **Source of truth = ClickUp/Zoho/Odoo.** The Core is a read-mostly mirror; writes are approval-gated.
- **Decoupled repositories.** Each agent and skill is an independent GitHub repo, versioned and tested independently.
- **Dynamic loading.** Core never needs a redeploy to adopt new agent logic — repos are cloned at event time.
- **Self-mutation with a human gate.** Agents propose their own bug fixes via PRs; `max_mutation_attempts = 1`; humans must merge.
- **Git is the source of truth** for all agent-editable artefacts (`graph.py`, `instructions.md`, skill packages, model-routing config). All changes are PRs with an eval gate.

---

## This repo layout (CommandCenter-Core)

```
ai-company-brain/        # Planning docs — start here
  product_requirements.md
  project_plan.md
  system_architecture.md
  wbs.md                 # Live work-breakdown with PERT estimates
  risk_register.md
  research_summary.md

apps/                    # Deployable services (one container each)
  gateway/               # FastAPI + Google SSO — event routing, pull queries, approvals
  orchestrator/          # LangGraph executor, Dynamic Agent Loader (importlib), PostgresSaver
  ingestion/             # ClickUp / Zoho / Gmail / WhatsApp / meeting ingest workers
  reconciler/            # Nightly diff + escalation queue
  action_broker/         # Approval queue + audit + source-of-truth write executor
  escalation_ui/         # Lightweight escalation surface

packages/                # Shared Python libs (uv workspace members)
  acb_common/            # Settings, logging, OTel bootstrap
  acb_schemas/           # Pydantic models for the entity graph
  acb_graph/             # Postgres + pgvector access layer
  acb_llm/               # LiteLLM client + tiered routing + Langfuse hooks + guardrails
  acb_audit/             # Append-only audit log
  acb_skills/            # Skill repo cloning + dynamic import helpers
  acb_auth/              # Auth helpers (Google SSO)

infra/                   # docker-compose, Postgres init SQL, LiteLLM config, Langfuse
workbench/               # Next.js Control Plane (chat, observability, HITL approvals)
  control_plane/         # Next.js 16 + CopilotKit + AG-UI (port 3001)
ide/                     # Forked Eclipse Theia (L1 IDE shell)
evals/                   # Promptfoo + Inspect AI evaluation harness
deploy/                  # Hostinger VPS + Caddy deploy scripts
scripts/                 # One-off ops / migration helpers
tests/                   # Cross-cutting integration + unit tests
```

---

## Running locally
  escalation_ui/         # Lightweight escalation surface

packages/                # Shared Python libs (uv workspace members)
  acb_common/            # Settings, logging, OTel bootstrap
  acb_schemas/           # Pydantic models for the entity graph
  acb_graph/             # Postgres + pgvector access layer
  acb_llm/               # LiteLLM client + tiered routing + Langfuse hooks + guardrails
  acb_audit/             # Append-only audit log (input for the Annealer)
  acb_skills/            # Skills runtime loader
  acb_auth/              # Auth helpers (Google SSO)

infra/                   # docker-compose, Postgres init SQL, LiteLLM config, Langfuse
skills/                  # Anthropic SKILL.md registry
workbench/               # Next.js Control Plane (Phase 0.5+)
  control_plane/         # Next.js 16 + CopilotKit + AG-UI (port 3001)
ide/                     # Forked Eclipse Theia (L1 IDE shell)
evals/                   # Promptfoo + Inspect AI evaluation harness
deploy/                  # Hostinger VPS + Caddy deploy scripts
scripts/                 # One-off ops / migration helpers
tests/                   # Cross-cutting integration + unit tests
```

---

## Running locally

### Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Python | 3.12+ | Backend services |
| [uv](https://docs.astral.sh/uv/) | ≥ 0.4 | Python workspace manager |
| Docker + Docker Compose | latest | Infra stack |
| Node.js | 20+ | Control plane (`workbench/`) |

### 1. Install Python workspace

```powershell
uv sync
```

### 2. Configure environment

```powershell
Copy-Item .env.example .env
# Edit .env — fill in LiteLLM keys, Langfuse secrets, etc.
```

### 3. Start the infra stack

```powershell
# Core (Postgres, Redis, LiteLLM)
docker compose -f infra/docker-compose.yml --profile core up -d

# Add Langfuse observability
docker compose -f infra/docker-compose.yml --profile core --profile obs up -d
```

Services once running:

| Service | URL |
|---|---|
| Postgres (pgvector) | `localhost:5432` |
| Redis | `localhost:6379` |
| LiteLLM proxy | `http://localhost:4000` |
| Langfuse | `http://localhost:3000` |

### 4. Start the gateway

```powershell
uv run uvicorn gateway.main:app --reload --host 0.0.0.0 --port 8000 --app-dir apps/gateway
```

`GET http://localhost:8000/health` → `{"status":"ok","env":"dev"}`

### 5. Start the Control Plane

```powershell
Set-Location workbench/control_plane
npm run dev          # http://localhost:3001
```

Control Plane panes:

| Pane | Path | Description |
|---|---|---|
| Chat / Agent Inbox | `/` | CopilotKit + AG-UI + LangGraph Agent Inbox; HITL queue |
| Observability | `/observability` | Langfuse traces, audit log, spend, mutation PR history |
| Workflows | `/workflows` | LangGraph workflow view (coming L3) |

---

## Common commands

| Task | Command |
|---|---|
| Lint | `uv run ruff check .` |
| Format | `uv run ruff format .` |
| Type-check | `uv run mypy apps packages` |
| Tests | `uv run pytest` |
| Coverage | `uv run pytest --cov=apps --cov=packages` |
| Add dep to a package | `uv add --package <name> <dep>` |
| Upgrade lockfile | `uv lock --upgrade` |
| Infra logs | `docker compose -f infra/docker-compose.yml logs -f --tail=100` |

See [`Makefile`](Makefile) for convenience targets.

---

## Tech stack

| Layer | Technology |
|---|---|
| IDE shell | Eclipse Theia (forked, browser target) |
| Control plane | Next.js 16, React 19, Tailwind v4, CopilotKit, AG-UI |
| Orchestration | LangGraph + PostgresSaver (durable state) |
| Dynamic loading | Python `importlib` + `sys.path.append()` (per-run agent clone) |
| Sandboxes | OpenHands SDK (Apache-2.0) — worker + dev mutation containers |
| LLM routing | LiteLLM proxy + vLLM (Qwen3-8B Tier-1) + Anthropic/OpenAI |
| Observability | Langfuse (self-hosted), OpenTelemetry |
| Database | Postgres 16 + pgvector + Apache AGE |
| Cache / queue | Redis Stack |
| Evals | Promptfoo + Inspect AI |
| Deploy | Docker Compose, Caddy reverse proxy, Hostinger KVM 4 VPS |

---

## Agent + Skill Development

**Authoring environment:** VS Code (locally or GitHub Codespaces). No in-app editor.

1. Create a new repo from the agent or skill template.
2. Edit `graph.py` / `instructions.md` / skill `impl.py` in VS Code.
3. Add evals in `evals/` (Promptfoo golden cases + Inspect AI scenarios).
4. Open a PR — CI runs `pytest` + evals; merge when green.
5. Core picks up the new version on the next event (no redeploy needed).

**Self-mutation:** if the live system encounters an error, the `Self_Mutation_Node` opens a PR on the failing agent's own repo automatically. You review the diff and merge. Core picks it up on the next run.

---

## Planning docs

All planning artefacts live in [`ai-company-brain/`](ai-company-brain/):

| Doc | Purpose |
|---|---|
| [`product_requirements.md`](ai-company-brain/product_requirements.md) | Full PRD — L1 through L4 requirements |
| [`project_plan.md`](ai-company-brain/project_plan.md) | Phased delivery plan + ADR log |
| [`system_architecture.md`](ai-company-brain/system_architecture.md) | C4 diagrams, data model, ADRs |
| [`wbs.md`](ai-company-brain/wbs.md) | Live WBS with PERT estimates |
| [`risk_register.md`](ai-company-brain/risk_register.md) | Risk register |
| [`research_summary.md`](ai-company-brain/research_summary.md) | Technology research + decisions |
