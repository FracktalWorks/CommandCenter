import { create } from "zustand";
import { Email, EmailAccount, EmailFolder, EMAIL_CATEGORIES, RunMessageResult } from "./types";
import * as api from "./api";
import type { EmailFolderRaw } from "./api";
import { QUICK_ACTIONS, MOCK_ACCOUNTS, MOCK_EMAILS, MOCK_FOLDERS } from "./mockData";

/**
 * Dev-only demo mode. With NEXT_PUBLIC_EMAIL_DEMO=1 (set in .env.local) the
 * store falls back to the bundled mock accounts/emails whenever the backend is
 * unreachable or returns nothing — so the email UI is explorable without a
 * connected mailbox.
 *
 * Double-gated: it requires BOTH a non-production build AND the explicit flag.
 * In a production build `process.env.NODE_ENV === "production"`, so DEMO is a
 * compile-time `false` and the bundler dead-code-eliminates every demo branch
 * (and the mock-data imports). Dummy data can never reach a deployment.
 */
const DEMO =
  process.env.NODE_ENV !== "production" &&
  process.env.NEXT_PUBLIC_EMAIL_DEMO === "1";

/** Mock messages for an account, scoped to the active folder (demo mode only). */
function demoEmailsFor(accountId: string | null, folder: string): Email[] {
  return MOCK_EMAILS.filter(
    (e) =>
      (!accountId || e.accountId === accountId) &&
      (folder === "starred" ? e.isStarred : e.folder === folder),
  );
}

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
  /** Label/category name → assigned colour (preset token), for the selected
   *  account. Names absent here fall back to a deterministic colour. */
  labelColors: Record<string, string | null>;
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
  /** A message opened by id (e.g. from a chat card) that is NOT in the current
   *  folder's loaded list — fetched on demand so the detail pane can show it
   *  without first switching to the folder it lives in. */
  selectedEmailOverride: Email | null;
  searchQuery: string;
  /** Checkbox multi-selection in the list, shared with the unified toolbar so
   *  bulk actions can live in the page-level bar instead of inside EmailList. */
  selectedIds: Set<string>;
  /** Transient command from the unified toolbar to the open email viewer
   *  (reply/forward/block/download), consumed and cleared by EmailDetail. */
  viewerCommand: "reply" | "reply-all" | "forward" | "block" | "download" | null;

  // UI
  composeOpen: boolean;
  composeDefaults: { to: string; subject: string; replyToBody?: string; quote?: string; replyToMessageId?: string } | null;
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
  /** Silent background refresh of the current folder's first page (no spinner),
   *  so assistant/upstream changes (labels, drafts, new mail, archives) appear
   *  without a manual reload. No-op while loading or paginated past page 1. */
  softRefresh: () => Promise<void>;
  loadMoreEmails: () => Promise<void>;
  backfillOlder: () => Promise<void>;
  selectAccount: (id: string) => void;
  selectFolder: (folder: string) => void;
  /** Filter the list by a label/category (null clears the filter). */
  selectLabel: (label: string | null) => void;
  selectEmail: (id: string | null) => void;
  /** Open a message by id even when it isn't in the current folder's list
   *  (chat-card "Open in inbox"): selects it and, if absent, fetches it so the
   *  detail pane renders it regardless of the active folder/view. */
  openEmailById: (id: string) => Promise<void>;
  /** Toggle one message in the checkbox multi-selection. */
  toggleEmailSelected: (id: string) => void;
  /** Replace the checkbox multi-selection (used by "select all"). */
  setSelectedEmails: (ids: string[]) => void;
  /** Clear the checkbox multi-selection. */
  clearEmailSelection: () => void;
  /** Apply an update to every checkbox-selected message, then clear. */
  bulkUpdateSelected: (updates: Partial<Pick<Email, "isRead" | "isStarred" | "isFlagged" | "folder">>) => void;
  /** Delete every checkbox-selected message, then clear. */
  bulkDeleteSelected: () => void;
  /** Send a transient command to the open email viewer (reply/forward/etc.). */
  setViewerCommand: (cmd: EmailState["viewerCommand"]) => void;
  setSearchQuery: (q: string) => void;
  openCompose: (defaults?: { to: string; subject: string; replyToBody?: string; quote?: string; replyToMessageId?: string }) => void;
  closeCompose: () => void;
  hydrateEmail: (email: Email) => void;
  /** "Captured to Tasks" toast state (email → GTD inbox). */
  taskCaptureNotice: { title: string; created: boolean } | null;
  /** Capture an email into the task inbox (AI-drafted server-side). */
  captureEmailToTasks: (emailId: string) => Promise<void>;
  clearTaskCaptureNotice: () => void;
  updateEmail: (id: string, updates: Partial<Pick<Email, "isRead" | "isStarred" | "isFlagged" | "folder">>) => Promise<void>;
  fetchLabels: (accountId?: string) => Promise<void>;
  /** Set a label/category's colour (preset token); syncs to the provider. */
  setLabelColor: (name: string, color: string) => Promise<void>;
  applyLabel: (id: string, name: string, add: boolean) => Promise<void>;
  /** Add/remove one category across many messages at once. */
  applyLabelBulk: (ids: string[], name: string, add: boolean) => Promise<void>;
  /** Remove ALL categories from the given messages. */
  clearCategories: (ids: string[]) => Promise<void>;
  deleteEmail: (id: string) => Promise<void>;
  sendEmail: (params: api.SendEmailParams) => Promise<void>;
  undoSend: () => void;
  /** Create or update a draft (provider + local mirror); returns the saved draft. */
  saveDraft: (params: api.SaveDraftParams) => Promise<Email>;
  /** Send an existing draft natively (Drafts → Sent) and drop it from the list. */
  sendDraft: (accountId: string, draftId: string) => Promise<void>;
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
  /** Make an account the user's default mailbox (the inbox the UI opens on). */
  setDefaultAccount: (id: string) => Promise<void>;
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

