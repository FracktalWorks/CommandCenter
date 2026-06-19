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

// ── Snake → CamelCase mappers ────────────────────────────────────────────

function asProvider(v: unknown): "gmail" | "microsoft" | "imap" {
  const s = String(v ?? "");
  if (s === "gmail" || s === "microsoft" || s === "imap") return s;
  return "imap";
}

/** Map a backend EmailAccount (snake_case) to frontend EmailAccount (camelCase). */
function mapAccount(raw: Record<string, unknown>): EmailAccount {
  return {
    id: String(raw.id ?? ""),
    provider: asProvider(raw.provider),
    emailAddress: String(raw.email_address ?? ""),
    label: String(raw.label ?? ""),
    avatar: (String(raw.email_address ?? "?").charAt(0) || "?").toUpperCase(),
    color: String(raw.avatar_color ?? "#6366f1"),
    unreadCount: Number(raw.unread_count ?? 0),
    syncEnabled: Boolean(raw.sync_enabled ?? true),
    lastSyncedAt: raw.last_synced_at ? String(raw.last_synced_at) : undefined,
  };
}

/** Map a backend Email message (snake_case) to frontend Email (camelCase). */
function mapEmail(raw: Record<string, unknown>): Email {
  const fromRaw = (raw.from_address ?? raw.from ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ""),
    providerMessageId: String(raw.provider_message_id ?? ""),
    threadId: raw.thread_id ? String(raw.thread_id) : undefined,
    accountId: String(raw.account_id ?? ""),
    from: {
      name: String(fromRaw.name ?? fromRaw.Name ?? ""),
      email: String(fromRaw.email ?? fromRaw.Email ?? ""),
    },
    to: ((raw.to_addresses ?? raw.to ?? []) as Array<Record<string, unknown>>).map(
      (a) => ({ name: String(a.name ?? a.Name ?? ""), email: String(a.email ?? a.Email ?? "") })
    ),
    cc: ((raw.cc_addresses ?? raw.cc ?? []) as Array<Record<string, unknown>>).map(
      (a) => ({ name: String(a.name ?? ""), email: String(a.email ?? "") })
    ),
    bcc: ((raw.bcc_addresses ?? raw.bcc ?? []) as Array<Record<string, unknown>>).map(
      (a) => ({ name: String(a.name ?? ""), email: String(a.email ?? "") })
    ),
    subject: String(raw.subject ?? ""),
    bodyText: String(raw.body_text ?? raw.bodyText ?? ""),
    bodyHtml: (raw.body_html as string) ?? (raw.bodyHtml as string) ?? undefined,
    bodyTruncated: Boolean(raw.body_truncated ?? raw.bodyTruncated ?? false),
    snippet: String(raw.snippet ?? ""),
    hasAttachments: Boolean(raw.has_attachments ?? raw.hasAttachments ?? false),
    attachments: ((raw.attachments as Array<Record<string, unknown>>) ?? []).map(
      (a) => ({
        id: String(a.id ?? ""),
        filename: String(a.filename ?? ""),
        mimeType: String(a.mime_type ?? a.mimeType ?? "application/octet-stream"),
        sizeBytes: Number(a.size_bytes ?? a.sizeBytes ?? 0),
        downloadUrl: (a.download_url as string) ?? (a.downloadUrl as string) ?? undefined,
      })
    ),
    isRead: Boolean(raw.is_read ?? raw.isRead ?? false),
    isStarred: Boolean(raw.is_starred ?? raw.isStarred ?? false),
    isFlagged: Boolean(raw.is_flagged ?? raw.isFlagged ?? false),
    labels: (raw.labels as string[]) ?? [],
    folder: String(raw.folder ?? "INBOX"),
    receivedAt: raw.received_at ? String(raw.received_at) : new Date().toISOString(),
    syncedAt: raw.synced_at ? String(raw.synced_at) : new Date().toISOString(),
  };
}

// ── Email Accounts ───────────────────────────────────────────────────────

export async function listEmailAccounts(): Promise<EmailAccount[]> {
  const raw = await gatewayFetch<Record<string, unknown>[]>("/email/accounts");
  return (raw ?? []).map(mapAccount);
}

export interface CreateEmailAccountParams {
  provider: "imap" | "gmail" | "microsoft";
  emailAddress: string;
  label?: string;
  credentials: Record<string, unknown>;
}

export async function createEmailAccount(
  params: CreateEmailAccountParams
): Promise<EmailAccount> {
  const body: Record<string, unknown> = {
    provider: params.provider,
    email_address: params.emailAddress,
    label: params.label ?? "",
    credentials: params.credentials,
  };
  const raw = await gatewayFetch<Record<string, unknown>>(
    "/email/accounts",
    { method: "POST", body: JSON.stringify(body) }
  );
  return mapAccount(raw);
}

