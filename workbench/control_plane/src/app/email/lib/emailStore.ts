import { create } from "zustand";
import { Email, EmailAccount, EmailFolder } from "./types";
import * as api from "./api";
import type { EmailFolderRaw } from "./api";
import { QUICK_ACTIONS } from "./mockData";

/** System folder icons mapped by canonical key. */
const SYSTEM_FOLDER_ICONS: Record<string, string> = {
  inbox: "Inbox", INBOX: "Inbox",
  sent: "Send", drafts: "FileText", archive: "Archive",
  trash: "Trash2", junk: "ShieldAlert", spam: "ShieldAlert",
  starred: "Star", important: "AlertTriangle",
};

/** Default system folders that always appear even before sync. */
const DEFAULT_SYSTEM_FOLDERS: EmailFolder[] = [
  { icon: "Inbox", label: "Inbox", key: "inbox", count: 0 },
  { icon: "Star", label: "Starred", key: "starred", count: 0 },
  { icon: "Send", label: "Sent", key: "sent", count: 0 },
  { icon: "FileText", label: "Drafts", key: "drafts", count: 0 },
  { icon: "Archive", label: "Archive", key: "archive", count: 0 },
  { icon: "Tag", label: "Labels", key: "labels", count: 0 },
  { icon: "Trash2", label: "Trash", key: "trash", count: 0 },
];

/**
 * Merge real provider folders with default system folders.
 * Provider folders are mapped by their canonical name (lowercased).
 * Folders not in the provider list keep their counts from email data.
 */
function mergeFolders(
  providerFolders: EmailFolderRaw[],
  emailCounts: Record<string, number>,
): EmailFolder[] {
  const providerMap = new Map<string, EmailFolderRaw>();
  for (const f of providerFolders) {
    providerMap.set(f.name.toLowerCase(), f);
  }

  return DEFAULT_SYSTEM_FOLDERS.map((df) => {
    const pf = providerMap.get(df.key);
    if (pf) {
      return {
        ...df,
        count: pf.message_count || emailCounts[df.key] || 0,
        label: pf.name, // use provider's display name
      };
    }
    return {
      ...df,
      count: emailCounts[df.key] || 0,
    };
  });
}

/**
 * Derive folder counts from email list (fallback when provider folders
 * haven't been fetched yet).
 */
function buildFolders(emails: Email[]): EmailFolder[] {
  const counts: Record<string, number> = {};
  for (const email of emails) {
    counts[email.folder.toLowerCase()] = (counts[email.folder.toLowerCase()] || 0) + 1;
    if (!email.isRead) counts["inbox"] = (counts["inbox"] || 0) + 1;
    if (email.isStarred) counts["starred"] = (counts["starred"] || 0) + 1;
  }

  return DEFAULT_SYSTEM_FOLDERS.map((df) => ({
    ...df,
    count: counts[df.key] || 0,
  }));
}

interface EmailState {
  // Data
  accounts: EmailAccount[];
  emails: Email[];
  folders: EmailFolder[];
  quickActions: typeof QUICK_ACTIONS;

  // Loading states
  accountsLoading: boolean;
  emailsLoading: boolean;
  foldersLoading: boolean;
  syncStatus: Record<string, "idle" | "syncing" | "error">;

  // Selection
  selectedAccountId: string | null;
  selectedFolder: string;
  selectedEmailId: string | null;
  searchQuery: string;

  // UI
  composeOpen: boolean;
  composeDefaults: { to: string; subject: string; replyToBody?: string; replyToMessageId?: string } | null;
  error: string | null;

  // Actions
  fetchAccounts: () => Promise<void>;
  fetchFolders: (accountId?: string) => Promise<void>;
  fetchEmails: () => Promise<void>;
  selectAccount: (id: string) => void;
  selectFolder: (folder: string) => void;
  selectEmail: (id: string | null) => void;
  setSearchQuery: (q: string) => void;
  openCompose: (defaults?: { to: string; subject: string; replyToBody?: string; replyToMessageId?: string }) => void;
  closeCompose: () => void;
  updateEmail: (id: string, updates: Partial<Pick<Email, "isRead" | "isStarred" | "isFlagged" | "folder">>) => Promise<void>;
  deleteEmail: (id: string) => Promise<void>;
  sendEmail: (params: api.SendEmailParams) => Promise<void>;
  triggerSync: (accountId: string) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  clearError: () => void;
}

let _debounceTimer: ReturnType<typeof setTimeout> | undefined;