/** localStorage key + URL param that persist the selected mailbox so the right
 *  inbox survives a refresh and is deep-linkable (the inbox-zero pattern, minus
 *  a dynamic route segment). */
const ACCOUNT_LS_KEY = "cc.email.selectedAccountId";
const ACCOUNT_URL_PARAM = "account";

/** Read the preferred account id: an explicit ?account= URL param wins (shared
 *  link), else the last selection from localStorage. Null on the server or when
 *  neither is set. */
function readPreferredAccountId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get(
      ACCOUNT_URL_PARAM,
    );
    if (fromUrl) return fromUrl;
  } catch {
    /* malformed URL — fall through to storage */
  }
  try {
    return window.localStorage.getItem(ACCOUNT_LS_KEY);
  } catch {
    return null;
  }
}

/** Persist the active account to localStorage and reflect it in the URL (without
 *  a navigation) so a refresh or shared link reopens the same mailbox. */
function persistAccountId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(ACCOUNT_LS_KEY, id);
    else window.localStorage.removeItem(ACCOUNT_LS_KEY);
  } catch {
    /* storage disabled (private mode) — URL still carries it */
  }
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(ACCOUNT_URL_PARAM, id);
    else url.searchParams.delete(ACCOUNT_URL_PARAM);
    window.history.replaceState({}, "", url);
  } catch {
    /* history unavailable — localStorage still carries it */
  }
}

/** Choose the initial account from a fetched list: a still-valid persisted/URL
 *  choice wins, else the user's default mailbox, else the first account. */
function pickInitialAccount(accounts: EmailAccount[]): string | null {
  if (accounts.length === 0) return null;
  const preferred = readPreferredAccountId();
  if (preferred && accounts.some((a) => a.id === preferred)) return preferred;
  return accounts.find((a) => a.isDefault)?.id ?? accounts[0].id;
}

