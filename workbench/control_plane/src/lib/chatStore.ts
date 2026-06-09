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
}

function _defaultState(): SessionStreamState {
  return { messages: [], isLoading: false, error: null, abortController: null };
}

// ── Module-level store ───────────────────────────────────────────────────────

const _store = new Map<string, SessionStreamState>();
const _listeners = new Map<string, Set<() => void>>();

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
  const prev = getSessionState(id); // uses the cached entry, never a transient object
  const next = updater(prev);
  _store.set(id, next);
  // Notify all subscribers for this session.
  _listeners.get(id)?.forEach((l) => l());
}

export function subscribeSession(id: string, listener: () => void): () => void {
  if (!_listeners.has(id)) _listeners.set(id, new Set());
  _listeners.get(id)!.add(listener);
  return () => {
    _listeners.get(id)?.delete(listener);
  };
}
