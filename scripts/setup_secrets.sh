#!/usr/bin/env bash
# Generate random secrets and write them to /opt/acb/app/.env.
# Run ON the VPS: bash /opt/acb/app/scripts/setup_secrets.sh
set -euo pipefail
cd /opt/acb/app

POSTGRES_PW=$(openssl rand -hex 16)
LITELLM_KEY=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 16)

echo "Generated random secrets"

sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${POSTGRES_PW}/" .env
sed -i "s/^LITELLM_MASTER_KEY=.*/LITELLM_MASTER_KEY=${LITELLM_KEY}/" .env
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql+psycopg://acb:${POSTGRES_PW}@localhost:5432/acb|" .env
sed -i "s/^GATEWAY_SESSION_SECRET=.*/GATEWAY_SESSION_SECRET=${SESSION_SECRET}/" .env

# Add missing vars
grep -q "^GATEWAY_INTERNAL_TOKEN=" .env || echo "GATEWAY_INTERNAL_TOKEN=${LITELLM_KEY}" >> .env
grep -q "^GATEWAY_BASE_URL=" .env || echo "GATEWAY_BASE_URL=http://127.0.0.1:8000" >> .env
grep -q "^EXECUTIVE_EMAILS=" .env || echo "# EXECUTIVE_EMAILS=ceo@fracktal.in,cto@fracktal.in" >> .env

echo ""
echo "Secrets configured:"
grep -E "^(POSTGRES_PASSWORD|LITELLM_MASTER_KEY|GATEWAY_SESSION_SECRET|GATEWAY_INTERNAL_TOKEN)" .env | sed 's/=.*/=***/'
