---
name: skill_template
description: "One-line description of what this skill does."
when_to_use: "Describe the trigger condition: which events, which agent, when to call this."
allowed_tools: []
authority: read
cost_tier: 1
version: 0.1.0
provenance: "hand-authored, {{ date }}"
rollout_stage: shadow
success_rate_30d: null
cases_seen_30d: 0
---

# {{ skill_name }}

<!-- One-paragraph summary of what this skill does and what business problem it solves. -->

## Entry Functions

| Function | Signature | Returns | Description |
|----------|-----------|---------|-------------|
| `run` | `run(payload: dict) -> str` | Plain text | Primary skill action |

## Steps
1. **Receive** the agent-supplied payload.
2. **Execute** core logic (see `skill_template/core.py`).
3. **Return** a plain-text summary the agent can embed in its context window.

## Dependencies
None yet. Add any third-party packages to `pyproject.toml`.

## Error Handling
- Raise a descriptive `RuntimeError` for unrecoverable failures.
- Return a user-friendly string (not an exception) for soft failures (e.g. no results found).

## Development
```bash
# Install
uv sync

# Run tests
uv run pytest tests/ -v

# Run evals (requires LITELLM_BASE_URL + LITELLM_API_KEY)
promptfoo eval -c evals/promptfoo.yaml
```

## Runtime Contract
- **Package name:** `skill_template` (rename to `skill_<name>` in your real repo)
- **Importable as:** `from skill_template import run`
- **Installed by:** Core executor via `uv pip install .` after cloning the repo,
  or by adding this repo to the consuming agent's `config.json::skill_repos`
