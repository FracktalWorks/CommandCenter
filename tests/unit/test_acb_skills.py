"""Tests for acb_skills registry."""
from __future__ import annotations

from pathlib import Path

from acb_skills import load_skill, load_skills


REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_DIR = REPO_ROOT / "skills"
L4_SKILLS_DIR = REPO_ROOT / "level4" / "skills"


def test_load_skills_finds_production_only() -> None:
    skills = load_skills(L4_SKILLS_DIR)
    fqids = {s.fqid for s in skills}
    # The two seeded production skills must show up.
    assert "sales/quiet_deal_followup" in fqids
    assert "delivery/stale_task_nudge" in fqids
    # examples/ and upstream/ are excluded by default.
    assert all(not s.path.parts.__contains__("examples") for s in skills)
    assert all(not s.path.parts.__contains__("upstream") for s in skills)


def test_load_skills_can_include_examples() -> None:
    skills = load_skills(SKILLS_DIR, include_examples=True)
    fqids = {s.fqid for s in skills}
    assert "examples/hello_skill" in fqids


def test_skill_frontmatter_parses_fields() -> None:
    md = L4_SKILLS_DIR / "sales" / "quiet_deal_followup" / "SKILL.md"
    s = load_skill(md)
    assert s.frontmatter.name == "quiet_deal_followup"
    assert s.frontmatter.authority == "suggest"
    assert s.frontmatter.cost_tier == 2
    assert s.frontmatter.rollout_stage == "shadow"
    assert "graph.read.deal_360" in s.frontmatter.allowed_tools
    # Body should start with the H1.
    assert s.body.lstrip().startswith("# Quiet Deal Follow-up")


def test_missing_root_returns_empty() -> None:
    assert load_skills("nonexistent-skills-dir-xyz") == []