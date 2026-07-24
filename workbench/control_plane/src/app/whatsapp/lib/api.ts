// Thin fetch wrappers over the /api/whatsapp proxy. Every call returns a safe
// default on failure so the read-only UI degrades to an empty state rather than
// throwing (the gateway may not be running in a pure-frontend dev session).

import type {
  WaAccount,
  WaCategory,
  WaChat,
  WaChatContext,
  WaMessage,
  WaStreams,
  WaTemplate,
} from "./types";

async function getJSON<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`/api/whatsapp/${path}`, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

async function sendJSON<T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown
): Promise<{ ok: boolean; data: T | null; error?: string }> {
  try {
    const res = await fetch(`/api/whatsapp/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    if (!res.ok) {
      const detail =
        (data as { detail?: string } | null)?.detail ?? `HTTP ${res.status}`;
      return { ok: false, data: null, error: detail };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, data: null, error: "network error" };
  }
}

function postJSON<T>(path: string, body: unknown) {
  return sendJSON<T>(path, "POST", body);
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

export function fetchContext(chatId: string): Promise<WaChatContext | null> {
  return getJSON<WaChatContext | null>(`chats/${chatId}/context`, null);
}

export function fetchTemplates(accountId: string): Promise<WaTemplate[]> {
  return getJSON<WaTemplate[]>(
    `templates?account_id=${encodeURIComponent(accountId)}&approved_only=true`,
    []
  );
}

export function sendText(chatId: string, text: string) {
  return postJSON<{ wa_message_id: string; send_regime: string }>(
    `chats/${chatId}/send`,
    { text }
  );
}

export function sendTemplate(
  chatId: string,
  templateName: string,
  language: string
) {
  return postJSON<{ wa_message_id: string; send_regime: string }>(
    `chats/${chatId}/send`,
    { template_name: templateName, template_language: language }
  );
}

export function captureTask(messageId: string) {
  return postJSON<{ item_id: string; title: string; created: boolean }>(
    "capture-task",
    { message_id: messageId }
  );
}

export function generateDraft(chatId: string) {
  return postJSON<{ chat_id: string; draft_text: string; language: string }>(
    `chats/${chatId}/draft`,
    {}
  );
}

export function fetchCategories(accountId: string): Promise<WaCategory[]> {
  return getJSON<WaCategory[]>(
    `categories?account_id=${encodeURIComponent(accountId)}`,
    []
  );
}

export function bootstrapCategories(accountId: string) {
  return postJSON<WaCategory[]>(
    `accounts/${accountId}/categories/bootstrap`,
    {}
  );
}

export function updateCategory(
  categoryId: string,
  patch: Partial<
    Pick<
      WaCategory,
      "notify_policy" | "auto_reply_policy" | "draft_policy" | "escalate_after_mins"
    >
  >
) {
  return sendJSON<WaCategory>(`categories/${categoryId}`, "PATCH", patch);
}
