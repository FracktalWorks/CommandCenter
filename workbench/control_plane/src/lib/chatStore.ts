/**
 * chatStore — module-level singleton that holds streaming chat state for every session.
 *
 * Why: React component state is destroyed on unmount (navigation away / session switch).
 * By storing messages + stream state here, active SSE loops continue writing even when
 * the component is unmounted, and remounting immediately reflects the current state.
 *
 * Usage (via useSyncExternalStore in useAgentChat.ts):
 *   const state = useSyncExternalStore(
 *     (l) => subscribeSession(id, l),
 *     () => getSessionState(id),
 *   );
 */

// ── ChatMessage type (co-located here to avoid circular imports) ────────────

export type ToolEventStatus = "running" | "done" | "error";

export interface SubAgentTool {
  id: string;
  name: string;
  status: ToolEventStatus;
  result?: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: ToolEventStatus;
  startedAt?: number;
  endedAt?: number;
  /** Number of reasoning blocks that existed when this tool started.
   *  Lets the UI interleave reasoning text and tool calls chronologically
   *  (VS Code-style timeline) without a separate timeline structure —
   *  this field persists through the existing tool_events JSONB column. */
  reasoningCutoff?: number;
  /** True while a delegated sub-agent is still running. */
  subAgentActive?: boolean;
  /** Name of the sub-agent being delegated to. */
  subAgentName?: string;
  /** Accumulated streaming text from the sub-agent. */
  subAgentText?: string;
  /** Tool calls made inside the sub-agent. */
  subAgentTools?: SubAgentTool[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /** True while the assistant is still streaming tokens. */
  streaming?: boolean;
  toolEvents?: ToolEvent[];
  progressLines?: string[];
  isThinkingActive?: boolean;
  /** Sequential reasoning blocks — each displayed as a separate timeline entry. */
  reasoningBlocks?: string[];
  /** Agent's structured todo list (VS Code Todos panel parity). */
  todos?: { id: string; title: string; status: string }[];
  agentState?: Record<string, unknown>;
  customEvents?: { name: string; value: unknown }[];
}

// ── Session state ────────────────────────────────────────────────────────────

export interface SessionStreamState {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  /** Kept here so stopGeneration() can abort even when component is unmounted. */
  abortController: AbortController | null;
  /** True when the stream was interrupted (refresh/tab-close) and polling is
   *  actively recovering content from Postgres.  The UI shows a "Reconnecting…"
   *  indicator while this is true. */
  recovering: boolean;
  /** Last SSE event ID received from the server.  Used for stream reconnection:
   *  on reconnect the client sends this ID so the server can replay only events
   *  that arrived after the disconnect. */
  lastEventId: string | null;
  /** Tracks the agent's run state for the UI status indicator:
   *  - "idle": no agent running
   *  - "running": agent is actively executing (confirmed by server)
   *  - "recovering": reconnecting or polling for content after disconnect
   *  - "unknown": can't determine status (e.g. Redis unavailable) */
  runStatus: "idle" | "running" | "recovering" | "unknown";
}

function _defaultState(): SessionStreamState {
  return { messages: [], isLoading: false, error: null, abortController: null, recovering: false, lastEventId: null, runStatus: "idle" };
}

// ── Module-level store ───────────────────────────────────────────────────────

const _store = new Map<string, SessionStreamState>();
const _listeners = new Map<string, Set<() => void>>();
const _globalListeners = new Set<() => void>();

export function getSessionState(id: string): SessionStreamState {
  // Always return the stored entry — never create a transient object.
  // useSyncExternalStore requires getSnapshot to return the SAME reference
  // when the state hasn't changed; a fresh _defaultState() on every call
  // causes React to see a "new" state on every render → infinite loop.
  if (!_store.has(id)) {
    _store.set(id, _defaultState());
  }
  return _store.get(id)!;
}

export function setSessionState(
  id: string,
  updater: (prev: SessionStreamState) => SessionStreamState,
): void {
  const prev = getSessionState(id);
  const next = updater(prev);
  _store.set(id, next);
  // Notify per-session subscribers.
  _listeners.get(id)?.forEach((l) => l());
  // Notify global subscribers when isLoading toggles.
  if (prev.isLoading !== next.isLoading) {
    _invalidActiveIdsCache();
    _globalListeners.forEach((l) => l());
  }
}

export function subscribeSession(id: string, listener: () => void): () => void {
  if (!_listeners.has(id)) _listeners.set(id, new Set());
  _listeners.get(id)!.add(listener);
  return () => {
    _listeners.get(id)?.delete(listener);
  };
}

// ── Global subscribers (for active-sessions tracking) ────────────────────

/** Subscribe to ANY session state change (for active-sessions dashboard). */
export function subscribeAllSessions(listener: () => void): () => void {
  _globalListeners.add(listener);
  return () => { _globalListeners.delete(listener); };
}

/** Get the set of session IDs that currently have isLoading === true. */
export function getActiveSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const [id, state] of _store) {
    if (state.isLoading) ids.add(id);
  }
  return ids;
}

// Cached active-IDs snapshot — must return the SAME reference
// when the set hasn't changed, otherwise useSyncExternalStore re-renders infinitely.
let _cachedActiveIds: Set<string> | null = null;
let _cachedActiveIdsStr: string | null = null;

function _invalidActiveIdsCache() {
  _cachedActiveIds = null;
  _cachedActiveIdsStr = null;
}

export function getActiveSessionIdsStable(): Set<string> {
  const fresh = getActiveSessionIds();
  const str = JSON.stringify([...fresh].sort());
  if (_cachedActiveIds && _cachedActiveIdsStr === str) return _cachedActiveIds;
  _cachedActiveIds = fresh;
  _cachedActiveIdsStr = str;
  return fresh;
}
