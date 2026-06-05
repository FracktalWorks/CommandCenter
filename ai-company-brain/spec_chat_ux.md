# Chat UX Specification — CommandCenter Control Plane

> **Type:** Implementation Spec  
> **Date:** 2026-06-05  
> **Status:** Ready for implementation  
> **Target:** `workbench/control_plane/src/` — chat tab and related components  
> **Reference:** VS Code source — `chatThinkingContentPart.ts`, `chatProgressContentPart.ts`, `chatSubagentContentPart.ts`, `chatToolInputOutputContentPart.ts` (read in full); GitHub Copilot Chat extension; Claude Code  
> **Source studied:** [microsoft/vscode](https://github.com/microsoft/vscode) `src/vs/workbench/contrib/chat/browser/widget/chatContentParts/`

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

## 2. What the VS Code source actually does (read from production code)

I read the full source of `chatThinkingContentPart.ts` (2249 lines) and `chatProgressContentPart.ts` (359 lines) from the VS Code core repo. Here is exactly how the production system works. This is what we should copy.

### The "Thinking container" — `ChatThinkingContentPart`

VS Code has ONE collapsible container for the entire "working" phase. It groups ALL tool calls and raw thinking text into a single expandable block. Its lifecycle:

1. **Created** when first thinking content or tool call arrives.
2. **Title starts as** `"Thinking"` — changes to `"Working"` when the first tool call is registered.
3. **While active**: title shows `"Working: <current tool label>"` — e.g. `"Working: Searching for login"` — using a CSS shimmer animation (`chat-thinking-title-shimmer`) on the subtitle portion. The container header shows a pulsing filled-circle codicon (`circleFilled`) when collapsed.
4. **Expansion**: Three modes — `Collapsed` (click to expand), `CollapsedPreview` (starts expanded, auto-collapses on completion), `FixedScrolling` (scrolls within a fixed-height box). Lazy rendering: tool items inside the container are only rendered when the user expands it (factory pattern).
5. **Working messages are randomised** from a pool, refreshing per tool call:
   - Default pool: `"Searching…"`, `"Analyzing…"`, `"Processing…"` etc.
   - Easter eggs (1-in-100 chance): `"Bribing the hamster"`, `"Reticulating splines"`, `"Summoning Clippy"`, `"Mining diamonds"`.
   - Terminal tool sub-pool (different from generic tool pool).
   - User-configurable via `chat.agent.thinkingPhrases` setting.
6. **Tool icons** are assigned by tool ID keyword matching:
   - `search/grep/find/list/semantic/codebase` → `$(search)` icon
   - `read/get_file/problems` → `$(book)` icon
   - `edit/create/replace/patch/insertEdit` → `$(pencil)` icon
   - `terminal` → `$(terminal)` icon (or `$(terminal-secure)` if sandbox-wrapped)
   - default → `$(tools)` icon
7. **On completion**:
   - Icon switches to `$(check)` (green checkmark).
   - Shimmer animation stops.
   - An LLM call generates a 10-word past-tense summary title: `"Updated HomePage.tsx"`, `"Reviewed 2 files"`, `"Searched for login and authentication"`. Uses `copilot-utility-small` model. Falls back to last extracted title if LLM fails.
   - Container auto-collapses (unless it has content worth showing).
8. **Single tool optimisation**: if there is exactly ONE tool call and no thinking text, VS Code moves the tool block OUT of the thinking container and renders it inline in the message flow (no accordion needed).

### The progress row — `ChatProgressContentPart`

Separate from the thinking container, individual progress messages render as rows:
- A `$(loading~spin)` icon while active, `$(check)` when done.
- The text uses a **shimmer** CSS animation while the step is active (CSS class `shimmer-progress`). This is NOT a spinner next to the text — the text itself has a flowing gradient highlight. That's the key visual.
- When a subsequent non-progress content arrives (like a tool result), the progress row auto-hides.
- Shows elapsed time + token stats (currently intentionally hidden in "minimal shipping version", but the structure is there).

### Subagent rendering — `chatSubagentContentPart.ts`

When the orchestrator delegates to a sub-agent (Claude Code style), VS Code renders a nested section with:
- The sub-agent's name and icon as a header
- Its tool calls rendered recursively in the same thinking-container pattern
- The outer thinking container's title shows `"Working: <subagent name>"`

### Key CSS patterns to replicate

From reading the source:
```
.chat-thinking-box                // outer wrapper
.chat-thinking-active             // while streaming (adds shimmer class)
.chat-thinking-title-shimmer      // the animated subtitle span
.shimmer-progress                 // on individual progress rows
.chat-thinking-spinner-item       // the in-container spinner row
.chat-thinking-item               // each item inside the container
.chat-thinking-tool-wrapper       // wrapper around icon + content for each tool
.chat-thinking-icon               // icon element (themed codicon)
```

The shimmer is a CSS `background-position` animation on a linear gradient — creates the "sweeping highlight" effect used in loading states.

---

## 3. Proposed UI layout (matching VS Code patterns exactly)

**State 1: Agent is working (streaming)**
```
  You: Show deals in Awaiting PO stage

┌──────────────────────────────────────────────────────────────────────┐
│  ◉ Working: Searching for Deals · Stage:equals:Awaiting PO    [▼]  │  ← Thinking container (collapsed)
└──────────────────────────────────────────────────────────────────────┘  Title has shimmer animation on "Searching for Deals..."
  [blinking cursor ▌]
```

**State 2: Expanded (user clicks ▼)**
```
┌──────────────────────────────────────────────────────────────────────┐
│  ◉ Working: Searching for Deals...                            [▲]  │  ← title + shimmer + collapse button
├──────────────────────────────────────────────────────────────────────┤
│  🔍 zoho_crm  search · Deals · Stage:equals:Awaiting PO       [▼]  │  ← tool row with icon + label + expand
│  🔍 Running query...                                                │
│                                                                      │
│  [spin] Mining diamonds...                                           │  ← rotating random working message
└──────────────────────────────────────────────────────────────────────┘
```

**State 3: Tool completes, response arriving**
```
┌──────────────────────────────────────────────────────────────────────┐
│  ✓  Retrieved Zoho deals  [826ms]                             [▼]  │  ← LLM-generated 10-word summary, check icon
└──────────────────────────────────────────────────────────────────────┘

  Here are the 4 deals in the "Awaiting PO" stage:
  ...
                                          [👍] [👎]  [Copy]
```

**State 4: Multi-agent delegation (when orchestrator calls agent-sales-assistant)**
```
┌──────────────────────────────────────────────────────────────────────┐
│  ◉ Working: agent-sales-assistant › Searching Zoho...         [▼]  │  ← "agentName › toolName" in title
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. New components to build (VS Code-accurate)

### 4.1 `ThinkingContainer` (new — replaces `ToolCallBlock`)

**Replaces** the per-message `ToolCallBlock` accordion in `MarkdownMessage.tsx`.  
**Wraps** the entire working phase as a single collapsible group.

**Three phases, matching VS Code exactly:**

```tsx
type ThinkingMode = 'collapsed' | 'collapsed-preview' | 'fixed-scroll';

interface ThinkingContainerProps {
  toolEvents: ToolEvent[];           // fed from useAgentChat SSE stream
  progressLines: string[];           // generated from tool_start events
  isActive: boolean;                 // false after RUN_FINISHED
  mode?: ThinkingMode;               // default 'collapsed-preview'
  finalTitle?: string;               // LLM-generated summary (arrived after completion)
}
```

**Title lifecycle:**
1. No tool calls yet → `"Thinking…"` (with shimmer)
2. First tool call → `"Working: <tool label>"` (with shimmer)
3. Active → `"Working: <latest tool label>"` (title updates as tool labels change)
4. Completed → LLM-generated past-tense summary OR last tool label

**Visual states:**
- Active: `◉` pulsing filled circle + CSS shimmer on title subtitle
- Expanded: `▼` chevron down
- Completed: `✓` green check mark, shimmer off, auto-collapse

**Tool icon mapping** (copied from VS Code `getToolInvocationIcon`):
```ts
function getToolIcon(toolName: string): string {
  const n = toolName.toLowerCase();
  if (/search|grep|find|list|semantic|codebase/.test(n)) return '🔍';
  if (/read|get_file|problems/.test(n))                   return '📖';
  if (/edit|create|replace|patch|insert/.test(n))         return '✏️';
  if (/terminal|bash|shell/.test(n))                      return '>';
  return '⚙';
}
```

**Random working messages** (cycling, not static):
```ts
const WORKING_MESSAGES = [
  "Searching…", "Analyzing…", "Processing…", "Checking…", "Reviewing…",
  // Easter eggs (1-in-100):
  "Bribing the hamster", "Reticulating splines", "Summoning Clippy",
];
```

**CSS shimmer** (the key visual — NOT a spinner next to text):
```css
@keyframes shimmer {
  from { background-position: -200px 0; }
  to   { background-position: 200px 0; }
}
.chat-thinking-title-shimmer {
  background: linear-gradient(90deg, 
    var(--text-muted) 25%, var(--text-normal) 50%, var(--text-muted) 75%);
  background-size: 400px 100%;
  animation: shimmer 1.5s infinite linear;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
```

### 4.2 `LLMTitleGenerator` (utility function)

After `RUN_FINISHED`, call the LiteLLM proxy with a small model to generate a 10-word past-tense summary of all tool labels:

```ts
async function generateThinkingTitle(toolLabels: string[]): Promise<string> {
  const context = toolLabels.join(', ');
  const prompt = `Summarize in a SINGLE past-tense phrase under 10 words:
Output must start with a past-tense verb (Updated/Reviewed/Searched/Ran).
Do NOT include tool names. Just actions and subjects.
Content: ${context}`;
  // Call /api/completions with tier1-haiku or smallest available model
}
```

Fallback: if LLM call fails or takes >2s, use the last tool label directly.

### 4.3 `AgentStatusBar` (new, smaller scope than originally planned)

**Location:** sticky top of the chat response area, only shown when agent is selected  
**Shows:** agent name, required integrations (green/red dots), active/idle status  
**Implementation:** small, static; no LLM dependency

```tsx
interface AgentStatusBarProps {
  agentName: string;
  integrations: { name: string; configured: boolean }[];
  isActive: boolean;
}
```

### 4.4 `MessageActionBar` (new)

👍 👎 Copy — below each assistant message. Retry removed (out of scope for now).

### 4.5 Updates to `useAgentChat.ts`

Add to `ChatMessage`:
```ts
progressLines?: string[];     // ordered list of tool labels for ThinkingContainer
thinkingTitle?: string;       // LLM-generated title (set after completion)
isThinkingActive?: boolean;   // true while RUN is in progress
```

`progress` and `agent_meta` SSE events (same as before).

### 4.6 Updates to `api/agent/chat/route.ts`

Emit progress events on each `TOOL_CALL_START`:
```ts
// TOOL_CALL_START → emit progress line
yield `data: ${JSON.stringify({ type: 'progress', content: toolName })}\n\n`;
```

No changes to the AG-UI → SSE translation otherwise.

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

## 6. Visual design spec (matching VS Code patterns)

### Colours (consistent with existing dark zinc palette)
| Element | Tailwind class | Notes |
|---|---|---|
| Thinking container | `bg-zinc-900/40 border border-zinc-700/40 rounded-lg` | Matches VS Code's subtle dark grouping |
| Title — active | `text-zinc-300` with CSS shimmer gradient | NOT a spinner next to text |
| Title — completed | `text-emerald-500` + ✓ icon | Same as current `text-emerald-500` |
| Tool row icon | `text-zinc-400` | Themed by tool type |
| Tool row label | `text-zinc-300 text-xs` | Truncated if long |
| Working message | `text-zinc-500 text-xs italic` | Rotating random message |
| Expand/collapse | `text-zinc-600 text-[10px]` | ▼ ▲ |
| Progress row | `text-zinc-400 text-xs` with shimmer | Same shimmer effect |
| Status bar | `bg-zinc-900 border-b border-zinc-800 px-4 py-1.5` | |
| Integration dot — OK | `bg-emerald-500 rounded-full w-1.5 h-1.5` | |
| Integration dot — missing | `bg-red-500 rounded-full w-1.5 h-1.5` | |

### Animation — the shimmer is the core visual language
```css
/* The flowing shimmer on title text while agent is working */
@keyframes chat-shimmer {
  from { background-position: -400px 0; }
  to   { background-position: 400px 0; }
}

.chat-thinking-title-shimmer {
  display: inline;
  background: linear-gradient(
    90deg,
    theme('colors.zinc.500') 0%,
    theme('colors.zinc.200') 40%,
    theme('colors.zinc.500') 80%
  );
  background-size: 400px 100%;
  animation: chat-shimmer 2s infinite linear;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Shimmer on entire progress rows while active */
.shimmer-progress {
  /* same gradient but on the text element */
}
```

### When to show vs hide the ThinkingContainer
- Show: any message where `progressLines.length > 0` OR `isThinkingActive === true`  
- Hide: plain LLM text responses with no tool calls (pass-through to LiteLLM directly)  
- Auto-collapse: 300ms after `isThinkingActive` transitions to `false`  
- User can always re-expand to see the tool call history

---

## 7. Implementation order (revised — VS Code-accurate)

| Step | Component/File | What | Complexity | Impact |
|---|---|---|---|---|
| 1 | `api/agent/chat/route.ts` | Emit `progress` SSE on each `TOOL_CALL_START`; emit `agent_meta` at start | Low | Feeds all new UI |
| 2 | `useAgentChat.ts` | Add `progressLines`, `isThinkingActive`, `thinkingTitle` to `ChatMessage` | Low | State for new components |
| 3 | `ThinkingContainer.tsx` | New component: collapsible, shimmer title, tool icon rows, random working messages | Medium-High | Core UX win |
| 4 | `AgentStatusBar.tsx` | Name + integration dots | Low | Context/orientation |
| 5 | `MarkdownMessage.tsx` | Replace `ToolCallBlock` with `ThinkingContainer`; remove old accordion | Low | Cleanup |
| 6 | `AgentChat.tsx` | Mount `AgentStatusBar`; pass `progressLines` / `isThinkingActive` to messages | Low | Wiring |
| 7 | `LLMTitleGenerator` | Async title gen via small model after completion | Medium | Polish |
| 8 | `MessageActionBar.tsx` | 👍 👎 Copy | Low | Polish |

Total estimated effort: **2–3 engineer-days** (simpler than the original 4-day estimate because we're copying proven patterns rather than inventing).

> **Note:** Steps 3 and 7 are independent. Step 3 (ThinkingContainer) gives the biggest UX improvement and can ship without Step 7 (LLM title gen). LLM title gen is a polish step.

---

## 8. What NOT to change (anti-patterns to avoid)

- Do not add a raw "system prompt" viewer — users don't need to see 57k tokens of skill instructions
- Do not show raw JSON for tool args by default — only on expand
- Do not auto-scroll to bottom during thinking (jarring) — only auto-scroll on new tokens
- Do not add a separate "debug" tab — visibility should be inline, not hidden behind a tab
- Do not show thinking panel for litellm mode (direct LLM, no tool calls) — hide ThinkingPanel if `progressLines.length === 0`

---

## 9. Files to create / modify

| File | Action | Notes |
|---|---|---|
| `src/components/ThinkingContainer.tsx` | Create | Core component; replaces per-tool accordion |
| `src/components/AgentStatusBar.tsx` | Create | Static, small |
| `src/components/MessageActionBar.tsx` | Create | 👍 👎 Copy |
| `src/components/MarkdownMessage.tsx` | Modify | Remove `ToolCallBlock`; use `ThinkingContainer` |
| `src/components/AgentChat.tsx` | Modify | Add `AgentStatusBar`, wire `progressLines` |
| `src/hooks/useAgentChat.ts` | Modify | Add `progressLines`, `isThinkingActive`, `thinkingTitle` |
| `src/app/api/agent/chat/route.ts` | Modify | Emit `progress` + `agent_meta` SSE events |
| `src/styles/thinking.css` | Create | Shimmer CSS animation |

---

## 10. Acceptance criteria

- [ ] Sending a message immediately shows a `ThinkingContainer` with shimmer title — **no blank screen**
- [ ] Container title starts `"Thinking…"`, transitions to `"Working: <tool label>"` on first tool call
- [ ] Title shimmer animation plays while active; stops (no flicker) when done
- [ ] Each tool call appears in the container header title as it starts
- [ ] Container auto-collapses 300ms after `RUN_FINISHED`; icon switches to green ✓
- [ ] Expand shows tool icon rows with random working messages while active
- [ ] After completion, LLM-generated title OR last tool label shown (never "Working" permanently)
- [ ] Agent name and integration status visible in `AgentStatusBar`
- [ ] 👍 👎 Copy visible on every assistant message
- [ ] Direct LLM mode (no tool calls) — `ThinkingContainer` NOT shown
- [ ] No visible regression on markdown, code blocks, MCQ choices, streaming cursor
