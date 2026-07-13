# Chat UI — AG-UI, HITL & custom-element rendering review (2026-07-02)

> Focused audit of how the chat frontend renders **HITL prompts**, **tool
> calls across their phases**, and **custom/generative UI elements**, compared
> against the [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)
> list and the **AG-UI protocol** it points to (`ag-ui-protocol/ag-ui`).
> Companion to [`core_module_map.md`](core_module_map.md) D3 (Chat UI surfaces)
> and [`core_loop_unification.md`](core_loop_unification.md) (Phase 3a–3c).

## What we have today (mapped from code)

**HITL (three flavours, two delivery modes).**
- Events: `confirmation_requested` → `ConfirmationCard` (Approve/Reject);
  `elicitation_requested` (structured questions) + `user_input_requested`
  (single ask_user) → `ElicitationCard`. Wired in `AgentChat.tsx` via
  `useAgentEvents.onCustomEvent`, filtered by `threadId`.
- **Blocking** (has `request_id`, MAF Tier 2 + native): the agent parks on a
  Future; the card POSTs to `/api/agent/respond-input` and the run resumes in
  the SAME stream (P1-2 routes the answer cross-worker). Fails CLOSED for
  destructive confirmations (HH-2).
- **Non-blocking** (no `request_id`, Copilot SDK): the answer is submitted as a
  new chat message.
- `onRunFinalized` clears only blocking cards (a non-blocking card must persist
  until answered). Session-switch resets all cards (render-phase guard).

**Tool phases** (`ThinkingContainer.tsx`): `tool_start` → running row (live,
open); `tool_partial` → streams terminal/tool output into the row; `tool_end`/
`tool_result` → collapses, honours `success` (done vs error). Reasoning +
narration segments interleave with tools chronologically via
`reasoningCutoff`/`segmentCutoff`. Sub-agent calls render as a git-tree
sub-timeline. Auto-expand while active, auto-collapse on completion.

**Custom / generative UI** (`GenerativeUIPanel.tsx`): `STATE_SNAPSHOT` +
named `CUSTOM` events render in a collapsible "Interactive view" — generic
`JsonView` (tables for arrays-of-objects, dl for objects) with a
**`CUSTOM_EVENT_RENDERERS` registry keyed by event name** for typed cards
(currently EMPTY — the extension point exists, unused). `artifact_created`/
`artifact_updated` → `ArtifactCard`; ```choices``` fenced blocks → inline MCQ
buttons; `TODO_LIST` → todo panel; email tool-calls → `EmailToolCards`.

## Comparison vs AG-UI (the list's reference protocol)

| AG-UI canonical practice | Ours | Verdict |
|---|---|---|
| Tool call 3-phase lifecycle: `ToolCallStart` → `ToolCallArgs` (delta accumulation) → `ToolCallEnd` | Backend emits `TOOL_CALL_START`/`TOOL_CALL_ARGS`/`TOOL_CALL_RESULT` and accumulates arg deltas onto one row | **=SOTA** on the lifecycle; naming diverges (`TOOL_CALL_RESULT` + a non-standard `TOOL_CALL_PARTIAL` vs canonical `TOOL_CALL_END`) |
| **HITL = agent calls a tool (e.g. `confirmAction`), frontend shows a dialog, sends the decision back as the tool result**, agent awaits the tool message | We do this exactly for the BLOCKING path (park on Future → card → respond-input → resume same stream). | **=SOTA** — this is precisely the AG-UI "tool-based HITL" pattern, and we add fail-closed + cross-worker delivery |
| **Frontend-defined / client-provided tools**: frontend declares tools in `RunAgentInput.tools`; a human-answered tool returns the user's input as the result | We inject a *prose addendum* describing frontend tools; the ask_* tools are backend-registered, not declared by the client in a typed `tools` array | **~gap** — works, but not the typed client-tool contract AG-UI specifies; the addendum is hand-maintained (drift risk, already flagged as B2) |
| Text message lifecycle: `TextMessageStart..Content..End`, one logical stream per messageId | Phase 3a/3c: real segment boundaries, tool-round-aligned, distinct ids | **=SOTA** (just fixed) |
| Generative UI / render custom components per event | `CUSTOM_EVENT_RENDERERS` registry exists but is empty → everything falls to generic `JsonView` | **~gap** — the mechanism is right; no typed renderers built yet |

