// Thin fetch wrappers over the /api/whatsapp proxy. Every call returns a safe
// default on failure so the read-only UI degrades to an empty state rather than
// throwing (the gateway may not be running in a pure-frontend dev session).

import type { WaAccount, WaChat, WaMessage, WaStreams } from "./types";

async function getJSON<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`/api/whatsapp/${path}`, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

export function fetchAccounts(): Promise<WaAccount[]> {
  return getJSON<WaAccount[]>("accounts", []);
}

export function fetchStreams(accountId?: string): Promise<WaStreams> {
  const q = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
  return getJSON<WaStreams>(`streams${q}`, {
    needs_reply: 0,
    waiting: 0,
    groups: 0,
    all: 0,
  });
}

export function fetchChats(stream: string, accountId?: string): Promise<WaChat[]> {
  const params = new URLSearchParams();
  if (stream) params.set("stream", stream);
  if (accountId) params.set("account_id", accountId);
  const qs = params.toString();
  return getJSON<WaChat[]>(`chats${qs ? `?${qs}` : ""}`, []);
}

export function fetchMessages(chatId: string): Promise<WaMessage[]> {
  return getJSON<WaMessage[]>(`chats/${chatId}/messages`, []);
}
