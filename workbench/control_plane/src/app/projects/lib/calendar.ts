/**
 * Projects · the calendar grid, as arithmetic (WS-27q).
 *
 * Every decision a month view makes that can be wrong without looking wrong —
 * which days a grid covers, which cells a task occupies, what dragging it to a
 * day should write — lives here as a pure function, because a calendar bug is
 * almost never a crash. It is a task on the wrong Tuesday, and the only way to
 * catch that is to assert on the arithmetic rather than to look at it.
 *
 * **Dates are handled as `YYYY-MM-DD` keys, not as `Date` objects, wherever a
 * DAY is meant.** `new Date("2026-08-07")` is midnight UTC, which is the 6th in
 * any western timezone — the single most common way a calendar loses a day. A
 * `Date` is used only for the arithmetic of walking a month, always through
 * local-time constructors and accessors, never through `toISOString()`.
 */

import type { TaskRow } from "./api";

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for a Date, read in LOCAL time. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A `YYYY-MM-DD` key back to a local-midnight Date. */
export function fromDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** `n` days after a key, as a key. Month and year roll over. */
export function shiftDay(key: string, days: number): string {
  const date = fromDayKey(key);
  date.setDate(date.getDate() + days);
  return dayKey(date);
}

export interface MonthGrid {
  /** The month the grid is *about*, as `YYYY-MM`. */
  month: string;
  /** Every day drawn, in order — always whole weeks. */
  days: string[];
  /** Rows of seven. */
  weeks: string[][];
}

/**
 * The days a month view draws, padded to whole weeks from Monday.
 *
 * **Monday, not Sunday.** The workspace this is for runs a Monday week, and a
 * grid whose weekend is split across two rows makes "what is left this week" a
 * question you have to count rather than see.
 *
 * The grid is padded to *whole weeks only* — not to a fixed six rows. A fixed
 * six always shows days from two neighbouring months and, in a 28-day February
 * starting on a Monday, an entire extra week of March. Padding to the week
 * boundary is the smallest grid that is still rectangular.
 */
export function monthGrid(anchor: Date): MonthGrid {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);

  // getDay() is 0=Sunday; a Monday week wants Monday=0, so Sunday becomes 6.
  const leading = (first.getDay() + 6) % 7;
  const trailing = 6 - ((last.getDay() + 6) % 7);

  const start = new Date(year, month, 1 - leading);
  const total = leading + last.getDate() + trailing;

  const days: string[] = [];
  for (let i = 0; i < total; i += 1) {
    days.push(dayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
  }

  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  return {
    month: `${year}-${String(month + 1).padStart(2, "0")}`,
    days,
    weeks,
  };
}

/**
 * The window to ask the server for, with a day of slack on each side.
 *
 * **The slack is not defensive padding, it is the contract.** The server reads
 * the window in UTC because a `start_date` is a floating date and a `due_at` is
 * an instant, and no single frame makes both exact. So it OVER-selects and the
 * browser — the only party that knows the viewer's timezone — does the
 * placement. Without the extra day, a viewer in UTC+5:30 loses every task due
 * in the first 5½ hours of the grid's first day.
 *
 * `to` is EXCLUSIVE, matching the endpoint's half-open window, so two
 * consecutive months tile instead of both claiming the tasks on the boundary.
 */
export function calendarWindow(grid: MonthGrid): { from: string; to: string } {
  const first = grid.days[0];
  const last = grid.days[grid.days.length - 1];
  return { from: shiftDay(first, -1), to: shiftDay(last, 2) };
}

/**
 * The day keys a task occupies, clamped to the grid.
 *
 * A task with both dates is a BAR and belongs on every day it covers — the
 * whole reason the endpoint filters on overlap. A task with one date is a
 * single day. A task with neither is nowhere, and returns an empty list rather
 * than being placed on today, which would be a task appearing on a day nobody
 * scheduled it for.
 *
 * Clamping matters as much as the span: a task running June to December must
 * occupy all of August's cells and none outside them, and an unclamped range
 * would try to render 180 cells that do not exist.
 */
