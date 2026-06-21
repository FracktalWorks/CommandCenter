import {
  ChatMessage, Email, EmailAccount,
  AnalyticsOverview, SenderStat, NewsletterStatus,
  AutomationRule, RuleTestResult, ExecutedRule, AssistantSettings,
  RecentTestResult, ColdSender, ReplyZeroThread, KnowledgeEntry,
} from "./types";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:8000";

async function gatewayFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  // `path` already includes the gateway's `/email` router prefix (e.g.
  // "/email/accounts"), and the Next proxy lives at `/api/email/[...path]`.
  // Prefix with `/api` (NOT `/api/email`) so we hit `/api/email/accounts`,
  // not the doubled `/api/email/email/accounts` (which 404s).
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.detail || `Gateway error ${res.status}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
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
    syncStatus: raw.sync_status ? String(raw.sync_status) : undefined,
    syncError: raw.sync_error ? String(raw.sync_error) : undefined,
  };
}

/** Map a backend Email message (snake_case) to frontend Email (camelCase). */
function mapEmail(raw: Record<string, unknown>): Email {
  const fromRaw = (raw.from_address ?? raw.from ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ""),
    providerMessageId: String(raw.provider_message_id ?? ""),
    threadId: raw.thread_id ? String(raw.thread_id) : undefined,
    threadCount: Number(raw.thread_count ?? raw.threadCount ?? 1),
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
    importance: ((): "high" | "normal" | "low" => {
      const v = String(raw.importance ?? "normal").toLowerCase();
      return v === "high" || v === "low" ? v : "normal";
    })(),
    labels: (raw.labels as string[]) ?? [],
    categories: Array.isArray(raw.categories)
      ? (raw.categories as string[]) // real provider categories (Outlook) — keep verbatim
      : ((raw.labels as string[]) ?? []).filter(
          // Falling back to Gmail labels: hide UPPERCASE system labels.
          (l) => !/^[A-Z_]+$/.test(l)
        ),
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
  /** Filter to messages carrying this label/category. */
  label?: string;
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
  if (params.label) searchParams.set("label", params.label);
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

/** All messages in a conversation (across folders), oldest-first. */
export async function listThread(
  accountId: string | undefined,
  threadId: string
): Promise<Email[]> {
  const sp = new URLSearchParams();
  if (accountId) sp.set("account_id", accountId);
  sp.set("thread_id", threadId);
  sp.set("page_size", "100");
  const raw = await gatewayFetch<{ emails: Record<string, unknown>[] }>(
    `/email/messages?${sp.toString()}`
  );
  return (raw.emails ?? []).map(mapEmail);
}

export interface BackfillResult {
  synced: number;
  next_page_token: string | null;
  exhausted: boolean;
}

/** Page further back through the provider's history for a folder. */
export async function backfillFolder(
  accountId: string,
  folder: string,
  pageToken?: string | null
): Promise<BackfillResult> {
  return gatewayFetch<BackfillResult>(
    `/email/accounts/${accountId}/backfill`,
    {
      method: "POST",
      body: JSON.stringify({
        folder,
        page_token: pageToken ?? null,
        max_pages: 3,
      }),
    }
  );
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

/** User-applicable label/category names for an account. */
export async function listLabels(accountId: string): Promise<string[]> {
  return gatewayFetch<string[]>(`/email/accounts/${accountId}/labels`);
}

/** Add/remove labels (by name) on a message; syncs to the provider. */
export async function updateEmailLabels(
  id: string,
  add: string[],
  remove: string[]
): Promise<Email> {
  const body: Record<string, unknown> = {};
  if (add.length) body.add_labels = add;
  if (remove.length) body.remove_labels = remove;
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
  return `/api/email/attachments/${attachmentId}/download`;
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
  const res = await fetch("/api/email/ai/chat", {
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

// ══════════════════════════════════════════════════════════════════════════
// Email Automation — Analytics, Senders/Bulk, Newsletters, Assistant rules
// ══════════════════════════════════════════════════════════════════════════

// ── Analytics ──────────────────────────────────────────────────────────────

export async function getAnalyticsOverview(
  accountId?: string,
  days = 30
): Promise<AnalyticsOverview> {
  const sp = new URLSearchParams({ days: String(days) });
  if (accountId) sp.set("account_id", accountId);
  return gatewayFetch<AnalyticsOverview>(`/email/analytics/overview?${sp}`);
}

// ── Senders + bulk actions ──────────────────────────────────────────────────

export async function listSenders(
  accountId?: string,
  folder?: string,
  limit = 200
): Promise<SenderStat[]> {
  const sp = new URLSearchParams({ limit: String(limit) });
  if (accountId) sp.set("account_id", accountId);
  if (folder) sp.set("folder", folder);
  const res = await gatewayFetch<{ senders: SenderStat[] }>(
    `/email/senders?${sp}`
  );
  return res.senders ?? [];
}

export interface BulkActionParams {
  action: "archive" | "trash" | "read" | "unread" | "star" | "unstar";
  accountId?: string;
  messageIds?: string[];
  senderEmail?: string;
  folder?: string;
  olderThanDays?: number;
  onlyRead?: boolean;
}

export async function bulkAction(
  params: BulkActionParams
): Promise<{ affected: number }> {
  const body: Record<string, unknown> = { action: params.action };
  if (params.accountId) body.account_id = params.accountId;
  if (params.messageIds) body.message_ids = params.messageIds;
  if (params.senderEmail) body.sender_email = params.senderEmail;
  if (params.folder) body.folder = params.folder;
  if (params.olderThanDays) body.older_than_days = params.olderThanDays;
  if (params.onlyRead) body.only_read = params.onlyRead;
  return gatewayFetch<{ affected: number }>("/email/messages/bulk", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Newsletters (unsubscribe disposition) ───────────────────────────────────

export async function upsertNewsletter(params: {
  accountId: string;
  email: string;
  name?: string;
  status: NewsletterStatus;
  unsubscribeLink?: string | null;
}): Promise<{ ok: boolean; status: string; archived: number }> {
  return gatewayFetch("/email/newsletters", {
    method: "POST",
    body: JSON.stringify({
      account_id: params.accountId,
      email: params.email,
      name: params.name,
      status: params.status,
      unsubscribe_link: params.unsubscribeLink ?? null,
    }),
  });
}

// ── Assistant: rules ────────────────────────────────────────────────────────

export async function listRules(accountId: string): Promise<AutomationRule[]> {
  const res = await gatewayFetch<{ rules: AutomationRule[] }>(
    `/email/rules?account_id=${encodeURIComponent(accountId)}`
  );
  return res.rules ?? [];
}

export async function createRule(rule: AutomationRule): Promise<AutomationRule> {
  return gatewayFetch<AutomationRule>("/email/rules", {
    method: "POST",
    body: JSON.stringify(rule),
  });
}

export async function updateRule(
  id: string,
  rule: AutomationRule
): Promise<AutomationRule> {
  return gatewayFetch<AutomationRule>(`/email/rules/${id}`, {
    method: "PATCH",
    body: JSON.stringify(rule),
  });
}

export async function deleteRule(id: string): Promise<void> {
  await gatewayFetch(`/email/rules/${id}`, { method: "DELETE" });
}

export async function testRules(params: {
  accountId: string;
  emailId?: string;
  subject?: string;
  fromEmail?: string;
  body?: string;
}): Promise<RuleTestResult> {
  return gatewayFetch<RuleTestResult>("/email/rules/test", {
    method: "POST",
    body: JSON.stringify({
      account_id: params.accountId,
      email_id: params.emailId,
      subject: params.subject,
      from_email: params.fromEmail,
      body: params.body,
    }),
  });
}

export async function getRulesHistory(
  accountId?: string,
  limit = 100
): Promise<ExecutedRule[]> {
  const sp = new URLSearchParams({ limit: String(limit) });
  if (accountId) sp.set("account_id", accountId);
  const res = await gatewayFetch<{ history: ExecutedRule[] }>(
    `/email/rules/history?${sp}`
  );
  return res.history ?? [];
}

export async function approveExecution(
  execId: string
): Promise<{ ok: boolean; status: string; actions: string[] }> {
  return gatewayFetch(`/email/rules/history/${execId}/approve`, {
    method: "POST",
  });
}

export async function rejectExecution(
  execId: string
): Promise<{ ok: boolean; status: string }> {
  return gatewayFetch(`/email/rules/history/${execId}/reject`, {
    method: "POST",
  });
}

export async function testRulesRecent(
  accountId: string,
  limit = 8
): Promise<RecentTestResult[]> {
  const res = await gatewayFetch<{ results: RecentTestResult[] }>(
    "/email/rules/test/recent",
    { method: "POST", body: JSON.stringify({ account_id: accountId, limit }) }
  );
  return res.results ?? [];
}

export async function runRules(params: {
  accountId: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<{ scheduled: boolean; dry_run: boolean }> {
  return gatewayFetch("/email/rules/run", {
    method: "POST",
    body: JSON.stringify({
      account_id: params.accountId,
      limit: params.limit ?? 20,
      dry_run: params.dryRun ?? true,
    }),
  });
}

// ── Assistant: settings ─────────────────────────────────────────────────────

export async function getAssistantSettings(
  accountId: string
): Promise<AssistantSettings> {
  return gatewayFetch<AssistantSettings>(
    `/email/assistant/settings?account_id=${encodeURIComponent(accountId)}`
  );
}

export async function saveAssistantSettings(
  settings: AssistantSettings
): Promise<AssistantSettings> {
  return gatewayFetch<AssistantSettings>("/email/assistant/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function generateWritingStyle(
  accountId: string
): Promise<{ writing_style: string }> {
  return gatewayFetch<{ writing_style: string }>(
    `/email/assistant/writing-style/generate?account_id=${encodeURIComponent(accountId)}`,
    { method: "POST" }
  );
}

// ── Assistant: knowledge base ───────────────────────────────────────────────

export async function listKnowledge(
  accountId: string
): Promise<KnowledgeEntry[]> {
  const res = await gatewayFetch<{ entries: KnowledgeEntry[] }>(
    `/email/knowledge?account_id=${encodeURIComponent(accountId)}`
  );
  return res.entries ?? [];
}

export async function createKnowledge(
  entry: KnowledgeEntry
): Promise<KnowledgeEntry> {
  return gatewayFetch<KnowledgeEntry>("/email/knowledge", {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

export async function updateKnowledge(
  id: string,
  entry: KnowledgeEntry
): Promise<KnowledgeEntry> {
  return gatewayFetch<KnowledgeEntry>(`/email/knowledge/${id}`, {
    method: "PATCH",
    body: JSON.stringify(entry),
  });
}

export async function deleteKnowledge(id: string): Promise<void> {
  await gatewayFetch(`/email/knowledge/${id}`, { method: "DELETE" });
}

// ── Sender categorization ───────────────────────────────────────────────────

export async function categorizeSenders(
  accountId: string,
  limit = 60
): Promise<{ scheduled: boolean }> {
  return gatewayFetch("/email/senders/categorize", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId, limit }),
  });
}

export async function getSenderCategories(
  accountId: string
): Promise<{ categories: string[]; counts: Record<string, number> }> {
  return gatewayFetch(
    `/email/senders/categories?account_id=${encodeURIComponent(accountId)}`
  );
}

// ── Cold-email blocker ──────────────────────────────────────────────────────

export async function listColdSenders(
  accountId: string
): Promise<ColdSender[]> {
  const res = await gatewayFetch<{ cold_senders: ColdSender[] }>(
    `/email/cold-senders?account_id=${encodeURIComponent(accountId)}`
  );
  return res.cold_senders ?? [];
}

export async function upsertColdSender(params: {
  accountId: string;
  fromEmail: string;
  status: "AI_LABELED_COLD" | "USER_REJECTED_COLD";
}): Promise<{ ok: boolean }> {
  return gatewayFetch("/email/cold-senders", {
    method: "POST",
    body: JSON.stringify({
      account_id: params.accountId,
      from_email: params.fromEmail,
      status: params.status,
    }),
  });
}

// ── Reply Zero ──────────────────────────────────────────────────────────────

export async function getReplyZero(
  accountId: string,
  type: "needs_reply" | "awaiting" = "needs_reply",
  limit = 50
): Promise<ReplyZeroThread[]> {
  const sp = new URLSearchParams({
    account_id: accountId,
    type,
    limit: String(limit),
  });
  const res = await gatewayFetch<{ threads: ReplyZeroThread[] }>(
    `/email/reply-zero?${sp}`
  );
  return res.threads ?? [];
}

/**
 * Draft a context-aware reply using the orchestrating drafter (memory +
 * sales/task-manager agents). Optionally also saves it to the provider Drafts.
 */
export async function draftReplySmart(
  accountId: string,
  messageId: string,
  createDraft = false,
  followUp = false
): Promise<{ draft: string; created: boolean }> {
  return gatewayFetch("/email/draft-reply", {
    method: "POST",
    body: JSON.stringify({
      account_id: accountId,
      message_id: messageId,
      create_draft: createDraft,
      follow_up: followUp,
    }),
  });
}

// ── Digest ──────────────────────────────────────────────────────────────────

export async function getDigest(
  accountId: string,
  period: "day" | "week" = "day"
): Promise<import("./types").DigestData> {
  return gatewayFetch(
    `/email/digest?account_id=${encodeURIComponent(accountId)}&period=${period}`
  );
}

export async function sendDigest(
  accountId: string,
  period: "day" | "week" = "day"
): Promise<{ sent: boolean; to: string }> {
  return gatewayFetch("/email/digest/send", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId, period }),
  });
}