**Protocol-conformance nuance.** The *backend* speaks near-canonical AG-UI
(uppercase event names). The **Next route (`route.ts`) re-translates** it into a
bespoke lowercase dialect (`delta`, `tool_start`, `message_start`, …) that only
our hand-rolled `chatStream.ts` reducer understands. So we are AG-UI-*shaped*
but not AG-UI-*wire-compatible* at the client boundary — which is why an
off-the-shelf AG-UI client can't drop in today (see below).

## The two genuine UX gaps (ranked)

1. **HITL cards render at the BOTTOM of the message list, not inline at the
   point the agent asked.** In `AgentChat.tsx` the cards render after the
   `messages.map(...)`, detached from the assistant turn that raised them. VS
   Code / the AG-UI reference render the prompt *inline in the conversation
   flow*, anchored to the asking turn. On a multi-turn or scrolled conversation
   ours can appear far from context. **Highest-value UX fix.** The card should
   render as (or immediately under) the assistant message whose run is blocked
   — keyed by `request_id`/message id.

2. **The generative-UI renderer registry is empty.** Every `CUSTOM` event
   renders as generic JSON in a collapsed "Interactive view". Typed cards
   (approval_request, clickup_task_card, zoho_deal_chip, …) are the "generative
   UI" the list/AG-UI describe. The plug-in point (`CUSTOM_EVENT_RENDERERS`) is
   built; it just needs typed renderers + agents emitting the named events.

## External tools/plugins — should we adopt any?

- **`ag-ui-protocol/ag-ui` (+ CopilotKit, its React impl):** the reference for
  exactly this surface. **Recommendation: adopt the protocol's event NAMES and
  the typed client-tool contract, but do NOT rip-and-replace our renderer.** Our
  `ThinkingContainer`/card system is richer than CopilotKit's defaults and is
  eval-locked. The high-value move is to stop the `route.ts` re-translation into
  a custom dialect and emit canonical AG-UI to the client — that makes us
  wire-compatible (optionally letting CopilotKit hooks consume our stream later)
  without losing our UI. Medium effort; do it as part of the D1 "route becomes a
  thin proxy" work, not standalone.
- **`modelcontextprotocol/inspector` (MCP Inspector):** directly fills the B4
  gap ("no MCP Inspector-style debug path"). **Recommendation: adopt as a dev
  tool** — point it at our `mcp_servers` to validate tool defs / test calls. Low
  effort, high debugging value. Not shipped to end users.
- **CopilotKit as a full framework:** **not recommended to adopt wholesale** —
  it would replace hand-tuned surfaces we've already hardened (tool cards, HITL
  fail-closed, sub-agent timeline, ownership/dedup guards) and re-introduce
  churn. Borrow its *patterns* (inline generative UI, typed frontend tools), not
  its runtime.
- **Playwright MCP / Chrome DevTools MCP:** unrelated to chat UX (they're
  agent *capabilities*); note for B3/B4 tool-suite work, not here.

## Recommended work (prioritised)

1. **Inline HITL cards** — render the confirmation/elicitation card anchored to
   the blocked assistant turn, not at the list bottom. Biggest perceived-quality
   win; contained frontend change; drive with the Playwright HITL flow.
2. **Emit canonical AG-UI to the client** — collapse the `route.ts` dialect
   re-translation so the wire format IS AG-UI (folds into the D1 thin-proxy
   demotion). Unlocks optional off-the-shelf client interop; removes one
   translation layer (fewer drift points).
3. **Ship 2–3 typed `CUSTOM_EVENT_RENDERERS`** (approval_request first, then a
   task/deal card) to make "generative UI" real instead of JSON.
