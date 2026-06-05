# Microsoft Agent Framework (MAF) — Complete Reference
> Source: pypi.org/project/agent-framework, github.com/microsoft/agent-framework, learn.microsoft.com/en-us/agent-framework  
> Last verified: 2026-06-04  |  Stable version: 1.7.0

---

## 1. Install

`ash
# Full install (all sub-packages — use for development)
pip install agent-framework

# Selective install (production — only what you need)
pip install agent-framework-core              # core + OpenAI + workflows
pip install agent-framework-ag-ui             # AG-UI streaming endpoint (rc — no --pre needed)
pip install agent-framework-github-copilot --pre   # GitHubCopilotAgent (beta)
pip install agent-framework-redis --pre        # RedisHistoryProvider + RedisContextProvider (beta)
pip install agent-framework-mem0 --pre         # Mem0ContextProvider (beta) — Phase 2
pip install agent-framework-durabletask --pre  # DurableTask hosting (beta) — Phase 2
pip install agent-framework-azure-cosmos --pre # CosmosCheckpointStorage (beta) — Phase 2
`

---

## 2. Package Status (as of 2026-06-04)

| Package | Status | Notes |
|---|---|---|
| gent-framework | released | Meta-package: installs all sub-packages |
| gent-framework-core | released | Core engine, workflows, orchestrations |
| gent-framework-openai | released | OpenAIChatClient, OpenAIChatCompletionClient |
| gent-framework-foundry | released | FoundryChatClient (Azure AI Foundry) |
| gent-framework-ag-ui | rc | dd_agent_framework_fastapi_endpoint |
| gent-framework-github-copilot | beta | GitHubCopilotAgent |
| gent-framework-redis | beta | RedisHistoryProvider, RedisContextProvider |
| gent-framework-mem0 | beta | Mem0ContextProvider |
| gent-framework-durabletask | beta | Durable/long-running workflow hosting |
| gent-framework-azure-cosmos | beta | CosmosCheckpointStorage (DTS only) |
| gent-framework-a2a | beta | Agent-to-Agent protocol proxy |
| gent-framework-anthropic | beta | Direct Anthropic (Claude) client |
| gent-framework-declarative | rc | YAML-defined agents |
| gent-framework-devui | beta | Interactive developer UI |

---

## 3. Core Agent API

`python
from agent_framework import Agent
from agent_framework.openai import OpenAIChatClient   # or FoundryChatClient, etc.

agent = Agent(
    client=OpenAIChatClient(),           # LLM backend (points at LiteLLM in our setup)
    name="my-agent",
    instructions="You are a helpful assistant.",
    tools=[my_tool_fn],                  # @tool decorated functions
    context_providers=[my_provider],     # ContextProvider subclasses
    middleware=[my_middleware],           # AgentMiddlewareLayer subclasses
)

# Single run (stateless)
result = await agent.run("Hello!")
print(result)   # AgentResponse — result.text, result.messages

# Multi-turn run (stateful within session)
session = agent.create_session()
r1 = await agent.run("My name is Alice.", session=session)
r2 = await agent.run("What is my name?", session=session)   # remembers Alice

# Streaming
async for update in await agent.run("Tell me a story", stream=True):
    print(update.text, end="", flush=True)
`

---

## 4. GitHubCopilotAgent (MAF + Copilot SDK bridge)

`python
from agent_framework_github_copilot import GitHubCopilotAgent

agent = GitHubCopilotAgent(
    instructions="You are a helpful assistant.",
    tools=[my_tool_fn],                  # MAF FunctionTools — auto-translated to CopilotTool
    context_providers=[my_provider],     # All MAF context providers work here
    default_options={
        "model": "claude-sonnet-4-5",
        "mcp_servers": {                 # Integration Registry credentials injection
            "clickup": {"command": "uvx", "args": ["mcp-clickup"], "env": {...}},
        },
        "provider": {                    # BYOK through LiteLLM
            "type": "openai",
            "base_url": "http://litellm:4000/v1",
            "api_key": LITELLM_KEY,
        },
        "on_permission_request": PermissionHandler.approve_all,
    },
)

async with agent:
    result = await agent.run("Check project status")
`

**Key points:**
- GitHubCopilotAgent IS a MAF BaseAgent — it participates in HandoffBuilder, ConcurrentBuilder, etc. the same as any other agent
- The Copilot SDK (github-copilot-sdk) handles the internal reasoning/tool loop; MAF wraps it
- context_providers= and middleware= both work exactly as with a standard Agent
- mcp_servers= is how Integration Registry credentials reach the Copilot CLI
- provider= is how you route through LiteLLM BYOK instead of the GitHub Copilot cloud backend

---

## 5. Multi-Agent Orchestration Patterns

`python
from agent_framework import HandoffBuilder, ConcurrentBuilder, GroupChatBuilder

# Handoff (triage → specialist)
workflow = (
    HandoffBuilder()
    .add_agent(triage_agent, can_handoff_to=[crm_agent, task_agent])
    .add_agent(crm_agent)
    .add_agent(task_agent)
    .build()
)
result = await workflow.run("Check deal pipeline and open tasks")

# Concurrent (fan-out, fan-in)
workflow = (
    ConcurrentBuilder()
    .add_agents([crm_agent, task_agent, invoice_agent])
    .build()
)

# Group chat (agents converse with each other)
workflow = GroupChatBuilder().add_agents([writer, reviewer]).build()
`

