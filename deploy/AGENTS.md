# Deployment

## Purpose
Hostinger VPS deployment scripts, Caddy reverse proxy config, and CI/CD pipeline.

## Key Files
- hostinger/bootstrap.sh -- initial VPS setup (installs uv, validates tokens, writes systemd units)
- hostinger/deploy.sh -- application deployment (Docker, restart services)
- hostinger/README.md -- setup instructions
- hostinger/acb-gateway.service -- systemd unit: FastAPI gateway on :8080
- hostinger/acb-workbench.service -- systemd unit: Next.js workbench on :3001
- caddy/ -- Caddy reverse proxy configuration
- ../.github/workflows/deploy.yml -- CI/CD: push-to-deploy (lint → test → SSH → deploy → smoke)
- ../.github/workflows/pr-check.yml -- PR validation (lint + test only)

## Conventions
- Bootstrap installs uv, validates GITHUB_TOKEN, writes acb/acb-gateway/acb-workbench systemd units
- Deploy pulls latest, rebuilds Docker images, syncs Python deps, restarts gateway + workbench systemd services
- **LLM routing: gateway /v1/chat/completions reads keys from encrypted Postgres — no separate proxy**
- Provider keys live in the encrypted `provider_keys` table; seeded from `.env` on first boot
- Next.js workbench is rebuilt (`npm ci && npm run build`) and restarted on every deploy
- Caddy handles SSL termination and routing
- CI/CD deploys on push to main; PRs run lint + test only
- SSH key for CI/CD must be a dedicated key (not a developer personal key)
