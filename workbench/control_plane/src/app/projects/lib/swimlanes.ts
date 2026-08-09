/**
 * Projects · swimlanes — the board's second axis (WS-27y).
 *
 * A board grouped by status and sub-grouped by assignee is a grid: columns are
 * the first axis, lanes are the second, and a cell is the intersection. All of
 * that intersection arithmetic lives here as pure functions, because the bugs
 * a swimlane board invites are silent ones — a task in the wrong cell, a lane
 * whose count disagrees with its cards, a multi-assignee task that vanishes
 * from one of its people's lanes.
 *
 * Lane identity and ordering are `groupTasks`'s, deliberately: a lane is just
 * a group drawn sideways, and re-deriving membership here would be a second
 * implementation of the rules `grouping.ts` already tests (two assignees →
 * both lanes, importance 0 is Low not unset, empty status lanes kept).
 */

import type { StatusRow, TaskRow } from "./api";
import { type GroupBy, type TaskGroup, groupTasks } from "./grouping";

export interface Swimlane {
  /** Stable lane identity — same vocabulary as a group key. */
  key: string;
  label: string;
  /** Distinct tasks in the lane, across every column. */
  total: number;
  /** Cells aligned index-for-index with the caller's columns. */
  cells: TaskRow[][];
}

/**
 * Columns × sub-axis → lanes.
 *
 * Lane order comes from grouping the DISTINCT union of every column's tasks —
 * so a status sub-axis keeps its configured lane order (and its empty lanes),
 * and an assignee sub-axis sorts people alphabetically with Unassigned last,
 * exactly as the flat board would have drawn them as columns.
 *
 * Each cell preserves its column's task order, so per-view positions survive
 * the split into lanes.
 */
export function buildSwimlanes(
  columns: readonly TaskGroup[],
  subBy: GroupBy,
  ctx: { statuses: StatusRow[]; projectName?: (id: string) => string }
): Swimlane[] {
  // Distinct union: a task drawn in two columns (two assignees, two tags) must
  // count once per lane, not once per column it appears in.
  const seen = new Set<string>();
  const union: TaskRow[] = [];
  for (const column of columns) {
    for (const task of column.tasks) {
      if (!seen.has(task.id)) {
        seen.add(task.id);
        union.push(task);
      }
    }
  }

  const order = groupTasks(union, subBy, ctx);
  const perColumn = columns.map(
    (column) =>
      new Map(groupTasks(column.tasks, subBy, ctx).map((g) => [g.key, g.tasks]))
  );

  return order.map((lane) => ({
    key: lane.key,
    label: lane.label,
    total: lane.tasks.length,
    cells: perColumn.map((cells) => cells.get(lane.key) ?? []),
  }));
}

/**
 * The lanes to draw. Empty lanes are hidden unless asked for — a board where
 * most people have nothing in most statuses is otherwise mostly whitespace.
 */
export function visibleLanes(
  lanes: readonly Swimlane[],
  showEmpty: boolean
): Swimlane[] {
  return showEmpty ? [...lanes] : lanes.filter((lane) => lane.total > 0);
}

/** How many lanes `visibleLanes` is hiding, for the toggle's honesty. */
export function hiddenLaneCount(lanes: readonly Swimlane[]): number {
  return lanes.filter((lane) => lane.total === 0).length;
}

/** Fold a lane shut, or open it back up. Pure, so the list can live in a view. */
export function toggleLane(
  collapsed: readonly string[],
  key: string
): string[] {
  return collapsed.includes(key)
    ? collapsed.filter((k) => k !== key)
    : [...collapsed, key];
}
