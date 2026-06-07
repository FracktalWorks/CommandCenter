"""Skill registry (v1) + Dynamic Agent Loader (v2) + Integration Registry."""
from acb_skills.agent_tools import call_agent, call_agent_background
from acb_skills.web_tools import fetch_page, web_search
from acb_skills.write_artifact import write_artifact, _WRITE_ARTIFACT_CONTEXT
from acb_skills.integrations import (
    IntegrationMisconfiguredError,
    IntegrationNotFoundError,
    build_integrations,
    list_registered,
)
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
    # v2 — Integration Registry
    "build_integrations",
    "list_registered",
    "IntegrationNotFoundError",
    "IntegrationMisconfiguredError",
    # Agent delegation tools (auto-injected; also importable explicitly)
    "call_agent",
    "call_agent_background",
    # Zero-credential web tools (auto-injected; also importable explicitly)
    "web_search",
    "fetch_page",
    # File-writing tool (auto-injected; also importable explicitly)
    "write_artifact",
    "_WRITE_ARTIFACT_CONTEXT",
]