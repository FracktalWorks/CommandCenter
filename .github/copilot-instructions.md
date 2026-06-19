# CommandCenter — Self-Anneal Agent

This is the CommandCenter orchestration platform repository.  It runs as a
headless, self-mutating multi-agent platform on MAF (Microsoft Agent Framework).

## Key facts

- **Python 3.11+** with `uv` package manager
- **FastAPI** for all HTTP/WS endpoints (gateway at `apps/gateway/`)
- **Postgres + pgvector** for entity graph, memory, audit, integrations
- **Redis Streams** for event bus and stream relay
- **Next.js** (App Router) for the Control Plane workbench (`workbench/control_plane/`)
- **Docker Compose** for local dev and single-VM production
- **DOX framework**: read the AGENTS.md chain before editing any file

## Entry points

- `agents.py` — MAF agent definition (build_agents entry point)
- `config.json` — CommandCenter agent contract
- `.github/prompts/system.md` — full system prompt
- `AGENTS.md` — root DOX document (global constraints, conventions, child index)

## Before editing

1. Read root `AGENTS.md`
2. Follow the DOX chain to the target file
3. Read the nearest `AGENTS.md` for local rules
4. Run `uv run python -m pytest tests/unit/ -x -q` after changes

## Control Plane UI (Next.js)

When editing any file under `workbench/control_plane/`:

- **Read** `workbench/control_plane/DESIGN_SYSTEM.md` first — it defines the
  unified UI/UX standards (colors, typography, spacing, component patterns).
- **Use shared components** from `src/components/`:
  - `Tabs` — for tab navigation (segmented or underline variants)
  - `FilterPills` — for filter/chip-style list filtering
  - Never inline ad-hoc tab bars, filter pills, or page headers.
- **Use semantic color tokens** (`bg-primary`, `text-foreground`, `border-border`,
  etc.) — never arbitrary hex values or `bg-[#1a1b1e]`.
- **Match the page layout pattern**: header → tabs/filters → content.
- Run `npx next build` from `workbench/control_plane/` to verify after changes.
