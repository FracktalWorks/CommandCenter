"""Skill registry (v1) + Dynamic Agent Loader (v2)."""
from acb_skills.loader import AgentLoadError, LoadedAgent, load_agent
from acb_skills.registry import Skill, SkillFrontmatter, load_skill, load_skills

__all__ = [
    # v1 — SKILL.md registry
    "Skill",
    "SkillFrontmatter",
    "load_skill",
    "load_skills",
    # v2 — Dynamic Agent Loader (ADR-013)
    "load_agent",
    "AgentLoadError",
    "LoadedAgent",
]