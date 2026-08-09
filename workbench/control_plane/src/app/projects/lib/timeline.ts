/**
 * Projects · the timeline, as arithmetic (WS-27t).
 *
 * A Gantt chart is bar geometry plus two rules that are not geometry at all,
 * and both were decisions rather than defaults:
 *
 * * **D-PM-11 — what earns a bar.** Hierarchy depth: top-level tasks get rows,
 *   subtasks fold into their parent and expand on demand. Paca's Timeline
 *   pre-filters to a reserved `Epic` type instead; that was rejected because
 *   `pm_task_types` is per-project data with no reserved names (D-PM-2), so
 *   "Epic" would have to become either a seeded row every project inherits or
 *   a name-match that silently stops working the day somebody renames a type.
 *   `parent_task_id` already says what depth means and cannot be renamed.
 *
 * * **D-PM-12 — an arrow WARNS, it does not push.** A `blocks` edge whose
 *   blocker finishes after the blocked task starts is drawn in the danger tone
 *   and says so. Nothing is rescheduled. Jira drags the dependents forward;
 *   that was rejected because it contradicts WS-27p's "derived and shown, never
 *   enforced" and turns one drag into an unbounded cascade of real `PATCH`es,
 *   each with its own activity row and notification.
 *
 * Dates are `YYYY-MM-DD` keys throughout, for the reason `lib/calendar.ts`
 * gives at length: `new Date("2026-08-07")` is midnight UTC, which is the 6th
 * anywhere west of Greenwich.
 */

import { dayKey, fromDayKey, shiftDay } from "./calendar";

import type { TaskRow } from "./api";

/** Chart pixels per calendar day. */
export const PX_PER_DAY = 24;
/** Height of one task row, in pixels. Rows are uniform so `y` is index × this. */
export const ROW_H = 34;
/** Days of breathing room either side of the data's own range. */
export const PAD_DAYS = 7;
/** Narrowest a bar may be drawn — a one-day task must still be clickable. */
export const MIN_BAR_PX = 10;

const DAY_MS = 86_400_000;

export interface TimelineRange {
  from: string;
  to: string;
  days: number;
  widthPx: number;
}

export interface Bar {
  leftPx: number;
  widthPx: number;
  /** Only one date is known, so the bar is a marker rather than a span. */
  singleDate: boolean;
  /** The interval came from this task's CHILDREN, not from its own dates. */
  derived: boolean;
}

export interface TimelineRow {
  task: TaskRow;
  depth: number;
  /** Subtasks of this row present in the window — drawn when expanded. */
  children: TaskRow[];
}

export interface Edge {
  id: string;
  blocker_id: string;
  blocked_id: string;
}

