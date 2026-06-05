# Chat UX Specification — CommandCenter Control Plane

> **Type:** Implementation Spec  
> **Date:** 2026-06-05  
> **Status:** Ready for implementation  
> **Target:** `workbench/control_plane/src/` — chat tab and related components  
> **Reference:** VS Code Chat Participant API, GitHub Copilot Chat, Claude Code, Perplexity

---

## 1. What's wrong today

The current chat shows a blank screen while the agent is working. The user has no idea:
- Whether the request was received
- Which agent is handling it
- What tool calls are being made
- What data is being read
- Whether something went wrong silently
- How long it will take

The only feedback is the final answer appearing. There are no intermediate signals.

The tool-call accordion exists in `MarkdownMessage.tsx` but only renders **after** the tool completes — so during a long Zoho query the user sees nothing for 5–20 seconds. The `tool_start` / `tool_end` SSE events are received by `useAgentChat.ts` but only stored in `message.toolEvents`; they are never surfaced above the message in a live panel.

---

## 2. Reference: how best-in-class tools do it

### GitHub Copilot Chat (VS Code)
- Shows `stream.progress("Searching workspace...")` messages as **inline grey text** above the response area while thinking
- Each tool call gets a collapsible pill: `🔍 Searched workspace — 3 results` (collapsed by default, click to expand)
- Spinning indicator on the active tool call
- Agent name shown in header (`@workspace`, `@terminal`)
- Follow-up question chips after each answer

### Claude Code
- **Transparent thinking block**: a scrollable, low-contrast expandable block labeled "Thinking…" that shows the model's chain-of-thought in real time
- Tool calls shown as sequential steps: `✓ Read file src/main.py`, `▶ Running bash command…`
- Duration shown on completed steps (e.g. `312ms`)
- Overall task progress bar for long operations

### Perplexity
- "Sources" panel streams in on the left while the answer types on the right
- Shows the exact search queries being run
- Confident sourcing: every claim links to the retrieved content

### Common patterns across all three
1. **Live progress text** — a short label that updates as the model thinks
2. **Tool call timeline** — ordered list of tool invocations with status icons (pending / running / done / error)
3. **Expandable details** — args and output available on click, collapsed by default
4. **Agent identity header** — which agent is active, clearly labelled
5. **Elapsed time** — visible on each step and overall
6. **Graceful error display** — failed steps shown red with the error message inline

---

## 3. Proposed UI layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  [agent-sales-assistant]  ·  tier2-sonnet  ·  zoho-crm, apollo      │  ← Agent status bar
└──────────────────────────────────────────────────────────────────────┘

  You: Show deals in Awaiting PO stage

┌──────────────────────────────────────────────────────────────────────┐
│  ▼ Thinking  [2.4s elapsed]                            [collapse ▲]  │  ← Thinking panel (live)
│                                                                      │
│  Searching Zoho CRM for deals matching "Awaiting PO"...             │
│  Found 4 records. Formatting response.                              │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  ✓ zoho_crm  search · Deals · Stage:equals:Awaiting PO  [1.8s]  ▼  │  ← Tool call pill (done)
│  [collapsed — click to see args/output]                             │
└──────────────────────────────────────────────────────────────────────┘

  Here are the 4 deals in the "Awaiting PO" stage:
  | # | Deal | Account |
  ...
                                          [👍] [👎]  [Copy]  [Retry]  ← Action bar
