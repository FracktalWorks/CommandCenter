import { create } from "zustand";
import {
  Disposition,
  Energy,
  GtdContext,
  GtdItem,
  GtdProject,
  Person,
  ProviderKind,
  Target,
  ViewKey,
} from "./types";
import {
  CONNECTED_PROVIDERS,
  MOCK_CONTEXTS,
  MOCK_ITEMS,
  MOCK_PEOPLE,
  MOCK_PROJECTS,
  type ConnectedProvider,
} from "./mockData";
import { isCalendarItem, isTickled } from "./utils";
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  rankForDrop,
  type TaskFilters,
  type TaskSort,
} from "./ordering";
import {
  accountToProviderEntry,
  apiBulkDispose,
  apiArchiveItem,
  apiCapture,
  apiCaptureBatch,
  apiDeleteAccount,
  apiDeleteItem,
  apiOrganize,
  apiPatchItem,
  apiPushItem,
  apiRefreshSchema,
  apiRefreshMembers,
  apiCreateAccountProject,
  apiSyncTasks,
  apiAtomize,
  fetchTaskSettings,
  updateTaskSettings,
  type TaskSettings,
  fetchAccounts,
  fetchItems,
  fetchPeople,
  fetchProjects,
  type OrganizeBody,
  type TaskAccount,
} from "./api";

/** Fire-and-forget a live-backend sync; the optimistic local update already
 *  happened, so a transient failure only means the next hydrate reconciles. */
function sync(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}

/** The outcome of clarifying an inbox item — the GTD decision tree (F2). */
/** Fields shared by clarified items that can be stored on a PM tool. */
interface SyncFields {
  /** Local vs a connected PM tool (§5.1). */
  dest?: Target;
  projectId?: string;
  /** the tool's stage/status, e.g. "Backlog" | "To-do". */
  status?: string;
  /** due date / timeline (ISO). */
  dueAt?: string;
  /** the tool's assignee/owner. */
  assignee?: Person;
}

export type ClarifyDecision =
  | { kind: "trash" }
  | { kind: "reference" }
  | { kind: "do-now" } // 2-minute rule → done
  | ({ kind: "someday" } & Pick<SyncFields, "dest" | "projectId" | "status">)
  | ({ kind: "delegate"; person: Person; nextAction: string } & Pick<
      SyncFields,
      "dest" | "projectId" | "status" | "dueAt"
    >)
  | ({
      kind: "next";
      nextAction: string;
      context: string;
      energy?: Energy;
      timeEstimateMins?: number;
    } & SyncFields)
  | ({ kind: "calendar"; nextAction: string; dueAt: string; context?: string } & Omit<
      SyncFields,
      "dueAt"
    >)
  | ({
      // turn the item into a new project's first next action (GTD: outcome + next action)
      kind: "project";
      outcome: string;
      nextAction: string;
      context?: string;
      energy?: Energy;
    } & SyncFields);

/** The editable metadata of a task (post-clarify edit). Every field optional —
 *  only what's provided changes. Maps to the gateway PATCH /items/{id}. Nulls
 *  aren't used; pass "" to clear a string field, undefined to leave it. */
export interface ItemMetaPatch {
  title?: string;
  notes?: string;
  nextAction?: string;
  context?: string;
  energy?: Energy;
  timeEstimateMins?: number;
  dueAt?: string;              // ISO; "" clears
  providerStatus?: string;    // the tool's stage
  workflowStage?: string;     // the local Kanban stage (board move)
  sortKey?: number;           // manual (drag) rank within a group/column
  assignee?: Person | null;   // null → unassign
}

/** Resolve a storage target into item source/provider/syncState fields.
 *  SYNCED items start 'pending' — the actual write to ClickUp/Jira is
 *  Action-Broker-gated, so they queue until pushed (or finished later). */
function targetFields(
  t?: Target,
): {
  source: "LOCAL" | "SYNCED";
  provider: ProviderKind;
  syncState: "local" | "pending";
  accountId?: string;
} | null {
  if (!t) return null;
  return {
    source: t.source,
    provider: t.source === "LOCAL" ? "local" : t.provider ?? "clickup",
    syncState: t.source === "SYNCED" ? "pending" : "local",
    accountId: t.source === "SYNCED" ? t.accountId : undefined,
  };
}

/** Map a UI ClarifyDecision to the gateway's organize body (live mode). */
function decisionToOrganizeBody(d: ClarifyDecision): OrganizeBody {
  const body: OrganizeBody = { kind: d.kind };
  const dest = "dest" in d ? d.dest : undefined;
  if (dest?.source === "SYNCED" && dest.accountId) body.account_id = dest.accountId;
  if ("projectId" in d && d.projectId) body.project_id = d.projectId;
  if ("status" in d && d.status) body.status = d.status;
  if ("dueAt" in d && d.dueAt) body.due_at = d.dueAt;
  if ("nextAction" in d && d.nextAction) body.next_action = d.nextAction;
  if ("context" in d && d.context) body.context = d.context;
  if ("energy" in d && d.energy) body.energy = d.energy;
  if ("timeEstimateMins" in d && d.timeEstimateMins)
    body.time_estimate_mins = d.timeEstimateMins;
  if (d.kind === "project") body.outcome = d.outcome;
  if (d.kind === "delegate")
    body.assignee = {
      name: d.person.name,
      email: d.person.email,
      provider_user_id: d.person.providerUserId,
    };
  else if ("assignee" in d && d.assignee)
    body.assignee = {
      name: d.assignee.name,
      email: d.assignee.email,
      provider_user_id: d.assignee.providerUserId,
    };
  return body;
}

