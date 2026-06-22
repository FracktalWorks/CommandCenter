import { create } from "zustand";
import { Email, EmailAccount, EmailFolder, EMAIL_CATEGORIES, RunMessageResult } from "./types";
import * as api from "./api";
import type { EmailFolderRaw } from "./api";
import { QUICK_ACTIONS } from "./mockData";

/**
 * Canonical folder keys shared with the backend (`providers/base.py`).
 * Provider folder names map onto these so the inbox/sent/etc. tabs line up
 * regardless of provider-specific naming ("Sent Items" vs "SENT").
 */
/** How many messages to request per page (and per "Load more" click). */
const PAGE_SIZE = 100;

const CANONICAL_ALIASES: Record<string, string> = {
  inbox: "inbox",
  "sent items": "sent", sentitems: "sent", "sent mail": "sent", sent: "sent",
  drafts: "drafts", draft: "drafts",
  "deleted items": "trash", deleteditems: "trash", trash: "trash", bin: "trash",
  archive: "archive",
  "junk email": "junk", junkemail: "junk", junk: "junk", spam: "junk",
};

function toCanonical(name: string): string {
  return CANONICAL_ALIASES[name.trim().toLowerCase()] ?? name.trim().toLowerCase();
}

/** Default system folders that always appear even before sync, in display order. */
const DEFAULT_SYSTEM_FOLDERS: EmailFolder[] = [
  { icon: "Inbox", label: "Inbox", key: "inbox", count: 0, type: "system" },
  { icon: "Star", label: "Starred", key: "starred", count: 0, type: "system" },
  { icon: "Send", label: "Sent", key: "sent", count: 0, type: "system" },
  { icon: "FileText", label: "Drafts", key: "drafts", count: 0, type: "system" },
  { icon: "Archive", label: "Archive", key: "archive", count: 0, type: "system" },
  { icon: "ShieldAlert", label: "Junk", key: "junk", count: 0, type: "system" },
  { icon: "Trash2", label: "Trash", key: "trash", count: 0, type: "system" },
];

const SYSTEM_KEYS = new Set(DEFAULT_SYSTEM_FOLDERS.map((f) => f.key));

// Gmail's reserved system labels — never surfaced as user folders.
const GMAIL_SYSTEM_LABELS = new Set([
  "chat", "important", "starred", "unread", "category_personal",
  "category_social", "category_promotions", "category_updates",
  "category_forums", "unwanted",
]);

/**
 * Merge real provider folders with the canonical system folders, and append the
 * provider's *own* user folders/labels so the sidebar mirrors the real mailbox
 * structure (two-way: what you see in Outlook/Gmail, you see here).
 */