export function taskDays(task: TaskRow, grid: MonthGrid): string[] {
  const startKey = task.start_date ? task.start_date.slice(0, 10) : null;
  // `due_at` is an instant, so it is read in the VIEWER's timezone — that is
  // the day they would say it is due. `start_date` is a floating date and is
  // taken as written; converting it through a Date would move it.
  const dueKey = task.due_at ? dayKey(new Date(task.due_at)) : null;
  if (!startKey && !dueKey) return [];

  const from = startKey ?? (dueKey as string);
  const to = dueKey ?? (startKey as string);
  // A due date before the start date is bad data, not a reason to render
  // nothing: show it on both endpoints rather than swallowing the task.
  const lo = from <= to ? from : to;
  const hi = from <= to ? to : from;

  const gridFrom = grid.days[0];
  const gridTo = grid.days[grid.days.length - 1];
  const first = lo > gridFrom ? lo : gridFrom;
  const lastDay = hi < gridTo ? hi : gridTo;
  if (first > lastDay) return [];

  const out: string[] = [];
  const span = Math.round(
    (fromDayKey(lastDay).getTime() - fromDayKey(first).getTime()) / DAY_MS,
  );
  for (let i = 0; i <= span; i += 1) out.push(shiftDay(first, i));
  return out;
}

/** Tasks bucketed by day key. Every grid day gets an entry, empty or not. */
export function placeTasks(
  tasks: readonly TaskRow[],
  grid: MonthGrid,
): Map<string, TaskRow[]> {
  const byDay = new Map<string, TaskRow[]>(grid.days.map((d) => [d, []]));
  for (const task of tasks) {
    for (const day of taskDays(task, grid)) byDay.get(day)?.push(task);
  }
  return byDay;
}

/**
 * The PATCH that moves a task to a day, or `null` if it is already there.
 *
 * **Dragging a bar moves the whole bar.** A task starting Monday and due Friday
 * dropped on Wednesday runs Wednesday to Sunday — the span is the estimate
 * somebody made, and a drag that silently shortens it to a single day destroys
 * information the user did not offer to change. This is the rule every
 * calendar-drag implementation gets wrong first, by writing only the date the
 * card was dropped on and leaving the other end where it was, which inverts
 * the interval as soon as you drag left.
 *
 * The `due_at` TIME OF DAY is preserved for the same reason: "due Friday at 5"
 * dragged to Monday is due Monday at 5, not Monday at midnight.
 *
 * Returns `null` for a no-op so a drop that did not move anything writes
 * nothing — an activity row saying a task moved from Tuesday to Tuesday is
 * noise in the one place people go to find out what changed.
 */
export function rescheduleTo(
  task: TaskRow,
  day: string,
): { start_date?: string | null; due_at?: string | null } | null {
  const startKey = task.start_date ? task.start_date.slice(0, 10) : null;
  const dueDate = task.due_at ? new Date(task.due_at) : null;
  const dueKey = dueDate ? dayKey(dueDate) : null;
  if (!startKey && !dueKey) return null;

  const anchor = startKey ?? (dueKey as string);
  if (anchor === day) return null;

  const offset = Math.round(
    (fromDayKey(day).getTime() - fromDayKey(anchor).getTime()) / DAY_MS,
  );
  const patch: { start_date?: string | null; due_at?: string | null } = {};
  // The anchor IS the start when there is one, so the new start is simply the
  // day it was dropped on. Written as `shiftDay(startKey, offset)` first, which
  // is the same value by construction and reads as if it could differ.
  if (startKey) patch.start_date = day;
  if (dueKey && dueDate) {
    const moved = fromDayKey(shiftDay(dueKey, offset));
    moved.setHours(
      dueDate.getHours(), dueDate.getMinutes(),
      dueDate.getSeconds(), dueDate.getMilliseconds(),
    );
    patch.due_at = moved.toISOString();
  }
  return patch;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "August 2026", for the grid's heading. */
export function monthLabel(grid: MonthGrid): string {
  const [year, month] = grid.month.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${year}`;
}

/** True when a grid day belongs to a neighbouring month. */
export function isOutsideMonth(day: string, grid: MonthGrid): boolean {
  return day.slice(0, 7) !== grid.month;
}

/** The month `n` months from the grid's own, as an anchor Date. */
export function shiftMonth(grid: MonthGrid, months: number): Date {
  const [year, month] = grid.month.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1 + months, 1);
}
