/**
 * Client-side chat session management.
 *
 * localStorage is the synchronous source-of-truth for the sidebar list (instant reads).
 * Every mutating operation also fires an async Postgres sync in the background so history
 * survives browser cache clears and is accessible from any device.
 *
 * Message persistence: `getMessages` / `saveMessages` use the Postgres API as primary
 * store and write-through to localStorage for instant reads on mount.
 */

export interface ChatSession {
  id: string;
  name: string;
  agentName: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Auto-derived from the first user message (M2.6). Falls back to `name`. */
  title?: string;
  /** Last ~120 chars of the most recent assistant turn, shown as a subtitle. */
  lastPreview?: string;
}

const STORAGE_KEY = "cc-chat-sessions";

export function getSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as ChatSession[];
  } catch (_e) {
    return [];
  }
}

export function upsertSession(session: ChatSession): void {
  const sessions = getSessions();
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.unshift(session);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  // Background sync to Postgres — never blocks the UI.
  _syncSessionToDb(session).catch(() => {});
}

export function deleteSession(id: string): void {
  const sessions = getSessions().filter((s) => s.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  // Also remove the persisted messages for this session.
  deleteMessages(id);
  // Background delete from Postgres.
  fetch(`/api/chat/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

export function createSession(agentName = "orchestrator"): ChatSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: new Date().toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
    agentName,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
}

export function touchSession(id: string, messageCount?: number): void {
  const sessions = getSessions();
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  s.updatedAt = new Date().toISOString();
  if (messageCount !== undefined) s.messageCount = messageCount;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

/** Truncate text at a word boundary, appending an ellipsis when cut. */
function truncateAtWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + "\u2026";
}

/**
 * Enrich a session with an auto-title (from the first user message) and a
 * last-turn preview. No-op for fields left undefined. Title is only set once,
 * so manual edits / the first message win and later turns don't overwrite it.
 */
export function enrichSession(
  id: string,
  info: { firstUserMessage?: string; lastPreview?: string; messageCount?: number },
): void {
  const sessions = getSessions();
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  if (info.firstUserMessage && !s.title) {
    s.title = truncateAtWord(info.firstUserMessage, 60);
  }
  if (info.lastPreview !== undefined) {
    s.lastPreview = truncateAtWord(info.lastPreview, 120);
  }
  if (info.messageCount !== undefined) s.messageCount = info.messageCount;
  s.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  // Sync enriched metadata to Postgres in background.
  _patchSessionInDb(id, {
    title: s.title,
    lastPreview: s.lastPreview,
    messageCount: s.messageCount,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Postgres API helpers (all async, all fire-and-forget safe)
// ---------------------------------------------------------------------------

/** Push a full session record to Postgres (create or update). */
async function _syncSessionToDb(s: ChatSession): Promise<void> {
  await fetch("/api/chat/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: s.id,
      agent_name: s.agentName,
      title: s.title ?? null,
      last_preview: s.lastPreview ?? null,
      message_count: s.messageCount,
    }),
  });
}

/** Partially update session metadata in Postgres. */
async function _patchSessionInDb(
  id: string,
  patch: { title?: string; lastPreview?: string; messageCount?: number },
): Promise<void> {
  await fetch(`/api/chat/sessions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: patch.title ?? null,
      last_preview: patch.lastPreview ?? null,
      message_count: patch.messageCount ?? null,
    }),
  });
}

/**
 * Fetch sessions from Postgres and merge into localStorage.
 * Called once on app mount by chat/page.tsx to restore sessions on a fresh browser.
 * localStorage wins for ordering (user-local reordering), Postgres wins for content.
 */
