#!/usr/bin/env bash
# One-time server bootstrap. Idempotent. Run as the `acb` user (non-root w/ sudo).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/acb/app}"
cd "$APP_DIR"

say()  { printf "\n==> %s\n" "$*"; }
warn() { printf "    !! %s\n" "$*" >&2; }

# 1. Sanity
say "Sanity"
[ "$EUID" -ne 0 ] || { warn "do not run as root; use the acb user"; exit 1; }
sudo -n true 2>/dev/null || { warn "user lacks sudo; fix usermod -aG sudo acb"; exit 1; }

# 2. Docker
say "Docker"
if ! command -v docker >/dev/null; then
  warn "docker not found; installing (Ubuntu 24.04)"
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
  warn "you may need to log out/in for the docker group to take effect"
fi
docker --version
docker compose version

# 3. Firewall (UFW)
say "Firewall"
if ! command -v ufw >/dev/null; then sudo apt-get install -y ufw; fi
sudo ufw --force reset >/dev/null
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # Caddy HTTP (ACME challenge)
sudo ufw allow 443/tcp    # Caddy HTTPS
sudo ufw --force enable

# 4. Caddy (reverse proxy + auto-TLS)
say "Caddy"
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi
sudo install -m 0644 "$APP_DIR/deploy/hostinger/caddy/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy || sudo systemctl restart caddy

# 5. .env
say "Environment file"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  warn "wrote $APP_DIR/.env from template; EDIT IT before running deploy.sh"
fi

# 6. systemd unit so the compose stack survives reboots
say "Systemd unit (acb.service)"
sudo tee /etc/systemd/system/acb.service >/dev/null <<UNIT
[Unit]
Description=AI Company Brain (docker compose stack)
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/docker compose -f infra/docker-compose.yml --profile core --profile obs up -d --remove-orphans
ExecStop=/usr/bin/docker compose -f infra/docker-compose.yml down

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable acb.service

cat <<'EOF'

OK. Bootstrap complete.

Next:
  1. nano /opt/acb/app/.env             # fill in secrets
  2. nano /opt/acb/app/deploy/hostinger/caddy/Caddyfile   # set your hostnames
  3. sudo systemctl reload caddy
  4. bash /opt/acb/app/deploy/hostinger/deploy.sh
EOF