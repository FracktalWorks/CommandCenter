# Evals — CommandCenter harness & skill evaluation (ADR-017, HH-1)

Three complementary layers, from cheapest/most-deterministic to most realistic:

| Layer | What it locks | Needs LLM? | CI |
|---|---|---|---|
| [`trajectories/`](trajectories/) | Harness invariants as golden trajectories: HITL round-trips, stream replay/reconnect semantics, delegation guards, tool-failure recovery | No | **blocking** (`skill-eval.yml`) |
| [`inspect/scenarios.py`](inspect/scenarios.py) | Skill scenarios scored on the structural contract (citations, JSON shape) via Inspect AI | mockllm smoke in CI; live model locally | blocking (smoke) |
| [`promptfoo.yaml`](promptfoo.yaml) + per-skill `skills/**/evals/cases.yaml` | Golden-case outputs of each skill against a real model | Yes (`LITELLM_BASE_URL`) | opt-in until CI secrets are wired |

## Layout

```
evals/
  _runner.py            shared promptfoo provider (SKILL.md prompt + fixtures + LiteLLM call)
  promptfoo.yaml        top-level curated golden set (what CI invokes)
  fixtures/entities.json  entity records standing in for graph.read.* results in CI
  inspect/scenarios.py  Inspect AI tasks
  trajectories/         offline pytest golden trajectories (no network, no DB)
```

## Running locally

```bash
# Harness trajectories (fast, offline)
uv run pytest evals/trajectories/ -v

# Inspect smoke (offline) / live
uv run inspect eval evals/inspect/scenarios.py --model mockllm/model --limit 1
uv run inspect eval evals/inspect/scenarios.py --model openai/tier-fast -M base_url=$LITELLM_BASE_URL/v1

# Promptfoo golden cases (needs a reachable LiteLLM endpoint)
npx promptfoo@latest eval --config evals/promptfoo.yaml
npx promptfoo@latest eval --config skills/triage/email_classify/evals/cases.yaml
```

## Conventions

- **One golden case per behaviour**, not per prompt-wording — cases assert the
  contract downstream code depends on (citation tokens, JSON keys, bounds),
  not exact strings.
- **Fixtures over DB**: cases reference stable UUIDs; `fixtures/entities.json`
  supplies the entity data so CI needs no graph database. Add fixture records
  when adding cases.
- **Trajectory tests live here, not in `tests/unit/`**, when they lock a
  cross-component agent-visible behaviour (tool → event → user → tool-result)
  rather than a single helper. Unit conventions still apply (no network/DB,
  `asyncio_mode=auto`).
- No `agents.py` / `SKILL.md` change should merge without a passing golden
  case (project plan §9 Quality Gates).
