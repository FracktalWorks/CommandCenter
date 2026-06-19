#!/bin/bash
# Run the comprehensive chat feature integration tests on the VPS.
# Usage:  bash scripts/run_chat_tests.sh [pytest-args...]
#
# Examples:
#   bash scripts/run_chat_tests.sh -v -x
#   bash scripts/run_chat_tests.sh -v -k "sse"
#   bash scripts/run_chat_tests.sh -v -k "not hitl"

set -euo pipefail

cd /opt/acb/app

export CC_GATEWAY_URL="http://127.0.0.1:8080"
export CC_AUTH_TOKEN="sk-local-dev-change-me"
export CC_TEST_MODEL="groq/llama-3.3-70b-versatile"
export CC_MAF_AGENT="task-manager"
export CC_COPILOT_AGENT="agent-project-manager"

echo "=== Chat Feature Integration Tests ==="
echo "Gateway:  ${CC_GATEWAY_URL}"
echo "Model:    ${CC_TEST_MODEL}"
echo "MAF:      ${CC_MAF_AGENT}"
echo "Copilot:  ${CC_COPILOT_AGENT}"
echo ""

/home/acb/.local/bin/uv run python -m pytest \
  tests/integration/test_chat_features.py \
  "${@:--v}" \
  --tb=short \
  --timeout=180
