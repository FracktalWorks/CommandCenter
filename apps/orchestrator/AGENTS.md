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
4. DETACHED EXECUTION: the gateway wraps the generator in stream_relay.run_detached(),
   which drains it in a background asyncio task pushing all events to Redis
   (cc:stream:{thread_id}). The HTTP response is just a Redis subscriber --
   client disconnects never kill the agent run.
5. Every _sse() frame is teed to Redis via per-thread ORDERED push chains
   (_tee_sse_line) so events land in exact emission order. Tier-1 MAF AG-UI
   frames (which bypass _sse) are teed explicitly in the Tier-1 loop.
6. RUN_FINISHED is emitted INSIDE the try block (before the finally tears down
   the relay) and the finally awaits pending pushes before mark_inactive --
   reconnecting clients always see the run end.
7. mark_active(reset=True) clears the previous run's stream so replay-from-0
   covers exactly the current run (prior turns live in Postgres).
8. Reconnect endpoint (GET /agent/run/{thread_id}/reconnect) replays from the
   cursor then subscribes live FROM THE REPLAY TAIL (no event gap).

### Reasoning / thinking stream (github-copilot runtime)
- Copilot SDK sessions emit ASSISTANT_REASONING_DELTA token-by-token when
  SessionConfig has streaming=True; copilot_agent.py translates them via
  Content.from_text_reasoning(text=...) -- the kwarg is REQUIRED (keyword-only
  API; positional calls raise TypeError silently swallowed by _on_event).
- The final ASSISTANT_REASONING full-block event is SKIPPED when its
  reasoning_id already streamed as deltas (prevents duplicated thinking text).
- think_mode "thinking"/"max" sets default_options["reasoning_effort"]
  (medium/high); _create_session forwards it to SessionConfig and retries
  without it if the model rejects it.
- Executor translates text_reasoning contents to THINKING_TEXT_MESSAGE_CONTENT
  SSE frames; tool-role text frames (progress, partial output) become
  PROGRESS_UPDATE frames -- never TEXT_MESSAGE_CONTENT (would pollute the
  visible answer). ASSISTANT_INTENT carries no text content; the raw INTENT
  handler renders it as a timeline entry.

### Todo-list tracking (VS Code Todos panel parity)
- The Copilot CLI tracks the agent's plan with its built-in `sql` tool
  against a `todos` table (INSERT INTO todos / UPDATE todos SET status).
- executor._TodoTracker parses those queries from TOOL_CALL args and emits
  TODO_LIST SSE frames ({todos: [{id,title,status}]}) on every change.
- Frontend: route.ts maps TODO_LIST -> {type:"todos"}; useAgentChat stores
  todos[] on the assistant ChatMessage; TodoPanel.tsx renders the
  collapsible "Todos (n/m)" panel pinned above the chat input.

## Verification

- pytest tests/ -- all 154 tests must pass
- Gateway must start: uv run uvicorn gateway.main:app
- Chat endpoint must stream: POST /agent/run/stream with model
- Tool calling must work: web_search, call_agent visible in stream

## Child DOX Index

None -- leaf directory. All orchestrator code is co-located.
