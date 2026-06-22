/**
 * Email AI-chat session persistence.
 *
 * localStorage is the instant source of truth (so a conversation survives
 * closing/reopening the panel and you can switch between past sessions). Each
 * change is also best-effort synced to the shared chat-session backend
 * (agent_name = "email-assistant") for durability + background-run tracking.
 */
const LIST_KEY = "email-chat-sessions";
const MSG_PREFIX = "email-chat-msgs-";
const AGENT = "email-assistant";

export interface EmailChatSession {
  id: string;
  title?: string;
  lastPreview?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number; // epoch ms
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full / unavailable — non-fatal
  }
}

function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getSessions(): EmailChatSession[] {
  return read<EmailChatSession[]>(LIST_KEY, []);
}

function persistList(list: EmailChatSession[]): void {
  write(LIST_KEY, list);
}

function syncSession(s: EmailChatSession): void {
  fetch("/api/chat/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: s.id,
      agent_name: AGENT,
      title: s.title ?? null,
      last_preview: s.lastPreview ?? null,
      message_count: s.messageCount,
    }),
  }).catch(() => {});
}

export function createSession(): EmailChatSession {
  const now = new Date().toISOString();
  const s: EmailChatSession = {
    id: uuid(),
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  persistList([s, ...getSessions()]);
  syncSession(s);
  return s;
}

export function deleteSession(id: string): void {
  persistList(getSessions().filter((s) => s.id !== id));
  try {
    localStorage.removeItem(MSG_PREFIX + id);
  } catch {
    /* ignore */
  }
  fetch(`/api/chat/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

export function getMessages(id: string): StoredChatMessage[] {
  return read<StoredChatMessage[]>(MSG_PREFIX + id, []);
}

export function saveMessages(id: string, msgs: StoredChatMessage[]): void {
  const trimmed = msgs.slice(-200);
  write(MSG_PREFIX + id, trimmed);

  const list = getSessions();
  const s = list.find((x) => x.id === id);
  if (s) {
    const firstUser = trimmed.find((m) => m.role === "user");
    if (firstUser && !s.title) s.title = firstUser.content.slice(0, 60);
    const last = trimmed[trimmed.length - 1];
    if (last) s.lastPreview = last.content.replace(/\s+/g, " ").slice(0, 100);
    s.messageCount = trimmed.length;
    s.updatedAt = new Date().toISOString();
    persistList(list);
    syncSession(s);
  }

  // Best-effort durable persistence to the shared chat backend.
  fetch(`/api/chat/sessions/${id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      trimmed.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      }))
    ),
  }).catch(() => {});
}

/** Session ids with an agent run currently in flight (background or this tab). */
export async function fetchActiveSessionIds(): Promise<Set<string>> {
  try {
    const res = await fetch("/api/chat/active-sessions", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return new Set();
    const rows: { threadId?: string }[] = await res.json();
    const ids = new Set<string>();
    for (const r of rows) {
      // threadId is "email-chat:<user>:<sessionId>"
      if (r.threadId && r.threadId.startsWith("email-chat:")) {
        const id = r.threadId.split(":").pop();
        if (id) ids.add(id);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}
