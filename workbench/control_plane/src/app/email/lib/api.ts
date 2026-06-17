import { ChatMessage, Email, EmailAccount } from "./types";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:8000";

async function gatewayFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Gateway error ${res.status}`);
  }

  return res.json();
}

// ── Email Accounts ───────────────────────────────────────────────────────

export async function listEmailAccounts(): Promise<EmailAccount[]> {
  return gatewayFetch<EmailAccount[]>("/email/accounts");
}

export async function deleteEmailAccount(id: string): Promise<void> {
  await gatewayFetch(`/email/accounts/${id}`, { method: "DELETE" });
}

export async function updateEmailAccount(
  id: string,
  updates: Partial<Pick<EmailAccount, "label" | "syncEnabled">>
): Promise<EmailAccount> {
  return gatewayFetch<EmailAccount>(`/email/accounts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

// ── Emails ───────────────────────────────────────────────────────────────

export interface ListEmailsParams {
  accountId?: string;
  folder?: string;
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface ListEmailsResponse {
  emails: Email[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listEmails(
  params: ListEmailsParams = {}
): Promise<ListEmailsResponse> {
  const searchParams = new URLSearchParams();
  if (params.accountId) searchParams.set("account_id", params.accountId);
  if (params.folder) searchParams.set("folder", params.folder);
  if (params.query) searchParams.set("query", params.query);
  if (params.page) searchParams.set("page", String(params.page));
  if (params.pageSize) searchParams.set("page_size", String(params.pageSize));

  return gatewayFetch<ListEmailsResponse>(
    `/email/messages?${searchParams.toString()}`
  );
}

export async function getEmail(id: string): Promise<Email> {
  return gatewayFetch<Email>(`/email/messages/${id}`);
}

export async function updateEmail(
  id: string,
  updates: Partial<Pick<Email, "isRead" | "isStarred" | "isFlagged" | "folder" | "labels">>
): Promise<Email> {
  return gatewayFetch<Email>(`/email/messages/${id}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteEmail(id: string): Promise<void> {
  await gatewayFetch(`/email/messages/${id}`, { method: "DELETE" });
}

// ── Send ─────────────────────────────────────────────────────────────────

export interface SendEmailParams {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  replyToMessageId?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<{ id: string }> {
  return gatewayFetch<{ id: string }>("/email/send", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

// ── Sync ─────────────────────────────────────────────────────────────────

export async function triggerSync(accountId: string): Promise<{ ok: boolean }> {
  return gatewayFetch<{ ok: boolean }>("/email/sync", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId }),
  });
}

// ── AI Chat ──────────────────────────────────────────────────────────────

export interface AIChatRequest {
  messages: { role: "user" | "assistant"; content: string }[];
  accountId?: string;
  emailContextId?: string; // currently selected email for context
}

export async function streamAIChat(
  request: AIChatRequest,
  onEvent: (event: { type: string; content?: string; done?: boolean }) => void
): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/email/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!res.ok) throw new Error(`AI chat failed: ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6));
          onEvent(data);
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }
}

// ── Quick Actions ─────────────────────────────────────────────────────────

export interface QuickActionResponse {
  action: string;
  result: string;
  ok: boolean;
}

export async function triggerQuickAction(
  action: string,
  accountId?: string,
  emailId?: string
): Promise<QuickActionResponse> {
  return gatewayFetch<QuickActionResponse>("/email/ai/quick-action", {
    method: "POST",
    body: JSON.stringify({
      action,
      account_id: accountId ?? null,
      email_id: emailId ?? null,
    }),
  });
}

// ── OAuth ────────────────────────────────────────────────────────────────

export function getOAuthUrl(provider: "gmail" | "microsoft"): string {
  return `${GATEWAY_URL}/email/oauth/${provider}/authorize`;
}
