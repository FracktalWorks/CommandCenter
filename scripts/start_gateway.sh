#!/usr/bin/env bash
# Start the gateway in the background and wait for it to be healthy.
set -euo pipefail
cd /opt/acb/app
export PATH="$HOME/.local/bin:$PATH"

# Start gateway
nohup uv run uvicorn gateway.main:app --host 0.0.0.0 --port 8080 > /tmp/gateway.log 2>&1 &
echo "Gateway PID: $!"

# Wait for it to start (up to 30s)
for i in $(seq 1 15); do
  if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
    echo "Gateway healthy!"
    curl -s http://localhost:8080/health
    exit 0
  fi
  sleep 2
done

echo "Gateway failed to start. Last log lines:"
tail -20 /tmp/gateway.log
exit 1
