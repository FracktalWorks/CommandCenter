# GitHub Copilot SDK — Reference & MAF Integration
> Source: pypi.org/project/github-copilot-sdk  
> Stable version: 1.0.0  |  Last verified: 2026-06-04

---

## 1. What the Copilot SDK IS (and is NOT)

The github-copilot-sdk is a **JSON-RPC bridge to the GitHub Copilot CLI process**. It:
- Spawns (or connects to) the Copilot CLI binary via stdio or TCP
- Manages CopilotSession instances (each session = one conversation with the model)
- Handles the internal reasoning/tool loop, streaming, context compaction
- Supports BYOK (custom OpenAI-compatible endpoints), MCP servers, streaming, telemetry

It is **NOT**:
- A memory system (no built-in cross-session memory)
- An orchestration system (no multi-agent routing)
- An observability system (no tracing unless you configure OTLP)

In CommandCenter, the Copilot SDK is **only used inside GitHubCopilotAgent** (MAF wrapper) and inside mutation containers (cb-mutation-runner). It is never called directly by application code.

---

## 2. Install

`ash
pip install github-copilot-sdk                    # stable 1.0.0
pip install "github-copilot-sdk[telemetry]"       # + OpenTelemetry support
# Requires Python 3.11+
# Requires GitHub Copilot CLI installed and accessible in PATH
`

---

## 3. Core API

### CopilotClient — lifecycle

`python
from copilot import CopilotClient
from copilot.session import PermissionHandler

# Spawn CLI and connect (async context manager — recommended)
async with CopilotClient() as client:
    async with await client.create_session(
        on_permission_request=PermissionHandler.approve_all,
        model="gpt-5",            # or "claude-sonnet-4-5"
        streaming=True,
        mcp_servers={             # Inject tool servers (Integration Registry pattern)
            "clickup": {"command": "uvx", "args": ["mcp-clickup"], "env": {...}},
        },
        provider={                # BYOK — route through gateway /v1 (litellm SDK)
            "type": "openai",
            "base_url": "http://127.0.0.1:8080/v1",
            "api_key": "sk-...",
        },
        infinite_sessions={       # Auto context compaction (default: enabled)
            "enabled": True,
            "background_compaction_threshold": 0.80,
        },
    ) as session:
        await session.send("Hello!")
`

### CopilotClient constructor key parameters

| Parameter | Purpose |
|---|---|
| connection | RuntimeConnection.for_stdio() (default), .for_tcp(), .for_uri() |
| github_token | Token for auth (bypasses interactive login) |
| ase_directory | Where CLI stores session state, config (~/.copilot default) |
| 	elemetry | {"otlp_endpoint": "http://..."} — enables OTel trace export |
| session_idle_timeout_seconds | Auto-cleanup idle sessions |

### create_session() key parameters

| Parameter | Purpose |
|---|---|
| model | "gpt-5", "claude-sonnet-4-5", etc. |
| system_message | {"mode": "append"/"replace", "content": "..."} |
| 	ools | Custom tools (@define_tool or raw Tool objects) |
| mcp_servers | Dict of MCP server configs — used for Integration Registry |
| provider | BYOK config (OpenAI-compatible endpoint) |
| streaming | Enable delta events |
| infinite_sessions | Context window auto-compaction config |
| on_permission_request | Called before each tool execution (approve/deny) |
| on_user_input_request | Handler for sk_user tool |
| hooks | on_pre_tool_use, on_post_tool_use, on_session_start, etc. |

---

## 4. How MAF's GitHubCopilotAgent Wraps the SDK

`
Application code
     │
     ▼
GitHubCopilotAgent (MAF class — agent-framework-github-copilot)
     │
     ├── Inherits BaseAgent + AgentMiddlewareLayer + AgentTelemetryLayer
     ├── Accepts: instructions, tools (MAF FunctionTool), context_providers, middleware
     ├── Translates MAF FunctionTool → CopilotTool (JSON schema + handler)
     ├── Calls context_providers.before_run() → builds enriched prompt
     │
     ▼
CopilotClient.create_session() (github-copilot-sdk)
     │
     ├── Forwards: model, system_message, mcp_servers, provider, tools
     ├── Runs internal reasoning/tool loop (SDK-managed)
     ├── Emits streaming delta events → MAF wraps as AgentResponseUpdate
     │
     ▼
CopilotSession.send_and_wait() / send()
     │
     ▼
AgentResponse → context_providers.after_run() → returns to caller
`