export const useEmailStore = create<EmailState>((set, get) => ({
  // Data
  accounts: [],
  emails: [],
  emailsTotal: 0,
  emailsPage: 1,
  folders: [],
  availableLabels: [],
  labelColors: {},
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
  selectedEmailOverride: null,
  searchQuery: "",
  selectedIds: new Set<string>(),
  viewerCommand: null,

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
      let accounts = await api.listEmailAccounts();
      // Demo fallback: no real accounts connected → show the mock set.
      if (accounts.length === 0 && DEMO) accounts = MOCK_ACCOUNTS;
      set({ accounts, accountsLoading: false });
      // Pick the initial mailbox when none is selected yet: a persisted/URL
      // choice wins, else the user's default account, else the first one — so a
      // refresh or shared ?account= link reopens the right inbox.
      const { selectedAccountId } = get();
      if (!selectedAccountId && accounts.length > 0) {
        const initial = pickInitialAccount(accounts);
        if (initial) {
          set({ selectedAccountId: initial });
          persistAccountId(initial);
          get().fetchFolders(initial);
          get().fetchLabels(initial);
        }
      }
    } catch (err: any) {
      // Demo fallback: backend unreachable → seed mock accounts so the UI works.
      if (DEMO) {
        set({ accounts: MOCK_ACCOUNTS, accountsLoading: false });
        if (!get().selectedAccountId) {
          set({ selectedAccountId: MOCK_ACCOUNTS[0].id, folders: MOCK_FOLDERS });
          get().fetchEmails();
        }
        return;
      }
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
      // Demo fallback: no backend → use the mock folder tree.
      if (DEMO) {
        set({ folders: MOCK_FOLDERS, foldersLoading: false });
        return;
      }
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
      let emails = result.emails;
      let total = result.total;
      // Demo fallback: backend returned nothing → show mock messages.
      if (emails.length === 0 && DEMO) {
        emails = demoEmailsFor(selectedAccountId, selectedFolder);
        total = emails.length;
      }
      // Don't clobber the provider folder tree (system + user folders) fetched
      // by fetchFolders — only seed a system-folder fallback if we have none yet.
      const existing = get().folders;
      const folders =
        existing.length > 0 ? existing : DEMO ? MOCK_FOLDERS : buildFolders(emails);
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
        emailsTotal: total,
        emailsPage: 1,
      });
    } catch (err: any) {
      // Demo fallback: backend unreachable → show mock messages.
      if (DEMO) {
        const emails = demoEmailsFor(selectedAccountId, selectedFolder);
        const existing = get().folders;
        set({
          emails,
          folders: existing.length > 0 ? existing : MOCK_FOLDERS,
          emailsLoading: false,
          emailsTotal: emails.length,
          emailsPage: 1,
        });
        return;
      }
      set({ emailsLoading: false, error: err.message || "Failed to load emails" });
    }
  },

  softRefresh: async () => {
    const {
      selectedAccountId, selectedFolder, selectedLabel, searchQuery,
      emailsLoading, emailsPage,
    } = get();
    // Don't disrupt an in-flight load or a user who has paginated/scrolled
    // deeper than the first page — they can pull-to-refresh manually.
    if (!selectedAccountId || emailsLoading || emailsPage > 1) return;
    try {
      const result = await api.listEmails({
        accountId: selectedAccountId,
        folder: selectedFolder,
        label: selectedLabel || undefined,
        query: searchQuery || undefined,
        page: 1,
        pageSize: PAGE_SIZE,
      });
      // Bail if the user navigated away mid-fetch (avoid clobbering the new view).
      const now = get();
      if (
        now.selectedAccountId !== selectedAccountId ||
        now.selectedFolder !== selectedFolder ||
        now.selectedLabel !== selectedLabel ||
        now.searchQuery !== searchQuery ||
        now.emailsPage > 1
      ) {
        return;
      }
      // Demo: don't let an empty background refresh wipe the seeded mock list.
      if (result.emails.length === 0 && DEMO) return;
      const labelSet = new Set(now.availableLabels);
      for (const e of result.emails) for (const c of e.categories || []) labelSet.add(c);
      set({
        emails: result.emails,
        emailsTotal: result.total,
        availableLabels: [...labelSet].sort(),
      });
    } catch {
      /* silent — a failed background refresh shouldn't surface an error */
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
      // Best-effort provider paging. Do NOT mark the folder exhausted on a
      // transient failure — that would permanently disable "load older" for the
      // session. Just stop this attempt and show a friendly, retryable note.
      set({
        backfilling: false,
        error: "Couldn't load older messages right now. Try again.",
      });
    }
  },

  selectAccount: (id: string) => {
    set({
      selectedAccountId: id, selectedEmailId: null,
      selectedEmailOverride: null, selectedIds: new Set(),
    });
    // Remember the choice (localStorage + URL) so it survives a refresh.
    persistAccountId(id);
    // Fetch folders, labels and emails for the newly selected account
    get().fetchFolders(id);
    get().fetchLabels(id);
    get().fetchEmails();
  },

  selectFolder: (folder: string) => {
    // Switching folders clears any active label filter + checkbox selection.
    set({
      selectedFolder: folder,
      selectedLabel: null,
      selectedEmailId: null,
      selectedEmailOverride: null,
      selectedIds: new Set(),
    });
    get().fetchEmails();
  },

  selectLabel: (label: string | null) => {
    set({ selectedLabel: label, selectedEmailId: null, selectedEmailOverride: null });
    get().fetchEmails();
  },

  selectEmail: (id: string | null) => {
    // Opening a different message cancels any pending viewer command and any
    // out-of-list override (a normal list selection is in `emails`).
    set({ selectedEmailId: id, selectedEmailOverride: null, viewerCommand: null });
    // Mark as read if unread
    if (id) {
      const email = get().emails.find((e) => e.id === id);
      if (email && !email.isRead) {
        get().updateEmail(id, { isRead: true });
      }
    }
  },

  openEmailById: async (id: string) => {
    set({ selectedEmailId: id, selectedEmailOverride: null, viewerCommand: null });
    // Already loaded in the current folder → behave like a normal selection.
    const inList = get().emails.find((e) => e.id === id);
    if (inList) {
      if (!inList.isRead) get().updateEmail(id, { isRead: true });
      return;
    }
    // Not in the loaded list (different folder / not yet paged in). Fetch the
    // single message so the detail pane can render it without the user first
    // navigating to the folder it lives in.
    try {
      const email = await api.getEmail(id);
      // A late-arriving fetch must not clobber a newer selection.
      if (get().selectedEmailId !== id) return;
      set({ selectedEmailOverride: email });
    } catch {
      set({ error: "Couldn't open that email." });
    }
  },

  toggleEmailSelected: (id: string) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    }),

  setSelectedEmails: (ids: string[]) => set({ selectedIds: new Set(ids) }),

  clearEmailSelection: () => set({ selectedIds: new Set() }),

  bulkUpdateSelected: (updates) => {
    const ids = [...get().selectedIds];
    ids.forEach((id) => get().updateEmail(id, updates));
    set({ selectedIds: new Set() });
  },

  bulkDeleteSelected: () => {
    const ids = [...get().selectedIds];
    ids.forEach((id) => get().deleteEmail(id));
    set({ selectedIds: new Set() });
  },

  setViewerCommand: (cmd) => set({ viewerCommand: cmd }),

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

  taskCaptureNotice: null,

  captureEmailToTasks: async (emailId) => {
    const email = get().emails.find((e) => e.id === emailId);
    if (!email) return;
    let notice: { title: string; created: boolean };
    try {
      const { captureEmailToTask } = await import("./api");
      notice = await captureEmailToTask(email.accountId, emailId);
    } catch {
      notice = { title: "Could not reach the tasks backend", created: false };
    }
    set({ taskCaptureNotice: notice });
    // Auto-dismiss THIS notice only — an older capture's timer must not
    // clear a newer notice (identity check, not a blanket null).
    setTimeout(() => {
      set((s) => (s.taskCaptureNotice === notice ? { taskCaptureNotice: null } : s));
    }, 6000);
  },

  clearTaskCaptureNotice: () => set({ taskCaptureNotice: null }),

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
    // Demo: keep the optimistic change; there's no backend to persist to.
    if (DEMO) return;
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
      const names = Array.from(
        new Set([...labels.map((l) => l.name), ...EMAIL_CATEGORIES])
      ).sort();
      // Name → colour map from the provider; uncoloured labels are simply
      // absent (the renderer falls back to a deterministic colour).
      const colors: Record<string, string | null> = {};
      for (const l of labels) if (l.color) colors[l.name] = l.color;
      set({ availableLabels: names, labelColors: colors });
    } catch {
      // Even if the provider list fails, offer the standard categories.
      set({
        availableLabels: Array.from(new Set([...EMAIL_CATEGORIES])).sort(),
        labelColors: {},
      });
    }
  },

  setLabelColor: async (name, color) => {
    const aid = get().selectedAccountId;
    if (!aid) return;
    const prev = get().labelColors;
    // Optimistically recolour everywhere chips read from labelColors.
    set({ labelColors: { ...prev, [name]: color } });
    if (DEMO) return;
    try {
      await api.setLabelColor(aid, name, color);
    } catch (err) {
      set({
        labelColors: prev,
        error: (err as Error)?.message || "Failed to set colour",
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
    // Demo: keep the optimistic chip change; no backend to persist to.
    if (DEMO) return;
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

  applyLabelBulk: async (ids, name, add) => {
    // Apply (or remove) one category across many messages. Sequential keeps it
    // simple and each call is small; optimistic per-message via applyLabel.
    for (const id of ids) {
      await get().applyLabel(id, name, add);
    }
  },

  clearCategories: async (ids) => {
    for (const id of ids) {
      const email = get().emails.find((e) => e.id === id);
      const cats = email?.categories || [];
      if (cats.length === 0) continue;
      const prev = get().emails;
      // Optimistically drop all category chips for this message.
      set({
        emails: prev.map((e) => (e.id === id ? { ...e, categories: [] } : e)),
      });
      try {
        await api.updateEmailLabels(id, [], cats);
      } catch (err) {
        set({
          emails: prev,
          error: (err as Error)?.message || "Failed to clear categories",
        });
      }
    }
  },

  deleteEmail: async (id) => {
    const prevEmails = get().emails;
    set({ emails: prevEmails.filter((e) => e.id !== id) });
    // Clear selection if the deleted message was selected.
    const clearSelectionIfDeleted = () => {
      if (get().selectedEmailId === id) {
        set({ selectedEmailId: get().emails[0]?.id ?? null });
      }
    };
    // Demo: keep the optimistic removal; no backend to delete from.
    if (DEMO) {
      clearSelectionIfDeleted();
      return;
    }
    try {
      await api.deleteEmail(id);
      clearSelectionIfDeleted();
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

  saveDraft: async (params) => {
    // Reverse-sync write: create/update the provider draft + local mirror.
    const draft = await api.saveDraft(params);
    set((s) => {
      const exists = s.emails.some((e) => e.id === draft.id);
      if (exists) {
        // Update the row in place (editing an existing draft).
        return {
          emails: s.emails.map((e) => (e.id === draft.id ? { ...e, ...draft } : e)),
        };
      }
      // Only surface a brand-new draft in the list when the Drafts folder is the
      // active view — otherwise it would wrongly appear in inbox/etc. (it's still
      // persisted, so it shows on the next Drafts open). The in-thread DraftCard
      // is driven by the conversation refetch, not this list.
      if (s.selectedFolder === "drafts") {
        return { emails: [draft, ...s.emails], emailsTotal: s.emailsTotal + 1 };
      }
      return {};
    });
    return draft;
  },

  sendDraft: async (accountId, draftId) => {
    const prev = get().emails;
    // Optimistically remove the draft — it's leaving Drafts for Sent.
    set({
      emails: prev.filter((e) => e.id !== draftId),
      emailsTotal: Math.max(0, get().emailsTotal - 1),
    });
    try {
      await api.sendDraft(accountId, draftId);
      if (get().selectedEmailId === draftId) set({ selectedEmailId: null });
    } catch (err: any) {
      set({ emails: prev, error: err.message || "Failed to send draft" });
      throw err;
    }
  },

  triggerSync: async (accountId: string) => {
    set({ syncStatus: { ...get().syncStatus, [accountId]: "syncing" } });
    // Demo: no backend to sync against — settle straight back to idle.
    if (DEMO) {
      set({ syncStatus: { ...get().syncStatus, [accountId]: "idle" } });
      return;
    }
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
      const removed = get().accounts.find((a) => a.id === id);
      await api.deleteEmailAccount(id);
      let accounts = get().accounts.filter((a) => a.id !== id);
      // If we deleted the default mailbox, the backend re-elects the earliest
      // remaining one — mirror that locally so the Star doesn't vanish until the
      // next refetch (accounts come ordered is_default DESC, created_at).
      if (removed?.isDefault && accounts.length > 0 && !accounts.some((a) => a.isDefault)) {
        accounts = accounts.map((a, i) => (i === 0 ? { ...a, isDefault: true } : a));
      }
      set({ accounts });
      if (get().selectedAccountId === id) {
        const next = accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? null;
        set({ selectedAccountId: next });
        persistAccountId(next);
        if (next) {
          get().fetchFolders(next);
          get().fetchLabels(next);
          get().fetchEmails();
        }
      }
    } catch (err: any) {
      set({ error: err.message || "Failed to delete account" });
    }
  },

  setDefaultAccount: async (id) => {
    // Optimistically move the default flag, then persist to the backend.
    const prev = get().accounts;
    set({
      accounts: prev.map((a) => ({ ...a, isDefault: a.id === id })),
    });
    try {
      await api.setDefaultEmailAccount(id);
    } catch (err: any) {
      set({ accounts: prev, error: err.message || "Failed to set default account" });
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
