# {{ agent_name }} — Agent Instructions

## Purpose
<!-- One-paragraph summary of what this agent does and what business goal it serves. -->

## Inputs
<!-- Describe the fields in `event_payload` that this agent expects. -->

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `...` | str  | Yes      | ...         |

## Outputs
The agent writes its final result to `state["result"]`.

| Key       | Type | Description |
|-----------|------|-------------|
| `result`  | Any  | Primary output returned to the caller. |

## Tools / Skills
<!-- List external tools, skill repos, or APIs this agent uses. -->
- None yet.

## Behaviour

1. **Receive** the incoming event.
2. **Validate** required fields.
3. **Execute** core logic.
4. **Return** structured result.

## Error Handling
If the agent raises an unhandled exception, the Core executor will invoke
`Self_Mutation_Node` (max 1 attempt per run).  The failing run is traced in
Langfuse via MAF's built-in OTel exporter and a PR is opened against this
repo for human review.

## Development
```bash
# Install dependencies
uv sync

# Run tests
uv run pytest tests/ -v

# Run evals (requires LITELLM_BASE_URL + LITELLM_API_KEY)
promptfoo eval -c evals/promptfoo.yaml
```

## Runtime Contract
- **Entry point:** `agents.py::build_agents() -> list[Agent]` (MAF)
- **Inference:** All LLM calls route through LiteLLM (`tier2-sonnet` alias)
- **MCP servers:** Declared in `config.json::mcp_servers`; credentials injected
  at runtime from the secrets vault
- **History:** `RedisHistoryProvider` attached only on interactive (AG-UI) path;
  background event-driven runs use in-memory `AgentSession`
