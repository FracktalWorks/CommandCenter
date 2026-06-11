# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay
  understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read this root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child whose scope contains the path, read that child and continue
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.
Update the closest owning AGENTS.md when a change affects:
- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes.
Update child docs when parent changes alter local rules.
Remove stale or contradictory text immediately.

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history

---

# CommandCenter -- Project Root

Organisation: Fracktal Works
Project: CommandCenter v2 -- Headless, self-mutating agent orchestration platform
Runtime: Unified MAF (Microsoft Agent Framework). No LangGraph. No deepagents. No n8n.
Last updated: 2026-06-10

## Purpose

CommandCenter is a headless, self-mutating, multi-agent orchestration platform
for running a company. Events trigger specialist agents dynamically loaded
from GitHub repos or local folders, executed via MAF, and self-healing on
failure via isolated Copilot SDK sandboxes.

## Global Constraints (Non-Negotiable)

1. No in-app agent/skill editing -- Control Plane is for chat, HITL, observability only
2. No credentials in agent or skill repos -- Integration Registry holds all secrets
3. Self-mutation max_mutation_attempts = 1 per failure event
4. No autonomous writes to source systems until Action Broker is live
5. Git is the single source of truth for all agent artefacts
6. MAF is the sole agent execution runtime -- Copilot SDK is mutation-sandbox only
7. No Theia / browser IDE
8. Source systems are authoritative -- CommandCenter is a read-mostly mirror
9. All new execution features MUST use MAF paths -- no raw Copilot SDK entrypoints
10. All gateway endpoints require auth (Bearer token + optional user identity)

## Global Conventions

- Python 3.11+ with uv package manager
- FastAPI for all HTTP/WS endpoints
- Postgres + pgvector for entity graph, memory, audit, integrations
- Redis Streams for event bus
- Gateway /v1/chat/completions for LLM routing (keys from encrypted Postgres; no separate proxy)
- MAF native OTel for observability (OTLP-ready)
- Docker Compose for local dev and single-VM production
- Type hints required on all public functions
- async/await throughout -- no sync blocking in request paths
- Tests in tests/unit/ and tests/integration/ -- pytest with asyncio
- CI/CD via GitHub Actions: deploy.yml (push-to-deploy on main), pr-check.yml (lint+test on PRs)
- Deploy target: Hostinger KVM 4 VPS (Ubuntu 24.04 + Docker)
- Agent-generated artefacts (images, reports, PDFs) MUST be written to
  `.tmp/` or `outputs/` within the agent workspace so the Control Plane
  file browser and inline chat cards can discover them.  The workspace
  API exposes these directories but hides other dot-prefixed dirs.

## Package Versions (as of 2026-06-10)

- agent-framework-core: 1.8.0
- agent-framework-github-copilot: 1.0.0rc1
- agent-framework-ag-ui: 1.0.0rc3
- agent-framework-openai: 1.7.0
- agent-framework-redis: 1.0.0b260521
- github-copilot-sdk: 1.0.0

## User Preferences

- MD-only by default -- never auto-build .docx unless user explicitly asks
- Test before claiming done -- run pytest after code changes
- Document after building -- update AGENTS.md files (DOX pass) after meaningful changes
- No git push without explicit user request -- commit locally, mention what was committed

## Child DOX Index

| Scope | Path | Covers |
|---|---|---|
| Application services | apps/AGENTS.md | Gateway, orchestrator, ingestion, reconciler |
| Shared packages | packages/AGENTS.md | acb_skills, acb_llm, acb_memory, acb_graph, acb_common |
| Skills | skills/AGENTS.md | Skill definitions and SKILL.md patterns |
| Infrastructure | infra/AGENTS.md | Docker Compose, Postgres, LLM tier config, Redis |
| Deployment | deploy/AGENTS.md | Hostinger VPS deployment |
| Planning docs | ai-company-brain/AGENTS.md | Product requirements, project plan, architecture |
| Workbench UI | workbench/AGENTS.md | Control Plane (Next.js) and local dev tools |
