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
