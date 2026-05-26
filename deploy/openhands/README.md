# OpenHands self-host

This directory ships OpenHands as the Skill Workbench backend.

## Why self-host?
- Skills authored inside OpenHands land directly in `skills/<domain>/<id>/SKILL.md` on the host repo (volume-mounted), so the GH PR flow stays in our hands.
- LLM calls route through our LiteLLM gateway, so spend, rate-limits, and model rollout are governed centrally.
- No third-party SaaS sees customer deal/HR data.

## Prereqs
- Docker Engine + Compose v2 on the host (Ubuntu 24.04 LTS recommended).
- LiteLLM reachable from this host (default: `http://host.docker.internal:4000`).
- `.env` at repo root populated with:
  - `LITELLM_BASE_URL` (e.g. `http://host.docker.internal:4000`)
  - `LITELLM_MASTER_KEY` (matches `infra/litellm/litellm.yaml`)
  - `OPENHANDS_DEFAULT_MODEL` (optional, default `litellm_proxy/tier2-gemini`)
  - `OPENHANDS_VERSION` (optional, default `0.55`)
  - `OPENHANDS_PORT` (optional, default `3000`)
  - `GITHUB_PAT` (optional, repo-scoped PAT for PR creation)

## Bring up
```bash
docker compose -f deploy/openhands/docker-compose.yml --env-file .env up -d
docker compose -f deploy/openhands/docker-compose.yml logs -f openhands
```
Visit http://<host>:3000 . On first launch, OpenHands writes settings into
`./openhands-state/` (gitignored).

## Production (Hetzner / Ubuntu 24.04)
1. Provision a CX22 or larger (2 vCPU, 4 GB) with Docker + Compose.
2. Clone this repo; populate `.env`.
3. Front with Caddy (or nginx) + `oauth2-proxy` restricting to `@fracktal.in`
   Google Workspace identities. Reverse-proxy to `127.0.0.1:3000`.
4. Open only 443/80 publicly; SSH key-only.
5. Back up `deploy/openhands/openhands-state/` nightly (workspaces + settings).

## Tear down
```bash
docker compose -f deploy/openhands/docker-compose.yml down
```
State persists in `./openhands-state/`. Delete that directory to wipe.

## Notes
- The `WORKSPACE_BASE` mount only exposes `skills/`. We deliberately do NOT
  mount the full repo - OpenHands should never see secrets or LiteLLM config.
- Skills authored here are saved as plain MD; review via PR before they
  flip to `rollout_stage: live` in the SKILL.md frontmatter.