---

## 6. AG-UI Endpoint (replaces copilot_chat.py)

`python
from fastapi import FastAPI, Depends
from agent_framework.ag_ui import add_agent_framework_fastapi_endpoint
from fastapi.security import APIKeyHeader

app = FastAPI()

# Wire AG-UI endpoint — CopilotKit frontend speaks this protocol natively
add_agent_framework_fastapi_endpoint(
    app,
    agent,                        # Any Agent or Workflow or GitHubCopilotAgent
    "/copilot/chat",
    dependencies=[Depends(verify_api_key)],   # Add auth in production
)
# Run: uvicorn gateway:app --reload
`

AG-UI supports all 7 features: streaming chat, backend tool rendering, HITL confirmation, generative UI, shared state, predictive state updates, interrupt/resume.

---

## 7. Observability (Built-in OTel — no Langfuse SDK needed in agent code)

`python
from agent_framework.observability import configure_otel_providers

# Called ONCE at application startup (e.g., in orchestrator/gateway main.py)
configure_otel_providers(
    OTEL_EXPORTER_OTLP_ENDPOINT="http://langfuse:3000/api/public/otel",
    OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64_pk_sk>",
)
# All agent runs, tool calls, LLM calls auto-emit traces to Langfuse.
# No SDK imports needed in individual agent or skill code.
`

---

## 8. Memory — Three Built-in Layers

MAF has three distinct memory layers. **They are not redundant — each solves a different scope.**

### Layer 1: In-process AgentSession (built-in, zero dependencies)
- Lives in session.state[provider_id] — a plain Python dict
- Survives the duration of ONE agent run/conversation; **lost on process restart**
- Used by ContextProvider.before_run() / fter_run() hooks
- Perfect for: within a single webhook-triggered run

`python
class MyProvider(ContextProvider):
    async def before_run(self, *, agent, session, context, state):
        state.setdefault("user_info", {})
        context.extend_instructions(self.source_id, f"User is: {state['user_info']}")

    async def after_run(self, *, agent, session, context, state):
        # Extract and save to state dict — persists across turns IN THIS SESSION
        state["user_info"]["name"] = extract_name(context)
`

### Layer 2: Redis-backed conversation history (agent-framework-redis)
- RedisHistoryProvider — persists chat **message history** (actual turns) to Redis Lists
- RedisContextProvider — persists arbitrary **context state** to Redis (key-value)
- Survives process restarts; thread-isolated per session_id
- **Uses vanilla edis:7-alpine — no redis-stack needed**

`python
from agent_framework.redis import RedisHistoryProvider

agent = Agent(
    client=OpenAIChatClient(),
    context_providers=[
        RedisHistoryProvider(source_id="chat_history", redis_url="redis://redis:6379"),
    ],
)
`

### Layer 3: Mem0 episodic/semantic memory (agent-framework-mem0 — Phase 2)
- Mem0ContextProvider — agent "remembers" facts across completely different sessions
- Stores/retrieves facts about users/entities using vector similarity search
- Requires Mem0 service (self-hosted or cloud); uses pgvector for storage
- **Phase 2 only** — our Postgres entity graph covers business memory for Phase 0

`python
from agent_framework.mem0 import Mem0ContextProvider

agent = Agent(
    context_providers=[
        Mem0ContextProvider(source_id="episodic_mem", user_id=user_id),
    ],
)
`

---

## 9. Workflows (MAF Native — no DTS needed for Phase 0)

`python
from agent_framework import WorkflowBuilder, WorkflowContext, executor

@executor(id="start")
async def start_step(message: str, ctx: WorkflowContext) -> None:
    result = await ctx.run_agent(triage_agent, message)
    await ctx.yield_output(result)
    # For HITL: submit to Action Broker (Postgres approval_queue), then return.
    # Fresh webhook on approval triggers a new workflow run.

workflow = WorkflowBuilder(start_executor=start_step).build()
`

**DurableTask (for multi-day HITL pauses) is Phase 2.** Add gent-framework-durabletask + DTS emulator Docker service when needed.

---

## 10. Key Links

| Resource | URL |
|---|---|
| GitHub repo | https://github.com/microsoft/agent-framework |
| Python packages dir | https://github.com/microsoft/agent-framework/tree/main/python/packages |
| Package status | https://github.com/microsoft/agent-framework/blob/main/python/PACKAGE_STATUS.md |
| MS Learn docs | https://learn.microsoft.com/en-us/agent-framework/ |
| Context providers samples | https://github.com/microsoft/agent-framework/tree/main/python/samples/02-agents/context_providers |
| AG-UI README | https://github.com/microsoft/agent-framework/tree/main/python/packages/ag-ui |
| Redis package README | https://github.com/microsoft/agent-framework/tree/main/python/packages/redis |
| Mem0 package README | https://github.com/microsoft/agent-framework/tree/main/python/packages/mem0 |
| GitHub Copilot package | https://github.com/microsoft/agent-framework/tree/main/python/packages/github_copilot |
| Workflow samples | https://github.com/microsoft/agent-framework/tree/main/python/samples/03-workflows |
