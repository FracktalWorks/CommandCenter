#!/usr/bin/env bash
# One-time full-history secret scan (audit BO-8).
#
# Scans the ENTIRE git history (not just the working tree) for committed
# credentials — the leaked Zoho token + `acb_dump.bak` are removed from HEAD but
# still recoverable from history. Run this:
#   1. now, to confirm what history still exposes;
#   2. after `git filter-repo --path .zoho_token_cache.json --path acb_dump.bak
#      --invert-paths` + a coordinated force-push, to confirm it is gone.
#
# Requires gitleaks (https://github.com/gitleaks/gitleaks):
#   go install github.com/gitleaks/gitleaks/v8@v8.18.4
#
# Reminder: purging history does NOT un-leak a credential — ROTATE the Zoho
# token (and anything in acb_dump.bak) regardless.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not found — install it first:"
  echo "  go install github.com/gitleaks/gitleaks/v8@v8.18.4"
  echo "  export PATH=\"\$(go env GOPATH)/bin:\$PATH\""
  exit 2
fi

echo "Scanning full git history for secrets (redacted output)…"
gitleaks detect \
  --source . \
  --config .gitleaks.toml \
  --redact \
  --verbose
