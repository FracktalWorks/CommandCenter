// Shared calendar primitives — constants, geometry helpers, formatters and the
// plan-request builder used across the calendar surface (CalendarView + its
// subcomponents in this directory, and FocusMode). Extracted from the former
// CalendarView monolith so each piece has one home and the day/week/month grid,
// the rail, the planner panels and Focus Mode all agree on the same math.

import { useEffect, useState } from "react";
import type { EnergyWindow } from "../../lib/api";
import { startOfDay, addDays, sameDay, type Block } from "../../lib/scheduling";
import type { GtdItem } from "../../lib/types";

// ── layout constants ─────────────────────────────────────────────────────────
export const DAY_START_HOUR = 7; // default grid window (overridden by prefs)
export const DAY_END_HOUR = 22;
export const HOUR_PX = 46; // vertical pixels per hour on the time grid
export const SOFT_CAPACITY_MINS = 6 * 60; // default "booked > 6h" flag
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ── drag-and-drop / resize ───────────────────────────────────────────────────
export const SNAP_MINS = 15; // blocks snap to a quarter-hour
export const DRAG_TYPE = "application/x-cc-cal";
export type DragPayload = {
  id: string;
  durationMins: number;
  grabOffsetMins: number;
};
export const snap = (mins: number) =>
  Math.round(mins / SNAP_MINS) * SNAP_MINS;

export type Mode = "day" | "week" | "month";
/** Truncated project-outcome lookup for the outcome ribbon on blocks. */
export type OutcomeById = Map<string, string>;

// ── date helpers (plain Date math; no date lib in the bundle) ────────────────
export const addMonths = (d: Date, n: number) => {
  const x = startOfDay(d);
  x.setMonth(x.getMonth() + n, 1);
  return x;
};
/** Monday-start week. */
export const startOfWeek = (d: Date) => {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(x, -dow);
};
export const startOfMonthGrid = (d: Date) =>
  startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1));
export const minutesInto = (d: Date) => d.getHours() * 60 + d.getMinutes();

// ── formatters ───────────────────────────────────────────────────────────────
/** "2:05 PM" — the calendar's one clock format. */
export const fmtClock = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "23m" / "1h 5m" — compact human duration for countdowns. */
export function fmtLeft(mins: number): string {
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ── grid helpers ─────────────────────────────────────────────────────────────
/** Deadline items (hard date, not timeboxed) due on `day` — the all-day lane. */
export function deadlinesForDay(items: GtdItem[], day: Date): GtdItem[] {
  return items.filter(
    (i) =>
      i.isHardDate &&
      i.dueAt &&
      !i.scheduledStart &&
      i.disposition !== "DONE" &&
      sameDay(new Date(i.dueAt), day),
  );
}

/** Assign overlapping blocks to side-by-side lanes (Google-Calendar style) so a
 *  double-booking is visible, not hidden. Returns each block with its lane index
 *  and the number of lanes in its overlap group (>1 ⇒ a conflict). */
export function layoutBlocks(
  blocks: Block[],
): { block: Block; lane: number; lanes: number }[] {
  const sorted = [...blocks].sort(
    (a, b) =>
      a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime(),
  );
  const out: { block: Block; lane: number; lanes: number }[] = [];
  let i = 0;
  while (i < sorted.length) {
    // Maximal group of transitively-overlapping blocks.
    let groupEnd = sorted[i].end.getTime();
    let j = i + 1;
    while (j < sorted.length && sorted[j].start.getTime() < groupEnd) {
      groupEnd = Math.max(groupEnd, sorted[j].end.getTime());
      j++;
    }
    const group = sorted.slice(i, j);
    const laneEnds: number[] = [];
    const laneOf = new Map<Block, number>();
    for (const b of group) {
      let lane = laneEnds.findIndex((end) => end <= b.start.getTime());
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(b.end.getTime());
      } else {
        laneEnds[lane] = b.end.getTime();
      }
      laneOf.set(b, lane);
    }
    const lanes = laneEnds.length;
    for (const b of group)
      out.push({ block: b, lane: laneOf.get(b) ?? 0, lanes });
    i = j;
  }
  return out;
}

/** A live clock that ticks so the calendar reflects the passage of time — the
 *  now-line, the current-block highlight, and the Now/Next countdowns all read
 *  from this instead of calling Date.now() in render (which the purity lint
 *  forbids, and which wouldn't re-render on its own anyway). */
export function useNow(intervalMs = 30000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ── planner request ──────────────────────────────────────────────────────────
/** Map the user's energy windows to absolute ISO intervals on `day` — the exact
 *  payload the planner/rollover endpoints expect. One home for what used to be
 *  copy-pasted into rollOver() and the Plan-day panel. */
export function energyWindowsPayload(
  windows: EnergyWindow[],
  day: Date,
): { start: string; end: string; energy: string }[] {
  return windows.map((w) => {
    const ws = new Date(day);
    ws.setHours(w.start_hour, 0, 0, 0);
    const we = new Date(day);
    we.setHours(w.end_hour, 0, 0, 0);
    return { start: ws.toISOString(), end: we.toISOString(), energy: w.energy };
  });
}
