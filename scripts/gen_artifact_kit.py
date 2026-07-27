#!/usr/bin/env python
"""Regenerate acb_skills/artifact_kit.json from the @cc/ui component source.

Run after editing ``workbench/control_plane/src/lib/artifactUi.tsx``:

    uv run python scripts/gen_artifact_kit.py

``tests/unit/test_artifact_kit.py`` re-parses the source and fails if the
committed JSON is stale, so this never has to be remembered — CI says so.

The manifest is committed rather than parsed at runtime so acb_skills has no
runtime dependency on the frontend tree (the orchestrator may not ship it).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
KIT_SOURCE = REPO_ROOT / "workbench" / "control_plane" / "src" / "lib" / "artifactUi.tsx"
MANIFEST = REPO_ROOT / "packages" / "acb_skills" / "acb_skills" / "artifact_kit.json"


def main() -> int:
    sys.path.insert(0, str(REPO_ROOT / "packages" / "acb_skills"))
    from acb_skills.artifact_kit import parse_kit_source  # noqa: PLC0415

    if not KIT_SOURCE.exists():
        print(f"error: {KIT_SOURCE} not found", file=sys.stderr)
        return 1
    kit = parse_kit_source(KIT_SOURCE.read_text(encoding="utf-8"))
    if not kit:
        print("error: parsed zero components — check the source format", file=sys.stderr)
        return 1
    MANIFEST.write_text(json.dumps(kit, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {MANIFEST.relative_to(REPO_ROOT)} ({len(kit)} components)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
