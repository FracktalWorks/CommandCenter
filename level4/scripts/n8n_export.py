"""Export all n8n workflows to workflows/<id>.json for Git tracking.

Usage:
    uv run python scripts/n8n_export.py

Required env vars:
    N8N_BASE_URL   (default: http://localhost:5678)
    N8N_API_KEY    API key created in n8n UI → Settings → n8n API

After first-time n8n setup (docker compose --profile workflows up), log in
at http://localhost:5678, go to Settings → n8n API, create a key and add it
to .env as N8N_API_KEY=<your-key>.

Writes one JSON file per workflow to workflows/, sorted-key + 2-space indent so
diffs are reviewable. Designed to be run from a pre-commit hook or a nightly
APScheduler job once n8n is in use.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parents[1]
OUT_DIR = REPO / "workflows"


def main() -> int:
    base = os.environ.get("N8N_BASE_URL", "http://localhost:5678").rstrip("/")
    api_key = os.environ.get("N8N_API_KEY")
    if not api_key:
        print(
            "N8N_API_KEY not set. Create one in n8n UI → Settings → n8n API.",
            file=sys.stderr,
        )
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    headers = {"X-N8N-API-KEY": api_key, "Accept": "application/json"}
    with httpx.Client(headers=headers, timeout=20.0) as c:
        r = c.get(f"{base}/api/v1/workflows")
        if r.status_code != 200:
            print(f"n8n returned {r.status_code}: {r.text[:200]}", file=sys.stderr)
            return 1
        wfs = r.json().get("data", [])

    written = 0
    for wf in wfs:
        wid = wf.get("id")
        if not wid:
            continue
        path = OUT_DIR / f"{wid}.json"
        path.write_text(json.dumps(wf, indent=2, sort_keys=True), encoding="utf-8")
        written += 1
    print(f"wrote {written} workflows -> {OUT_DIR.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())