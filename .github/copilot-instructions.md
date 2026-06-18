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
