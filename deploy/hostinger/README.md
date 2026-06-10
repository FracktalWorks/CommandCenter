# Deploying AI Company Brain on a Hostinger KVM VPS

Target spec (matches `system_architecture.md` §5 v1 baseline):

| Plan | vCPU | RAM  | Disk        | Price (2-yr renewal) |
|------|------|------|-------------|----------------------|
| KVM 2 | 2    | 8 GB | 100 GB NVMe | ~$14.99/mo           |
| **KVM 4 (recommended)** | **4** | **16 GB** | **200 GB NVMe** | **~$28.99/mo** |

KVM 4 has enough headroom for Postgres + Redis + LiteLLM + workbench. KVM 2 works for Phase 0/1 only.

## One-time: provision the server

1. Buy a VPS plan from <https://www.hostinger.com/vps-hosting>.
2. In hPanel → VPS → **Operating system**, pick **Ubuntu 24.04 with Docker** (one-click template).
3. Add your SSH public key under VPS → SSH keys (or set a strong root password).
4. Note the public IP. Optionally point a subdomain (e.g. `commandcenter.fracktal.in`) A-record to it.
5. Wait for provisioning (~3–5 min), then `ssh root@<ip>`.

## One-time: bootstrap

Once SSH works:

```bash
# On your laptop, push the code first (or git clone on the server below).
ssh root@<ip>

# On the server:
adduser --disabled-password --gecos "" acb
usermod -aG sudo,docker acb
mkdir -p /home/acb/.ssh && cp ~/.ssh/authorized_keys /home/acb/.ssh/ && chown -R acb:acb /home/acb/.ssh
exit

ssh acb@<ip>

# Clone + bootstrap
sudo mkdir -p /opt/acb && sudo chown acb:acb /opt/acb
git clone <your-repo-url> /opt/acb/app
cd /opt/acb/app
bash deploy/hostinger/bootstrap.sh
```

`bootstrap.sh` will:
- Verify Docker is present (Hostinger one-click template ships it).
- Install Caddy (reverse proxy with auto-TLS via Let's Encrypt).
- Copy `.env.example` → `/opt/acb/app/.env` if missing (you'll edit it before the first `up`).
- Install UFW firewall rules (22, 80, 443 only).
- Set up systemd unit so the compose stack starts on reboot.

## Configure secrets

```bash
nano /opt/acb/app/.env
```

Set at minimum:
- `GEMINI_API_KEY` (Tier 1/2/3 — primary LLM provider)
- `GITHUB_TOKEN` (Tier fallback + Claude via Copilot; needs `copilot` scope)
- `POSTGRES_PASSWORD` (any long random string)
- `LITELLM_MASTER_KEY` (any long random string)
- `GATEWAY_SESSION_SECRET` (random)
- ClickUp / Zoho / WhatsApp tokens as each phase needs them.

Then edit `deploy/hostinger/caddy/Caddyfile` and replace the placeholder hostnames with yours.

## First deploy

```bash
bash deploy/hostinger/deploy.sh
```

This runs `docker compose --profile core up -d`, waits for healthchecks, and runs `scripts/check_infra.py`.

## Redeploy after a code change

```bash
cd /opt/acb/app
git pull
bash deploy/hostinger/deploy.sh
```

## Updating images

```bash
cd /opt/acb/app
docker compose -f infra/docker-compose.yml pull
bash deploy/hostinger/deploy.sh
```

## Backups

Hostinger takes weekly backups of the whole VPS automatically (included in plan). For Postgres-level point-in-time recovery later, add `pgbackrest` or a `pg_dump` cron job.

## Observability + ops dashboards

Once deployed (and DNS pointed):
- **Control Plane (UI):** `https://commandcenter.your-domain.tld`
- **Gateway API:** `https://api.commandcenter.your-domain.tld`

LiteLLM stays on the internal Docker network — never exposed publicly.

## CI/CD via GitHub Actions

Push-to-deploy is configured via `.github/workflows/deploy.yml`. On every push to
`main`, the pipeline:

1. **Lint** — Ruff lint + mypy type check
2. **Test** — Full unit test suite (`pytest tests/unit/`)
3. **Deploy** — SSH into Hostinger VPS, `git pull`, restart Docker Compose, sync Python deps, reload Caddy, run `check_infra.py`
4. **Smoke** — Hit `https://commandcenter.your-domain.tld/health` from CI

PRs get a lighter `pr-check.yml` workflow (lint + test only, no deploy).

### One-time: set up CI/CD secrets

In your GitHub repo → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|--------|-------|
| `HOSTINGER_HOST` | VPS IP address (e.g. `123.45.67.89`) |
| `HOSTINGER_USER` | SSH user (`acb`) |
| `HOSTINGER_SSH_KEY` | SSH private key (ed25519 preferred) |
| `HOSTINGER_SSH_PORT` | SSH port (usually `22`) |

Generate an SSH key for CI/CD (do NOT reuse your personal key):

```bash
ssh-keygen -t ed25519 -C "ci-deploy@commandcenter" -f ~/.ssh/ci_deploy_key
cat ~/.ssh/ci_deploy_key.pub >> ~/.ssh/authorized_keys   # on the VPS
cat ~/.ssh/ci_deploy_key  # → paste into HOSTINGER_SSH_KEY secret
```

### Manual deploy (fallback)

If CI/CD is unavailable, SSH into the VPS and run:

```bash
cd /opt/acb/app && git pull && bash deploy/hostinger/deploy.sh
```

## Cost ceiling per `project_plan.md` §8

- VPS (KVM 4): ~$29/mo
- Vexa compute (when Phase 2 lands): ~€0.05–0.15/meeting
- LLM API (Gemini + GitHub Copilot): cost metered via LiteLLM; tuned per ADR-008 caching strategy

Stay well under the per-month budget by keeping Tier 1 on a cheap model (Haiku, then Qwen3 once a GPU host is added) and enforcing prompt caching in `litellm/config.yaml`.