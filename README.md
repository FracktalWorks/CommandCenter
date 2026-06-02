# CommandCenter

> **Fracktal Works** — a self-hosted, browser-accessible agent platform for running and augmenting a company. Delivered in four levels: Cloud IDE + Copilot → Multi-Agent Workspace → Automation & Workflows → Company Intelligence layer over ClickUp, Zoho CRM, Odoo ERP, Gmail, WhatsApp, and meetings.

---

## What is CommandCenter?

CommandCenter is the operating system for Fracktal Works. It begins as a cloud IDE that feels like VS Code with AI copilots and grows into a full multi-agent workspace — where you can create specialist agents, wire them together into workflows, and put an agentic intelligence layer over all company data.

**Vision:** a system where you talk to specialist agents, wire agents together, run workflows autonomously, and get a co-pilot for organising projects, understanding who's doing what, delegating by role and hierarchy, following up on deadlines, escalating, and acting as a sales/BI assistant for running the company.

### Four levels of capability

| Level | Name | What it delivers |
|---|---|---|
| **L1** | Cloud IDE + Copilot | Browser IDE (forked Eclipse Theia), AI copilot, code exec/deploy via OpenHands, config plane for keys/MCP/models |
| **L2** | Multi-Agent Workspace | Agent registry + switcher, skill authoring, long-term memory, self-healing, agent-to-agent handoff |
| **L3** | Automation & Workflows | LangGraph workflow engine, React Flow visual canvas, webhook/cron triggers, human-in-the-loop over email/WhatsApp |
| **L4** | Company Intelligence | Entity graph over ClickUp/Zoho/Odoo, cited Q&A, smart delegation, follow-up & escalation, approval-gated writes |

**Current status:** L1 IDE shell complete; L4 scaffolding (Phase 0) in progress. See [`ai-company-brain/wbs.md`](ai-company-brain/wbs.md) for the live WBS.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│                  CommandCenter (browser)                 │
│  Theia IDE shell  +  Control Plane (Next.js :3001)      │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ Skill      │  │ Chat / Agent │  │  Observability  │ │
│  │ Studio     │  │ Inbox        │  │  (Langfuse)     │ │
│  └────────────┘  └──────────────┘  └─────────────────┘ │
└─────────────────────────────┬───────────────────────────┘
                              │ HTTP / WS
        ┌─────────────────────▼─────────────────────┐
        │       Gateway  (FastAPI :8000)             │
        │  Google SSO · pull queries · approvals     │
        └──┬──────────────┬──────────────────────────┘
           │              │
    ┌──────▼───┐   ┌──────▼──────────────────────────┐
    │Orchestr- │   │  Ingestion workers               │
    │ator      │   │  ClickUp · Zoho · Gmail ·        │
    │(LangGraph│   │  WhatsApp · Meetings             │
    │+ agents) │   └──────┬───────────────────────────┘
    └──────────┘          │
                   ┌──────▼──────────────────────────┐
                   │  Entity graph (Postgres+pgvector)│
                   │  + Reconciler + Action Broker    │
                   └─────────────────────────────────┘
```

**Key principles:**
- **Source of truth = ClickUp/Zoho/Odoo.** The brain is a read-mostly mirror; writes are approval-gated through `action_broker`.
- **One execution model.** LangGraph orchestrates all agents, skills, and workflows — no second runtime.
- **Anti-drift by construction.** Every source system has a nightly reconciler; zero silent divergence is a hard requirement.
- **Annealable.** The system mines its own audit log and crystallises repeated human interventions into reviewed, gated skills (Hermes-style annealing).
- **Git is the source of truth** for every agent-editable artefact — directives, skills, workflow specs, model-routing config. All changes are PRs with an eval gate (ADR-015).

---

## Repo layout

```
ai-company-brain/        # Planning docs — start here
  product_requirements.md
  project_plan.md
  system_architecture.md
  wbs.md                 # Live work-breakdown with PERT estimates
  risk_register.md
  research_summary.md

apps/                    # Deployable services (one container each)
  gateway/               # FastAPI + Google SSO — pull queries, push, approvals
  orchestrator/          # LangGraph + Deep Agents harness, tiered LLM router
  ingestion/             # ClickUp / Zoho / Gmail / WhatsApp / meeting workers
  reconciler/            # Nightly diff + escalation queue
  action_broker/         # Approval queue + audit + source-of-truth write executor
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

### 5. Start the Control Plane (Phase 0.5+)

```powershell
Set-Location workbench/control_plane
npm run dev          # http://localhost:3001
```

Control Plane panes:

| Pane | Path | Description |
|---|---|---|
| Chat / Agent Inbox | `/` | CopilotKit + AG-UI + LangGraph Agent Inbox |
| Skill Studio | `/skills` | Monaco editor + OpenHands embed + PR flow |
| Observability | `/observability` | Langfuse traces, audit log, spend |
| Workflow Editor | `/workflows` | LangGraph + React Flow canvas (coming L3) |

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
| Orchestration | LangGraph + Deep Agents (tiered sub-agent harness) |
| LLM routing | LiteLLM proxy (Gemini 2.5 Pro/Flash, Anthropic Claude, local Qwen3) |
| Observability | Langfuse (self-hosted), OpenTelemetry |
| Database | Postgres 16 + pgvector |
| Cache / queue | Redis Stack |
| Code sandbox | OpenHands (self-hosted) |
| Skills format | Anthropic `SKILL.md` (ADR-013) |
| Evals | Promptfoo + Inspect AI |
| Deploy | Docker Compose, Caddy reverse proxy, Hostinger KVM 4 VPS |

---

## Skills

Skills follow the [Anthropic `SKILL.md` format](https://github.com/anthropics/anthropic-quickstarts). Production skills live in `skills/`; examples in [`skills/examples/`](skills/examples/). The Annealer sub-agent can draft new skills from the audit log — they are gated by PR + eval before promotion.

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