function applyDecision(
  item: GtdItem,
  d: Exclude<ClarifyDecision, { kind: "project" }>,
): GtdItem {
  const now = new Date().toISOString();
  const base: GtdItem = { ...item, updatedAt: now, clarifiedAt: now };
  switch (d.kind) {
    case "trash":
      return { ...base, disposition: "TRASH" };
    case "reference":
      return { ...base, disposition: "REFERENCE" };
    case "someday":
      return {
        ...base,
        disposition: "SOMEDAY",
        projectId: d.projectId ?? base.projectId,
        providerStatus: d.status ?? base.providerStatus,
        ...(targetFields(d.dest) ?? {}),
      };
    case "do-now":
      return { ...base, disposition: "DONE", isTwoMinute: true, completedAt: now };
    case "delegate":
      return {
        ...base,
        disposition: "WAITING",
        isMine: false,
        nextAction: d.nextAction,
        waitingOn: d.person,
        delegatedAt: now,
        projectId: d.projectId ?? base.projectId,
        providerStatus: d.status ?? base.providerStatus,
        dueAt: d.dueAt ?? base.dueAt,
        ...(targetFields(d.dest) ?? {}),
      };
    case "next":
      return {
        ...base,
        disposition: "NEXT",
        nextAction: d.nextAction,
        context: d.context,
        energy: d.energy,
        timeEstimateMins: d.timeEstimateMins,
        projectId: d.projectId ?? base.projectId,
        providerStatus: d.status ?? base.providerStatus,
        dueAt: d.dueAt ?? base.dueAt,
        assignee: d.assignee ?? base.assignee,
        ...(targetFields(d.dest) ?? {}),
      };
    case "calendar":
      return {
        ...base,
        disposition: "NEXT",
        nextAction: d.nextAction,
        context: d.context,
        dueAt: d.dueAt,
        isHardDate: true,
        projectId: d.projectId ?? base.projectId,
        providerStatus: d.status ?? base.providerStatus,
        assignee: d.assignee ?? base.assignee,
        ...(targetFields(d.dest) ?? {}),
      };
  }
}

// The clarify AI proposal lives in lib/clarify.ts (proposeClarification).

// UI-first build: the store is seeded from bundled mock data (see mockData.ts).
// Capture writes to local state only. When the gateway `/tasks` API lands, these
// mutators get an async API call behind them; the component API stays the same.

let idCounter = 1000;
const nextId = () => `local-${idCounter++}`;

