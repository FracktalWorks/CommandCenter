// Manual (drag-to-reorder) ordering math + the filter/sort model shared by the
// list and Kanban board. Kept pure so it's unit-testable and used identically
// on both surfaces (a card dropped in a list group and on a board column go
// through the same rank computation).

import { GtdItem } from "./types";
import { isOverdue } from "./utils";
import { priorityRank } from "./priority";

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
// "urgency" was dropped as a sort: it's a coarse urgent/not bucket that
// "due" already orders more finely (soonest deadline first) and "priority"
// already folds urgency into its rank — so it added nothing.
export type SortField =
  | "manual"
  | "priority"
  | "due"
  | "created"
  | "title"
  | "energy";

export type SortDir = "asc" | "desc";

// Facet filters: each is a SET of accepted values — a task matches a facet if it
// falls in ANY of that facet's selected values (OR within a facet), and it must
// pass EVERY active facet (AND across facets). Empty set = facet inactive. This
// powers the unified Filter popover (Context / Priority / Energy) + the chips.
export interface TaskFilters {
  /** free-text over title + next action */
  query: string;
  /** @context names to include ([] = any). NO_CONTEXT sentinel = "no @context". */
  contexts: string[];
  /** priority cells to include ([] = any). */
  priorities: string[];
  /** energy levels to include ([] = any). NO_ENERGY sentinel = "no energy set". */
  energies: string[];
  /** assignee name exact match ("" = any) — only used on non-next views. */
  assignee: string;
}

export interface TaskSort {
  field: SortField;
  dir: SortDir;
}

/** Sentinel facet values for "unset" buckets, so they can be filtered like any
 *  other value (a task with no @context / no energy). */
export const NO_CONTEXT_FACET = "∅context";
export const NO_ENERGY_FACET = "∅energy";

export const DEFAULT_FILTERS: TaskFilters = {
  query: "",
  contexts: [],
  priorities: [],
  energies: [],
  assignee: "",
};
// Default: within each status group, order by the priority matrix (1 = Critical
// first). The user can switch to Manual (drag-reorder) or any field via the
// toolbar. (Next Actions is grouped by status; this sorts inside each group.)
export const DEFAULT_SORT: TaskSort = { field: "priority", dir: "asc" };

export function filtersActive(f: TaskFilters): boolean {
  return Boolean(
    f.query.trim() ||
      f.contexts.length ||
      f.priorities.length ||
      f.energies.length ||
      f.assignee,
  );
}

/** How many facet VALUES are active (for the "Filter (N)" badge). Search and the
 *  single-select assignee each count as one. */
export function activeFilterCount(f: TaskFilters): number {
  return (
    f.contexts.length +
    f.priorities.length +
    f.energies.length +
    (f.query.trim() ? 1 : 0) +
    (f.assignee ? 1 : 0)
  );
}

