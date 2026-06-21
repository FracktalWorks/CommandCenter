export interface EmailAddress {
  name: string;
  email: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl?: string;
}

export interface Email {
  id: string;
  providerMessageId: string;
  threadId?: string;
  /** Number of messages in this conversation (1 = standalone). */
  threadCount?: number;
  accountId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  bodyTruncated: boolean;
  snippet: string;
  hasAttachments: boolean;
  attachments?: Attachment[];
  isRead: boolean;
  isStarred: boolean;
  isFlagged: boolean;
  /** Provider importance: 'high' | 'normal' | 'low' (Outlook), mapped for Gmail. */
  importance: "high" | "normal" | "low";
  /** Provider labels (Gmail) — used for folder/label chips. */
  labels: string[];
  /** Outlook categories / Gmail user labels with optional colors. */
  categories: string[];
  folder: string;
  receivedAt: string; // ISO 8601
  syncedAt: string;
}

export interface EmailAccount {
  id: string;
  provider: "gmail" | "microsoft" | "imap";
  emailAddress: string;
  label: string;
  avatar: string; // initials
  color: string; // hex color for avatar bg
  unreadCount: number;
  syncEnabled: boolean;
  lastSyncedAt?: string;
  /** Provider sync state: 'idle' | 'syncing' | 'error'. */
  syncStatus?: string;
  /** Last sync error (e.g. expired OAuth token), when syncStatus is 'error'. */
  syncError?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface QuickAction {
  label: string;
  action: string; // backend action key: 'summarize' | 'find_urgent' | 'draft_reply' | 'unsubscribe'
  prompt: string;
  icon: string; // Lucide icon name
}

/** The Email Automation features surfaced in the sidebar. */
export type AutomationFeature =
  | "assistant"
  | "reply-zero"
  | "digest"
  | "unsubscribe"
  | "archive"
  | "analytics";

export type DigestFrequency = "OFF" | "DAILY" | "WEEKLY";

export interface DigestData {
  period_days: number;
  totals: {
    inbox: number;
    unread: number;
    attachments: number;
    needs_reply: number;
  };
  by_category: { category: string; count: number }[];
  top_senders: { name: string; email: string; count: number }[];
  markdown: string;
}

/** Sender categories assigned by the LLM categorizer (mirrors the backend). */
export const EMAIL_CATEGORIES = [
  "Newsletter", "Marketing", "Receipt", "Calendar", "Notification",
  "Cold Email", "Personal", "Support", "Unknown",
] as const;

export type ColdBlockerMode = "OFF" | "LABEL" | "ARCHIVE";

export interface ColdSender {
  from_email: string;
  status: "AI_LABELED_COLD" | "USER_REJECTED_COLD";
  reason: string | null;
  updated_at: string | null;
}

export interface ReplyZeroThread {
  thread_id: string;
  message_id: string;
  subject: string;
  from: string;
  from_email: string;
  received_at: string | null;
  is_read: boolean;
  /** Why the classifier flagged this thread (needs-reply rationale). */
  reason?: string;
  /** Days since the last message (used for the follow-up window). */
  awaiting_days?: number | null;
  /** True when an awaiting thread is older than the follow-up window. */
  needs_follow_up?: boolean;
}

// ── Analytics ──────────────────────────────────────────────────────────────

export interface AnalyticsOverview {
  totals: {
    total: number;
    unread: number;
    sent: number;
    archived: number;
    starred: number;
    with_attachments: number;
    read_rate: number;
  };
  volume: { day: string; received: number; sent: number }[];
  top_senders: { email: string; name: string; count: number; unread: number }[];
  by_folder: { folder: string; count: number }[];
}

// ── Senders (bulk archive / unsubscribe) ────────────────────────────────────

export type NewsletterStatus = "APPROVED" | "UNSUBSCRIBED" | "AUTO_ARCHIVED";

export interface SenderStat {
  email: string;
  name: string;
  count: number;
  unread: number;
  archived: number;
  read_rate: number;
  last_received: string | null;
  unsubscribe_link: string | null;
  status: NewsletterStatus;
  category?: string | null;
}

// ── Assistant rules ─────────────────────────────────────────────────────────

export type RuleActionType =
  | "ARCHIVE"
  | "LABEL"
  | "MARK_READ"
  | "STAR"
  | "MARK_SPAM"
  | "TRASH"
  | "MOVE_FOLDER"
  | "REPLY"
  | "FORWARD"
  | "DRAFT_EMAIL"
  | "CALL_WEBHOOK";

export interface RuleAction {
  id?: string;
  type: RuleActionType;
  label?: string | null;
  subject?: string | null;
  content?: string | null;
  to_address?: string | null;
  cc_address?: string | null;
  bcc_address?: string | null;
  url?: string | null;
}

export interface AutomationRule {
  id?: string;
  account_id: string;
  name: string;
  instructions?: string | null;
  enabled: boolean;
  /** Apply actions automatically (true) or only propose for approval (false). */
  automated: boolean;
  run_on_threads: boolean;
  conditional_operator: "AND" | "OR";
  from_pattern?: string | null;
  to_pattern?: string | null;
  subject_pattern?: string | null;
  body_pattern?: string | null;
  category_filter_type?: "INCLUDE" | "EXCLUDE" | null;
  category_filters: string[];
  system_type?: string | null;
  sort_order: number;
  actions: RuleAction[];
}

export interface RuleTestResult {
  matched: boolean;
  rule: { id: string; name: string } | null;
  reason: string;
  actions: RuleAction[];
}

export interface ExecutedRule {
  id: string;
  rule_name: string | null;
  subject: string | null;
  from: string | null;
  status: string;
  automated: boolean;
  actions: string[];
  reason: string | null;
  created_at: string | null;
}

export interface AssistantSettings {
  account_id: string;
  about: string;
  signature: string;
  auto_run: boolean;
  cold_email_blocker: ColdBlockerMode;
  /** Which LiteLLM tier or model id the assistant agent/chat uses
   *  (e.g. "tier-balanced" or "deepseek/deepseek-chat"). */
  agent_model: string;
  /** Scheduled inbox-digest cadence. */
  digest_frequency: DigestFrequency;
  /** Global "always do this" guidance for the assistant. */
  personal_instructions: string;
  /** Tone/length/style guidance for drafted replies (can be auto-derived). */
  writing_style: string;
  /** Whether the assistant drafts replies for emails that need one. */
  draft_replies: boolean;
  /** Remind about sent threads awaiting a reply older than N days (0 = off). */
  follow_up_days: number;
}

/** A draft knowledge-base entry the assistant draws on when writing replies. */
export interface KnowledgeEntry {
  id?: string;
  account_id: string;
  title: string;
  content: string;
  updated_at?: string | null;
}

/** A configurable LLM tier/provider, from GET /api/settings/llm. */
export interface LLMTier {
  tier_name: string;
  tier_id: string;
  model: string;
  provider: string;
  provider_configured: boolean;
}

export interface LLMProvider {
  id: string;
  label: string;
  configured: boolean;
  models: string[];
}

export interface LLMConfigResponse {
  tiers: LLMTier[];
  providers: LLMProvider[];
}

export interface RecentTestResult {
  email_id: string;
  subject: string;
  from: string;
  matched: boolean;
  rule: { id: string; name: string } | null;
  reason: string;
  actions: string[];
}

export interface EmailFolder {
  icon: string; // Lucide icon name
  label: string;
  key: string;
  count: number;
  /** 'system' for canonical folders, 'user' for provider-created folders/labels. */
  type?: "system" | "user";
  /** Unread count from the provider, when available. */
  unread?: number;
}
