// Manual (drag-to-reorder) ordering math + the filter/sort model shared by the
// list and Kanban board. Kept pure so it's unit-testable and used identically
// on both surfaces (a card dropped in a list group and on a board column go
// through the same rank computation).

import { GtdItem } from "./types";
import { isOverdue } from "./utils";
import { isUrgent, priorityRank } from "./priority";

/** The step between freshly-assigned ranks (also the re-spread gap). */
const RANK_STEP = 1000;

/** Effective rank of an item for manual ordering. Items never dragged have no
 *  sortKey; they sort AFTER ranked ones (matching the backend's NULLS LAST),
 *  ordered by creation like today. We fold that into a single comparable number
 *  so a mixed group orders deterministically. */
export function effectiveRank(i: GtdItem): number {
  return i.sortKey ?? Number.POSITIVE_INFINITY;
}

/** Order a group of items by (sortKey NULLS LAST, createdAt DESC) — the same
 *  order the gateway returns, so the client re-sort is a no-op on fresh data
 *  and only matters mid-drag (optimistic) or after a filter. */
export function byManualOrder(items: GtdItem[]): GtdItem[] {
  return [...items].sort((a, b) => {
    const ra = effectiveRank(a);
    const rb = effectiveRank(b);
    if (ra !== rb) return ra - rb;
    // tie (both unranked, or equal keys): newest first
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
}

/** Compute the sortKey for a card dropped at `toIndex` within `ordered` (the
 *  destination group's items in their current manual order, EXCLUDING the moved
 *  card). Returns the midpoint between the neighbours' ranks. When a neighbour
 *  is unranked (infinite), we fall back to a finite anchor so the result is a
 *  real number. */
export function rankForDrop(ordered: GtdItem[], toIndex: number): number {
  const clamp = Math.max(0, Math.min(toIndex, ordered.length));
  const finiteRank = (i: GtdItem | undefined, fallback: number): number => {
    const r = i ? i.sortKey : undefined;
    return r == null || !Number.isFinite(r) ? fallback : r;
  };
  const before = ordered[clamp - 1];
  const after = ordered[clamp];
  if (!before && !after) return RANK_STEP; // empty group
  if (!before) {
    // dropping at the top: below the first item's rank
    const first = finiteRank(after, RANK_STEP);
    return first - RANK_STEP;
  }
  if (!after) {
    // dropping at the bottom: above the last item's rank
    const last = finiteRank(before, 0);
    return last + RANK_STEP;
  }
  const lo = finiteRank(before, 0);
  const hi = finiteRank(after, lo + RANK_STEP * 2);
  return (lo + hi) / 2;
}

// ── Filter & sort model ─────────────────────────────────────────────────────

/** How a view is ordered. "manual" is the drag-reorder order (default) and is
 *  the only mode where dragging to reposition is allowed; any explicit field
 *  sort overrides manual position, so dragging is disabled in those modes. */
export type SortField =
  | "manual"
  | "priority"
  | "due"
  | "urgency"
  | "created"
  | "title"
  | "energy";

export type SortDir = "asc" | "desc";

export interface TaskFilters {
  /** free-text over title + next action */
  query: string;
  /** @context exact match ("" = any) */
  context: string;
  /** assignee name exact match ("" = any) */
  assignee: string;
}

export interface TaskSort {
  field: SortField;
  dir: SortDir;
}

export const DEFAULT_FILTERS: TaskFilters = { query: "", context: "", assignee: "" };
export const DEFAULT_SORT: TaskSort = { field: "manual", dir: "asc" };

export function filtersActive(f: TaskFilters): boolean {
  return Boolean(f.query.trim() || f.context || f.assignee);
}

const ENERGY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** Apply the free-text/context/assignee filters to a list. */
export function applyFilters(items: GtdItem[], f: TaskFilters): GtdItem[] {
  const q = f.query.trim().toLowerCase();
  return items.filter((i) => {
    if (q) {
      const hay = `${i.title} ${i.nextAction ?? ""} ${i.notes ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.context && i.context !== f.context) return false;
    if (f.assignee && (i.assignee?.name ?? "") !== f.assignee) return false;
    return true;
  });
}

/** Apply a sort. "manual" defers to byManualOrder; the field sorts compare the
 *  chosen key and respect the direction. Unset keys sort last regardless of
 *  direction (so blanks don't jump to the top on desc). */
export function applySort(items: GtdItem[], s: TaskSort): GtdItem[] {
  if (s.field === "manual") return byManualOrder(items);
  const dir = s.dir === "asc" ? 1 : -1;
  const keyed = items.map((i) => ({ i, k: sortKeyFor(i, s.field) }));
  keyed.sort((a, b) => {
    const an = a.k == null;
    const bn = b.k == null;
    if (an && bn) return 0;
    if (an) return 1; // nulls always last
    if (bn) return -1;
    if (a.k! < b.k!) return -1 * dir;
    if (a.k! > b.k!) return 1 * dir;
    return 0;
  });
  return keyed.map((x) => x.i);
}

function sortKeyFor(i: GtdItem, field: SortField): string | number | null {
  switch (field) {
    case "priority":
      // Matrix rank 1..8 (1 = highest). Asc puts Founder Fire first.
      return priorityRank(i);
    case "urgency":
      // Urgent first: 0 = urgent, 1 = not. Overdue/soon float up on asc.
      return isUrgent(i) ? 0 : 1;
    case "due":
      return i.dueAt ?? null;
    case "created":
      return i.createdAt ?? null;
    case "title":
      return i.title ? i.title.toLowerCase() : null;
    case "energy":
      return i.energy ? ENERGY_RANK[i.energy] : null;
    default:
      return null;
  }
}

/** Overdue-first helper used by group headers (kept here so list + board share
 *  the same "needs attention" signal). */
export function overdueCount(items: GtdItem[], now: number): number {
  return items.filter((i) => isOverdue(i, now)).length;
}

// ── Group-by (the toolbar "lens" that slices a list into labelled sections) ──

import {
  CELL_META,
  CELLS_IN_ORDER,
  NO_CONTEXT_GROUP,
  actionMode,
  priorityCell,
} from "./priority";

export type GroupBy = "none" | "context" | "priority" | "mode" | "energy";

export interface TaskGroup {
  key: string;
  label: string;
  /** emoji/icon token for the header (optional). */
  emoji?: string;
  items: GtdItem[];
}

const ENERGY_LABEL: Record<string, string> = {
  low: "Low energy",
  medium: "Medium energy",
  high: "High energy",
};
const MODE_LABEL: Record<string, { label: string; emoji: string }> = {
  do: { label: "Do — my work", emoji: "🎯" },
  delegate: { label: "Delegate", emoji: "⚡" },
  schedule: { label: "Schedule", emoji: "📅" },
  drop: { label: "Consider dropping", emoji: "🗑" },
};

/** Slice items into ordered, labelled groups for the chosen lens. Group ORDER
 *  is meaningful (priority → matrix order; mode → do/delegate/schedule/drop;
 *  energy → high→low). Items within a group keep their incoming order (already
 *  sorted by the caller). Returns a single unlabelled group for "none". */
export function groupItems(
  items: GtdItem[],
  by: GroupBy,
  urgentWindowHours?: number,
): TaskGroup[] {
  if (by === "none") return [{ key: "all", label: "", items }];

  if (by === "priority") {
    const buckets = new Map<string, GtdItem[]>();
    for (const i of items) {
      const cell = priorityCell(i, urgentWindowHours);
      (buckets.get(cell) ?? buckets.set(cell, []).get(cell)!).push(i);
    }
    return CELLS_IN_ORDER.filter((c) => buckets.has(c)).map((c) => ({
      key: c,
      label: CELL_META[c].label,
      emoji: CELL_META[c].emoji,
      items: buckets.get(c)!,
    }));
  }

  if (by === "mode") {
    const order = ["do", "delegate", "schedule", "drop"];
    const buckets = new Map<string, GtdItem[]>();
    for (const i of items) {
      const m = actionMode(i, urgentWindowHours);
      (buckets.get(m) ?? buckets.set(m, []).get(m)!).push(i);
    }
    return order
      .filter((m) => buckets.has(m))
      .map((m) => ({
        key: m,
        label: MODE_LABEL[m].label,
        emoji: MODE_LABEL[m].emoji,
        items: buckets.get(m)!,
      }));
  }

  if (by === "energy") {
    const order = ["high", "medium", "low", "none"];
    const buckets = new Map<string, GtdItem[]>();
    for (const i of items) {
      const e = i.energy ?? "none";
      (buckets.get(e) ?? buckets.set(e, []).get(e)!).push(i);
    }
    return order
      .filter((e) => buckets.has(e))
      .map((e) => ({
        key: e,
        label: e === "none" ? "No energy set" : ENERGY_LABEL[e],
        items: buckets.get(e)!,
      }));
  }

  // context
  const buckets = new Map<string, GtdItem[]>();
  for (const i of items) {
    const c = i.context || NO_CONTEXT_GROUP;
    (buckets.get(c) ?? buckets.set(c, []).get(c)!).push(i);
  }
  return Array.from(buckets.keys())
    .sort((a, b) =>
      a === NO_CONTEXT_GROUP ? 1 : b === NO_CONTEXT_GROUP ? -1 : a.localeCompare(b),
    )
    .map((c) => ({ key: c, label: c, items: buckets.get(c)! }));
}
