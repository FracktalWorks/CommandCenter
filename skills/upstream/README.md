# Upstream Skills (do not hand-edit)

Populated weekly by `.github/workflows/skills-upstream-sync.yml`:

- `upstream/anthropics/` — mirror of https://github.com/anthropics/skills (subset of `skills/`)
- `upstream/voltagent/` — mirror of https://github.com/VoltAgent/awesome-agent-skills (curated subset)

Each sync opens a PR titled `chore(skills): upstream sync YYYY-MM-DD` so maintainers can
review diffs before adopting any upstream skill into a Fracktal domain folder.

To adopt an upstream skill: copy it under `skills/<domain>/<skill_id>/`, change
`provenance:` to note the upstream commit SHA, and add an entry in `CHANGELOG.md`.