```

---

## 4. New components to build

### 4.1 `AgentStatusBar` (new)
**Location:** top of the chat response area, persistent while agent is loaded  
**Shows:**
- Active agent name (e.g. `agent-sales-assistant`)
- Model being used (e.g. `tier2-sonnet`)
- Required integrations (green dot = connected, red = missing)
- "Connected" / "Partial" / "Error" status

```tsx
// Props
interface AgentStatusBarProps {
  agentName: string;
  model?: string;
  integrations: { name: string; configured: boolean }[];
}
```

### 4.2 `ThinkingPanel` (new)
**Location:** in the assistant message bubble, above the final text  
**Behaviour:**
- Appears immediately when the agent starts processing
- Shows a sequence of progress lines as they stream in
- Auto-collapses after the response is complete (stays expandable)
- Driven by a new `thought` event type in the SSE stream

**Progress lines come from:**
- A new `{type: "progress", content: "Searching Zoho CRM..."}` SSE event emitted by the chat route
- Derived from tool call names: when `tool_start` fires, auto-generate `Calling zoho_crm…`

```tsx
interface ThinkingPanelProps {
  lines: string[];          // progressive list of status strings
  isActive: boolean;        // true while still streaming
  elapsedMs: number;        // shown as "3.2s elapsed"
  defaultExpanded?: boolean; // true during streaming, false after done
}
```

### 4.3 `ToolCallTimeline` (replace current accordion)
**Location:** inside the assistant message, between ThinkingPanel and final text  
**Shows:** ordered sequence of tool calls as cards  
**Behaviour:** 
- Running tools show a spinner
- Done tools show ✓ with duration
- Failed tools show ✗ with inline error
- Click to expand args / output (same as current accordion but styled better)

```tsx
interface ToolCallTimelineProps {
  events: ToolEvent[];
  isStreaming: boolean;
}
```

### 4.4 `MessageActionBar` (new)
**Location:** below each assistant message  
**Shows:** 👍 👎 Copy Retry  
**Behaviour:**
- Thumbs up/down sends audit event to gateway (`POST /audit`)
- Copy copies the raw markdown text
- Retry re-sends the last user message

### 4.5 Updates to `useAgentChat.ts`
Add two new SSE event types:
- `{type: "progress", content: "string"}` → appended to `message.progressLines[]`
- `{type: "thinking", content: "string"}` → same as progress (Claude-style thinking)

Add to `ChatMessage` interface:
```ts
progressLines?: string[];   // live status lines shown in ThinkingPanel
agentName?: string;         // which agent produced this message
modelUsed?: string;         // which model tier was used
durationMs?: number;        // total time from request to completion
```

### 4.6 Updates to `api/agent/chat/route.ts`
Emit progress events before the AG-UI stream:
- When `tool_start` fires → emit `{type:"progress", content:"Calling <tool_name>…"}`
- When `tool_end` fires → emit `{type:"progress", content:"✓ <tool_name> completed (<duration>ms)"}`
- After `RUN_FINISHED` → emit `{type:"progress", content:"Done"}` with total duration

---

## 5. SSE event additions

Add to the existing event types in `useAgentChat.ts`:

```ts
// New SSE event from /api/agent/chat
{ type: "progress"; content: string }      // status line (shown in ThinkingPanel)
{ type: "agent_meta"; agent: string; model: string; integrations: string[] }  // header bar data
```

Emitted by `api/agent/chat/route.ts` at:
- Request start: `agent_meta` with agent name / model
- Each `TOOL_CALL_START` AG-UI event: `progress` with "Calling tool_name…"
- Each `TOOL_CALL_END` AG-UI event: `progress` with "✓ tool_name (Xms)"
- `RUN_ERROR`: `progress` with "⚠ Error: <message>"

---

## 6. Visual design spec

### Colours (consistent with existing dark zinc palette)
| Element | Colour |
|---|---|
| Thinking panel background | `bg-zinc-900/40 border border-zinc-700/40` |
| Progress line text | `text-zinc-400 text-xs` |
| Tool call — running | `border-zinc-700 animate-pulse` spinner `border-blue-400` |
| Tool call — done | `text-emerald-500` ✓ |
| Tool call — error | `text-red-400` ✗ |
| Duration label | `text-zinc-600` |
| Agent status bar | `bg-zinc-900 border-b border-zinc-800` |
| Integration dot — OK | `bg-emerald-500` |
| Integration dot — missing | `bg-red-500` |
| Elapsed time | `text-zinc-500 text-[10px] font-mono` |

### Animation
- Tool running: 2px border spinner `animate-spin`
- Thinking panel open: `transition-all duration-200`
- Progress lines: fade in with `animate-fade-in` (150ms)
- Streaming cursor: existing `▌ blink` stays unchanged

---

## 7. Implementation order

| Step | Component | Complexity | Impact |
|---|---|---|---|
| 1 | `useAgentChat.ts` — add `progressLines` to state | Low | Enables all others |
| 2 | `api/agent/chat/route.ts` — emit `progress` events on tool events | Low | Core data feed |
| 3 | `ThinkingPanel` component | Medium | Biggest UX win — removes blank screen |
| 4 | `ToolCallTimeline` (replace accordion) | Medium | Visibility into tool execution |
| 5 | `AgentStatusBar` | Low | Orientation / context |
| 6 | `MessageActionBar` (👍👎 Copy Retry) | Low | Polish |
| 7 | `agent_meta` event + header bar data | Low | Model/integration display |

Total estimated effort: **3–4 engineer-days**.

---

## 8. What NOT to change (anti-patterns to avoid)

- Do not add a raw "system prompt" viewer — users don't need to see 57k tokens of skill instructions
- Do not show raw JSON for tool args by default — only on expand
- Do not auto-scroll to bottom during thinking (jarring) — only auto-scroll on new tokens
- Do not add a separate "debug" tab — visibility should be inline, not hidden behind a tab
- Do not show thinking panel for litellm mode (direct LLM, no tool calls) — hide ThinkingPanel if `progressLines.length === 0`

---

## 9. Files to create / modify

| File | Action |
|---|---|
| `src/components/ThinkingPanel.tsx` | Create |
| `src/components/ToolCallTimeline.tsx` | Create (replaces tool-call accordion in MarkdownMessage) |
| `src/components/AgentStatusBar.tsx` | Create |
| `src/components/MessageActionBar.tsx` | Create |
| `src/components/MarkdownMessage.tsx` | Modify: remove inline ToolCallBlock, use ToolCallTimeline |
| `src/components/AgentChat.tsx` | Modify: add AgentStatusBar, MessageActionBar; pass progressLines to ThinkingPanel |
| `src/hooks/useAgentChat.ts` | Modify: handle `progress` + `agent_meta` events; add progressLines/durationMs to ChatMessage |
| `src/app/api/agent/chat/route.ts` | Modify: emit `progress` SSE events on tool call events |

---

## 10. Acceptance criteria

- [ ] Sending a message immediately shows a spinner/ThinkingPanel — no blank screen
- [ ] Each tool call appears in the timeline as it starts, with a running indicator
- [ ] Tool calls update to ✓ or ✗ when complete, with duration
- [ ] ThinkingPanel collapses automatically when the response is done
- [ ] Agent name and integration status visible in the status bar
- [ ] Clicking a completed tool call expands args/output
- [ ] 👍 👎 Copy Retry actions visible on every assistant message
- [ ] litellm mode (direct LLM) shows no ThinkingPanel (no tool calls)
- [ ] No visible regression on existing message rendering (markdown, code blocks, citations)
