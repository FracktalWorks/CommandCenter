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

1. executor.py is the single entry point for agent execution (streaming and batch). Injects platform tools, MCP server config from the registry, and integration credentials at runtime.
2. copilot_agent.py provides CommandCenterCopilotAgent -- the MAF wrapper for Copilot SDK agents with BYOK + MCP server forwarding
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
3. _stash_pull_before_mutation() syncs the clone (stash → fetch → rebase → pop stash)
   before the Docker sandbox runs, preventing stale-code fixes and merge conflicts
4. The Docker sandbox runs mutation_runner.py with MUTATION_PROMPT env var
5. Commits are registered as pending_commit rows for inbox approval
6. Local-only repos skip push on approval; use git reset HEAD~1 for rejection
7. _pull_latest() in acb_skills.loader preserves local-only commits (pending approval)
   via rebase instead of destructive reset --hard

### Session continuity and stale-session recovery
- Copilot SDK session IDs (service_session_id) are stored in-memory
  (_copilot_session_store) AND in Postgres (chat_session.service_session_id).
- On each run_agent_stream() call, _get_stored_session_id() looks up the ID;
  if found, _resume_session() is used so the SDK preserves full history.
- **Stale session after gateway restart**: When the Copilot CLI process dies,
  resume_session() raises "Failed to create GitHub Copilot session". The
  executor catches this via the _run_copilot_attempt() retry loop:
  1. Detects "session"+"error" in the exception message and a stored session ID.
  2. Calls _clear_stored_session_id() to NULL the Postgres record.
  3. Injects prior conversation (messages[], last 20, 300 chars each) as text prefix.
  4. Retries with session=None, creating a fresh Copilot SDK session.
  Max 1 retry (_session_retry_attempted flag); second failure surfaces as RUN_ERROR.
- _clear_stored_session_id() NULLs the Postgres row async via run_in_executor.
- Model switch mid-thread: detected via _copilot_model_store; forces new session.

### Streaming event flow
1. run_agent_stream() creates CommandCenterCopilotAgent patches on loaded agent
2. agent.run(stream=True) returns AgentResponseUpdate objects via _run_copilot_attempt()
3. Each update is translated to AG-UI SSE events (TEXT_MESSAGE_CONTENT, TOOL_CALL_*, etc.)

### Prompt-cache sentinel convention (specs/llm_caching_memory.md)
When the executor appends memory context to an agent's instructions /
`system_message`, it inserts a `<!-- CACHE BREAK -->` sentinel
(`acb_llm.prompt_cache.CACHE_BREAK`) at the stable/dynamic boundary — stable
prefix (instructions + tool addendum) BEFORE the sentinel, dynamic memory
AFTER. The single `apply_prompt_caching` transform (called at both completion
choke points — `acb_llm.complete*` and gateway `/v1`) consumes it: Anthropic
tiers get an explicit `cache_control` breakpoint at the seam + the tool array
cached; every other provider has the sentinel stripped. **Keep the stable
prefix first and never put per-request/per-turn content before the sentinel** —
anything before it is treated as cacheable and byte-stability is required for a
cache hit.

### Injected tools (auto-available to all agents)
The executor's _inject_agent_tools() patches every loaded agent with cross-cutting
tools so no agent repo needs to declare them:
- call_agent / call_agents_parallel / call_agent_background  (agent_tools.py)
- web_search / fetch_page                                  (web_tools.py)
- write_artifact                                           (write_artifact.py)
- remember / recall_timeline / save_memory / save_episode   (memory_tools.py)
- manage_todo_list                                         (todo_tools.py)
- ask_questions                                            (ask_tools.py)
- get_errors                                               (error_tools.py)
- save_note / recall_notes                                 (note_tools.py)
- query_history                                            (history_tools.py)
- github_search / github_repo_search                       (github_tools.py)
Injection targets: _tools (GitHubCopilotAgent), tools (MAF Agent), _default_options.tools (legacy).
Tool guidance is appended to _default_options.system_message via _build_injected_tools_addendum().
User context (_set_memory_user_id) is set by gateway route agent.py before each run.
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
  TOOL_CALL_PARTIAL {toolCallId, delta} when the raw Copilot event
  (TOOL_EXECUTION_PARTIAL_RESULT / TOOL_EXECUTION_PROGRESS) carries a
  tool_call_id -- live terminal output streams into that tool's row in the
  UI -- otherwise PROGRESS_UPDATE. Never TEXT_MESSAGE_CONTENT (would pollute
  the visible answer). ASSISTANT_INTENT carries no text content; the raw
  INTENT handler renders it as a timeline entry.

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