/** A task's own scheduled interval, or `null` when it has no dates. */
export function interval(task: TaskRow): { from: string; to: string } | null {
  const start = task.start_date ? task.start_date.slice(0, 10) : null;
  const due = task.due_at ? dayKey(new Date(task.due_at)) : null;
  if (!start && !due) return null;
  const a = start ?? (due as string);
  const b = due ?? (start as string);
  // Bad data — due before start — is shown as the span it implies rather than
  // dropped: the timeline is the one view that would have made it obvious.
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/**
 * The interval a ROW occupies, folding in its children.
 *
 * A parent with no dates of its own still gets a bar when its subtasks have
 * them — that is the point of grouping by depth, and a parent drawn as a blank
 * row while its children carry the schedule would make the default view look
 * empty. `derived` marks it so the UI can say the dates were not typed here.
 */
export function rowInterval(
  task: TaskRow,
  children: readonly TaskRow[],
): { from: string; to: string; derived: boolean } | null {
  const own = interval(task);
  if (own) return { ...own, derived: false };
  const spans = children.map(interval).filter(Boolean) as { from: string; to: string }[];
  if (spans.length === 0) return null;
  return {
    from: spans.reduce((lo, s) => (s.from < lo ? s.from : lo), spans[0].from),
    to: spans.reduce((hi, s) => (s.to > hi ? s.to : hi), spans[0].to),
    derived: true,
  };
}

/**
 * Group the window's tasks into rows by hierarchy depth (D-PM-11).
 *
 * **A subtask whose parent is not in the window is promoted to a row of its
 * own**, rather than hidden under a parent that is not there. Hiding it would
 * make a filtered timeline silently drop work — the same failure the `undated`
 * count exists to prevent, one level down.
 */
export function timelineRows(tasks: readonly TaskRow[]): TimelineRow[] {
  const present = new Set(tasks.map((t) => t.id));
  const childrenOf = new Map<string, TaskRow[]>();
  const roots: TaskRow[] = [];

  for (const task of tasks) {
    const parent = task.parent_task_id;
    if (parent && present.has(parent)) {
      const kids = childrenOf.get(parent) ?? [];
      kids.push(task);
      childrenOf.set(parent, kids);
    } else {
      roots.push(task);
    }
  }

  return roots.map((task) => ({
    task,
    depth: 0,
    children: childrenOf.get(task.id) ?? [],
  }));
}

/**
 * The date range the chart covers: the data's own span, padded.
 *
 * Fitted to the data rather than to a fixed month, because a timeline's
 * question is "what runs alongside what" and a window that clips the answer is
 * the wrong window. Falls back to a fortnight around today when nothing in the
 * set has a date at all, so an empty chart still has an axis to read.
 */
export function timelineRange(
  rows: readonly TimelineRow[],
  todayKey: string,
): TimelineRange {
  const spans = rows
    .map((r) => rowInterval(r.task, r.children))
    .filter(Boolean) as { from: string; to: string }[];

  const from = spans.length
    ? shiftDay(spans.reduce((lo, s) => (s.from < lo ? s.from : lo), spans[0].from), -PAD_DAYS)
    : shiftDay(todayKey, -14);
  const to = spans.length
    ? shiftDay(spans.reduce((hi, s) => (s.to > hi ? s.to : hi), spans[0].to), PAD_DAYS)
    : shiftDay(todayKey, 14);

  const days =
    Math.round((fromDayKey(to).getTime() - fromDayKey(from).getTime()) / DAY_MS) + 1;
  return { from, to, days, widthPx: days * PX_PER_DAY };
}

/** Pixels from the chart's left edge to the START of a day. */
export function dayPx(day: string, range: TimelineRange): number {
  const offset =
    (fromDayKey(day).getTime() - fromDayKey(range.from).getTime()) / DAY_MS;
  return Math.round(offset) * PX_PER_DAY;
}

/**
 * Where a row's bar sits, or `null` when it has no dates anywhere.
 *
 * A bar covers its last day rather than stopping at that day's left edge — a
 * task starting and ending on Tuesday must cover Tuesday, not be a zero-width
 * line at its start.
 */
export function bar(
  task: TaskRow,
  children: readonly TaskRow[],
  range: TimelineRange,
): Bar | null {
  const span = rowInterval(task, children);
  if (!span) return null;
  const leftPx = dayPx(span.from, range);
  const rightPx = dayPx(span.to, range) + PX_PER_DAY;
  return {
    leftPx,
    widthPx: Math.max(MIN_BAR_PX, rightPx - leftPx),
    singleDate: span.from === span.to,
    derived: span.derived,
  };
}

export interface MonthCell {
  key: string;
  label: string;
  px: number;
  widthPx: number;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Month header cells across the range, clipped to it at both ends. */
export function monthCells(range: TimelineRange): MonthCell[] {
  const out: MonthCell[] = [];
  let cursor = range.from;
  while (cursor <= range.to) {
    const [year, month] = cursor.split("-").map(Number);
    const firstOfNext = dayKey(new Date(year, month, 1));
    const end = firstOfNext <= range.to ? shiftDay(firstOfNext, -1) : range.to;
    const px = dayPx(cursor, range);
    out.push({
      key: cursor.slice(0, 7),
      label: `${MONTHS[month - 1]} ${year}`,
      px,
      widthPx: dayPx(end, range) + PX_PER_DAY - px,
    });
    cursor = firstOfNext;
  }
  return out;
}

/**
 * Does this dependency disagree with the schedule? (D-PM-12)
 *
 * A `blocks` edge asserts the blocker finishes before the blocked task starts.
 * It is violated when the blocker's END is strictly after the blocked task's
 * START — the two overlap, so the sequence the arrow claims cannot happen.
 *
 * **Equal dates are NOT a conflict.** A blocker due on the 10th and a task
 * starting on the 10th is the normal way people schedule a handover; flagging
 * it would make the warning fire on half a healthy plan and be ignored within a
 * week.
 *
 * **An edge with a date missing on either end is not a conflict either** — it
 * is unknowable, and a warning that fires on absent data teaches people that
 * the warning means nothing.
 *
 * **A finished blocker never conflicts.** It has already happened; the dates
 * are history, and WS-27p's rule that a resolved blocker blocks nothing applies
 * to the warning exactly as it applies to the badge.
 */
export function conflicts(
  blocker: Pick<TaskRow, "start_date" | "due_at" | "completed_at">,
  blocked: Pick<TaskRow, "start_date" | "due_at">,
): boolean {
  if (blocker.completed_at) return false;
  const before = interval(blocker as TaskRow);
  const after = interval(blocked as TaskRow);
  if (!before || !after) return false;
  return before.to > after.from;
}

/** A one-sentence explanation of a conflict, for the warning's title. */
export function conflictLabel(blockerTitle: string): string {
  return `Starts before "${blockerTitle}" is due to finish. Nothing has been ` +
    `rescheduled — the dates are yours to fix.`;
}

/**
 * The elbow path from one bar's right edge to another's left edge.
 *
 * Elbowed rather than straight, and routed OUT of the source before turning,
 * because a straight diagonal across six rows crosses every bar between them
 * and stops being followable at exactly the density where you need it.
 *
 * Returns `null` when either end has no bar: an arrow to a task with no dates
 * has nowhere to land, and drawing it to the row's left margin would invent a
 * date the task does not have.
 */
export function edgePath(
  from: { bar: Bar | null; row: number },
  to: { bar: Bar | null; row: number },
): string | null {
  if (!from.bar || !to.bar) return null;
  const y1 = from.row * ROW_H + ROW_H / 2;
  const y2 = to.row * ROW_H + ROW_H / 2;
  const x1 = from.bar.leftPx + from.bar.widthPx;
  const x2 = to.bar.leftPx;
  const stub = 10;

  // Room to route forwards: out, across, in.
  if (x2 >= x1 + stub * 2) {
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`;
  }
  // The blocked bar starts at or before the blocker ends — the conflict case,
  // and the one a naive path draws backwards through both bars. Route around
  // below/above instead so the arrow stays readable while it is wrong.
  const lane = (Math.max(y1, y2) + ROW_H / 2 + Math.min(y1, y2)) / 2;
  return (
    `M ${x1} ${y1} H ${x1 + stub} V ${lane} H ${x2 - stub} V ${y2} H ${x2}`
  );
}

/**
 * May this drag create a link?
 *
 * Only the cheap, local refusals — a task cannot block itself, and an edge that
 * already exists is a no-op rather than a duplicate. **The cycle check is NOT
 * duplicated here**: `assert_no_block_cycle` owns it, bounded and tested, and a
 * second implementation in the browser would be the one that drifts. The drop
 * posts and reports the gateway's own refusal message.
 */
export function canLink(
  blockerId: string,
  blockedId: string,
  existing: readonly Edge[],
): { ok: true } | { ok: false; reason: string } {
  if (blockerId === blockedId) {
    return { ok: false, reason: "A task cannot block itself." };
  }
  if (existing.some((e) => e.blocker_id === blockerId && e.blocked_id === blockedId)) {
    return { ok: false, reason: "That dependency is already there." };
  }
  return { ok: true };
}