**Key design facts:**
- GitHubCopilotAgent participates in HandoffBuilder/ConcurrentBuilder orchestrations identically to a standard Agent  
- The SDK handles the model reasoning loop; MAF handles everything outside (routing, memory, tracing, HITL)
- All MAF context providers (including RedisHistoryProvider, custom providers) work with GitHubCopilotAgent  
- Per-run middleware is NOT supported by GitHubCopilotAgent (SDK controls the tool loop); use agent-level middleware only

---

## 5. Session State and Memory

The Copilot SDK has **NO built-in cross-session memory**. What it does have:
- **Infinite sessions**: Auto-compacts conversation context window when it fills up (keeps recent + summarizes old). This is a context-window management feature, NOT persistent memory.
- **Session state files**: CLI stores session state in ~/.copilot/session-state/{session_id}/ for resumption within the same CLI process. Cleared on client.stop().

Cross-session memory (e.g., "remember this customer prefers email") requires MAF context providers (RedisContextProvider, Mem0ContextProvider) layered on top.

---

## 6. Telemetry

`python
client = CopilotClient(
    telemetry={
        "otlp_endpoint": os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"],  # generic OTLP backend (TBD; Langfuse removed)
    }
)
`

When using GitHubCopilotAgent via MAF, telemetry is handled at the MAF level via configure_otel_providers(). You do NOT configure the SDK telemetry separately — MAF's OTel layer covers the whole agent run including Copilot SDK calls.

---

## 7. BYOK (Bring Your Own Key) — LiteLLM integration

`python
# In GitHubCopilotAgent default_options:
default_options={
    "provider": {
        "type": "openai",                           # LiteLLM is OpenAI-compatible
        "base_url": "http://127.0.0.1:8080/v1",       # gateway /v1 (litellm SDK)
        "api_key": os.environ["LITELLM_MASTER_KEY"],
    },
    "model": "tier-1",   # LiteLLM alias (maps to claude-haiku or gpt-4o-mini)
}
`

This routes ALL Copilot SDK model calls through LiteLLM, which means:
- LiteLLM cost tracking applies
- Model aliases (tier-1/2/3) work
- GitHub token auth is bypassed

---

## 8. Tools

`python
from copilot import define_tool
from pydantic import BaseModel, Field

class LookupParams(BaseModel):
    id: str = Field(description="Issue ID")

@define_tool(description="Fetch issue details")
async def lookup_issue(params: LookupParams) -> str:
    return await fetch_issue(params.id)

# Pass to session:
session = await client.create_session(tools=[lookup_issue], ...)

# In GitHubCopilotAgent: pass as MAF @tool decorated functions — auto-translated
@tool(approval_mode="always_require")   # requires on_function_approval callback
def write_back_to_crm(data: dict) -> str: ...
`

---

## 9. Permission Handling

`python
from copilot.session import PermissionHandler

# Approve all (dev/sandbox only):
on_permission_request=PermissionHandler.approve_all

# Custom (production — gate shell/write operations):
def on_permission_request(request, invocation):
    match request:
        case PermissionRequestShell(full_command_text=cmd):
            return PermissionDecisionReject(feedback="Shell denied")
        case _:
            return PermissionDecisionApproveOnce()
`

In CommandCenter: mutation containers use pprove_all (isolated sandbox). Background MAF agents use deny_all by default; specific write-backs go through Action Broker, not shell tools.

---

## 10. Key Links

| Resource | URL |
|---|---|
| PyPI | https://pypi.org/project/github-copilot-sdk/ |
| GitHub Copilot CLI | https://docs.github.com/en/copilot/github-copilot-in-the-cli |
| GitHubCopilotAgent source | https://github.com/microsoft/agent-framework/blob/main/python/packages/github_copilot/agent_framework_github_copilot/_agent.py |
| MAF GitHub Copilot package | https://github.com/microsoft/agent-framework/tree/main/python/packages/github_copilot |
| MAF multi-agent workflows | https://docs.github.com/en/copilot/how-tos/copilot-sdk/integrations/microsoft-agent-framework#multi-agent-workflows |
| Getting started | https://docs.github.com/en/copilot/how-tos/copilot-sdk/getting-started |
| Custom agents / sub-agents | https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents |
| Custom skills | https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/skills |

---

## 11. Multi-Agent Orchestration Patterns (from official docs)

> Source: https://docs.github.com/en/copilot/how-tos/copilot-sdk/integrations/microsoft-agent-framework

### The canonical pattern: `agent.as_tool()`

Every MAF agent (including GitHubCopilotAgent) can expose itself as a callable tool for any other agent:

```python
from agent_framework import Agent
from agent_framework.openai import OpenAIChatCompletionClient

specialist = Agent(
    client=client,
    name="sales-specialist",
    instructions="You handle outbound prospecting using the available tools.",
    tools=[zoho_search, prospect_finder, ...],
)

# Expose as a FunctionTool — the description is what the orchestrator LLM reads
tool = specialist.as_tool(
    name="sales_specialist",
    description="7-step B2B outbound prospecting, lead scraping, Zoho CRM. Use for sales tasks.",
)

# Orchestrator uses it just like any other tool
orchestrator = Agent(
    client=client,
    name="orchestrator",
    instructions="Route to specialist tools based on user request.",
    tools=[retrieve_entity_context, sales_specialist_tool, task_manager_tool, ...],
)
```

**This is how CommandCenter's dynamic capability registry works** — every registered agent becomes a tool via `as_tool()` at gateway startup.

### Sequential workflow (WorkflowBuilder)

Use `WorkflowBuilder` with `add_chain()` for multi-step pipelines where each agent feeds the next:

```python
from agent_framework import WorkflowBuilder

wf = WorkflowBuilder(
    start_executor=research_agent,
    output_from="all",
)
wf.add_chain([research_agent, writer_agent, reviewer_agent])
workflow = wf.build()
result = await workflow.run("Analyze and document the auth module")
```

### Parallel (fan-out / fan-in)

```python
wf = WorkflowBuilder(start_executor=coordinator)
wf.add_fan_out_edges(coordinator, [security_agent, performance_agent])
wf.add_fan_in_edges([security_agent, performance_agent], synthesiser)
workflow = wf.build()
```

### MAF primitives available in this install

| Primitive | Use for |
|---|---|
| `Agent.as_tool()` | Expose any agent as a callable tool (zero-code routing) |
| `WorkflowBuilder.add_chain()` | Sequential pipeline A→B→C |
| `WorkflowBuilder.add_fan_out_edges()` | Parallel execution (scatter) |
| `WorkflowBuilder.add_fan_in_edges()` | Aggregate parallel results (gather) |
| `WorkflowBuilder.add_switch_case_edge_group()` | Conditional branching |
| `FunctionalWorkflow` | Fully code-driven workflow DAG |

Note: `HandoffBuilder` and `ConcurrentBuilder` shown in older MAF docs are NOT present in this install — use `WorkflowBuilder` directly.

---

## 12. Custom Agents (sub-agent delegation inside a single SDK session)

> Source: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents

This is a **Copilot SDK feature** (not MAF-level) — define lightweight agents within a single `CopilotClient` session. Each sub-agent has its own `prompt`, `tools` allowlist, and optional `mcpServers`. The runtime auto-delegates based on the `description`.

```python
session = await client.create_session(
    custom_agents=[
        {
            "name": "researcher",
            "description": "Explores codebases and answers questions using read-only tools",
            "tools": ["grep", "glob", "view"],
            "prompt": "You are a research assistant. Analyze code, never modify files.",
            "infer": True,  # runtime auto-selects based on user intent
        },
        {
            "name": "editor",
            "description": "Makes targeted code changes",
            "tools": ["view", "edit", "bash"],
            "prompt": "You make minimal, surgical changes.",
        },
    ],
    on_permission_request=PermissionHandler.approve_all,
)
```

**Key facts:**
- `description` is the routing signal — the runtime matches user intent to agent description
- `infer: False` disables auto-selection (user must explicitly invoke)
- Sub-agent lifecycle events: `subagent.started`, `subagent.completed`, `subagent.failed`, `subagent.selected`
- Use `defaultAgent.excludedTools` to force the main agent to delegate heavy tools to sub-agents

**CommandCenter usage:** custom agents inside a single `GitHubCopilotAgent` session are useful for self-contained specialisation within the mutation container (e.g., a researcher sub-agent reads code, an editor sub-agent writes fixes). For cross-repo agent routing, use MAF `as_tool()` instead.

---

## 13. Custom Skills (SKILL.md in the Copilot SDK sense)

> Source: https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/skills

The Copilot SDK has its own skills concept: a directory of `SKILL.md` files loaded via `skill_directories`. When loaded, the skill content is injected into the session context.

```python
session = await client.create_session(
    skill_directories=["./skills/security", "./skills/testing"],
    custom_agents=[{
        "name": "security-auditor",
        "skills": ["security-scan"],  # eagerly preloaded into this sub-agent
        "prompt": "Focus on OWASP Top 10",
    }],
)
```

**Relationship to CommandCenter's `skills/*/SKILL.md`:**
- CommandCenter's `_build_system_prompt()` already does the same thing manually — reads all `skills/*/SKILL.md` files and appends them to the system prompt
- If using `GitHubCopilotAgent` directly, you could instead pass `skill_directories=["skills"]` to the underlying SDK session and let the CLI load them natively
- Current CommandCenter approach (manual concatenation) is equivalent and more explicit; either works