function makeCaptureItem(title: string): GtdItem {
  const ts = new Date().toISOString();
  return {
    id: nextId(),
    source: "LOCAL",
    provider: "local",
    title,
    disposition: "INBOX",
    isMine: true,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** A restorable snapshot taken *before* a dispose/clarify, for one-level undo. */
interface UndoSnapshot {
  items: GtdItem[];
  projects: GtdProject[];
  processed: number;
  selectedItemId: string | null;
  /** human label for the toast, e.g. "Trashed" / "Filed under Someday". */
  label: string;
  /** which item ids the change touched (live mode reverts these server-side). */
  changedIds?: string[];
  /** Items HARD-DELETED by this change. Undo re-creates them server-side
   *  (a new row/id) via capture, since delete is permanent — unlike a
   *  disposition change, which undo reverts in place via changedIds. */
  deletedItems?: GtdItem[];
}

/** Friendly past-tense label for a one-tap disposition (undo toast). */
const DISPOSE_LABEL: Partial<Record<Disposition, string>> = {
  TRASH: "Trashed",
  SOMEDAY: "Moved to Someday",
  REFERENCE: "Filed as Reference",
  DONE: "Marked done",
  NEXT: "Filed as Next action",
  WAITING: "Moved to Waiting",
};

/** Friendly label for a clarify decision (undo toast). */
function clarifyLabel(d: ClarifyDecision): string {
  switch (d.kind) {
    case "trash": return "Trashed";
    case "reference": return "Filed as Reference";
    case "someday": return "Moved to Someday";
    case "do-now": return "Marked done";
    case "delegate": return `Delegated to ${d.person.name}`;
    case "next": return "Filed as Next action";
    case "calendar": return "Scheduled";
    case "project": return "Made a Project";
  }
}

/** Apply a one-tap disposition (shared by quick + bulk dispose). */
function disposeOne(item: GtdItem, disposition: Disposition): GtdItem {
  const now = new Date().toISOString();
  return {
    ...item,
    disposition,
    updatedAt: now,
    clarifiedAt: now,
    ...(disposition === "DONE" ? { completedAt: now, isTwoMinute: true } : {}),
  };
}

interface TaskState {
  items: GtdItem[];
  projects: GtdProject[];
  contexts: GtdContext[];
  people: Person[];
  /** 'demo' = bundled mock data (no gateway); 'live' = the /tasks API. */
  backend: "demo" | "live";
  /** True until the first hydrate() resolves — the UI shows a spinner instead
   *  of the (empty) initial state, so production never flashes mock data. */
  loading: boolean;
  /** Destination entries for Clarify — Local + each connected workspace.
   *  In live mode entry ids are task_account UUIDs. */
  providers: ConnectedProvider[];
  /** Connected PM-tool workspaces (live mode). */
  accounts: TaskAccount[];

  selectedView: ViewKey;
  /** when drilled into a single @context under Next Actions */
  selectedContext: string | null;
  selectedItemId: string | null;
  selectedProjectId: string | null;
  /** A task opened FULL-PAGE (focused overlay) — the ClickUp/Linear-style
   *  maximized view over the same editable detail. null = closed. */
  focusedItemId: string | null;
  openFocus: (id: string) => void;
  closeFocus: () => void;
  /** "Mine only / Synced / All" board filter — hides the connected-workspace
   *  mirror so your own captures aren't swamped. */
  sourceFilter: "all" | "local" | "synced";
  setSourceFilter: (f: "all" | "local" | "synced") => void;
  /** Toolbar filters (search / context / assignee) applied to the active view
   *  in both list and board modes. */
  filters: TaskFilters;
  setFilters: (patch: Partial<TaskFilters>) => void;
  clearFilters: () => void;
  /** Ordering of the active view. "manual" enables drag-to-reorder; a field
   *  sort overrides manual position and disables dragging. */
  sort: TaskSort;
  setSort: (patch: Partial<TaskSort>) => void;

  /** ids of the most recent capture batch (for undo). */
  lastCaptureIds: string[];
  /** global quick-capture palette (ubiquitous capture). */
  quickCaptureOpen: boolean;
  quickCaptureMode: "single" | "sweep";
  /** the focused clarify overlay (keyboard-driven inbox processing). */
  clarifyModalOpen: boolean;
  /** the PM-tool workspaces connect/manage modal. */
  workspacesModalOpen: boolean;
  /** count of items processed out of the inbox this session (momentum). */
  processedThisSession: number;
  /** one-level undo for the most recent dispose/clarify — the safety net that
   *  makes rapid triage feel safe (GTD: the system must be trusted). */
  undoSnapshot: UndoSnapshot | null;

  // actions
  selectView: (view: ViewKey) => void;
  selectContext: (context: string | null) => void;
  selectItem: (id: string | null) => void;
  selectProject: (id: string | null) => void;
  /** Capture a new inbox item (frictionless quick-add). */
  capture: (title: string, attachments?: import("./types").TaskAttachment[]) => void;
  /** Capture many items at once (mind sweep) — one per non-empty line. */
  captureMany: (text: string) => void;
  /** Undo the most recent capture batch (only items still in the inbox). */
  undoLastCapture: () => void;
  /** Clarify an inbox item — apply the GTD decision and advance to the next. */
  clarify: (id: string, decision: ClarifyDecision) => void;
  /** Skip the current item (leave it in the inbox to process later) and move on. */
  skipToNextInbox: () => void;
  /** One-tap disposition (hover / keyboard triage) — no full decision tree. */
  quickDispose: (id: string, disposition: Disposition) => void;
  /** Apply the same disposition to many items at once (multi-select). */
  bulkDispose: (ids: string[], disposition: Disposition) => void;
  /** Archive (hide from active views) or un-archive a task — independent of
   *  DONE. Optimistic; the row moves to / from the Archive view. */
  archiveItem: (id: string, archived: boolean) => void;
  /** Lazily pull archived tasks into the store (they're excluded from the
   *  normal hydrate) — called when the Archive view is opened. */
  loadArchive: () => Promise<void>;
  /** PERMANENTLY delete an item (hard-remove the row, not a GTD "Trash"
   *  disposition). Optimistic + undoable (undo re-creates it). */
  deleteItem: (id: string) => void;
  /** Permanently delete many items at once (multi-select). */
  deleteItems: (ids: string[]) => void;
  /** Defer (tickler): hide from the active inbox until a date, then resurface. */
  deferItem: (id: string, dateIso: string) => void;
  /** Bring a deferred item back into the active inbox now. */
  undeferItem: (id: string) => void;
  /** Edit a task's editable fields — works for inbox captures AND clarified
   *  items (context/energy/estimate/due/stage/assignee/next action/notes).
   *  For a SYNCED ClickUp task, the mapped fields also back-sync upstream. */
  updateItem: (id: string, patch: ItemMetaPatch) => void;
  /** Drag-reorder: move `id` to `toIndex` within `groupItems` (the destination
   *  group's items in their current manual order), optionally re-filing it to a
   *  new workflow stage / provider status. Computes a fractional sortKey between
   *  the neighbours and patches sortKey (+ the stage change) in one write. */
  reorderItem: (
    id: string,
    groupItems: GtdItem[],
    toIndex: number,
    refile?: { workflowStage?: string; providerStatus?: string },
  ) => void;
  /** Inline-rename a captured item (fix a typo without clarifying). */
  renameItem: (id: string, title: string) => void;
  /** Undo the most recent dispose/clarify — restores the item(s) to the inbox. */
  undoLastChange: () => void;
  /** Dismiss the undo affordance without undoing (e.g. after a timeout). */
  dismissUndo: () => void;
  /** Load live data from the gateway; silently stays on mock data if absent. */
  hydrate: () => Promise<void>;
  /** Re-fetch connected workspaces (after connect/refresh in the modal). */
  refreshAccounts: () => Promise<void>;
  /** Disconnect a workspace account. */
  disconnectAccount: (id: string) => Promise<void>;
  /** Refresh one account's provider schema (projects/members/statuses). */
  refreshAccountSchema: (id: string) => Promise<void>;
  /** LIVE member pull for one workspace — people removed in the tool
   *  disappear from the delegate picker. */
  refreshAccountMembers: (accountId: string) => Promise<void>;
  /** Create a NEW provider project (ClickUp list) under a space/folder. */
  createWorkspaceProject: (
    accountId: string,
    req: { name: string; spaceId: string; folderId?: string },
  ) => Promise<{ projectId: string; providerRef: string; name: string }>;
  /** Duplicate-capture notice: the AI found the just-captured item is the
   *  same as (verdict "duplicate" — auto-skipped, undoable) or similar to
   *  (verdict "similar" — the user decides) an existing open item. */
  dupNotice: {
    verdict: "duplicate" | "similar";
    /** the freshly captured item (already removed when verdict=duplicate) */
    title: string;
    itemId: string | null;
    matchTitle: string;
    matchId: string;
  } | null;
  /** Resolve the dup notice: keep both / treat as the same (remove new). */
  resolveDupNotice: (action: "keep" | "same" | "dismiss") => void;
  /** Per-user task-manager settings (AI tiers + toggles). Defaults render
   *  immediately; hydrate() refreshes from the gateway. */
  settings: TaskSettings;
  /** Patch settings (optimistic; persisted via PUT /tasks/settings). */
  updateSettings: (patch: Partial<TaskSettings>) => Promise<void>;
  settingsModalOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  /** True while a provider pull (POST /tasks/sync) is in flight. */
  syncing: boolean;
  /** Pull existing provider tasks into the mirror (one account, or all),
   *  then re-fetch items so Waiting/Next fill from the connected tool. */
  syncNow: (accountId?: string) => Promise<void>;
  /** Explicit user-approved push of a pending item to its workspace. */
  pushItem: (id: string) => Promise<void>;
  openQuickCapture: (mode: "single" | "sweep") => void;
  closeQuickCapture: () => void;
  /** Open/close the clarify overlay for an item. */
  openClarify: (id: string) => void;
  closeClarify: () => void;
  openWorkspaces: () => void;
  closeWorkspaces: () => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  // Start EMPTY + loading. hydrate() fills from the gateway (live) or, only if
  // the gateway is truly absent, falls back to the bundled mocks (demo/local
  // dev). This is what stops production briefly flashing dummy tasks on load.
  items: [],
  projects: [],
  contexts: MOCK_CONTEXTS,
  people: [],
  backend: "demo",
  loading: true,
  providers: CONNECTED_PROVIDERS,
  accounts: [],

  selectedView: "inbox",
  selectedContext: null,
  focusedItemId: null,
  openFocus: (id) => set({ focusedItemId: id, selectedItemId: id }),
  closeFocus: () => set({ focusedItemId: null }),
  sourceFilter: "all",
  setSourceFilter: (f) => set({ sourceFilter: f }),
  filters: DEFAULT_FILTERS,
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  clearFilters: () => set({ filters: DEFAULT_FILTERS }),
  sort: DEFAULT_SORT,
  setSort: (patch) => set((s) => ({ sort: { ...s.sort, ...patch } })),
  selectedItemId: null,
  selectedProjectId: null,
  lastCaptureIds: [],
  quickCaptureOpen: false,
  quickCaptureMode: "single",
  clarifyModalOpen: false,
  workspacesModalOpen: false,
  processedThisSession: 0,
  undoSnapshot: null,

  selectView: (view) =>
    set({
      selectedView: view,
      selectedContext: null,
      selectedItemId: null,
      selectedProjectId: null,
      // A search/filter is scoped to the view you set it in — reset on nav so a
      // stale query doesn't silently hide items in the next view.
      filters: DEFAULT_FILTERS,
    }),

  selectContext: (context) =>
    set({ selectedView: "next", selectedContext: context, selectedItemId: null }),

  selectItem: (id) => set({ selectedItemId: id }),

  selectProject: (id) =>
    set({ selectedView: "projects", selectedProjectId: id, selectedItemId: null }),

  capture: (title, attachments) => {
    const t = title.trim();
    if (!t) return;
    const item = { ...makeCaptureItem(t), attachments };
    set((s) => ({ items: [item, ...s.items], lastCaptureIds: [item.id] }));
    if (get().backend === "live") {
      // Optimistic row already shown; swap in the server row (real id) when it lands.
      sync(
        apiCapture(t, undefined, attachments).then((server) => {
          set((s) => ({
            items: s.items.map((i) => (i.id === item.id ? server : i)),
            lastCaptureIds: s.lastCaptureIds.map((x) =>
              x === item.id ? server.id : x,
            ),
            selectedItemId:
              s.selectedItemId === item.id ? server.id : s.selectedItemId,
          }));
          // Background duplicate check (capture stays frictionless): the AI
          // compares the new capture against open items. Confident duplicate
          // → auto-remove with an undoable notice; similar → ask the user.
          if (!get().settings.captureDedup) return;
          apiAtomize(t, { excludeIds: [server.id] })
            .then(({ items: cands }) => {
              const c = cands[0];
              // The atomizer sees the just-created row too — a self-match
              // (same id) is not a duplicate.
              if (!c || c.verdict === "new" || !c.matchId || c.matchId === server.id) return;
              if (c.verdict === "duplicate") {
                set((s) => ({
                  items: s.items.filter((i) => i.id !== server.id),
                  dupNotice: {
                    verdict: "duplicate", title: server.title,
                    itemId: null, matchTitle: c.matchTitle ?? "",
                    matchId: c.matchId!,
                  },
                }));
                apiDeleteItem(server.id).catch(() => {});
              } else {
                set({
                  dupNotice: {
                    verdict: "similar", title: server.title,
                    itemId: server.id, matchTitle: c.matchTitle ?? "",
                    matchId: c.matchId!,
                  },
                });
              }
            })
            .catch(() => { /* dedup is best-effort */ });
        }),
      );
    }
  },

  dupNotice: null,

  resolveDupNotice: (action) => {
    const n = get().dupNotice;
    if (!n) return;
    if (action === "keep" && n.verdict === "duplicate") {
      // Re-add the auto-skipped capture ("add anyway").
      get().capture(n.title);
    } else if (action === "same" && n.verdict === "similar" && n.itemId) {
      // The user confirmed it's the same item — remove the new copy.
      const id = n.itemId;
      set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
      if (get().backend === "live") sync(apiDeleteItem(id).catch(() => {}));
    }
    set({ dupNotice: null });
  },

  captureMany: (text) => {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;
    const newItems = lines.map(makeCaptureItem);
    set((s) => ({
      items: [...newItems, ...s.items],
      lastCaptureIds: newItems.map((i) => i.id),
    }));
    if (get().backend === "live") {
      sync(
        apiCaptureBatch(lines).then((serverItems) =>
          set((s) => {
            const byIndex = new Map(
              newItems.map((tmp, idx) => [tmp.id, serverItems[idx]]),
            );
            return {
              items: s.items.map((i) => byIndex.get(i.id) ?? i),
              lastCaptureIds: s.lastCaptureIds.map(
                (x) => byIndex.get(x)?.id ?? x,
              ),
            };
          }),
        ),
      );
    }
  },

  undoLastCapture: () => {
    const ids = get().lastCaptureIds;
    if (!ids.length) return;
    const remove = new Set(ids);
    set((s) => ({
      items: s.items.filter(
        (i) => !(remove.has(i.id) && i.disposition === "INBOX"),
      ),
      lastCaptureIds: [],
    }));
    if (get().backend === "live") {
      sync(Promise.all(ids.map((id) => apiDeleteItem(id).catch(() => {}))));
    }
  },

  openQuickCapture: (mode) => set({ quickCaptureOpen: true, quickCaptureMode: mode }),
  closeQuickCapture: () => set({ quickCaptureOpen: false }),
  openClarify: (id) => set({ selectedItemId: id, clarifyModalOpen: true }),
  closeClarify: () => set({ clarifyModalOpen: false }),
  openWorkspaces: () => set({ workspacesModalOpen: true }),
  closeWorkspaces: () => set({ workspacesModalOpen: false }),

  clarify: (id, decision) => {
    set((s) => {
      const snapshot: UndoSnapshot = {
        items: s.items,
        projects: s.projects,
        processed: s.processedThisSession,
        selectedItemId: s.selectedItemId,
        label: clarifyLabel(decision),
        changedIds: [id],
      };
      let projects = s.projects;
      let items: GtdItem[];
      if (decision.kind === "project") {
        // Create a project and make this item its first next action.
        const now = new Date().toISOString();
        const pid = nextId();
        const tf =
          targetFields(decision.dest) ??
          { source: "LOCAL" as const, provider: "local" as ProviderKind, syncState: "local" as const };
        const project: GtdProject = {
          id: pid,
          source: tf.source,
          provider: tf.provider,
          accountId: tf.accountId,
          outcome: decision.outcome,
          status: "ACTIVE",
          hasNextAction: true,
        };
        projects = [project, ...s.projects];
        items = s.items.map((i) =>
          i.id === id
            ? {
                ...i,
                disposition: "NEXT",
                nextAction: decision.nextAction,
                context: decision.context,
                energy: decision.energy,
                projectId: pid,
                source: tf.source,
                provider: tf.provider,
                accountId: tf.accountId,
                syncState: tf.syncState,
                providerStatus: decision.status,
                dueAt: decision.dueAt ?? i.dueAt,
                assignee: decision.assignee ?? i.assignee,
                updatedAt: now,
                clarifiedAt: now,
              }
            : i,
        );
      } else {
        items = s.items.map((i) => (i.id === id ? applyDecision(i, decision) : i));
      }
      // advance to the OLDEST remaining inbox item — GTD processes FIFO
      const remaining = items.filter((i) => i.disposition === "INBOX");
      const nextInbox = remaining.length
        ? remaining.reduce((a, b) =>
            new Date(b.createdAt) < new Date(a.createdAt) ? b : a,
          )
        : undefined;
      return {
        items,
        projects,
        selectedItemId: nextInbox?.id ?? null,
        processedThisSession: s.processedThisSession + 1,
        undoSnapshot: snapshot,
      };
    });
    if (get().backend === "live") {
      const apply = apiOrganize(id, decisionToOrganizeBody(decision));
      if (decision.kind === "project") {
        // The server mints its own project id — reconcile both lists so the
        // optimistic local project/id drift doesn't linger.
        sync(
          apply.then(async () => {
            const [items, projects] = await Promise.all([
              fetchItems("all"),
              fetchProjects(),
            ]);
            set({ items, projects });
          }),
        );
      } else {
        sync(
          apply.then(async (server) => {
            set((s) => ({
              items: s.items.map((i) => (i.id === id ? server : i)),
            }));
            // Default-sync posture: an accepted decision that targeted a
            // workspace (the accept UI showed the destination) pushes
            // immediately when the tool has everything it needs (a real
            // provider project). Otherwise it stays staged with the manual
            // Push affordance — never lost, never silently failing.
            if (server.syncState === "pending" && server.projectId) {
              try {
                const pushed = await apiPushItem(server.id);
                set((s) => ({
                  items: s.items.map((i) => (i.id === pushed.id ? pushed : i)),
                }));
              } catch {
                /* stays pending — the Push button remains */
              }
            }
          }),
        );
      }
    }
  },

  /** LIVE member refresh for one workspace (delegate-picker freshness). */
  refreshAccountMembers: async (accountId: string) => {
    if (get().backend !== "live") return;
    try {
      const fresh = await apiRefreshMembers(accountId);
      set((s) => ({
        accounts: s.accounts.map((a) => (a.id === accountId ? fresh : a)),
      }));
    } catch {
      /* keep cached members */
    }
  },

  /** Create a NEW provider project (ClickUp list) under a space/folder and
   *  refresh the mirrored project list so pickers see it immediately. */
  createWorkspaceProject: async (accountId, req) => {
    const created = await apiCreateAccountProject(accountId, req);
    try {
      const [projects, accounts] = await Promise.all([
        fetchProjects(),
        fetchAccounts(),
      ]);
      set({ projects, accounts });
    } catch {
      /* next hydrate reconciles */
    }
    return created;
  },

  skipToNextInbox: () =>
    set((s) => {
      const inbox = s.items
        .filter((i) => i.disposition === "INBOX")
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      if (inbox.length <= 1) return s; // nothing else to move to
      const idx = inbox.findIndex((i) => i.id === s.selectedItemId);
      const next = inbox[(idx + 1) % inbox.length];
      return { selectedItemId: next.id };
    }),

  quickDispose: (id, disposition) => {
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? disposeOne(i, disposition) : i)),
      processedThisSession: s.processedThisSession + 1,
      undoSnapshot: {
        items: s.items,
        projects: s.projects,
        processed: s.processedThisSession,
        selectedItemId: s.selectedItemId,
        label: DISPOSE_LABEL[disposition] ?? "Filed",
        changedIds: [id],
      },
    }));
    if (get().backend === "live") sync(apiBulkDispose([id], disposition));
  },

  bulkDispose: (ids, disposition) => {
    set((s) => {
      const set_ = new Set(ids);
      const affected = s.items.filter(
        (i) => set_.has(i.id) && i.disposition === "INBOX",
      ).length;
      return {
        items: s.items.map((i) =>
          set_.has(i.id) ? disposeOne(i, disposition) : i,
        ),
        processedThisSession: s.processedThisSession + affected,
        undoSnapshot: {
          items: s.items,
          projects: s.projects,
          processed: s.processedThisSession,
          selectedItemId: s.selectedItemId,
          label: `${DISPOSE_LABEL[disposition] ?? "Filed"} ${affected} item${affected === 1 ? "" : "s"}`,
          changedIds: ids,
        },
      };
    });
    if (get().backend === "live") sync(apiBulkDispose(ids, disposition));
  },

  archiveItem: (id, archived) => {
    const nowIso = new Date().toISOString();
    set((s) => ({
      items: s.items.map((i) =>
        i.id === id
          ? { ...i, archivedAt: archived ? nowIso : undefined, updatedAt: nowIso }
          : i,
      ),
      // Close the pop-up if we're archiving the focused task.
      focusedItemId:
        archived && s.focusedItemId === id ? null : s.focusedItemId,
    }));
    if (get().backend === "live") sync(apiArchiveItem(id, archived));
  },

  loadArchive: async () => {
    if (get().backend !== "live") return;
    try {
      const archived = await fetchItems("archive");
      set((s) => {
        // Merge: replace any existing rows by id, add the rest.
        const byId = new Map(s.items.map((i) => [i.id, i]));
        for (const a of archived) byId.set(a.id, a);
        return { items: Array.from(byId.values()) };
      });
    } catch {
      /* keep current state */
    }
  },

  deleteItem: (id) => {
    const target = get().items.find((i) => i.id === id);
    if (!target) return;
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
      selectedItemId: s.selectedItemId === id ? null : s.selectedItemId,
      undoSnapshot: {
        items: s.items,
        projects: s.projects,
        processed: s.processedThisSession,
        selectedItemId: s.selectedItemId,
        label: "Deleted",
        deletedItems: [target],
      },
    }));
    if (get().backend === "live") sync(apiDeleteItem(id).catch(() => {}));
  },

  deleteItems: (ids) => {
    const remove = new Set(ids);
    const targets = get().items.filter((i) => remove.has(i.id));
    if (!targets.length) return;
    set((s) => ({
      items: s.items.filter((i) => !remove.has(i.id)),
      selectedItemId:
        s.selectedItemId && remove.has(s.selectedItemId)
          ? null
          : s.selectedItemId,
      undoSnapshot: {
        items: s.items,
        projects: s.projects,
        processed: s.processedThisSession,
        selectedItemId: s.selectedItemId,
        label: `Deleted ${targets.length} item${targets.length === 1 ? "" : "s"}`,
        deletedItems: targets,
      },
    }));
    if (get().backend === "live") {
      sync(Promise.all(ids.map((id) => apiDeleteItem(id).catch(() => {}))));
    }
  },

  deferItem: (id, dateIso) => {
    set((s) => ({
      items: s.items.map((i) =>
        i.id === id
          ? { ...i, deferUntil: dateIso, updatedAt: new Date().toISOString() }
          : i,
      ),
    }));
    if (get().backend === "live") sync(apiPatchItem(id, { defer_until: dateIso }));
  },

  undeferItem: (id) => {
    set((s) => ({
      items: s.items.map((i) =>
        i.id === id
          ? { ...i, deferUntil: undefined, updatedAt: new Date().toISOString() }
          : i,
      ),
    }));
    if (get().backend === "live") sync(apiPatchItem(id, { defer_until: "" }));
  },

  updateItem: (id, patch) => {
    set((s) => ({
      items: s.items.map((i) => {
        if (i.id !== id) return i;
        const title = patch.title !== undefined ? patch.title.trim() : i.title;
        if (!title) return i; // never allow an empty title
        return {
          ...i,
          title,
          notes: patch.notes !== undefined ? patch.notes : i.notes,
          nextAction:
            patch.nextAction !== undefined ? patch.nextAction : i.nextAction,
          context: patch.context !== undefined ? patch.context : i.context,
          energy: patch.energy !== undefined ? patch.energy : i.energy,
          timeEstimateMins:
            patch.timeEstimateMins !== undefined
              ? patch.timeEstimateMins || undefined
              : i.timeEstimateMins,
          dueAt: patch.dueAt !== undefined ? patch.dueAt || undefined : i.dueAt,
          providerStatus:
            patch.providerStatus !== undefined
              ? patch.providerStatus
              : i.providerStatus,
          workflowStage:
            patch.workflowStage !== undefined
              ? patch.workflowStage
              : i.workflowStage,
          sortKey:
            patch.sortKey !== undefined ? patch.sortKey : i.sortKey,
          // Dropping on the last configured stage marks the task DONE — mirror
          // the backend optimistically so the card leaves the active board.
          disposition:
            patch.workflowStage !== undefined &&
            patch.workflowStage ===
              get().settings.workflowStages[
                get().settings.workflowStages.length - 1
              ]
              ? "DONE"
              : i.disposition,
          assignee:
            patch.assignee !== undefined
              ? patch.assignee ?? undefined
              : i.assignee,
          updatedAt: new Date().toISOString(),
        };
      }),
    }));
    if (get().backend === "live") {
      const body: Parameters<typeof apiPatchItem>[1] = {};
      if (patch.title !== undefined && patch.title.trim())
        body.title = patch.title.trim();
      if (patch.notes !== undefined) body.notes = patch.notes;
      if (patch.nextAction !== undefined) body.next_action = patch.nextAction;
      if (patch.context !== undefined) body.context = patch.context;
      if (patch.energy !== undefined) body.energy = patch.energy;
      if (patch.timeEstimateMins !== undefined)
        body.time_estimate_mins = patch.timeEstimateMins;
      if (patch.dueAt !== undefined) body.due_at = patch.dueAt;
      if (patch.providerStatus !== undefined)
        body.provider_status = patch.providerStatus;
      if (patch.workflowStage !== undefined)
        body.workflow_stage = patch.workflowStage;
      if (patch.sortKey !== undefined) body.sort_key = patch.sortKey;
      if (patch.assignee !== undefined) {
        if (patch.assignee === null) body.clear_assignee = true;
        else
          body.assignee = {
            name: patch.assignee.name,
            email: patch.assignee.email,
            provider_user_id: patch.assignee.providerUserId,
          };
      }
      if (Object.keys(body).length) {
        // Swap in the server row (authoritative — e.g. a ClickUp back-sync may
        // normalize the stage) so the optimistic edit reconciles.
        sync(
          apiPatchItem(id, body).then((server) =>
            set((s) => ({
              items: s.items.map((i) => (i.id === id ? server : i)),
            })),
          ),
        );
      }
    }
  },

  reorderItem: (id, groupItems, toIndex, refile) => {
    const moving = get().items.find((i) => i.id === id);
    if (!moving) return;
    // `toIndex` is the gap index within `groupItems` (which may still include
    // the moved card, e.g. an intra-group drag). The neighbour set is that
    // group WITHOUT the moved card; when the card originally sat BEFORE the
    // gap, removing it shifts every later index down by one — adjust so the
    // card lands in the visually-targeted slot rather than one past it.
    const fromIndex = groupItems.findIndex((i) => i.id === id);
    const others = groupItems.filter((i) => i.id !== id);
    const destIndex =
      fromIndex !== -1 && fromIndex < toIndex ? toIndex - 1 : toIndex;
    const newKey = rankForDrop(others, destIndex);
    // One patch carries the rank and any stage re-file, so a cross-column drag
    // that also repositions is a single write (and one optimistic update).
    const patch: ItemMetaPatch = { sortKey: newKey };
    if (refile?.workflowStage !== undefined)
      patch.workflowStage = refile.workflowStage;
    if (refile?.providerStatus !== undefined)
      patch.providerStatus = refile.providerStatus;
    get().updateItem(id, patch);
  },

  renameItem: (id, title) => {
    const t = title.trim();
    if (!t) return;
    set((s) => ({
      items: s.items.map((i) =>
        i.id === id ? { ...i, title: t, updatedAt: new Date().toISOString() } : i,
      ),
    }));
    if (get().backend === "live") sync(apiPatchItem(id, { title: t }));
  },

  undoLastChange: () => {
    const snap = get().undoSnapshot;
    if (!snap) return;
    const { items, projects, processed, selectedItemId, changedIds, deletedItems } = snap;
    set({
      items,
      projects,
      processedThisSession: processed,
      selectedItemId,
      undoSnapshot: null,
    });
    if (get().backend !== "live") return;
    if (deletedItems?.length) {
      // Undo a HARD delete: the row is gone server-side, so re-create it (a
      // new id) and swap the restored local placeholder to the server row so
      // future edits target a real row. Local state is already restored.
      sync(
        Promise.all(
          deletedItems.map(async (d) => {
            try {
              const created = await apiCapture(d.title, d.notes ?? undefined);
              set((s) => ({
                items: s.items.map((i) => (i.id === d.id ? created : i)),
                selectedItemId:
                  s.selectedItemId === d.id ? created.id : s.selectedItemId,
              }));
            } catch {
              /* leave the local restore; a reload reconciles */
            }
          }),
        ),
      );
    } else if (changedIds?.length) {
      // Revert the server rows to their pre-change disposition (the local
      // state is already fully restored from the snapshot).
      const prev = new Map(items.map((i) => [i.id, i]));
      sync(
        Promise.all(
          changedIds.map((id) => {
            const p = prev.get(id);
            return p
              ? apiPatchItem(id, { disposition: p.disposition }).catch(() => {})
              : Promise.resolve();
          }),
        ),
      );
    }
  },

  dismissUndo: () => set({ undoSnapshot: null }),

  hydrate: async () => {
    try {
      const [items, projects, accounts, orgPeople] = await Promise.all([
        fetchItems("all"),
        fetchProjects(),
        fetchAccounts(),
        fetchPeople().catch(() => [] as Person[]),
      ]);
      const providers: ConnectedProvider[] = [
        { id: "local", label: "Local", provider: "local", source: "LOCAL", statuses: [] },
        ...accounts.map(accountToProviderEntry),
      ];
      // People priority: the org-knowledge layer (roles/skills, §6.1) →
      // provider workspace members → bundled mocks.
      const members = accounts.flatMap((a) => a.members);
      const people = orgPeople.length
        ? orgPeople
        : members.length
          ? members
          : MOCK_PEOPLE;
      set({
        backend: "live",
        loading: false,
        items,
        projects,
        accounts,
        providers,
        people,
      });
      // Settings load in parallel (defaults already render); the auto-sync
      // below honours the user's toggle once they arrive.
      const settings = await fetchTaskSettings().catch(() => get().settings);
      set({ settings });
      // Background pull: refresh the provider mirror (incremental cursor
      // makes this cheap) so Waiting/Next reflect the tool without a manual
      // sync. Fire-and-forget — the UI is already usable on cached rows.
      if (accounts.length > 0 && settings.autoSyncOnOpen) void get().syncNow();
    } catch {
      // Gateway absent/unreachable → demo mode on the bundled mocks (local
      // dev only). We seed the mocks HERE, not at init, so production (gateway
      // present) never shows them even for a frame.
      set({
        backend: "demo",
        loading: false,
        items: MOCK_ITEMS,
        projects: MOCK_PROJECTS,
        people: MOCK_PEOPLE,
      });
    }
  },

  refreshAccounts: async () => {
    if (get().backend !== "live") return;
    try {
      const accounts = await fetchAccounts();
      const providers: ConnectedProvider[] = [
        { id: "local", label: "Local", provider: "local", source: "LOCAL", statuses: [] },
        ...accounts.map(accountToProviderEntry),
      ];
      const members = accounts.flatMap((a) => a.members);
      const orgPeople = await fetchPeople().catch(() => [] as Person[]);
      const projects = await fetchProjects();
      set({
        accounts,
        providers,
        projects,
        people: orgPeople.length
          ? orgPeople
          : members.length
            ? members
            : MOCK_PEOPLE,
      });
    } catch {
      /* keep current state */
    }
  },

  disconnectAccount: async (id) => {
    await apiDeleteAccount(id);
    await get().refreshAccounts();
    // Mirrored items cascade server-side; re-pull the item list too.
    try {
      set({ items: await fetchItems("all") });
    } catch {
      /* next hydrate reconciles */
    }
  },

  refreshAccountSchema: async (id) => {
    await apiRefreshSchema(id);
    await get().refreshAccounts();
  },

  settings: {
    chatModel: "tier-powerful",
    clarifyModel: "tier-balanced",
    atomizeModel: "tier-fast",
    emailCaptureModel: "tier-fast",
    captureDedup: true,
    autoSyncOnOpen: true,
    clarifyUseLlm: true,
    backgroundSync: true,
    mirrorDoneTasks: false,
    workflowStages: ["TODO", "IN PROCESS", "WAITING FOR", "DONE"],
  },

  updateSettings: async (patch) => {
    // Optimistic: the modal reflects the change instantly; the server is the
    // source of truth on response (and on the next hydrate if the PUT fails).
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    if (get().backend !== "live") return;
    try {
      set({ settings: await updateTaskSettings(patch) });
    } catch {
      /* next hydrate reconciles */
    }
  },

  settingsModalOpen: false,
  openSettings: () => set({ settingsModalOpen: true }),
  closeSettings: () => set({ settingsModalOpen: false }),

  syncing: false,

  syncNow: async (accountId) => {
    if (get().backend !== "live" || get().syncing) return;
    set({ syncing: true });
    try {
      await apiSyncTasks(accountId ? { accountId } : undefined);
      // Re-pull items + account sync status so the views fill immediately.
      const [items] = await Promise.all([
        fetchItems("all"),
        get().refreshAccounts(),
      ]);
      set({ items });
    } catch {
      /* account rows carry sync_error; next hydrate reconciles */
    } finally {
      set({ syncing: false });
    }
  },

  pushItem: async (id) => {
    const pushed = await apiPushItem(id);
    set((s) => ({ items: s.items.map((i) => (i.id === id ? pushed : i)) }));
  },
}));

