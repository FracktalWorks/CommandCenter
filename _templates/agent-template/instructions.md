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
`attempt_self_mutation` (max 1 attempt).  The failing run is flagged in
Langfuse and a PR is opened against this repo for human review.

## Development
```bash
# Run tests
pytest tests/

# Run evals
promptfoo eval -c evals/promptfoo.yaml
```
