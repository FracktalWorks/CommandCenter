# Deployment

## Purpose
Hostinger VPS deployment scripts, Caddy reverse proxy config, and CI/CD pipeline.

## Key Files
- hostinger/bootstrap.sh -- initial VPS setup
- hostinger/deploy.sh -- application deployment
- hostinger/README.md -- setup instructions + CI/CD secrets guide
- caddy/ -- Caddy reverse proxy configuration
- ../.github/workflows/deploy.yml -- CI/CD: push-to-deploy (lint → test → SSH → deploy → smoke)
- ../.github/workflows/pr-check.yml -- PR validation (lint + test only)

## Conventions
- Bootstrap installs pwsh, uv, validates GITHUB_TOKEN
- Deploy pulls latest, rebuilds Docker images, restarts services
- Caddy handles SSL termination and routing
- CI/CD deploys on push to main; PRs run lint + test only
- SSH key for CI/CD must be a dedicated key (not a developer personal key)
