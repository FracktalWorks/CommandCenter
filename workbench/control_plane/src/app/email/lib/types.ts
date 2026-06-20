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