function mergeFolders(
  providerFolders: EmailFolderRaw[],
  emailCounts: Record<string, number>,
): EmailFolder[] {
  // Index provider folders by canonical key for system-folder count/labels.
  const canonProvider = new Map<string, EmailFolderRaw>();
  for (const f of providerFolders) {
    const key = toCanonical(f.name);
    // Prefer the entry with the most messages if duplicates collapse to one key.
    const existing = canonProvider.get(key);
    if (!existing || (f.message_count || 0) > (existing.message_count || 0)) {
      canonProvider.set(key, f);
    }
  }

  const systemFolders = DEFAULT_SYSTEM_FOLDERS.map((df) => {
    const pf = canonProvider.get(df.key);
    return {
      ...df,
      count: pf?.message_count || emailCounts[df.key] || 0,
      unread: pf?.unread_count ?? undefined,
    };
  });

  // Append user-created provider folders/labels (anything not a system key).
  const userFolders: EmailFolder[] = [];
  const seen = new Set<string>();
  for (const f of providerFolders) {
    const key = toCanonical(f.name);
    if (SYSTEM_KEYS.has(key) || key === "starred") continue;
    if (f.type === "system") continue; // skip provider system folders
    if (GMAIL_SYSTEM_LABELS.has(key) || /^category_/.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    userFolders.push({
      icon: "Folder",
      label: f.name,
      key,
      count: f.message_count || emailCounts[key] || 0,
      unread: f.unread_count ?? undefined,
      type: "user",
    });
  }
  userFolders.sort((a, b) => a.label.localeCompare(b.label));

  return [...systemFolders, ...userFolders];
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
  emailsTotal: number;
  emailsPage: number;
  folders: EmailFolder[];
  /** User-applicable label/category names for the selected account. */
  availableLabels: string[];
  quickActions: typeof QUICK_ACTIONS;

  // Loading states
  accountsLoading: boolean;
  emailsLoading: boolean;
  loadingMore: boolean;
  backfilling: boolean;
  foldersLoading: boolean;
  /** Per-folder cursor for paging older provider history (client-held). */
  backfillToken: Record<string, string | null>;
  /** Per-folder flag: the provider has no older mail left to fetch. */
  backfillExhausted: Record<string, boolean>;
  syncStatus: Record<string, "idle" | "syncing" | "error">;
  /** Accounts whose live provider calls returned 401/403 (stale OAuth), keyed
   *  by account id → error message. Drives the in-app reconnect banner
   *  immediately, without waiting for the next sync to set sync_status. */
  authErrors: Record<string, string>;

  // Selection
  selectedAccountId: string | null;
  selectedFolder: string;
  /** Active label/category filter (null = no label filter). */
  selectedLabel: string | null;
  selectedEmailId: string | null;
  searchQuery: string;

  // UI
  composeOpen: boolean;
  composeDefaults: { to: string; subject: string; replyToBody?: string; replyToMessageId?: string } | null;
  /** A message queued to send, shown with an "Undo" toast until the timer fires. */
  pendingSend: api.SendEmailParams | null;
  /** A prompt handed from the Assistant's "Fix" flow to the AI chat panel, which
   *  consumes it into its input on the next render then clears it. */
  pendingChatPrompt: string | null;
  error: string | null;

  // ── Assistant "Test/Apply on all" run (lifted here so it survives the
  //    Assistant overlay/TestTab unmounting when the user navigates away) ──
  /** Per-message rule-run results, keyed by message id. */
  testResults: Record<string, RunMessageResult>;
  /** Message ids with a run currently in flight (per-row spinner). */
  testRunningIds: string[];
  /** True while a "Test/Run on all" sweep is iterating. */
  testBulkRunning: boolean;
  /** The mode the active/last sweep used (false = Test/dry-run, true = Apply). */
  testApplyMode: boolean;

  // Actions
  fetchAccounts: () => Promise<void>;
  fetchFolders: (accountId?: string) => Promise<void>;
  fetchEmails: () => Promise<void>;
  loadMoreEmails: () => Promise<void>;
  backfillOlder: () => Promise<void>;
  selectAccount: (id: string) => void;
  selectFolder: (folder: string) => void;
  /** Filter the list by a label/category (null clears the filter). */
  selectLabel: (label: string | null) => void;
  selectEmail: (id: string | null) => void;
  setSearchQuery: (q: string) => void;
  openCompose: (defaults?: { to: string; subject: string; replyToBody?: string; replyToMessageId?: string }) => void;
  closeCompose: () => void;
  hydrateEmail: (email: Email) => void;
  updateEmail: (id: string, updates: Partial<Pick<Email, "isRead" | "isStarred" | "isFlagged" | "folder">>) => Promise<void>;
  fetchLabels: (accountId?: string) => Promise<void>;
  applyLabel: (id: string, name: string, add: boolean) => Promise<void>;
  deleteEmail: (id: string) => Promise<void>;
  sendEmail: (params: api.SendEmailParams) => Promise<void>;
  undoSend: () => void;
  /** Queue a prompt for the AI chat panel (used by the Assistant "Fix" flow). */
  setPendingChatPrompt: (prompt: string | null) => void;
  /** Run rules on one message (Test = dry-run, Apply = execute) and store result. */
  runTestOnMessage: (accountId: string, messageId: string, isTest: boolean) => Promise<void>;
  /** Sweep a list of messages sequentially; keeps running across navigation. */
  runTestOnAll: (accountId: string, messageIds: string[], isTest: boolean) => Promise<void>;
  /** Request the in-progress sweep to stop after the current message. */
  stopTestRun: () => void;
  /** Clear cached per-message results (e.g. when switching Test↔Apply). */
  clearTestResults: () => void;
  triggerSync: (accountId: string) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  clearError: () => void;
}

let _debounceTimer: ReturnType<typeof setTimeout> | undefined;
/** Pending "Undo send" timer — fires the real send after the undo window. */
let _sendTimer: ReturnType<typeof setTimeout> | undefined;
/** Cooperative stop flag for the Assistant "Test/Run on all" sweep. Kept at
 *  module scope so it survives TestTab unmounting (run continues in the store). */
let _stopTestRun = false;
/** How long the user has to undo a send. */
const UNDO_SEND_MS = 5000;

export const useEmailStore = create<EmailState>((set, get) => ({
  // Data
  accounts: [],
  emails: [],
  emailsTotal: 0,
  emailsPage: 1,
  folders: [],
  availableLabels: [],
  quickActions: QUICK_ACTIONS,

  // Loading states
  accountsLoading: false,
  emailsLoading: false,
  loadingMore: false,
  backfilling: false,
  foldersLoading: false,
  backfillToken: {},
  backfillExhausted: {},
  syncStatus: {},
  authErrors: {},

  // Selection
  selectedAccountId: null,
  selectedFolder: "inbox",
  selectedLabel: null,
  selectedEmailId: null,
  searchQuery: "",

  // UI
  composeOpen: false,
  composeDefaults: null,
  pendingSend: null,
  pendingChatPrompt: null,
  error: null,

  testResults: {},
  testRunningIds: [],
  testBulkRunning: false,
  testApplyMode: false,

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
        // Fetch folders + labels for the auto-selected account
        get().fetchFolders(accounts[0].id);
        get().fetchLabels(accounts[0].id);
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
      // Live provider call succeeded — clear any prior auth flag for this account.
      const cleared = { ...get().authErrors };
      delete cleared[aid];
      set({ folders, foldersLoading: false, authErrors: cleared });
    } catch (err: any) {
      // Fall back to deriving from emails
      const folders = buildFolders(get().emails);
      // A 401/403 from the live folder call means the account's OAuth token is
      // stale — flag it immediately so the reconnect banner shows without
      // waiting for the next background sync to mark sync_status='error'.
      if (err?.status === 401 || err?.status === 403) {
        set({
          folders,
          foldersLoading: false,
          authErrors: {
            ...get().authErrors,
            [aid]: err?.message || "Authentication failed — reconnect the account.",
          },
        });
      } else {
        set({ folders, foldersLoading: false });
      }
    }
  },

  fetchEmails: async () => {
    const { selectedAccountId, selectedFolder, selectedLabel, searchQuery } = get();
    set({ emailsLoading: true, error: null });
    try {
      const result = await api.listEmails({
        accountId: selectedAccountId || undefined,
        folder: selectedFolder,
        label: selectedLabel || undefined,
        query: searchQuery || undefined,
        page: 1,
        pageSize: PAGE_SIZE,
      });
      const emails = result.emails;
      // Don't clobber the provider folder tree (system + user folders) fetched
      // by fetchFolders — only seed a system-folder fallback if we have none yet.
      const existing = get().folders;
      const folders = existing.length > 0 ? existing : buildFolders(emails);
      // Seed the label picker from categories actually present on messages —
      // providers like Outlook expose no master categories, so without this the
      // right-click "Label" menu would stay empty even when mail is categorized.
      const labelSet = new Set(get().availableLabels);
      for (const e of emails) for (const c of e.categories || []) labelSet.add(c);
      set({
        emails,
        folders,
        availableLabels: [...labelSet].sort(),
        emailsLoading: false,
        emailsTotal: result.total,
        emailsPage: 1,
      });
    } catch (err: any) {
      set({ emailsLoading: false, error: err.message || "Failed to load emails" });
    }
  },

  loadMoreEmails: async () => {
    const {
      selectedAccountId, selectedFolder, searchQuery,
      emailsPage, emails, loadingMore, emailsTotal,
    } = get();
    if (loadingMore || emails.length >= emailsTotal) return;
    set({ loadingMore: true });
    try {
      const nextPage = emailsPage + 1;
      const result = await api.listEmails({
        accountId: selectedAccountId || undefined,
        folder: selectedFolder,
        label: get().selectedLabel || undefined,
        query: searchQuery || undefined,
        page: nextPage,
        pageSize: PAGE_SIZE,
      });
      // Append, de-duping by id in case a sync shifted the window mid-scroll.
      const seen = new Set(emails.map((e) => e.id));
      const merged = [...emails, ...result.emails.filter((e) => !seen.has(e.id))];
      set({
        emails: merged,
        emailsPage: nextPage,
        emailsTotal: result.total,
        loadingMore: false,
      });
    } catch {
      // Paging older mail is best-effort and auto-triggers on scroll, so never
      // surface the raw provider error (it leaks the Graph/Gmail request URL).
      set({ loadingMore: false, error: "Couldn't load more messages. Try again." });
    }
  },

  backfillOlder: async () => {
    const {
      selectedAccountId, selectedFolder, backfilling,
      backfillToken, emails, emailsPage,
    } = get();
    if (backfilling || !selectedAccountId) return;
    set({ backfilling: true, error: null });
    try {
      // 1) Pull older mail from the provider into the DB.
      const res = await api.backfillFolder(
        selectedAccountId,
        selectedFolder,
        backfillToken[selectedFolder] ?? undefined,
      );
      // 2) Surface the freshly-persisted older page from the DB and append it.
      const nextPage = emailsPage + 1;
      const result = await api.listEmails({
        accountId: selectedAccountId,
        folder: selectedFolder,
        page: nextPage,
        pageSize: PAGE_SIZE,
      });
      const seen = new Set(emails.map((e) => e.id));
      const merged = [...emails, ...result.emails.filter((e) => !seen.has(e.id))];
      set({
        emails: merged,
        emailsPage: nextPage,
        emailsTotal: result.total,
        backfilling: false,
        backfillToken: {
          ...get().backfillToken,
          [selectedFolder]: res.next_page_token,
        },
        backfillExhausted: {
          ...get().backfillExhausted,
          [selectedFolder]: res.exhausted,
        },
      });
    } catch {
      // Best-effort provider paging — mark this folder exhausted so the scroll
      // observer stops re-firing (and re-flashing), and show a friendly note
      // instead of the raw provider request URL.
      set({
        backfilling: false,
        error: "No more older messages could be loaded right now.",
        backfillExhausted: {
          ...get().backfillExhausted,
          [get().selectedFolder]: true,
        },
      });
    }
  },

  selectAccount: (id: string) => {
    set({ selectedAccountId: id, selectedEmailId: null });
    // Fetch folders, labels and emails for the newly selected account
    get().fetchFolders(id);
    get().fetchLabels(id);
    get().fetchEmails();
  },

  selectFolder: (folder: string) => {
    // Switching folders clears any active label filter.
    set({ selectedFolder: folder, selectedLabel: null, selectedEmailId: null });
    get().fetchEmails();
  },

  selectLabel: (label: string | null) => {
    set({ selectedLabel: label, selectedEmailId: null });
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

  hydrateEmail: (full) => {
    // Merge a fully-fetched message (body + attachments) into the cached list
    // so reply quoting and re-opens use the complete copy without re-fetching.
    set({
      emails: get().emails.map((e) => (e.id === full.id ? { ...e, ...full } : e)),
    });
  },

  updateEmail: async (id, updates) => {
    // Optimistic update. When an email is moved to a *different* folder than the
    // one we're viewing (archive / move-to / etc.), drop it from the list so it
    // visibly leaves the current folder — except in the virtual "starred" view.
    const prevEmails = get().emails;
    const movedAway =
      updates.folder !== undefined &&
      updates.folder !== get().selectedFolder &&
      get().selectedFolder !== "starred";
    set({
      emails: movedAway
        ? prevEmails.filter((e) => e.id !== id)
        : prevEmails.map((e) => (e.id === id ? { ...e, ...updates } : e)),
      emailsTotal: movedAway
        ? Math.max(0, get().emailsTotal - 1)
        : get().emailsTotal,
    });
    try {
      const updated = await api.updateEmail(id, updates);
      if (!movedAway) {
        set({
          emails: get().emails.map((e) =>
            e.id === id ? { ...e, ...updated } : e
          ),
        });
      }
    } catch (err: any) {
      // Revert on failure
      set({ emails: prevEmails, error: err.message || "Failed to update email" });
    }
  },

  fetchLabels: async (accountId?: string) => {
    const aid = accountId ?? get().selectedAccountId;
    if (!aid) return;
    try {
      const labels = await api.listLabels(aid);
      // Always offer the standard categories too, so they're available to apply
      // (applying creates the real Gmail label / Outlook category upstream).
      const merged = Array.from(
        new Set([...labels, ...EMAIL_CATEGORIES])
      ).sort();
      set({ availableLabels: merged });
    } catch {
      // Even if the provider list fails, offer the standard categories.
      set({
        availableLabels: Array.from(new Set([...EMAIL_CATEGORIES])).sort(),
      });
    }
  },

  applyLabel: async (id, name, add) => {
    const prevEmails = get().emails;
    // Optimistically update the message's category chips.
    set({
      emails: prevEmails.map((e) => {
        if (e.id !== id) return e;
        const cats = e.categories || [];
        const next = add
          ? cats.includes(name) ? cats : [...cats, name]
          : cats.filter((c) => c !== name);
        return { ...e, categories: next };
      }),
    });
    // Track a brand-new label so it's offered for other messages immediately.
    if (add && !get().availableLabels.includes(name)) {
      set({ availableLabels: [...get().availableLabels, name].sort() });
    }
    try {
      const updated = await api.updateEmailLabels(
        id,
        add ? [name] : [],
        add ? [] : [name],
      );
      set({
        emails: get().emails.map((e) => (e.id === id ? { ...e, ...updated } : e)),
      });
    } catch (err: any) {
      set({ emails: prevEmails, error: err.message || "Failed to update label" });
    }
  },

  deleteEmail: async (id) => {
    const prevEmails = get().emails;
    set({ emails: prevEmails.filter((e) => e.id !== id) });
    try {
      await api.deleteEmail(id);
      // Clear selection if deleted was selected
      if (get().selectedEmailId === id) {
        set({ selectedEmailId: get().emails[0]?.id ?? null });
      }
    } catch (err: any) {
      set({ emails: prevEmails, error: err.message || "Failed to delete email" });
    }
  },

  sendEmail: async (params) => {
    // Optimistically close the composer and hold the message for a few seconds
    // so it can be undone before it actually leaves.
    set({
      composeOpen: false,
      composeDefaults: null,
      pendingSend: params,
      error: null,
    });
    if (_sendTimer) clearTimeout(_sendTimer);
    _sendTimer = setTimeout(async () => {
      const p = get().pendingSend;
      if (!p) return;
      set({ pendingSend: null });
      try {
        await api.sendEmail(p);
        get().fetchEmails(); // surface the sent item
      } catch (err: any) {
        set({ error: err.message || "Failed to send email" });
      }
    }, UNDO_SEND_MS);
  },

  undoSend: () => {
    if (_sendTimer) {
      clearTimeout(_sendTimer);
      _sendTimer = undefined;
    }
    const p = get().pendingSend;
    set({ pendingSend: null });
    // Reopen the composer with the draft so it can be edited and re-sent.
    if (p) {
      set({
        composeOpen: true,
        composeDefaults: {
          to: p.to.join(", "),
          subject: p.subject,
          replyToBody: p.bodyText,
          replyToMessageId: p.replyToMessageId,
        },
      });
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

  setPendingChatPrompt: (prompt) => set({ pendingChatPrompt: prompt }),

  runTestOnMessage: async (accountId, messageId, isTest) => {
    if (get().testRunningIds.includes(messageId)) return;
    set({ testRunningIds: [...get().testRunningIds, messageId] });
    try {
      const res = await api.runRuleOnMessage({ accountId, messageId, isTest });
      set({ testResults: { ...get().testResults, [messageId]: res } });
    } catch (err: any) {
      set({ error: err?.message || "Rule run failed" });
    } finally {
      set({ testRunningIds: get().testRunningIds.filter((id) => id !== messageId) });
    }
  },

  runTestOnAll: async (accountId, messageIds, isTest) => {
    if (get().testBulkRunning) return;
    _stopTestRun = false;
    set({ testBulkRunning: true, testApplyMode: isTest ? get().testApplyMode : true });
    try {
      for (const id of messageIds) {
        if (_stopTestRun) break;
        await get().runTestOnMessage(accountId, id, isTest);
      }
    } finally {
      set({ testBulkRunning: false });
    }
  },

  stopTestRun: () => {
    _stopTestRun = true;
  },

  clearTestResults: () => set({ testResults: {} }),

  clearError: () => set({ error: null }),
}));
