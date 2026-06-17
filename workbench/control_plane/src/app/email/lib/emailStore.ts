import { create } from "zustand";
import { Email, EmailAccount, EmailFolder } from "./types";
import * as api from "./api";
import { QUICK_ACTIONS } from "./mockData";

/**
 * Derive folder counts from email list.
 */
function buildFolders(emails: Email[]): EmailFolder[] {
  const counts: Record<string, number> = {};
  for (const email of emails) {
    counts[email.folder] = (counts[email.folder] || 0) + 1;
    if (!email.isRead) counts["inbox-unread"] = (counts["inbox-unread"] || 0) + 1;
    if (email.isStarred) counts["starred"] = (counts["starred"] || 0) + 1;
  }

  return [
    { icon: "Inbox", label: "Inbox", key: "inbox", count: counts["inbox"] || 0 },
    { icon: "Star", label: "Starred", key: "starred", count: counts["starred"] || 0 },
    { icon: "Send", label: "Sent", key: "sent", count: counts["sent"] || 0 },
    { icon: "FileText", label: "Drafts", key: "drafts", count: counts["drafts"] || 0 },
    { icon: "Archive", label: "Archive", key: "archive", count: counts["archive"] || 0 },
    { icon: "Tag", label: "Labels", key: "labels", count: 0 },
    { icon: "Trash2", label: "Trash", key: "trash", count: counts["trash"] || 0 },
  ];
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
      }
    } catch (err: any) {
      set({ accountsLoading: false, error: err.message || "Failed to load accounts" });
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
    // Fetch emails for the newly selected account
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
