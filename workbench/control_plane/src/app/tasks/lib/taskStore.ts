import { create } from "zustand";
import { Disposition, Energy, GtdContext, GtdItem, GtdProject, Person, ViewKey } from "./types";
import { MOCK_CONTEXTS, MOCK_ITEMS, MOCK_PEOPLE, MOCK_PROJECTS } from "./mockData";
import { isCalendarItem, isTickled } from "./utils";

/** The outcome of clarifying an inbox item — the GTD decision tree (F2). */
export type ClarifyDecision =
  | { kind: "trash" }
  | { kind: "someday" }
  | { kind: "reference" }
  | { kind: "do-now" } // 2-minute rule → done
  | { kind: "delegate"; person: Person; nextAction: string; projectId?: string }
  | {
      kind: "next";
      nextAction: string;
      context: string;
      energy?: Energy;
      timeEstimateMins?: number;
      projectId?: string;
    }
  | { kind: "calendar"; nextAction: string; dueAt: string; context?: string; projectId?: string }
  | {
      // turn the item into a new project's first next action (GTD: outcome + next action)
      kind: "project";
      outcome: string;
      nextAction: string;
      context?: string;
      energy?: Energy;
    };

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
      return { ...base, disposition: "SOMEDAY" };
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

  selectedView: ViewKey;
  /** when drilled into a single @context under Next Actions */
  selectedContext: string | null;
  selectedItemId: string | null;
  selectedProjectId: string | null;

  /** ids of the most recent capture batch (for undo). */
  lastCaptureIds: string[];
  /** global quick-capture palette (ubiquitous capture). */
  quickCaptureOpen: boolean;
  quickCaptureMode: "single" | "sweep";
  /** the focused clarify overlay (keyboard-driven inbox processing). */
  clarifyModalOpen: boolean;
  /** count of items processed out of the inbox this session (momentum). */
  processedThisSession: number;

  // actions
  selectView: (view: ViewKey) => void;
  selectContext: (context: string | null) => void;
  selectItem: (id: string | null) => void;
  selectProject: (id: string | null) => void;
  /** Capture a new inbox item (frictionless quick-add). */
  capture: (title: string) => void;
  /** Capture many items at once (mind sweep) — one per non-empty line. */
  captureMany: (text: string) => void;
  /** Undo the most recent capture batch (only items still in the inbox). */
  undoLastCapture: () => void;
  /** Clarify an inbox item — apply the GTD decision and advance to the next. */
  clarify: (id: string, decision: ClarifyDecision) => void;
  /** One-tap disposition (hover / keyboard triage) — no full decision tree. */
  quickDispose: (id: string, disposition: Disposition) => void;
  /** Apply the same disposition to many items at once (multi-select). */
  bulkDispose: (ids: string[], disposition: Disposition) => void;
  /** Defer (tickler): hide from the active inbox until a date, then resurface. */
  deferItem: (id: string, dateIso: string) => void;
  /** Bring a deferred item back into the active inbox now. */
  undeferItem: (id: string) => void;
  /** Edit a captured item's title and/or note. */
  updateItem: (id: string, patch: { title?: string; notes?: string }) => void;
  /** Inline-rename a captured item (fix a typo without clarifying). */
  renameItem: (id: string, title: string) => void;
  openQuickCapture: (mode: "single" | "sweep") => void;
  closeQuickCapture: () => void;
  /** Open/close the clarify overlay for an item. */
  openClarify: (id: string) => void;
  closeClarify: () => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  items: MOCK_ITEMS,
  projects: MOCK_PROJECTS,
  contexts: MOCK_CONTEXTS,
  people: MOCK_PEOPLE,

  selectedView: "inbox",
  selectedContext: null,
  selectedItemId: null,
  selectedProjectId: null,
  lastCaptureIds: [],
  quickCaptureOpen: false,
  quickCaptureMode: "single",
  clarifyModalOpen: false,
  processedThisSession: 0,

  selectView: (view) =>
    set({ selectedView: view, selectedContext: null, selectedItemId: null, selectedProjectId: null }),

  selectContext: (context) =>
    set({ selectedView: "next", selectedContext: context, selectedItemId: null }),

  selectItem: (id) => set({ selectedItemId: id }),

  selectProject: (id) =>
    set({ selectedView: "projects", selectedProjectId: id, selectedItemId: null }),

  capture: (title) =>
    set((s) => {
      const t = title.trim();
      if (!t) return s;
      const item = makeCaptureItem(t);
      return { items: [item, ...s.items], lastCaptureIds: [item.id] };
    }),

  captureMany: (text) =>
    set((s) => {
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) return s;
      const newItems = lines.map(makeCaptureItem);
      return {
        items: [...newItems, ...s.items],
        lastCaptureIds: newItems.map((i) => i.id),
      };
    }),

  undoLastCapture: () =>
    set((s) => {
      if (!s.lastCaptureIds.length) return s;
      const remove = new Set(s.lastCaptureIds);
      return {
        items: s.items.filter(
          (i) => !(remove.has(i.id) && i.disposition === "INBOX"),
        ),
        lastCaptureIds: [],
      };
    }),

  openQuickCapture: (mode) => set({ quickCaptureOpen: true, quickCaptureMode: mode }),
  closeQuickCapture: () => set({ quickCaptureOpen: false }),
  openClarify: (id) => set({ selectedItemId: id, clarifyModalOpen: true }),
  closeClarify: () => set({ clarifyModalOpen: false }),

  clarify: (id, decision) =>
    set((s) => {
      let projects = s.projects;
      let items: GtdItem[];
      if (decision.kind === "project") {
        // Create a project and make this item its first next action.
        const now = new Date().toISOString();
        const pid = nextId();
        const project: GtdProject = {
          id: pid,
          source: "LOCAL",
          provider: "local",
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
      };
    }),

  quickDispose: (id, disposition) =>
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? disposeOne(i, disposition) : i)),
      processedThisSession: s.processedThisSession + 1,
    })),

  bulkDispose: (ids, disposition) =>
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
      };
    }),

  deferItem: (id, dateIso) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.id === id
          ? { ...i, deferUntil: dateIso, updatedAt: new Date().toISOString() }
          : i,
      ),
    })),

  undeferItem: (id) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.id === id
          ? { ...i, deferUntil: undefined, updatedAt: new Date().toISOString() }
          : i,
      ),
    })),

  updateItem: (id, patch) =>
    set((s) => ({
      items: s.items.map((i) => {
        if (i.id !== id) return i;
        const title = patch.title !== undefined ? patch.title.trim() : i.title;
        if (!title) return i; // never allow an empty title
        return {
          ...i,
          title,
          notes: patch.notes !== undefined ? patch.notes : i.notes,
          updatedAt: new Date().toISOString(),
        };
      }),
    })),

  renameItem: (id, title) =>
    set((s) => {
      const t = title.trim();
      if (!t) return s;
      return {
        items: s.items.map((i) =>
          i.id === id ? { ...i, title: t, updatedAt: new Date().toISOString() } : i,
        ),
      };
    }),
}));

// ── Derived selectors (pure; keep view logic in one place) ──────────────────

/** Items shown for a given view (+ optional context drill-down). */
export function itemsForView(
  items: GtdItem[],
  view: ViewKey,
  context: string | null,
): GtdItem[] {
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
    someday: 0, reference: 0, engage: 0, horizons: 0,
  } as Record<ViewKey, number>;
  for (const i of items) {
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