4. **Add MCP Inspector to the dev toolchain** (B4).
5. **Typed frontend-tool contract** — declare client tools in a structured
   payload instead of prose addendum (kills B2 drift).

All are UI/protocol-layer, none are correctness bugs. #1 and #3 are the ones
that directly answer "is the right thing shown, and does it feel right."

## Evaluated: Prefab (Prefect) + FastMCP Apps (2026-07-02)

Both were suggested for "creating UI elements in chat on the fly." They are the
SAME stack: **FastMCP Apps is built on Prefab.**

- **Prefab** — "the generative UI framework that even humans can use": a
  Python-first generative-UI library. Agents compose UI in Python
  (`with Card(): …`, 100+ components, reactive `Rx` state, Actions like
  SetState/ShowToast), serialized to a **self-contained JSON component tree**
  (`{view, state}`) and rendered by a React bundle (`/renderer.js`).
  Explicitly **streaming- + token-efficient** — designed for an LLM to emit UI
  incrementally. This is genuinely aligned with our "generative UI" gap (the
  empty `CUSTOM_EVENT_RENDERERS` registry).
- **FastMCP Apps** — the delivery layer: `@mcp.tool(app=True)` returns a Prefab
  component so "a tool returns an interactive UI instead of text," rendered
  "right inside the conversation." Four patterns: Interactive Tools,
  FastMCPApp (server callbacks), **Generative UI** (model writes Prefab live),
  Custom HTML.

**The blocker for a drop-in integration — transport + host requirement.**
FastMCP Apps delivers UI via the **MCP Apps extension**: the tool returns a UI
resource and the **HOST/CLIENT must implement MCP Apps** to render it (the
model of Claude Desktop / ChatGPT apps). That is a **competing UI transport to
our AG-UI stack** — our chat is a custom Next.js client that speaks our AG-UI
dialect over SSE, not an MCP-Apps host. And there is **no confirmed standalone
npm package** for the Prefab React renderer today (`/renderer.js` is loaded from
their infra; registry probes for `@prefect/prefab*` → 404; `prefab-react` exists
but has empty metadata and is likely a namesake). Prefab is also brand-new
(recently launched) — small ecosystem, API churn risk.

**Verdict.**
- **Do NOT route our chat through FastMCP Apps / the MCP Apps extension.** It
  would mean either (a) making our chat an MCP-Apps host — a second UI transport
  bolted alongside AG-UI, exactly the "two parallel protocols" trap — or (b)
  depending on their hosted renderer. Both fight our eval-locked AG-UI surface.
- **The idea Prefab embodies — a serializable, agent-emittable UI component
  tree rendered by a registry — is EXACTLY right and is what our own
  `CUSTOM_EVENT_RENDERERS` registry + a `generative_ui` CUSTOM event should
  do.** Prefab validates the design; we already own the better-fitting
  mechanism (it rides our existing AG-UI `CUSTOM` channel, no new transport).
- **IF Prefab publishes a standalone React renderer + a stable JSON schema**,
  the high-leverage move would be: agent emits a Prefab-shaped JSON tree as a
  `CUSTOM` event → a single `CUSTOM_EVENT_RENDERERS["generative_ui"]` renderer
  wraps Prefab's renderer. That gets us 100+ components + streaming generative
  UI *inside our AG-UI stack* with no protocol fork. Re-evaluate when the
  standalone renderer + schema are confirmed. Until then, hand-write the 2–3
  typed renderers (rec #3) — same registry, no external dependency.
- **FastMCP itself** (the MCP *server* framework, gofastmcp.com core — separate
  from Apps) remains worth considering for authoring our MCP servers (B4), but
  that's a backend-tooling choice unrelated to chat UI.

Net: adopt the *pattern* (serializable generative-UI tree via our CUSTOM
channel + registry), not the *transport* (MCP Apps). Revisit a Prefab-renderer
integration once it's standalone-embeddable.