export async function fetchAndMergeSessionsFromDb(): Promise<ChatSession[]> {
  try {
    const res = await fetch("/api/chat/sessions", { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return getSessions();
    const remote = (await res.json()) as Array<{
      id: string;
      agentName: string;
      title?: string;
      lastPreview?: string;
      messageCount: number;
      createdAt: string;
      updatedAt: string;
    }>;

    const local = getSessions();
    const localIds = new Set(local.map((s) => s.id));

    // Add any sessions from Postgres that aren't in localStorage.
    for (const r of remote) {
      if (!localIds.has(r.id)) {
        local.push({
          id: r.id,
          name: r.title ?? r.id,
          agentName: r.agentName,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          messageCount: r.messageCount,
          title: r.title,
          lastPreview: r.lastPreview,
        });
      }
    }

    // Sort by updatedAt descending.
    local.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
    return local;
  } catch (_e) {
    return getSessions();
  }
}

// ---------------------------------------------------------------------------
// Message persistence — localStorage write-through cache + Postgres primary store
//
// localStorage:  instant reads on mount (no loading flash)
// Postgres:      durable store, survives browser cache clears / new devices
//
// Ephemeral fields (streaming, isThinkingActive) are never saved.
// ---------------------------------------------------------------------------

/** Minimal persisted shape — no streaming/ephemeral fields. */
export interface PersistedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /** True if the assistant was still streaming when saved (recovery flag). */
  streaming?: boolean;
  toolEvents?: unknown[];
  progressLines?: string[];
  reasoningBlocks?: string[];
  agentState?: Record<string, unknown>;
  customEvents?: { name: string; value: unknown }[];
  /** Agent's structured todo list (VS Code Todos panel parity). */
  todos?: { id: string; title: string; status: string }[];
}

const MESSAGES_PREFIX = "cc-msgs-";
/** Maximum messages kept per session to avoid storage bloat. */
const MAX_MESSAGES_PER_SESSION = 200;

/** Read from localStorage cache (synchronous, instant). */
export function getMessages(sessionId: string): PersistedMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MESSAGES_PREFIX + sessionId);
    return raw ? (JSON.parse(raw) as PersistedMessage[]) : [];
  } catch (_e) {
    return [];
  }
}

/**
 * Save messages to localStorage immediately, then POST to Postgres in background.
 * Streaming messages (even with empty content) are preserved so the recovery
 * effect can detect an interrupted stream on page reload.  __ERROR__ system
 * messages are always skipped.
 */
export function saveMessages(sessionId: string, messages: PersistedMessage[]): void {
  if (typeof window === "undefined") return;
  const settled = messages
    .filter((m) =>
      m.role === "user" ||
      m.content.trim().length > 0 ||
      // Preserve streaming assistant messages even if empty — the recovery
      // effect needs them to detect an interrupted stream on reload.
      (m.role === "assistant" && m.streaming)
    )
    .filter((m) => !(m.role === "system" && m.content.startsWith("__ERROR__")))
    .slice(-MAX_MESSAGES_PER_SESSION);

  // 1. Write-through cache (sync, instant)
  try {
    localStorage.setItem(MESSAGES_PREFIX + sessionId, JSON.stringify(settled));
  } catch (_e) {
    // Storage quota exceeded — continue to Postgres anyway
  }

  // 2. Persist to Postgres (async, background)
  if (settled.length === 0) return;
  const payload = settled.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    tool_events: m.toolEvents ?? [],
    progress_lines: m.progressLines ?? [],
    // Gateway expects a string — join blocks with the \n---\n separator so
    // restore can split them back with indices intact (reasoningCutoff).
    reasoning: m.reasoningBlocks && m.reasoningBlocks.length > 0
      ? m.reasoningBlocks.join("\n---\n")
      : null,
    agent_state: m.agentState ?? null,
    custom_events: m.customEvents ?? [],
  }));
  fetch(`/api/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/**
 * Load messages from Postgres and update the localStorage cache.
 * Returns the fetched list, or falls back to the localStorage cache on error.
 */
export async function fetchMessagesFromDb(sessionId: string): Promise<PersistedMessage[]> {
  try {
    const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return getMessages(sessionId);
    const remote = (await res.json()) as Array<{
      id: string;
      role: "user" | "assistant" | "system";
      content: string;
      timestamp: number;
      toolEvents?: unknown[];
      progressLines?: string[];
      reasoning?: string;
      agentState?: Record<string, unknown>;
      customEvents?: { name: string; value: unknown }[];
      todos?: { id: string; title: string; status: string }[];
    }>;
    // Map Postgres `reasoning` field to localStorage `reasoningBlocks`.
    // Split on the block separator WITHOUT dropping empty segments so block
    // indices stay aligned with each tool's reasoningCutoff.
    const mapped = remote.map((r) => ({
      ...r,
      reasoningBlocks: r.reasoning ? r.reasoning.split("\n---\n") : undefined,
      reasoning: undefined,
    }));
    // Update localStorage cache with authoritative Postgres data.
    try {
      localStorage.setItem(MESSAGES_PREFIX + sessionId, JSON.stringify(mapped));
    } catch (_e) { /* quota */ }
    return mapped as unknown as PersistedMessage[];
  } catch (_e) {
    return getMessages(sessionId);
  }
}

export function deleteMessages(sessionId: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(MESSAGES_PREFIX + sessionId);
  // Postgres messages are CASCADE-deleted when the session is deleted via the API.
}
