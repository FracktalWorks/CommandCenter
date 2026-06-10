# Deployment

## Purpose
Hostinger VPS deployment scripts and Caddy reverse proxy config.

## Key Files
- hostinger/bootstrap.sh -- initial VPS setup
- hostinger/deploy.sh -- application deployment
- caddy/ -- Caddy reverse proxy configuration

## Conventions
- Bootstrap installs pwsh, uv, validates GITHUB_TOKEN
- Deploy pulls latest, rebuilds Docker images, restarts services
- Caddy handles SSL termination and routing
