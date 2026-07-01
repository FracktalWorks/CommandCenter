import { create } from "zustand";
import { Disposition, Energy, GtdContext, GtdItem, GtdProject, Person, ViewKey } from "./types";
import { MOCK_CONTEXTS, MOCK_ITEMS, MOCK_PEOPLE, MOCK_PROJECTS } from "./mockData";
import { isCalendarItem } from "./utils";

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
  | { kind: "calendar"; nextAction: string; dueAt: string; context?: string; projectId?: string };

function applyDecision(item: GtdItem, d: ClarifyDecision): GtdItem {
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

/** A mocked clarify suggestion. Stands in for the `task-manager` agent until
 *  the gateway `/tasks/items/{id}/clarify` endpoint is wired (§3.1). Pure
 *  keyword heuristics — deterministic, no network. */
export interface ClarifySuggestion {
  disposition: "NEXT" | "SOMEDAY" | "REFERENCE";
  nextAction: string;
  context?: string;
  energy?: Energy;
  rationale: string;
}

export function suggestClarification(item: GtdItem): ClarifySuggestion {
  const t = item.title.toLowerCase();
  const has = (...words: string[]) => words.some((w) => t.includes(w));

  if (has("idea", "maybe", "someday", "learn", "evaluate", "explore")) {
    return {
      disposition: "SOMEDAY",
      nextAction: item.title,
      rationale: "Sounds like an idea to incubate, not a commitment yet.",
    };
  }
  if (has("receipt", "file", "fyi", "reference", "invoice", "statement")) {
    return {
      disposition: "REFERENCE",
      nextAction: item.title,
      rationale: "Looks like information to keep, not an action.",
    };
  }

  let context = "@computer";
  if (has("call", "phone", "ring", "dial")) context = "@calls";
  else if (has("buy", "pick up", "store", "errand", "drop off", "collect")) context = "@errands";
  else if (has("ask", "discuss", "agenda", "1:1", "meet")) context = "@agenda";

  const verb = context === "@calls" ? "Call about" : context === "@errands" ? "Pick up" : "Action";
  return {
    disposition: "NEXT",
    nextAction: `${verb}: ${item.title}`,
    context,
    energy: "low",
    rationale: `Actionable now — fits ${context}.`,
  };
}

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
      const items = s.items.map((i) => (i.id === id ? applyDecision(i, decision) : i));
      // advance to the OLDEST remaining inbox item — GTD processes FIFO
      const remaining = items.filter((i) => i.disposition === "INBOX");
      const nextInbox = remaining.length
        ? remaining.reduce((a, b) =>
            new Date(b.createdAt) < new Date(a.createdAt) ? b : a,
          )
        : undefined;
      return { items, selectedItemId: nextInbox?.id ?? null };
    }),

  quickDispose: (id, disposition) =>
    set((s) => {
      const now = new Date().toISOString();
      return {
        items: s.items.map((i) =>
          i.id === id
            ? {
                ...i,
                disposition,
                updatedAt: now,
                clarifiedAt: now,
                ...(disposition === "DONE"
                  ? { completedAt: now, isTwoMinute: true }
                  : {}),
              }
            : i,
        ),
      };
    }),

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
    if (i.disposition === "INBOX") c.inbox++;
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
