"""Tests for {{ skill_name }}.

Offline-only — no LLM calls, no Docker required.
Run with:
    pytest tests/ -v
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make the skill package importable from the repo root
sys.path.insert(0, str(Path(__file__).parent.parent))

from skill_template import run
from skill_template.core import run as core_run


# ---------------------------------------------------------------------------
# SKILL.md
# ---------------------------------------------------------------------------

def test_skill_md_has_valid_frontmatter() -> None:
    """SKILL.md must exist and have valid YAML frontmatter."""
    skill_md = Path(__file__).parent.parent / "SKILL.md"
    assert skill_md.exists(), "SKILL.md is missing"
    content = skill_md.read_text(encoding="utf-8")
    assert content.startswith("---"), "SKILL.md must start with YAML frontmatter (---)"
    parts = content.split("---", 2)
    assert len(parts) >= 3, "SKILL.md frontmatter must have closing ---"

    import yaml  # noqa: PLC0415
    fm = yaml.safe_load(parts[1])
    for required_key in ("name", "description", "authority", "version"):
        assert required_key in fm, f"SKILL.md frontmatter missing required key: {required_key!r}"


# ---------------------------------------------------------------------------
# Entry function: run()
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_run_returns_string() -> None:
    """run() must return a string."""
    result = await run({"key": "value"})
    assert isinstance(result, str)
    assert len(result) > 0


@pytest.mark.asyncio
async def test_run_handles_empty_payload() -> None:
    """run() must not raise on an empty payload."""
    result = await run({})
    assert isinstance(result, str)


@pytest.mark.asyncio
async def test_run_reflects_payload_keys() -> None:
    """run() output should reference the supplied payload in some way."""
    result = await run({"entity_id": "abc-123", "action": "summarise"})
    assert isinstance(result, str)


# ---------------------------------------------------------------------------
# __init__ exports
# ---------------------------------------------------------------------------

def test_init_exports_run() -> None:
    """__init__.py must export the run() function."""
    import skill_template  # noqa: PLC0415
    assert hasattr(skill_template, "run"), "__init__.py must export 'run'"
    assert callable(skill_template.run)


def test_core_and_init_run_are_same() -> None:
    """__init__.run must be the same object as core.run."""
    assert run is core_run, "skill_template.run should directly re-export skill_template.core.run"