export async function deleteEmailAccount(id: string): Promise<void> {
  await gatewayFetch(`/email/accounts/${id}`, { method: "DELETE" });
}

export async function updateEmailAccount(
  id: string,
  updates: Partial<Pick<EmailAccount, "label" | "syncEnabled">>
): Promise<EmailAccount> {
  // Map camelCase → snake_case for the backend PATCH
  const body: Record<string, unknown> = {};
  if (updates.label !== undefined) body.label = updates.label;
  if (updates.syncEnabled !== undefined) body.sync_enabled = updates.syncEnabled;
  const raw = await gatewayFetch<Record<string, unknown>>(
    `/email/accounts/${id}`,
    { method: "PATCH", body: JSON.stringify(body) }
  );
  return mapAccount(raw);
}

// ── Folders ──────────────────────────────────────────────────────────────

export interface EmailFolderRaw {
  provider_folder_id: string;
  name: string;
  type: string; // 'system' | 'user'
  message_count: number;
  unread_count: number;
}

export async function listEmailFolders(
  accountId: string
): Promise<EmailFolderRaw[]> {
  return gatewayFetch<EmailFolderRaw[]>(
    `/email/accounts/${accountId}/folders`
  );
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

  const raw = await gatewayFetch<{
    emails: Record<string, unknown>[];
    total: number;
    page: number;
    page_size: number;
  }>(`/email/messages?${searchParams.toString()}`);

  return {
    emails: (raw.emails ?? []).map(mapEmail),
    total: raw.total ?? 0,
    page: raw.page ?? 1,
    pageSize: raw.page_size ?? 50,
  };
}

export async function getEmail(id: string): Promise<Email> {
  const raw = await gatewayFetch<Record<string, unknown>>(`/email/messages/${id}`);
  return mapEmail(raw);
}

// ── Full-body fetch (for truncated messages) ────────────────────────────

export interface FullBodyResponse {
  message_id: string;
  body_text: string;
  body_html: string | null;
  subject: string;
  from: string;
}

export async function fetchFullBody(id: string): Promise<FullBodyResponse> {
  return gatewayFetch<FullBodyResponse>(`/email/messages/${id}/full-body`);
}

export async function updateEmail(
  id: string,
  updates: Partial<Pick<Email, "isRead" | "isStarred" | "isFlagged" | "folder" | "labels">>
): Promise<Email> {
  // Map camelCase → snake_case for the backend PATCH
  const body: Record<string, unknown> = {};
  if (updates.isRead !== undefined) body.is_read = updates.isRead;
  if (updates.isStarred !== undefined) body.is_starred = updates.isStarred;
  if (updates.isFlagged !== undefined) body.is_flagged = updates.isFlagged;
  if (updates.folder !== undefined) body.folder = updates.folder;
  if (updates.labels !== undefined) body.labels = updates.labels;
  const raw = await gatewayFetch<Record<string, unknown>>(
    `/email/messages/${id}`,
    { method: "PATCH", body: JSON.stringify(body) }
  );
  return mapEmail(raw);
}

export async function deleteEmail(id: string): Promise<void> {
  await gatewayFetch(`/email/messages/${id}`, { method: "DELETE" });
}

// ── Attachments ────────────────────────────────────────────────────────────

export function getAttachmentDownloadUrl(attachmentId: string): string {
  return `${GATEWAY_URL}/email/attachments/${attachmentId}/download`;
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
  // Map camelCase → snake_case for the backend
  const body: Record<string, unknown> = {
    account_id: params.accountId,
    to: params.to,
    subject: params.subject,
    body_text: params.bodyText,
  };
  if (params.cc) body.cc = params.cc;
  if (params.bcc) body.bcc = params.bcc;
  if (params.bodyHtml) body.body_html = params.bodyHtml;
  if (params.replyToMessageId) body.reply_to_message_id = params.replyToMessageId;
  return gatewayFetch<{ id: string }>("/email/send", {
    method: "POST",
    body: JSON.stringify(body),
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

const WORKBENCH_URL =
  (typeof window !== "undefined" ? window.location.origin : "") ||
  process.env.NEXT_PUBLIC_WORKBENCH_URL ||
  "http://localhost:3001";

export function getOAuthUrl(provider: "gmail" | "microsoft"): string {
  return `${GATEWAY_URL}/email/oauth/${provider}/authorize`;
}

export function getOAuthAuthorizeUrl(
  provider: "gmail" | "microsoft",
  redirectAfter?: string
): string {
  const params = new URLSearchParams();
  if (redirectAfter) params.set("redirect_after", redirectAfter);
  const qs = params.toString();
  return `${GATEWAY_URL}/email/oauth/${provider}/authorize${qs ? `?${qs}` : ""}`;
}

export function getOAuthCallbackUrl(): string {
  return `${WORKBENCH_URL}/email/oauth/callback`;
}
