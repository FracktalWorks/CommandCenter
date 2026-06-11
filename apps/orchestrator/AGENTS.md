# Orchestrator -- Agent Execution Engine

## Purpose

The orchestrator is the runtime engine for all agent execution in CommandCenter.
It dynamically loads agents from GitHub repos or local folders, executes them
via MAF, handles cross-agent delegation, triggers self-mutation on failure,
and streams chat responses as AG-UI events.

## Ownership

- Owner: CommandCenter Core team
- Path: apps/orchestrator/

## Local Contracts

1. executor.py is the single entry point for agent execution (streaming and batch)
2. copilot_agent.py provides CommandCenterCopilotAgent -- the MAF wrapper for Copilot SDK agents with BYOK
3. agents.py exports build_orchestrator_agent() -- the main orchestrator MAF Agent
4. mutation.py handles Self_Mutation_Node -- spawns Docker sandbox on agent failure
5. stream_relay.py buffers all SSE events to Redis Streams for fire-and-forget chat with live reconnection
6. All agents must go through MAF -- no raw Copilot SDK paths for business execution
7. mutation_runner.py runs inside the Docker sandbox -- uses Copilot SDK directly (by design)

## Work Guidance

### Adding a new agent runtime feature
1. Feature goes in executor.py (streaming: run_agent_stream, batch: run_agent)
2. If it touches Copilot SDK agents, modify CommandCenterCopilotAgent in copilot_agent.py
3. Ensure all Copilot SDK event types are translated to AG-UI SSE events
4. Test with both github-copilot and maf agent types
5. Run pytest tests/ before committing

### Modifying the mutation layer
1. mutation.py contains attempt_self_mutation() and prompt builders
2. Agent purpose context (instructions.md, skills, trigger) is assembled in _build_telemetry()
3. The Docker sandbox runs mutation_runner.py with MUTATION_PROMPT env var
4. Commits are registered as pending_commit rows for inbox approval
5. Local-only repos skip push on approval; use git reset HEAD~1 for rejection

### Streaming event flow
1. run_agent_stream() creates CommandCenterCopilotAgent patches on loaded agent
2. agent.run(stream=True) returns AgentResponseUpdate objects
3. Each update is translated to AG-UI SSE events (TEXT_MESSAGE_CONTENT, TOOL_CALL_*, etc.)
4. Events are yielded as SSE frames to the gateway
5. Every SSE frame is also pushed to Redis Stream (cc:stream:{thread_id}) via stream_relay
   so the reconnect endpoint (GET /agent/run/{thread_id}/reconnect) can replay missed
   events after a browser disconnect.
6. _stream_relay_thread_id context var controls teeing; set per-run, cleared on finish

## Verification

- pytest tests/ -- all 154 tests must pass
- Gateway must start: uv run uvicorn gateway.main:app
- Chat endpoint must stream: POST /agent/run/stream with model
- Tool calling must work: web_search, call_agent visible in stream

## Child DOX Index

None -- leaf directory. All orchestrator code is co-located.