const ENERGY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** Apply the search + facet filters. Each facet is OR-within, AND-across. */
export function applyFilters(items: GtdItem[], f: TaskFilters): GtdItem[] {
  const q = f.query.trim().toLowerCase();
  const ctxSet = new Set(f.contexts);
  const priSet = new Set(f.priorities);
  const enSet = new Set(f.energies);
  return items.filter((i) => {
    if (q) {
      const hay = `${i.title} ${i.nextAction ?? ""} ${i.notes ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (ctxSet.size) {
      const key = i.context || NO_CONTEXT_FACET;
      if (!ctxSet.has(key)) return false;
    }
    if (priSet.size && !priSet.has(priorityCell(i))) return false;
    if (enSet.size) {
      const key = i.energy || NO_ENERGY_FACET;
      if (!enSet.has(key)) return false;
    }
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
      // Matrix rank 1..7 (1 = highest). Asc puts Critical first.
      return priorityRank(i);
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

// ── Status axis (the 4 fixed Next-Actions stages) ────────────────────────────
//
// The Next-Actions board and grouped list slice tasks into the user's 4 FIXED
// workflow stages (settings.workflowStages) — NOT the raw union of every ClickUp
// status (that was cluttered). A LOCAL task's stage is its `workflowStage`; a
// SYNCED ClickUp task's stage is derived from its `providerStatus` through the
// user's status→stage MAP (settings.statusStageMap), so many upstream statuses
// collapse into one clean stage. Dragging a card between these stages writes the
// mapped status back to ClickUp (backend), per task's own project.
//
// (The per-PROJECT detail view is separate — it shows that project's real
// ClickUp statuses via an explicit `stages` prop and doesn't use this axis.)

/** Case/space-insensitive key for matching a status name ("To Do" ≡ "to do";
 *  "to do" and "todo" stay distinct — ClickUp treats them as different). */
function normStatus(s: string): string {
  return s.trim().toLowerCase();
}

/** The status→stage map for a synced task. Keyed by normalized status name. */
export type StatusStageMap = Record<string, string>;

/** The stage a SYNCED task's ClickUp status maps to, or "" when unmapped. */
export function stageForProviderStatus(
  providerStatus: string | undefined,
  map: StatusStageMap,
): string {
  if (!providerStatus) return "";
  return map[normStatus(providerStatus)] ?? "";
}

// Name heuristics for guessing which stage a raw ClickUp status belongs to —
// a mirror of the gateway's `guess_stage_for_status` (settings.py) so an
// UNMAPPED ClickUp status still lands in the right column here, identically to
// the guess the settings mapping table shows. First match wins in this order
// (so "in review" hits IN PROCESS, not WAITING). Each entry is a canonical
// stage name + the substrings that imply it; a heuristic for a stage the user
// doesn't have is skipped, and anything unmatched falls back to the first stage.
const STAGE_HEURISTICS: [string, string[]][] = [
  ["DONE", ["done", "complete", "closed", "resolved", "shipped", "cancel"]],
  ["WAITING FOR", ["waiting", "blocked", "on hold", "hold", "paused", "pending", "stuck"]],
  ["IN PROCESS", ["progress", "process", "doing", "review", "testing", "qa", "active", "wip", "started"]],
  ["TODO", ["todo", "to do", "to-do", "backlog", "open", "new", "icebox", "later", "someday", "planned", "queue"]],
];

/** Guess which of the user's `stages` a raw ClickUp status name belongs to, by
 *  substring heuristics — the client twin of the gateway's guess so an unmapped
 *  ClickUp status resolves to a sensible column instead of dumping into the
 *  first one. Only guesses stages the user actually has (matched by upper-cased
 *  name); falls back to the first stage when nothing matches, so a task is
 *  never lost. */
export function guessStageForStatus(
  status: string | undefined,
  stages: string[],
): string {
  const low = (status ?? "").trim().toLowerCase();
  const have = new Map(stages.map((s) => [s.trim().toUpperCase(), s]));
  for (const [canonical, needles] of STAGE_HEURISTICS) {
    if (have.has(canonical) && needles.some((n) => low.includes(n))) {
      return have.get(canonical)!;
    }
  }
  return stages[0] ?? "";
}

/** The stage column a task belongs in on the Next-Actions board. A LOCAL task
 *  keys off its `workflowStage`; a SYNCED task off its ClickUp `providerStatus`
 *  translated through `statusStageMap`. A synced task that also has a local
 *  `workflowStage` override (set by a drag that couldn't back-sync) uses that.
 *  Falls back to `firstStage` when nothing resolves — so a task is never lost. */
export function statusColumnForItem(
  item: GtdItem,
  stages: string[],
  firstStage: string,
  statusStageMap: StatusStageMap = {},
): string {
  const known = (s: string | undefined): string =>
    s && stages.some((st) => normStatus(st) === normStatus(s))
      ? stages.find((st) => normStatus(st) === normStatus(s))!
      : "";
  // A completed task always rests in the LAST stage (the "Done" column) — that's
  // the terminal column it stays in until archived, regardless of whatever stage
  // or ClickUp status it carried when it was completed.
  if (item.disposition === "DONE" && stages.length) {
    return stages[stages.length - 1];
  }
  if (item.source === "LOCAL") {
    return known(item.workflowStage) || firstStage;
  }
  // Synced: a local stage override wins (a drag that stayed local); then the
  // user's explicit status→stage map; then the status matched directly against
  // the axis (the per-project view, whose axis IS the raw ClickUp statuses);
  // and finally the name heuristic, so an UNMAPPED status still lands in a
  // sensible stage on the global board instead of dumping into the first one.
  return (
    known(item.workflowStage) ||
    known(stageForProviderStatus(item.providerStatus, statusStageMap)) ||
    known(item.providerStatus) ||
    guessStageForStatus(item.providerStatus, stages)
  );
}

// ── Group-by (the toolbar "lens" that slices a list into labelled sections) ──

import {
  ACTION_MODE_META,
  CELL_META,
  CELLS_IN_ORDER,
  NO_CONTEXT_GROUP,
  actionMode,
  priorityCell,
  type ActionMode,
} from "./priority";

export type GroupBy =
  | "none" | "context" | "priority" | "mode" | "energy" | "depth";

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
// The mode group-by labels come from the ONE shared ACTION_MODE_META (same as
// the Action Mode column) so the grouping and the column never diverge.
const MODE_LABEL = ACTION_MODE_META;

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
    const order: ActionMode[] = ["do", "delegate", "schedule", "drop"];
    const buckets = new Map<ActionMode, GtdItem[]>();
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

  if (by === "depth") {
    // Deep (flow-state) work vs everything else — so a planning pass can see
    // at a glance which tasks need protected unbroken blocks.
    const deep = items.filter((i) => i.deepWork);
    const shallow = items.filter((i) => !i.deepWork);
    return [
      ...(deep.length
        ? [{ key: "deep", label: "Deep work", emoji: "\u{1F30A}", items: deep }]
        : []),
      ...(shallow.length
        ? [{ key: "shallow", label: "Shallow", items: shallow }]
        : []),
    ];
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