export const useEmailStore = create<EmailState>((set, get) => ({
  // Data
  accounts: [],
  emails: [],
  folders: [],
  quickActions: QUICK_ACTIONS,

  // Loading states
  accountsLoading: false,
  emailsLoading: false,
  foldersLoading: false,
  syncStatus: {},

  // Selection
  selectedAccountId: null,
  selectedFolder: "inbox",
  selectedEmailId: null,
  searchQuery: "",

  // UI
  composeOpen: false,
  composeDefaults: null,
  error: null,

  // Actions
  fetchAccounts: async () => {
    set({ accountsLoading: true, error: null });
    try {
      const accounts = await api.listEmailAccounts();
      set({ accounts, accountsLoading: false });
      // Auto-select first account if none selected
      const { selectedAccountId } = get();
      if (!selectedAccountId && accounts.length > 0) {
        set({ selectedAccountId: accounts[0].id });
        // Fetch folders for the auto-selected account
        get().fetchFolders(accounts[0].id);
      }
    } catch (err: any) {
      set({ accountsLoading: false, error: err.message || "Failed to load accounts" });
    }
  },

  fetchFolders: async (accountId?: string) => {
    const aid = accountId ?? get().selectedAccountId;
    if (!aid) return;
    set({ foldersLoading: true });
    try {
      const rawFolders = await api.listEmailFolders(aid);
      // Merge with current email counts
      const emailCounts: Record<string, number> = {};
      for (const e of get().emails) {
        const key = e.folder.toLowerCase();
        emailCounts[key] = (emailCounts[key] || 0) + 1;
      }
      const folders = mergeFolders(rawFolders, emailCounts);
      set({ folders, foldersLoading: false });
    } catch {
      // Fall back to deriving from emails
      const folders = buildFolders(get().emails);
      set({ folders, foldersLoading: false });
    }
  },

  fetchEmails: async () => {
    const { selectedAccountId, selectedFolder, searchQuery } = get();
    set({ emailsLoading: true, error: null });
    try {
      const result = await api.listEmails({
        accountId: selectedAccountId || undefined,
        folder: selectedFolder,
        query: searchQuery || undefined,
      });
      const emails = result.emails;
      const folders = buildFolders(emails);
      set({ emails, folders, emailsLoading: false });
    } catch (err: any) {
      set({ emailsLoading: false, error: err.message || "Failed to load emails" });
    }
  },

  selectAccount: (id: string) => {
    set({ selectedAccountId: id, selectedEmailId: null });
    // Fetch folders and emails for the newly selected account
    get().fetchFolders(id);
    get().fetchEmails();
  },

  selectFolder: (folder: string) => {
    set({ selectedFolder: folder, selectedEmailId: null });
    get().fetchEmails();
  },

  selectEmail: (id: string | null) => {
    set({ selectedEmailId: id });
    // Mark as read if unread
    if (id) {
      const email = get().emails.find((e) => e.id === id);
      if (email && !email.isRead) {
        get().updateEmail(id, { isRead: true });
      }
    }
  },

  setSearchQuery: (q: string) => {
    set({ searchQuery: q });
    // Debounce: wait 300ms since last keystroke before fetching
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      get().fetchEmails();
    }, 300);
  },

  openCompose: (defaults) => {
    set({ composeOpen: true, composeDefaults: defaults || null });
  },

  closeCompose: () => {
    set({ composeOpen: false, composeDefaults: null });
  },

  updateEmail: async (id, updates) => {
    // Optimistic update
    const prevEmails = get().emails;
    set({
      emails: prevEmails.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      ),
    });
    try {
      const updated = await api.updateEmail(id, updates);
      set({
        emails: get().emails.map((e) =>
          e.id === id ? { ...e, ...updated } : e
        ),
        folders: buildFolders(get().emails),
      });
    } catch (err: any) {
      // Revert on failure
      set({ emails: prevEmails, error: err.message || "Failed to update email" });
    }
  },

  deleteEmail: async (id) => {
    const prevEmails = get().emails;
    set({ emails: prevEmails.filter((e) => e.id !== id) });
    try {
      await api.deleteEmail(id);
      set({ folders: buildFolders(get().emails) });
      // Clear selection if deleted was selected
      if (get().selectedEmailId === id) {
        set({ selectedEmailId: get().emails[0]?.id ?? null });
      }
    } catch (err: any) {
      set({ emails: prevEmails, error: err.message || "Failed to delete email" });
    }
  },

  sendEmail: async (params) => {
    set({ error: null });
    try {
      await api.sendEmail(params);
      set({ composeOpen: false, composeDefaults: null });
      // Refresh emails to show sent item
      get().fetchEmails();
    } catch (err: any) {
      set({ error: err.message || "Failed to send email" });
    }
  },

  triggerSync: async (accountId: string) => {
    set({ syncStatus: { ...get().syncStatus, [accountId]: "syncing" } });
    try {
      await api.triggerSync(accountId);
      set({ syncStatus: { ...get().syncStatus, [accountId]: "idle" } });
      get().fetchEmails();
      get().fetchAccounts();
    } catch (err: any) {
      set({
        syncStatus: { ...get().syncStatus, [accountId]: "error" },
        error: err.message || "Sync failed",
      });
    }
  },

  deleteAccount: async (id) => {
    try {
      await api.deleteEmailAccount(id);
      const accounts = get().accounts.filter((a) => a.id !== id);
      set({ accounts });
      if (get().selectedAccountId === id) {
        set({ selectedAccountId: accounts[0]?.id ?? null });
      }
    } catch (err: any) {
      set({ error: err.message || "Failed to delete account" });
    }
  },

  clearError: () => set({ error: null }),
}));