// ── Derived selectors (pure; keep view logic in one place) ──────────────────

/** Items shown for a given view (+ optional context drill-down + source
 *  filter). ``source`` hides the connected-workspace mirror ("local") or shows
 *  only it ("synced"); "all" (default) shows both. */
export function itemsForView(
  items: GtdItem[],
  view: ViewKey,
  context: string | null,
  source: "all" | "local" | "synced" = "all",
): GtdItem[] {
  if (source === "local") items = items.filter((i) => i.source === "LOCAL");
  else if (source === "synced") items = items.filter((i) => i.source !== "LOCAL");
  // Archived tasks are hidden everywhere except the Archive view.
  if (view === "archive") return items.filter((i) => i.archivedAt);
  items = items.filter((i) => !i.archivedAt);
  switch (view) {
    case "inbox":
      return items.filter((i) => i.disposition === "INBOX");
    case "next":
      return items.filter(
        (i) => i.disposition === "NEXT" && (!context || i.context === context),
      );
    case "waiting":
      return items.filter((i) => i.disposition === "WAITING");
    case "someday":
      return items.filter((i) => i.disposition === "SOMEDAY");
    case "reference":
      return items.filter((i) => i.disposition === "REFERENCE");
    case "calendar":
      return items
        .filter(isCalendarItem)
        .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
    default:
      return [];
  }
}

/** Per-view counts for the sidebar badges. */
export function viewCounts(items: GtdItem[]): Record<ViewKey, number> {
  const c = {
    inbox: 0, next: 0, waiting: 0, calendar: 0, projects: 0,
    someday: 0, reference: 0, archive: 0, engage: 0, horizons: 0,
  } as Record<ViewKey, number>;
  for (const i of items) {
    if (i.archivedAt) continue; // archived rows never count toward active views
    if (i.disposition === "INBOX" && !isTickled(i)) c.inbox++;
    else if (i.disposition === "NEXT") c.next++;
    else if (i.disposition === "WAITING") c.waiting++;
    else if (i.disposition === "SOMEDAY") c.someday++;
    else if (i.disposition === "REFERENCE") c.reference++;
    if (isCalendarItem(i)) c.calendar++;
  }
  return c;
}

/** Count of NEXT items per context (for the expandable @context sub-list). */
export function contextCounts(items: GtdItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) {
    if (i.disposition !== "NEXT" || !i.context) continue;
    out[i.context] = (out[i.context] ?? 0) + 1;
  }
  return out;
}
