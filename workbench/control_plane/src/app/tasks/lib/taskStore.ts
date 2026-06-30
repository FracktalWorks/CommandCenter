import { create } from "zustand";
import { GtdContext, GtdItem, GtdProject, ViewKey } from "./types";
import { MOCK_CONTEXTS, MOCK_ITEMS, MOCK_PROJECTS } from "./mockData";
import { isCalendarItem } from "./utils";

// UI-first build: the store is seeded from bundled mock data (see mockData.ts).
// Capture writes to local state only. When the gateway `/tasks` API lands, these
// mutators get an async API call behind them; the component API stays the same.

let idCounter = 1000;
const nextId = () => `local-${idCounter++}`;

interface TaskState {
  items: GtdItem[];
  projects: GtdProject[];
  contexts: GtdContext[];

  selectedView: ViewKey;
  /** when drilled into a single @context under Next Actions */
  selectedContext: string | null;
  selectedItemId: string | null;
  selectedProjectId: string | null;

  // actions
  selectView: (view: ViewKey) => void;
  selectContext: (context: string | null) => void;
  selectItem: (id: string | null) => void;
  selectProject: (id: string | null) => void;
  /** Capture a new inbox item (frictionless quick-add). */
  capture: (title: string) => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  items: MOCK_ITEMS,
  projects: MOCK_PROJECTS,
  contexts: MOCK_CONTEXTS,

  selectedView: "inbox",
  selectedContext: null,
  selectedItemId: null,
  selectedProjectId: null,

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
      const ts = new Date().toISOString();
      const item: GtdItem = {
        id: nextId(),
        source: "LOCAL",
        provider: "local",
        title: t,
        disposition: "INBOX",
        isMine: true,
        createdAt: ts,
        updatedAt: ts,
      };
      // newest first
      return { items: [item, ...s.items] };
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
