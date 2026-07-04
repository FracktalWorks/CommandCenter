# Skills

## Purpose
Skill definitions and SKILL.md patterns. Each skill is a domain-specific capability.

## Skill Structure
- skills/{category}/{skill_name}/SKILL.md -- skill instructions
- skills/{category}/{skill_name}/scripts/ -- Python scripts
- Categories: delivery/, maintenance/, reconciler/, sales/, triage/, upstream/
  (maintenance/ = dev-velocity skills that operate ON this codebase, e.g.
  codebase_health_audit — see ai-company-brain/specs/dev_velocity_tooling_2026-07.md)

## Conventions
- SKILL.md has YAML frontmatter with name and description
- Scripts are called via subprocess by agent tool functions
- No credentials in skill files -- Integration Registry only

## Verification
- Each SKILL.md must have valid frontmatter
- Scripts must be importable and have docstrings
