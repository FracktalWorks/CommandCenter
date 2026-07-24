"""On-demand design system tool (generative_ui_2 §7).

design.md is no longer injected into every agent prompt; agents call
load_design_system() when they need the full design language (a heavy report
or bespoke custom HTML). These tests lock in that the tool returns the real
doc, strips the YAML front matter, and is wired into the injection floor.
"""
from __future__ import annotations

import asyncio

import acb_skills.design_tools as dt


def test_load_design_system_returns_the_real_doc():
    out = asyncio.run(dt.load_design_system())
    # Substantive content from the actual design.md body.
    assert "Command Center" in out
    assert "Visual theme & atmosphere" in out
    assert len(out) > 2000  # the real ~16KB doc, not the fallback string


def test_front_matter_is_stripped():
    out = asyncio.run(dt.load_design_system())
    # The YAML front-matter keys must NOT leak into the returned body…
    assert "when_to_use:" not in out
    assert "summary:" not in out
    # …and the body should start at the H1, not a stray "---" fence.
    assert out.lstrip().startswith("# Command Center")


def test_doc_reader_is_cached_and_stable():
    dt._design_doc.cache_clear()
    first = dt._design_doc()
    second = dt._design_doc()
    assert first == second and first != ""


def test_load_design_system_in_core_floor():
    from orchestrator._tool_injection import (
        _CORE_STANDARD_TOOL_NAMES,
        _resolve_injected_scope,
    )
    assert "load_design_system" in _CORE_STANDARD_TOOL_NAMES
    # Rides the floor even under a narrow scope.
    resolved = _resolve_injected_scope(["web_search"])
    assert resolved is not None and "load_design_system" in resolved


def test_annotation_is_read_only():
    from acb_skills.tool_annotations import TOOL_ANNOTATIONS
    hints = TOOL_ANNOTATIONS["load_design_system"]
    assert hints["read_only"] is True
    assert hints["destructive"] is False
    assert hints["open_world"] is False


def test_design_md_has_front_matter():
    """The front matter documents when to load the doc (agent-facing hint)."""
    from pathlib import Path

    import acb_skills
    raw = (Path(acb_skills.__file__).parent / "design.md").read_text(
        encoding="utf-8",
    )
    assert raw.startswith("---")
    assert "when_to_use:" in raw and "summary:" in raw
