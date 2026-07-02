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

import { serializeReasoning, parseReasoning } from "@/lib/chatStream";

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

/** Write to localStorage without letting a QuotaExceededError crash the caller
 *  (the session list / message cache can fill the quota on heavy users). */
function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota exceeded or storage unavailable — Postgres remains the durable store */
  }
}

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
  safeSetItem(STORAGE_KEY, JSON.stringify(sessions));
  // Background sync to Postgres — never blocks the UI.
  _syncSessionToDb(session).catch(() => {});
}

export function deleteSession(id: string): void {
  const sessions = getSessions().filter((s) => s.id !== id);
  safeSetItem(STORAGE_KEY, JSON.stringify(sessions));
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
  safeSetItem(STORAGE_KEY, JSON.stringify(sessions));
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
  safeSetItem(STORAGE_KEY, JSON.stringify(sessions));
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
        // Fall back to a formatted date (matching createSession) — NEVER the
        // raw UUID — so restored-from-DB sessions with no title don't show an
        // unreadable id in the sidebar.
        const fallbackName = (() => {
          const d = new Date(r.createdAt);
          return isNaN(d.getTime())
            ? "Conversation"
            : d.toLocaleString("en-IN", {
                day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
              });
        })();
        local.push({
          id: r.id,
          name: r.title ?? fallbackName,
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
    safeSetItem(STORAGE_KEY, JSON.stringify(local));
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
  /** Real assistant-message segments (Phase 3b) — restored from
   *  agent_state.segments so segment-native rendering survives a reload. */
  segments?: { id: string; text: string }[];
}

const MESSAGES_PREFIX = "cc-msgs-";
/** Maximum messages kept per session to avoid storage bloat. */
const MAX_MESSAGES_PER_SESSION = 200;

// ── Send-queue persistence ────────────────────────────────────────────────
// Queued/steered messages live in an in-memory ref while the component is
// mounted, but that ref is lost on a page refresh or when the user switches
// to another agent's session (the queue belongs to a specific session).
// Persist it per-session so a queued message survives both.
const QUEUE_PREFIX = "cc-queue-";

/** Read the persisted send-queue for a session (survives refresh / switch). */
export function getQueue(sessionId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(QUEUE_PREFIX + sessionId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch (_e) {
    return [];
  }
}

/** Persist (or clear, when empty) the send-queue for a session. */
export function saveQueue(sessionId: string, queue: string[]): void {
  if (typeof window === "undefined") return;
  try {
    if (queue.length === 0) localStorage.removeItem(QUEUE_PREFIX + sessionId);
    else localStorage.setItem(QUEUE_PREFIX + sessionId, JSON.stringify(queue));
  } catch (_e) {
    // Storage quota exceeded — best-effort only.
  }
}

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
  // The server-side stream route (translateAndPersistStream in
  // app/api/agent/chat/route.ts) is the AUTHORITATIVE writer for an assistant
  // message while it streams — it accumulates the full SSE stream and re-upserts
  // the SAME row (by id) every ~3s and at completion.  If the client also POSTs
  // its partial / possibly-stale snapshot of a still-streaming assistant row,
  // the two last-writer-wins upserts race and a late client write can TRUNCATE
  // the server's final content.  Exclude still-streaming assistant rows from the
  // DB write; the client persists them once settled (streaming=false), which is
  // idempotent with the server's final.  (localStorage above still keeps the
  // streaming rows for refresh-recovery detection.)
  // NOTE: litellm mode has NO server-side persister, so a litellm reply is
  // durable only in localStorage until it settles (streaming=false), after which
  // this path writes the final.  Don't "fix" that by re-adding streaming-row
  // writes — it reintroduces the truncation race on the copilot/executor path
  // (which IS persisted server-side during the stream).
  const forDb = settled.filter((m) => !(m.role === "assistant" && m.streaming));
  if (forDb.length === 0) return;
  const payload = forDb.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    tool_events: m.toolEvents ?? [],
    progress_lines: m.progressLines ?? [],
    // Stored as JSON (serializeReasoning) so a block containing a "---" line
    // can't be torn apart on restore — see chatStream.parseReasoning.
    reasoning: serializeReasoning(m.reasoningBlocks),
    // Persist the structured todo list + real message segments (Phase 3b)
    // inside agent_state so the Todos panel and segment-native rendering
    // survive a refresh (no dedicated DB columns needed).
    agent_state: ((): Record<string, unknown> | null => {
      const st: Record<string, unknown> = { ...(m.agentState ?? {}) };
      if (m.todos && m.todos.length > 0) st.todos = m.todos;
      if (m.segments && m.segments.length > 0) st.segments = m.segments;
      return Object.keys(st).length > 0 ? st : null;
    })(),
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
 *
 * Pass `opts` to lazy-load a window of history instead of the full session:
 *   - `limit`:  return only the most recent N messages (windowed restore).
 *   - `before`: a `timestamp` cursor — only messages older than it (used to
 *               page backwards on scroll-up).
 *
 * When paginating (limit or before set), the localStorage cache is left
 * untouched — the caller merges the window into the visible list and the
 * component's own save effect persists it.  Only an unpaginated full fetch
 * rewrites the cache authoritatively.
 */
export async function fetchMessagesFromDb(
  sessionId: string,
  opts?: { limit?: number; before?: number },
): Promise<PersistedMessage[]> {
  const paginated = !!(opts?.limit || opts?.before);
  try {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.before) qs.set("before", String(opts.before));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await fetch(`/api/chat/sessions/${sessionId}/messages${suffix}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return paginated ? [] : getMessages(sessionId);
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
      reasoningBlocks: parseReasoning(r.reasoning),
      reasoning: undefined,
      // Restore the todo list from agent_state (where it was persisted).
      todos: r.todos
        ?? (r.agentState?.todos as
          | { id: string; title: string; status: string }[]
          | undefined),
      // Restore real message segments (Phase 3b) so segment-native rendering
      // survives a full reload — the renderer prefers these over the folded
      // content when present.
      segments: r.agentState?.segments as
        | { id: string; text: string }[]
        | undefined,
    }));
    // Update localStorage cache with authoritative Postgres data — only on a
    // full (unpaginated) fetch.  A windowed/paginated fetch must not shrink or
    // clobber the cache.
    if (!paginated) {
      try {
        localStorage.setItem(MESSAGES_PREFIX + sessionId, JSON.stringify(mapped));
      } catch (_e) { /* quota */ }
    }
    return mapped as unknown as PersistedMessage[];
  } catch (_e) {
    return paginated ? [] : getMessages(sessionId);
  }
}

export function deleteMessages(sessionId: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(MESSAGES_PREFIX + sessionId);
  // Postgres messages are CASCADE-deleted when the session is deleted via the API.
}
