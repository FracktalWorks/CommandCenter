# Multi-Agent Orchestration — Architecture & Work Plan

**Status:** proposed · **Date:** 2026-07-17 · **Owner:** Vijay
**Scope:** how MAF agents and GitHub Copilot SDK agents delegate to each other today, and the
backbone for the future visual workflow editor.

Every claim marked ✅ below was **verified by execution** against the live VPS
(`agent-framework-core==1.8.1`) or an isolated throwaway venv (`core==1.11.0` +
`orchestrations==1.0.0`). Reproduction commands are in [§8](#8-appendix--reproduction).

---

## 1. Executive summary

1. **The email hand-off failure was not an orchestration gap.** `call_agent` exists and is
   injected everywhere. `technical-project-planner`'s `config.json: tool_scope` omitted it, and
   `_CORE_STANDARD_TOOL_NAMES` doesn't rescue it — so it was silently stripped. Meanwhile the
   system-prompt addendum **described `call_agent` anyway** and listed `email-assistant` by name.
   The agent was misinformed, not confused. **Fix: ~2 lines.**

2. **We already have the workflow backbone.** `WorkflowBuilder` + `AgentExecutor` ship in
   `agent-framework-core`, which we have. A graph mixing a native MAF agent and a Copilot SDK
   agent **builds and runs today** ✅ — no adapter, no new dependency.

3. **`BaseAgent` / `SupportsAgentRun` is the unification layer.** Both runtimes conform. This is
   the single most important architectural fact in this document; everything else follows.

4. **4 of MAF's 5 pre-built orchestrations accept mixed runtimes. `HandoffBuilder` does not** ✅ —
   it hard-rejects `GitHubCopilotAgent`. Ironic, given "handoff" is what we set out to build; but
   handoff is also **the wrong pattern** for our case (see [§5.1](#51-handoff-is-the-wrong-pattern-for-our-case)).

5. **Phases 0–3 need no dependency change at all** ✅ — ship them on core 1.8.1 first. The framework
   uplift to current (core 1.11 + satellites) is a **separate, worthwhile cycle** — not just the price
   of orchestrations, but a **maintenance dividend** that retires ≥4 live workarounds (§5.5). Its cost
   is two forced vendor-SDK majors + one breaking AG-UI change (§4.0/§7). Sequence it after Phases 0–1,
   before/merged-with Phase 5 — not folded into the bug-fix.

---

## 2. What actually broke

### 2.1 The chain

```
planner needs to email a file
  → reaches for call_agent            → NOT in its tool schema  (scope stripped it)
  → falls back to Copilot SDK's built-in Task/"general-purpose agent"
                                      → GitHub OAuth error (we run BYOK)  ← the decoy
  → falls back to shell mail clients  → none installed
  → gives up, tells the user to do it manually
```

Only the first link is real. Everything after is fallback flailing that generated unrelated errors.

### 2.2 Root cause A — `call_agent` is not in the guaranteed floor

`_CORE_STANDARD_TOOL_NAMES` ([`_tool_injection.py:41-48`](../../apps/services/orchestrator/orchestrator/_tool_injection.py#L41-L48))
guarantees every tool an agent needs to **work alone** — and not one tool it needs to **hand off**:

```
web_search, fetch_page, write_artifact, share_artifact, manage_todo_list,
ask_questions, run_diagnostics, get_errors, save_note, recall_notes
```

The planner's declared scope:

```json
"tool_scope": ["web_search","fetch_page","write_artifact",
               "manage_todo_list","ask_user","save_note","recall_notes"]
```

Verified effective toolset on prod ✅:

```
ask_questions, ask_user, fetch_page, get_errors, manage_todo_list,
recall_notes, run_diagnostics, save_note, share_artifact, web_search, write_artifact

call_agent injected? False
```

This is a **live latent bug in `apis-config` too** — its scope also omits `call_agent`, so it
cannot delegate to anything. Three of four in-repo agents remembered to list it. The convention is
held together by remembering to type one line.

> Side finding: `ask_user` in that scope matches **no injected tool** (the real name is
> `ask_questions`). It silently no-ops. Nothing warns.

### 2.3 Root cause B — the addendum lies (the one that actually misled the model)

```python
def _build_injected_tools_addendum(*, is_sub_agent: bool = False) -> str:
```

No `tool_scope` parameter. It is **scope-blind by construction**. Verified on prod ✅:

```
addendum MENTIONS call_agent?   True
addendum lists email-assistant? True
```

So the planner's prompt described a tool it did not have, and named the exact agent to send it to.
That is why the transcript reads *"the call_agent function isn't wired here"* and *"let me try the
email-assistant agent directly"* — it knew the name **only** because the prompt supplied it.

### 2.4 Measured cost of the scope-blind addendum ✅

| Block | ~tokens | note |
|---|---:|---|
| **Full addendum** (per Copilot agent, per turn) | **7,827** | describes ~30 tools |
| ├─ design.md | 4,078 | injected unconditionally |
| └─ registry (all agents know all agents) | 416 | **5% of the total** |
| Sub-agent compact addendum | 1,227 | for comparison |

The planner receives **11 tools and a 7,827-token prompt describing ~30 of them.**

**Note for the "reduce clutter via hub-and-spoke" proposal:** the inter-agent awareness this would
remove is **416 tokens — 5%**. It would leave ~95% of the measured cost untouched while adding a
routing hop. The clutter is the scope-blind addendum and unconditional design.md, not the topology.

---

## 3. Verified capability matrix

### 3.1 The substrate — both runtimes conform ✅

```
native MAF Agent : Agent → AgentMiddlewareLayer → AgentTelemetryLayer → RawAgent → BaseAgent
Copilot SDK      : GitHubCopilotAgent → BaseAgent          ← NOT an `Agent` subclass

isinstance(maf_agent,     SupportsAgentRun) → True
isinstance(copilot_agent, SupportsAgentRun) → True
```

`AgentExecutor(agent: SupportsAgentRun, *, session, id, context_mode, context_filter)` accepts a
**runtime-checkable structural protocol**, not a class. Required members:
`name, description, id, create_session, get_session, run`. `create_session`/`get_session` come from
the shared `BaseAgent`; `run` from each runtime; `name`/`description`/`id` are set in `__init__`.

> ⚠️ **Gotcha that will bite anyone re-checking this:** a *class-level* `hasattr` reports **both**
> runtimes as non-conforming, because three required members are instance attributes. Test
> instances, never classes, or you will reach the opposite conclusion.

### 3.2 Mixed-runtime graph — builds today on core 1.8.1 ✅

```python
maf = Agent(client, "…", name="maf-node")
cop = GitHubCopilotAgent(name="copilot-node", instructions="…")
wf  = (WorkflowBuilder(start_executor=AgentExecutor(maf, id="a"))
       .add_edge(AgentExecutor(maf, id="a"), AgentExecutor(cop, id="b"))
       .build())
# -> MIXED-RUNTIME WORKFLOW BUILT OK -> Workflow
```

`as_tool()` also works on both → `FunctionTool` / `FunctionTool`.

### 3.3 Pre-built orchestrations — mixed-runtime support ✅

Tested in an isolated venv (`core==1.11.0`, `orchestrations==1.0.0`):

| Builder | Package | Mixed MAF + Copilot | Constraint found by execution |
|---|---|:---:|---|
| `WorkflowBuilder` + `AgentExecutor` | **core (have it)** | ✅ | none |
| `SequentialBuilder` | orchestrations | ✅ | — |
| `ConcurrentBuilder` | orchestrations | ✅ | needs ≥2 targets |
| `GroupChatBuilder` | orchestrations | ✅ | participants are `SupportsAgentRun`; **`orchestrator_agent` must be a native MAF `Agent`** |
| `MagenticBuilder` | orchestrations | ✅ | manager is `StandardMagenticManager(agent: SupportsAgentRun)` — **a Copilot agent can be the manager** |
| **`HandoffBuilder`** | orchestrations | ❌ | **hard TypeError** (below) |

```
Handoff Copilot-only -> TypeError: Participants must be Agent instances. Got GitHubCopilotAgent.
                        Handoff workflows require Agent because they rely on cloning, tool
                        injection, and middleware…
Handoff MAF-only     -> ValueError: Handoff workflows require all participant agents to have
                        'require_per_service_call_history_persistence=True'.
```

Confirmed by the docs: *"Handoff orchestration only supports `Agent` and the agents must support
local tools execution."*

### 3.4 Dependency reality ✅ (PyPI, 2026-07-18)

```
agent-framework-orchestrations  latest 1.0.0   requires core <2,>=1.9.0
prod today: agent-framework-core 1.8.1                        ← below that floor

Latest satellites all pin core >=1.11.0 → coupled, move together:
  agent-framework-openai         1.10.1  requires core>=1.11.0 + openai>=2.25 (was 1.99 → MAJOR)
  agent-framework-github-copilot 1.0.0rc3 requires core>=1.11.0 + github-copilot-sdk==1.0.2 (was 0.1.32 → MAJOR)
  agent-framework-ag-ui          1.0.0rc8 requires core>=1.11.0
  agent-framework-redis          1.0.0b260521  already current, needs only core>=1.6.0
```

**Two shapes of upgrade.** (a) *Minimal:* core→1.9/1.10 + orchestrations, satellites untouched (they
only need `core <2`) — unlocks Phase 5, dodges both SDK majors. (b) *Full:* core→1.11 + all satellites
latest — required to reach the copilot-side fixes in §5.5, but drags **two vendor-SDK majors** (openai
1.99→2.x, github-copilot-sdk 0.1.32→1.0.2) and one breaking AG-UI change. The full-set resolves to
`core 1.11.0` in an isolated venv ✅. Prove which path resolves before committing (Phase 4.1).
(Note: `OpenAIChatCompletionClient` already takes `model=` on 1.8.1 — no `model_id` churn; the real
churn is the two underlying SDK majors, not the framework client surface.)

### 3.5 Capacity ✅ (my earlier memory concern was overblown)

```
RAM   : 3915 MB total · 2805 MB available · gateway RSS ≈ 418 MB · swap 4 GB (137 MB used)
Disk  : 48 G total · 23 G available · agent clones 3.5 G
        (commandcenter-dev 2.1 G, agent-sales-assistant 1.4 G — everything else < 10 MB)
```

Agents run **in-process on a shared venv**, so `sys.modules` is shared and the marginal cost of an
extra node is the agent object + its tools, not a new interpreter. Multi-agent workflows are very
likely fine. **Still measure in Phase 2** — but this is not the blocker I previously implied.

---

## 4. Target architecture — four layers

```
┌── L3  Pre-built orchestrations (Phase 5 — needs the Phase-4 uplift, core ≥1.9)
│       Sequential · Concurrent · GroupChat · Magentic     [mixed-runtime OK]
│       Handoff                                             [MAF-only — excluded]
├── L2  Designed workflows  ← the workflow-editor backbone   [core 1.8.1, have it]
│       WorkflowBuilder + AgentExecutor · graph authored in the editor
│       deterministic · traceable · checkpointable · per-node context control
├── L1  Conversational delegation  ← fixes the email bug     [core 1.8.1, have it]
│       call_agent / call_agents_parallel / call_agent_background
│       model-decided · ad-hoc · lazy-loaded · agent-as-tools semantics
└── L0  Substrate: BaseAgent / SupportsAgentRun              [nothing to do]
        both runtimes already conform
```

**L1 and L2 are complementary, not competing** — same substrate, different decision-maker:

| | L1 `call_agent` | L2 `Workflow` |
|---|---|---|
| Who decides the route | the **model**, mid-conversation | the **graph**, authored up front |
| Shape | ad-hoc, bounded subtask | designed pipeline |
| Loading | **lazy** — one repo at call time | eager — all nodes live |
| Determinism | none | full, traceable |
| Answers | "planner needs an email sent" | "run the weekly report pipeline" |

---

## 5. Decisions & rationale

### 5.1 Handoff is the wrong pattern for our case

Microsoft's own distinction:

> **Handoff** — control is explicitly passed; the receiving agent takes **full ownership** of the
> task and the conversation. **Agent-as-tools** — a primary agent delegates a subtask; once done,
> **control returns to the primary agent**, which retains overall responsibility and manages context.

The planner needed an email sent. The user is talking to the **planner** about a project plan — they
should not be dumped into the email agent. Control must return. That is **agent-as-tools**, which is
exactly what `call_agent` implements.

So `HandoffBuilder`'s Copilot restriction **does not block us** — we were never going to use it for
this. (Note also: MAF's handoff is internally a **mesh** — *"agents are connected directly without an
orchestrator"* — so even Microsoft's handoff is not hub-and-spoke.)

### 5.2 Keep `call_agent`; do not replace it with `as_tool()`

`call_agent` is a **lazy `as_tool()` over a dynamic registry**, plus guards MAF doesn't ship:

| | MAF `as_tool()` | our `call_agent` |
|---|:---:|:---:|
| HITL gate | `approval_mode` | `request_confirmation` (fails closed) |
| Sub-agent streaming | `stream_callback` | `_run_sub_agent_streaming` |
| **Lazy repo load** | ✗ needs a live instance | ✅ loads at call time |
| Cycle detection | ✗ | ✅ `_delegation_refusal` |
| Depth cap | ✗ | ✅ `_MAX_DELEGATION_DEPTH=2` |
| Timeout / tier inheritance | ✗ | ✅ |

`as_tool()` requires an **instantiated** agent. Using it for delegation would mean cloning and
building every potential delegate at load time — 8 repos, 3.5 GB, to answer one question. Our
registry is dynamic and lazily cloned; `call_agent` is the right abstraction **for L1**. We are not
behind MAF here.

### 5.3 The workflow editor *is* the orchestrator — a designed one

The hub-and-spoke instinct is right that coordination should be centralised. It lands at **L2**, not
L1: the graph is the central authority, authored by a human, deterministic and traceable. This is
strictly better than Magentic's LLM-in-the-routing-loop for our case, and it avoids the
[information-bottleneck failure mode](https://claude.com/blog/multi-agent-coordination-patterns)
Anthropic documents for orchestrator patterns. Users chat directly with specialists, so no hub is
in the loop for L1 anyway.

### 5.4 Context discipline belongs at the node, not the topology

`AgentExecutor(context_mode='full' | 'last_agent' | 'custom', context_filter=…)` gives **per-node**
control over what each agent sees. That is a first-class knob that directly serves the
"avoid clutter" goal — and it needs no topology change.

### 5.5 The framework uplift is a maintenance dividend, not just orchestrations

**Phases 0–3 need zero dependency changes** — keep them on core 1.8.1 and ship them first. But the
uplift to current (core 1.11 + satellites) is **not** merely the price of the orchestrations package,
as an earlier draft framed it. Reading the actual changelogs (core 1.9→1.11, copilot-sdk 0.1.32→1.0.x),
the release wave fixes a cluster of bugs we currently **hand-work-around** — so the uplift lets us
*delete* shim code, not just add features. Confirmed still-live in our tree:

| Upstream fix | Version | Shim it retires (verified present) |
|---|---|---|
| Copilot SDK exposes `tokenPrices` + **context-window limits** on public types | copilot-sdk 1.0.2 | `COPILOT_INFINITE_SESSIONS` window-guessing (`_copilot_session.py`) |
| "Disable harness compaction when max tokens not provided" (#6410) | core 1.9.0 | same false "context length exceeded", framework side |
| github-copilot function approval via `on_pre_tool_use` hook (#6750) + tool-approval middleware (#6414/#6522) | core 1.10/1.9 | `_gate_injected_tool` (exists only because `on_permission_request` skips injected tools) |
| Telemetry-context fixes: background ctx error (#6764), OTel parent ctx for deferred streams (#6709), span nesting (#6552) | core 1.10.0 | the **telemetry killswitch** — we disabled instrumentation over the ContextVar-reset bug |
| Message-injection middleware — enqueue into an active run (#6998) | core 1.11.0 | native-MAF `_nq` steering queue + write_artifact steering |
| Structured-response parse fix — avoids spurious `ValidationError`/`JSONDecodeError` (#6383) | core 1.11.0 | JSON-mode fragility ([[llm-json-mode-required]]) |
| `defer` / `toolSearch` native lazy tool loading + progressive MCP disclosure (#6850) | copilot-sdk 1.0.2/1.0.7, core 1.11 | hand tool-count management in `_CORE_STANDARD_TOOL_NAMES` |

Each row is a place we could remove code. That is a maintenance dividend, not a feature wishlist — and
it is why the uplift is worth scheduling **sooner than "only when we need Magentic/GroupChat."** Every
release we skip, we keep maintaining shims for bugs already fixed upstream; the debt compounds.

**The catch is real too:** the good fixes concentrate in core 1.11 + copilot-sdk 1.0.2 — i.e. the full
coordinated bump (§3.4), which drags **two vendor SDK majors** (openai 1.99→2.x, github-copilot-sdk
0.1.32→1.0.2) and **one breaking AG-UI change** (interrupt/resume canonicalization, #6925) against our
most-customized subsystem. So it is a genuine investment with a genuine payoff — scoped as its own
cycle (Phase 4), not folded into the Phase 0 bug-fix. When adopting orchestrations, still expose
Magentic/GroupChat as **node types inside a graph**, not a parallel top-level architecture.

### 5.6 Collaborative multi-agent chat — the three shapes of "collaboration" *(deferred design note)*

"Multiple agents collaborating" is not one thing. It is three, and only the third needs a runtime
coordinator ("orchestrator"). Getting this distinction wrong leads to building L3 machinery for
problems L1/L2 already solve.

| Shape | What it is | Coordinator | Layer |
|---|---|---|---|
| **A. One owner pulls in helpers** | The conversation-owning agent delegates bounded subtasks; control returns to it | none — the owning agent **is** the coordinator | **L1** `call_agent` (agent-as-tools) |
| **B. Designed pipeline** | Fixed flow (planner → researcher → reviewer) authored up front | none — the **graph** coordinates, deterministically | **L2** `WorkflowBuilder` |
| **C. Free-form room** | Agents share one conversation, see each other's messages, dynamically build on them / take turns | **required** — something must pick who speaks next | **L3** `GroupChatBuilder` / `MagenticBuilder` |

**The user's "do I need an orchestrator for multi-agent chat?" resolves to: only for Shape C.**
Shapes A and B collaborate with no orchestrator.

**Shape C's coordinator does NOT have to be an LLM agent.** `GroupChatBuilder` rejects an unconfigured
call with: *"No orchestrator has been configured. Pass `orchestrator_agent`, `orchestrator`, or
`selection_func`."* (evidence: the constructor's own error message, not a positive build test). So the
"who speaks next" decision has three implementations, cheapest first:

1. **`selection_func`** — a plain Python function (round-robin, rule-based). No LLM, no per-turn cost,
   deterministic. Most "collaboration" is really just turn-taking and lands here.
2. **`orchestrator_agent`** — an LLM agent that reads the conversation and chooses. Flexible; adds a
   model call per turn. **Typed as a native MAF `Agent`** — so keep the selector MAF-side.
3. **Magentic manager** — `StandardMagenticManager(agent: SupportsAgentRun)`; also **plans** and tracks
   progress for open-ended tasks. Verified ✅: the manager may be a **Copilot** agent.

**Mixed-runtime support for Shape C** (verified ✅): the *participants* (collaborating agents) can be
mixed MAF + Copilot in both `GroupChat` and `Magentic`. The only runtime constraint is on the
*coordinator role* — GroupChat's `orchestrator_agent` is MAF-typed (sidestepped entirely by using a
`selection_func`); Magentic's manager accepts either runtime.

**Caveat before building Shape C:** Anthropic's
[coordination-patterns writeup](https://claude.com/blog/multi-agent-coordination-patterns) flags
free-form multi-agent chat as the *least predictable* pattern — agents duplicate work or talk past
each other without firm turn-taking + termination rules. It is the most impressive demo and the least
reliable in production. Before reaching for Shape C, ask whether a **Shape B designed workflow**
produces the same outcome with full traceability. Prefer B unless the collaboration genuinely must be
dynamic and open-ended.

---

## 6. Work plan

### Phase 0 — Fix the hand-off *(≈half a day · no deps · unblocks email today)*

| # | Change | File |
|---|---|---|
| 0.1 | Add `call_agent`, `call_agents_parallel`, `call_agent_background` to `_CORE_STANDARD_TOOL_NAMES` | `_tool_injection.py` |
| 0.2 | Thread `tool_scope` into `_build_injected_tools_addendum(*, is_sub_agent, tool_scope)`; emit only sections for tools actually injected | `_tool_injection.py` |
| 0.3 | Warn when a `tool_scope` entry matches no known tool (catches `ask_user`) | `_tool_injection.py` |
| 0.4 | Tests: floor includes delegation; addendum omits un-injected tools; scope-typo warns | `tests/unit/test_core_tool_floor.py` |

**Safety:** adding `call_agent` to the floor means every agent can reach every agent. Blast radius
stays bounded — each target's own `request_confirmation` gate still requires a human, and
`_delegation_refusal` + depth cap already guard recursion.
**Done when:** the planner can email a file via `call_agent("email-assistant", …)`, attaching
`technical-project-planner:outputs/…` (that cross-workspace syntax **already works**).

### Phase 1 — Context discipline *(≈1 day · no deps)*

- **1.1** Gate `design.md` (4,078 tok) on need — skip for agents that never render documents/UI.
- **1.2** Trim registry descriptions to one line. `technical-project-planner`'s entry is a
  ~150-token paragraph of trigger keywords inflicted on **every other agent**; that belongs in its
  own instructions. This is what makes the mesh scale past 50 agents.
- **1.3** Re-measure. Target: **7,827 → under 2,000** for a scoped agent.

### Phase 2 — Workflow runtime *(≈1 week · no deps — core 1.8.1 suffices)*

- **2.1 Multi-loader.** `ExitStack` over N `load_agent()` contexts. Today `load_agent` is a
  context manager yielding **one** agent per run; a graph needs N live at once. **This is the real
  work.**
- **2.2 Per-node tool injection.** Apply each node's `tool_scope` independently (depends on Phase 0.2).
- **2.3 Graph spec.** Versioned JSON: nodes (`agent_name`, `tool_scope?`, `context_mode`,
  `context_filter?`), edges (incl. `switch_case` / `fan_out` / `fan_in`), `start`, `output_from`.
  **This is the editor's save format — design it before the UI.**
- **2.4 Compiler.** spec → `AgentExecutor` per node → `WorkflowBuilder` → `.build()`.
  Pass `output_from=` explicitly (omitting it is **deprecated** and will break).
- **2.5 Runner + streaming.** Bridge workflow events to the existing SSE relay; reuse the
  `SUB_AGENT_*` event shape.
- **2.6 Measure memory** with all 8 agents live; confirm §3.5.

**Editor vocabulary is already covered by core:** `add_chain`, `add_edge`, `add_fan_out_edges`,
`add_fan_in_edges`, `add_switch_case_edge_group`, `add_multi_selection_edge_group`.

### Phase 3 — Workflow editor UI *(≈1 week)*

Node palette from the live registry · canvas → graph spec · save/load · run + live trace.

### Phase 4 — Framework uplift & migration to latest *(≈1–2 weeks · its own hardening cycle)*

Migrate the whole `agent-framework` stack to current. Justified by the **workaround dividend** (§5.5),
not just orchestrations. Do this **after Phases 0–1 ship** (they need no deps) and **before/merged-with
Phase 5** (orchestrations needs core ≥1.9 anyway). Scope it as a standalone cycle — never fold it into
the Phase 0 bug-fix.

**4.0 — Version target (verified on PyPI 2026-07-18).** The satellites are coupled: openai/copilot/ag-ui
*latest* all pin `core >=1.11.0`, so they move together. It is one coordinated bump, not piecemeal.

| Package | Installed | Target | Bump drags in |
|---|---|---|---|
| agent-framework-core | 1.8.1 | **1.11.0** | — |
| agent-framework-openai | 1.7.0 | **1.10.1** | **openai 1.99 → 2.x** (SDK major) |
| agent-framework-github-copilot | 1.0.0b260402 | **1.0.0rc3** | **github-copilot-sdk 0.1.32 → 1.0.2** (SDK major) |
| agent-framework-ag-ui | 1.0.0rc3 | **1.0.0rc8** | breaking interrupt/resume (#6925) |
| agent-framework-redis | 1.0.0b260521 | 1.0.0b260521 | **already current — no change** |
| agent-framework-orchestrations | *(none)* | **1.0.0** | needs core ≥1.9 (satisfied) |
| github-copilot-sdk | 0.1.32 | 1.0.2 | **pinned exactly** by copilot rc3 (not 1.0.7) |

> **Minimal-bump fallback:** if the full jump proves too costly, orchestrations needs only **core ≥1.9**,
> and our *currently-installed* satellites only require `core <2` — so core→1.9/1.10 + orchestrations,
> leaving both vendor SDKs untouched, is a lighter path that still unlocks Phase 5 while dodging the two
> SDK majors. Prove which resolves in an isolated venv (4.1).

**4.1 — Resolution proof (isolated venv, throwaway).** `uv venv` in `/tmp`; `uv pip install` the target
set; capture the fully-resolved version lock. **Never touch `/opt/acb/app/.venv`.** Confirm the two SDK
majors resolve and import. Decide full-bump vs minimal-bump here on evidence.

**4.2 — Land the coordinated bump.** Update the four `pyproject.toml` pins (orchestrator, gateway,
agent-email-assistant, agent-task-manager); `uv sync`. redis unchanged.

**4.3 — Absorb the two forced SDK majors.** openai 1.99→2.x and github-copilot-sdk 0.1.32→1.0.2 are the
real risk (7/8 agents ride the Copilot path). Re-verify against [[maf-agent-openai-client-choice]] and
[[copilot-sdk-context-window-unknown]]; check session/tool API shape on copilot-sdk 1.0.2.

**4.4 — Migrate the one breaking AG-UI change (#6925).** Interrupt/resume is canonicalized around
`RUN_FINISHED.outcome.interrupts` + `ResumeEntry`. This hits our most-customized code — the HITL resume
path (`resolve_relay_thread_id`, `_pending_user_input` in `ask_tools.py`). Migrate deliberately; this is
where the schedule risk lives. **Gains that ride along:** SSE keepalive for silent streams (#6980 —
targets our idle-watchdog/HITL stalls), AG-UI thread snapshot persistence (#6471), clear-queued-approvals
-on-cancel (#6947), preserve streamed text message id in mixed snapshots (#6269).

**4.5 — Retire the shims, one at a time, each behind a verification.** Work the §5.5 table. For each
row, confirm the upstream fix actually covers *our* case before deleting the workaround — these are
strong candidates, not guarantees. Priority order:
  1. **Telemetry killswitch** → re-enable instrumentation, confirm the ContextVar-reset bug is gone
     ([[chat-maf-telemetry-contextvar-bug]], `test_executor_telemetry_killswitch.py`).
  2. **`COPILOT_INFINITE_SESSIONS`** → read the real context window off `ModelBilling`; drop the guess.
  3. **`_gate_injected_tool`** → move to the native `on_pre_tool_use` hook (fires for injected tools too).
  4. **Native-MAF `_nq` steering** → evaluate message-injection middleware (#6998) as a replacement.

**4.6 — Gate.** Full eval suite (21/21) + prod build + a manual soak of the Copilot streaming path
before merge. Deploy `git reset --hard`s and `uv sync`s, so the lock must be committed and clean.

### Phase 5 — Pre-built orchestrations + collaborative chat *(depends on Phase 4)*

Unlocks **Shape C** (free-form collaborative multi-agent chat, §5.6). Shapes A and B do **not** depend
on this.

- **5.1** With orchestrations installed (Phase 4), expose Magentic/GroupChat as **node types inside a
  graph**, not a parallel top-level architecture.
- **5.2 Collaborative chat surface (Shape C).** New chat mode where N registered agents share one
  conversation. Coordinator picked cheapest-first (§5.6): start with a **`selection_func`** (round-robin
  / rule-based, no LLM, no MAF-`Agent` constraint); add `orchestrator_agent` (MAF-typed) or a Magentic
  manager only if dynamic routing is genuinely needed. Participants may be mixed runtime. Requires a
  **termination condition** + turn cap up front (§5.6 reliability caveat). Reuses the Phase 2 multi-loader
  and the SSE relay.
- **5.3** `HandoffBuilder`: MAF-only. Skip, migrate specific agents to native MAF, or use Magentic
  instead. **Do not** rewrite all Copilot agents for this.

---

## 7. Risks & open questions

| Risk | Severity | Mitigation |
|---|---|---|
| Two forced SDK majors (openai 1.99→2.x, copilot-sdk 0.1.32→1.0.2) | **high** | Phase 4.1 isolated-venv proof + 4.3; minimal-bump fallback dodges both; not needed for 0–3 |
| Breaking AG-UI interrupt/resume (#6925) vs our custom HITL resume | **high** | Phase 4.4 deliberate migration; the schedule risk lives here |
| Shim removal deletes a workaround the fix doesn't fully cover | med | 4.5 verifies each fix against our case *before* deleting; one at a time |
| Floor-wide `call_agent` widens reach | low | per-target confirm gate + depth/cycle guards already exist |
| N live agents exhaust 4 GB | low–med | in-process shared `sys.modules`; measure in 2.6; 4 GB swap available |
| Graph spec churn after editor ships | med | version the spec in 2.3 **before** UI work |
| `HandoffBuilder` never supports Copilot | low | we don't need handoff semantics (§5.1) |

**Open questions**
1. Should L2 workflows be **user-authored only**, or may an agent invoke a saved workflow via a tool?
2. Where do workflow definitions live — Postgres (survives `git reset --hard`) or repo files?
   Precedent says **Postgres**.
3. Does a node need HITL? `AgentExecutor` supports `request_info`; confirm it survives our SSE relay.
4. Do we cap live nodes per workflow (`commandcenter-dev` alone is a 2.1 GB clone)?

---

## 8. Appendix — reproduction

```bash
ssh acb@187.127.179.143

# A. planner's effective toolset — proves call_agent is stripped
cd /opt/acb/app && .venv/bin/python - <<'PY'
from orchestrator._tool_injection import _resolve_injected_scope, _build_injected_tools_addendum
scope = ["web_search","fetch_page","write_artifact","manage_todo_list",
         "ask_user","save_note","recall_notes"]     # technical-project-planner's real scope
eff = _resolve_injected_scope(scope)
print("call_agent injected?", "call_agent" in eff)                       # False
ad = _build_injected_tools_addendum()
print("addendum mentions call_agent?", "call_agent(" in ad)              # True  ← the lie
print("addendum tokens ~", len(ad)//4)                                   # ~7827
PY

# B. mixed-runtime workflow on core 1.8.1 — no new deps
cd /opt/acb/app && .venv/bin/python - <<'PY'
from agent_framework import Agent, AgentExecutor, WorkflowBuilder
from agent_framework.openai import OpenAIChatCompletionClient
import agent_framework_github_copilot as gc
c   = OpenAIChatCompletionClient(model="gpt-4o-mini", api_key="sk-probe")
a   = AgentExecutor(Agent(c, "p", name="maf"), id="maf-node")
b   = AgentExecutor(gc.GitHubCopilotAgent(name="cop", instructions="p"), id="copilot-node")
wf  = WorkflowBuilder(start_executor=a).add_edge(a, b).build()
print("MIXED-RUNTIME WORKFLOW OK ->", type(wf).__name__)
PY

# C. orchestrations matrix (ISOLATED venv — never touch /opt/acb/app/.venv)
rm -rf /tmp/orchprobe && mkdir -p /tmp/orchprobe && cd /tmp/orchprobe
uv venv -q .venv && uv pip install -q --python .venv/bin/python \
    agent-framework-orchestrations agent-framework-github-copilot agent-framework-openai
# → pulls core 1.11.0; HandoffBuilder rejects GitHubCopilotAgent,
#   Sequential/Concurrent/GroupChat/Magentic accept mixed runtimes
rm -rf /tmp/orchprobe        # ALWAYS clean up
```

---

## 9. References

- [MAF — Workflow orchestrations](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/)
- [MAF — Handoff](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff) *(the `Agent`-only restriction)*
- [MAF — Magentic](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic)
- [MAF — Orchestration patterns reach 1.0](https://devblogs.microsoft.com/agent-framework/agent-frameworks-orchestration-patterns-reach-1-0/)
- [OpenAI — Agent orchestration: handoffs vs agents-as-tools](https://openai.github.io/openai-agents-python/multi_agent/)
- [Anthropic — How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Anthropic — Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns)

Related specs: [`agent_file_and_memory_framework.md`](agent_file_and_memory_framework.md) ·
[`core_module_map.md`](core_module_map.md) · [`harness_hardening_2026-07.md`](harness_hardening_2026-07.md)
