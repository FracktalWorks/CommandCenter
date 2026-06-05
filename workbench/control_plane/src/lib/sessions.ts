/**
 * Client-side chat session management backed by localStorage.
 * Migration path: swap getSessions/upsertSession/deleteSession to call
 * a /api/chat/sessions Postgres-backed route when persistence is needed.
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
  } catch {
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
}

export function deleteSession(id: string): void {
  const sessions = getSessions().filter((s) => s.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
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
}
