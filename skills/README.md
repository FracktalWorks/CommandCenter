# Skills (Anthropic `SKILL.md` format · ADR-013)

Phase-0 home for skills. From Phase 0.5 (WBS 0.5.1) onward these move to a dedicated repo `ai-company-brain-skills`, with weekly upstream sync from `anthropics/skills` and `VoltAgent/awesome-agent-skills`.

Layout per skill:
```
skills/<domain>/<skill_id>/
  SKILL.md          # YAML frontmatter + Markdown instructions
  scripts/          # Python scripts executed in E2B sandbox (Phase 2.9)
  tests/            # Unit tests
  evals/            # Promptfoo + Inspect AI cases (Phase 1.9 CI gate)
  CHANGELOG.md
```

See [`examples/hello_skill`](examples/hello_skill) and architecture doc §11.
