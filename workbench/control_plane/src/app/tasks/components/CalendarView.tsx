"use client";

// Calendar & timeboxing view (scaffold — spec: ai-company-brain/specs/
// calendar_timeboxing.md). Day / Week = an hour time-grid with tasks placed as
// blocks by scheduled_start/scheduled_end; Month = a day-cell grid with chips.
// An "unscheduled" rail of next actions lets you timebox by clicking a task
// into the focused day (drag-drop + resize are P1). Deadlines (is_hard_date)
// show as all-day markers so a due date is never invisible.
//
// P0 renders from the already-hydrated store `items`; the dedicated
// apiCalendarRange(from,to) endpoint is wired for P1 precise range loading.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  Zap,
  X,
  Sparkles,
  CalendarPlus,
  Settings2,
  Plus,
  Trash2,
  Loader2,
  Check,
  AlertTriangle,
  Wand2,
  RotateCcw,
  CalendarClock,
  Lock,
  Unlock,
  Play,
  ClipboardCheck,
} from "lucide-react";
import {
  apiPlanDay,
  apiRollover,
  apiReplan,
  apiEstimateStats,
  type TaskSettings,
  type EnergyWindow,
  type DayPlanResult,
  type EstimateStats,
} from "../lib/api";
import { useTaskStore } from "../lib/taskStore";
import { GtdItem } from "../lib/types";
import { durationLabel } from "../lib/utils";

type Mode = "day" | "week" | "month";

const DAY_START_HOUR = 7; // grid window; energy-window config is P1
const DAY_END_HOUR = 22;
const HOUR_PX = 46;
const DEFAULT_BLOCK_MINS = 30;
const SOFT_CAPACITY_MINS = 6 * 60; // "you've booked >6h of focus" flag (P1 setting)

// ── date helpers (plain Date math; no date lib in the bundle) ────────────────
const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
};
const addMonths = (d: Date, n: number) => {
  const x = startOfDay(d);
  x.setMonth(x.getMonth() + n, 1);
  return x;
};
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();
/** Monday-start week. */
const startOfWeek = (d: Date) => {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(x, -dow);
};
const startOfMonthGrid = (d: Date) => startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1));
const minutesInto = (d: Date) => d.getHours() * 60 + d.getMinutes();
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ── drag-and-drop / resize ───────────────────────────────────────────────────
const SNAP_MINS = 15; // blocks snap to a quarter-hour
const DRAG_TYPE = "application/x-cc-cal";
type DragPayload = { id: string; durationMins: number; grabOffsetMins: number };
const snap = (mins: number) => Math.round(mins / SNAP_MINS) * SNAP_MINS;

type Block = { item: GtdItem; start: Date; end: Date };

/** Timeboxed blocks that fall on `day`. */
function blocksForDay(items: GtdItem[], day: Date): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    if (!item.scheduledStart) continue;
    const start = new Date(item.scheduledStart);
    if (!sameDay(start, day)) continue;
    const end = item.scheduledEnd
      ? new Date(item.scheduledEnd)
      : new Date(start.getTime() + (item.timeEstimateMins ?? DEFAULT_BLOCK_MINS) * 60000);
    out.push({ item, start, end });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Deadline items (hard date, not timeboxed) due on `day` — the all-day lane. */
function deadlinesForDay(items: GtdItem[], day: Date): GtdItem[] {
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
function layoutBlocks(
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
    for (const b of group) out.push({ block: b, lane: laneOf.get(b) ?? 0, lanes });
    i = j;
  }
  return out;
}

/** First 30-min-aligned free slot on `day` at/after the window start (or now, if
 *  today), that fits `mins` without overlapping an existing block. */
function firstFreeSlot(
  dayBlocks: Block[],
  day: Date,
  mins: number,
  startHour: number,
  endHour: number,
): Date {
  const now = new Date();
  const earliest = new Date(day);
  earliest.setHours(startHour, 0, 0, 0);
  if (sameDay(day, now) && now > earliest) {
    // round up to the next 30
    const m = now.getMinutes();
    earliest.setHours(now.getHours(), m <= 30 ? 30 : 60, 0, 0);
  }
  const dayEnd = new Date(day);
  dayEnd.setHours(endHour, 0, 0, 0);
  let cursor = earliest;
  const sorted = [...dayBlocks].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const b of sorted) {
    if (b.end <= cursor) continue;
    if (cursor.getTime() + mins * 60000 <= b.start.getTime()) break; // fits before b
    if (b.end > cursor) cursor = new Date(b.end);
  }
  if (cursor.getTime() + mins * 60000 > dayEnd.getTime()) return earliest; // overflow → stack at top
  return cursor;
}

/** A live clock that ticks so the calendar reflects the passage of time — the
 *  now-line, the current-block highlight, and the Now/Next countdowns all read
 *  from this instead of calling Date.now() in render (which the purity lint
 *  forbids, and which wouldn't re-render on its own anyway). */
function useNow(intervalMs = 30000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "23m" / "1h 5m" — compact human duration for countdowns. */
function fmtLeft(mins: number): string {
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function CalendarView() {
  const items = useTaskStore((s) => s.items);
  const updateItem = useTaskStore((s) => s.updateItem);
  const openFocus = useTaskStore((s) => s.openFocus);
  const quickDispose = useTaskStore((s) => s.quickDispose);
  const loadDone = useTaskStore((s) => s.loadDone);
  const settings = useTaskStore((s) => s.settings);
  // The plannable day window + capacity come from the user's calendar prefs so
  // the grid and the AI planner agree; sane defaults when unset.
  const dayStart = settings.dayStartHour ?? DAY_START_HOUR;
  const dayEnd = Math.max(dayStart + 1, settings.dayEndHour ?? DAY_END_HOUR);
  const capacityTarget = settings.dailyCapacityMins ?? SOFT_CAPACITY_MINS;
  const energyWindows = settings.energyWindows ?? [];
  const updateSettings = useTaskStore((s) => s.updateSettings);
  const [mode, setMode] = useState<Mode>("day");
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The AI planner panel: "plan" fills free slots from unscheduled next actions;
  // "replan" reorganizes the rest of today's flexible blocks from now. null = shut.
  const [planMode, setPlanMode] = useState<null | "plan" | "replan">(null);
  const [rolling, setRolling] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Mobile / tap-to-schedule sheet. `at` set ⇒ a tapped slot (schedule at that
  // exact time); absent ⇒ opened from the FAB (auto-place into the first free
  // slot of `day`). The rail is desktop-only, so this is the phone path.
  const [sheet, setSheet] = useState<{ day: Date; at?: Date } | null>(null);
  // One live clock drives the now-line, the current-block ring and the Now/Next
  // countdowns so the whole surface ages in real time (30s tick).
  const now = useNow();

  // Persist the user's real IANA timezone so the server-side nightly roll-over
  // computes their local-day boundary correctly (defaults to UTC otherwise).
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz !== settings.timezone) void updateSettings({ timezone: tz });
  }, [settings.timezone, updateSettings]);

  // Pull DONE tasks into the store so COMPLETED time-blocks stay on the grid
  // (they're excluded from the normal hydrate). Keeps the sense of progress.
  useEffect(() => {
    void loadDone();
  }, [loadDone]);

  // Deadline radar: unscheduled next actions with a due date approaching (≤14d)
  // — the ones most likely to slip because they were never timeboxed.
  const dueSoon = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
    const nowMs = Date.now();
    const horizon = nowMs + 14 * 86400000;
    return items
      .filter(
        (i) =>
          i.isMine &&
          i.disposition === "NEXT" &&
          !i.scheduledStart &&
          !i.archivedAt &&
          i.dueAt &&
          new Date(i.dueAt).getTime() <= horizon,
      )
      .map((i) => ({
        item: i,
        days: Math.ceil((new Date(i.dueAt as string).getTime() - nowMs) / 86400000),
      }))
      .sort((a, b) => a.days - b.days);
  }, [items]);

  // Unscheduled, schedulable next actions (mine, NEXT, no block yet).
  const unscheduled = useMemo(
    () =>
      items.filter(
        (i) =>
          i.disposition === "NEXT" &&
          i.isMine &&
          !i.scheduledStart &&
          !i.archivedAt,
      ),
    [items],
  );

  // Completed blocks on the focused day — the "done today" tally (progress).
  const doneStats = useMemo(() => {
    const done = blocksForDay(items, anchor).filter(
      (b) => b.item.disposition === "DONE",
    );
    return {
      count: done.length,
      mins: done.reduce(
        (n, b) => n + (b.end.getTime() - b.start.getTime()) / 60000,
        0,
      ),
    };
  }, [items, anchor]);

  const schedule = (item: GtdItem, day: Date, at?: Date) => {
    const mins = item.timeEstimateMins ?? DEFAULT_BLOCK_MINS;
    const start =
      at ?? firstFreeSlot(blocksForDay(items, day), day, mins, dayStart, dayEnd);
    const end = new Date(start.getTime() + mins * 60000);
    updateItem(item.id, {
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
    });
  };
  const unschedule = (item: GtdItem) =>
    updateItem(item.id, { scheduledStart: "", scheduledEnd: "" });
  // Move/resize a block to an exact start+end (drag-drop + resize commit here).
  const reschedule = (id: string, start: Date, end: Date) =>
    updateItem(id, {
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
    });

  // Focus timer: stamp when you actually START a block (clears any prior end so
  // it re-times cleanly). Actual work-time = actualEnd − actualStart.
  const startFocus = (item: GtdItem) =>
    updateItem(item.id, { actualStart: new Date().toISOString(), actualEnd: "" });

  // Complete/uncomplete a block. Finishing a STARTED (timed) session stamps
  // actualEnd = now so planned-vs-actual is captured; reopening clears it.
  const completeBlock = (item: GtdItem) => {
    const toDone = item.disposition !== "DONE";
    if (toDone) {
      if (item.actualStart && !item.actualEnd)
        updateItem(item.id, { actualEnd: new Date().toISOString() });
    } else if (item.actualEnd) {
      updateItem(item.id, { actualEnd: "" });
    }
    quickDispose(item.id, toDone ? "DONE" : "NEXT");
  };

  // Overdue = a past time-block whose task isn't done → offer a one-click
  // roll-over into today's open slots (the "fell behind → stale plan" failure).
  const overdueCount = useMemo(() => {
    // Real wall-clock is intentional here (the calendar is a live surface,
    // unlike the demo cards that use a frozen MOCK_NOW).
    // eslint-disable-next-line react-hooks/purity
    const nowMs = Date.now();
    return items.filter(
      (i) =>
        i.scheduledStart &&
        i.scheduledEnd &&
        i.disposition !== "DONE" &&
        new Date(i.scheduledEnd).getTime() < nowMs,
    ).length;
  }, [items]);

  // Is there anything left to reorganize today? "Replan the rest of my day" only
  // makes sense with ≥1 flexible, not-done block still ahead (end ≥ now) — a
  // fixed meeting or a finished block isn't movable, so it wouldn't offer this.
  const canReplan = useMemo(() => {
    const nowMs = now.getTime();
    return items.some(
      (i) =>
        i.scheduledStart &&
        i.scheduledEnd &&
        i.disposition !== "DONE" &&
        (i.flexible ?? true) &&
        sameDay(new Date(i.scheduledStart), now) &&
        new Date(i.scheduledEnd).getTime() >= nowMs,
    );
  }, [items, now]);

  // Anything scheduled today (done or not) → an end-of-day review has something
  // to reflect on. Independent of the browsed day (the review is about today).
  const hasTodayActivity = useMemo(
    () =>
      items.some(
        (i) => i.scheduledStart && sameDay(new Date(i.scheduledStart), now),
      ),
    [items, now],
  );

  const rollOver = async () => {
    setRolling(true);
    const today = startOfDay(new Date());
    const s = new Date(today);
    s.setHours(dayStart, 0, 0, 0);
    const e = new Date(today);
    e.setHours(dayEnd, 0, 0, 0);
    try {
      const res = await apiRollover({
        day_start: s.toISOString(),
        day_end: e.toISOString(),
        energy_windows: energyWindows.map((w) => {
          const ws = new Date(today);
          ws.setHours(w.start_hour, 0, 0, 0);
          const we = new Date(today);
          we.setHours(w.end_hour, 0, 0, 0);
          return {
            start: ws.toISOString(),
            end: we.toISOString(),
            energy: w.energy,
          };
        }),
        capacity_mins: capacityTarget,
        buffer_mins: settings.bufferMins ?? 0,
      });
      for (const b of res.blocks) {
        updateItem(b.itemId, { scheduledStart: b.start, scheduledEnd: b.end });
      }
    } catch {
      /* best-effort */
    } finally {
      setRolling(false);
    }
  };

  const step = (dir: 1 | -1) =>
    setAnchor((a) =>
      mode === "month"
        ? addMonths(a, dir)
        : addDays(a, dir * (mode === "week" ? 7 : 1)),
    );

  const title =
    mode === "month"
      ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : mode === "week"
        ? `Week of ${startOfWeek(anchor).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
        : anchor.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          });

  const days =
    mode === "week"
      ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i))
      : [anchor];

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      {/* Header: title, nav, mode toggle */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <CalendarDays className="h-5 w-5 shrink-0 text-primary" />
        <h1 className="text-base font-semibold text-foreground">{title}</h1>
        <div className="ml-2 flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous"
            onClick={() => step(-1)}
            className="tech-transition rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setAnchor(startOfDay(new Date()))}
            className="tech-transition rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            Today
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={() => step(1)}
            className="tech-transition rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="relative ml-auto flex items-center gap-2">
          {dueSoon.length > 0 && (
            <span
              title={`${dueSoon.length} unscheduled task(s) due within 2 weeks`}
              className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning"
            >
              <AlertTriangle className="h-3 w-3" />
              {dueSoon.length} due soon
            </span>
          )}
          {hasTodayActivity && (
            <button
              type="button"
              onClick={() => setReviewOpen(true)}
              title="End-of-day review — what got done, what carries forward, estimate accuracy"
              className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Review</span>
            </button>
          )}
          {canReplan && (
            <button
              type="button"
              onClick={() => setPlanMode("replan")}
              title="Fell behind? Reorganize the rest of today's flexible blocks from now."
              className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            >
              <CalendarClock className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Replan</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setPlanMode("plan")}
            title="AI-plan your day from your Next Actions"
            className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1.5 text-[12px] font-medium text-primary hover:bg-primary/20"
          >
            <Wand2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Plan my day</span>
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label="Calendar settings"
            title="Day window, capacity, energy windows"
            className={[
              "tech-transition rounded-md p-1.5",
              settingsOpen
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            ].join(" ")}
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <div className="flex rounded-lg bg-secondary p-0.5 text-xs">
            {(["day", "week", "month"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={[
                  "tech-transition rounded-md px-2.5 py-1 font-medium capitalize",
                  mode === m
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                {m}
              </button>
            ))}
          </div>
          {settingsOpen && (
            <CalendarSettings
              settings={settings}
              onChange={(patch) => void updateSettings(patch)}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>
      </div>

      {/* Now / Next — always reflects the *real* current time (today), even when
          you're browsing another day/week. The antidote to time-blindness, and
          the one scheduling-aware surface that's also visible on mobile. */}
      <NowNextBar
        now={now}
        items={items}
        onOpen={openFocus}
        onComplete={completeBlock}
        onStart={startFocus}
        onGoToToday={() => {
          setAnchor(startOfDay(new Date()));
          if (mode === "month") setMode("day");
        }}
      />

      {overdueCount > 0 && (
        <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-[12px]">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-foreground">
            {overdueCount} scheduled task{overdueCount === 1 ? "" : "s"} from
            earlier {overdueCount === 1 ? "wasn't" : "weren't"} completed.
          </span>
          <button
            type="button"
            onClick={() => void rollOver()}
            disabled={rolling}
            title="Reschedule them into today's open slots (deadline-aware)"
            className="tech-transition inline-flex shrink-0 items-center gap-1.5 rounded-md bg-warning/20 px-2.5 py-1 font-medium text-warning hover:bg-warning/30 disabled:opacity-50"
          >
            {rolling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            Roll over to today
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          {mode === "month" ? (
            <MonthGrid
              anchor={anchor}
              items={items}
              onPickDay={(d) => {
                setAnchor(d);
                setMode("day");
              }}
              onOpen={openFocus}
            />
          ) : (
            <TimeGrid
              days={days}
              items={items}
              now={now}
              dayStart={dayStart}
              dayEnd={dayEnd}
              energyWindows={energyWindows}
              onOpen={openFocus}
              onUnschedule={unschedule}
              onComplete={completeBlock}
              reschedule={reschedule}
              onPickSlot={(day, at) => setSheet({ day, at })}
              onSetFlexible={(item, flexible) =>
                updateItem(item.id, { flexible })
              }
            />
          )}
        </div>

        {/* Unscheduled rail — click a task to timebox it into the focused day.
            Hidden in month mode. */}
        {mode !== "month" && (
          <UnscheduledRail
            tasks={unscheduled}
            focusedDayLabel={
              mode === "week" ? "this week's first open slot" : "today"
            }
            capacityMins={blocksForDay(items, anchor).reduce(
              (n, b) => n + (b.end.getTime() - b.start.getTime()) / 60000,
              0,
            )}
            capacityTarget={capacityTarget}
            dueSoon={dueSoon}
            doneStats={doneStats}
            onPlan={() => setPlanMode("plan")}
            onSchedule={(t) => schedule(t, mode === "week" ? startOfWeek(anchor) : anchor)}
            onScheduleToday={(t) => schedule(t, startOfDay(new Date()))}
            onOpen={openFocus}
          />
        )}
      </div>

      {/* Mobile scheduling entry point — the rail is desktop-only and touch has
          no drag-and-drop, so on a phone this is how you timebox: pick a task
          (auto-placed) or Plan the whole day. Anchored to the calendar area so
          it sits above the app's bottom bar. */}
      {mode !== "month" && (
        <button
          type="button"
          onClick={() =>
            setSheet({ day: mode === "week" ? startOfWeek(anchor) : anchor })
          }
          aria-label="Schedule a task"
          className="tech-transition absolute bottom-4 right-4 z-30 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-3 font-semibold text-primary-foreground shadow-lg hover:opacity-90 md:hidden"
        >
          <CalendarPlus className="h-5 w-5" />
          {unscheduled.length > 0 && (
            <span className="text-[13px] tabular-nums">{unscheduled.length}</span>
          )}
        </button>
      )}

      {sheet && (
        <ScheduleSheet
          day={sheet.day}
          at={sheet.at}
          tasks={unscheduled}
          dueSoon={dueSoon}
          onSchedule={(t, at) => {
            schedule(t, sheet.day, at);
            setSheet(null);
          }}
          onPlan={() => {
            setSheet(null);
            setPlanMode("plan");
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {reviewOpen && (
        <EndOfDayReview
          now={now}
          items={items}
          onOpen={openFocus}
          onClose={() => setReviewOpen(false)}
        />
      )}

      {planMode && (
        <PlanDayPanel
          mode={planMode}
          target={
            planMode === "replan" || mode !== "day" ? startOfDay(now) : anchor
          }
          dayStart={dayStart}
          dayEnd={dayEnd}
          capacityMins={capacityTarget}
          bufferMins={settings.bufferMins ?? 0}
          energyWindows={energyWindows}
          onClose={() => setPlanMode(null)}
        />
      )}
    </div>
  );
}

// ── Now / Next focus bar ─────────────────────────────────────────────────────
// "What should I be doing right now, and what's next?" — a persistent, live
// strip that always reflects the real current time (today), independent of the
// day you're browsing. Directly targets time-blindness: the current block gets
// a countdown + a one-tap done, the next block a "starts in" timer.
function NowNextBar({
  now,
  items,
  onOpen,
  onComplete,
  onStart,
  onGoToToday,
}: {
  now: Date;
  items: GtdItem[];
  onOpen: (id: string) => void;
  onComplete: (item: GtdItem) => void;
  onStart: (item: GtdItem) => void;
  onGoToToday: () => void;
}) {
  const nowMs = now.getTime();
  const todayBlocks = blocksForDay(items, startOfDay(now));
  const current = todayBlocks.find(
    (b) =>
      b.item.disposition !== "DONE" &&
      b.start.getTime() <= nowMs &&
      b.end.getTime() > nowMs,
  );
  const next = todayBlocks.find(
    (b) => b.item.disposition !== "DONE" && b.start.getTime() > nowMs,
  );

  // Nothing live to say → stay out of the way (empty day, or the day is over).
  if (!current && !next) return null;

  const fmtClock = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const minsLeft = current
    ? Math.max(0, Math.ceil((current.end.getTime() - nowMs) / 60000))
    : 0;
  const minsToNext = next
    ? Math.max(0, Math.ceil((next.start.getTime() - nowMs) / 60000))
    : 0;
  const nextIsNow = next && minsToNext <= 0;
  // How far through the current block we are (fills as the block elapses).
  const progress = current
    ? Math.min(
        100,
        Math.max(
          0,
          ((nowMs - current.start.getTime()) /
            (current.end.getTime() - current.start.getTime())) *
            100,
        ),
      )
    : 0;
  // Focus timer state: is the current block being actively timed, and for how
  // long? (actual work-time, distinct from the block's scheduled elapse.)
  const startedAt =
    current && current.item.actualStart
      ? new Date(current.item.actualStart)
      : null;
  const running = !!startedAt && !!current && !current.item.actualEnd;
  const focusMins =
    running && startedAt
      ? Math.max(0, Math.floor((nowMs - startedAt.getTime()) / 60000))
      : 0;

  return (
    <div className="flex items-stretch gap-3 border-b border-border bg-primary/[0.04] px-4 py-2">
      {/* NOW */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
          <span className="relative flex h-2 w-2">
            {current && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
            )}
            <span
              className={[
                "relative inline-flex h-2 w-2 rounded-full",
                current ? "bg-primary" : "bg-muted-foreground/40",
              ].join(" ")}
            />
          </span>
          Now
        </span>
        {current ? (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onComplete(current.item);
              }}
              aria-label="Mark done"
              title="Mark done"
              className="tech-transition flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/50 text-transparent hover:border-success hover:bg-success/10 hover:text-success"
            >
              <Check className="h-3 w-3" strokeWidth={3} />
            </button>
            {!running && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onStart(current.item);
                }}
                aria-label="Start focus timer"
                title="Start — track how long this actually takes"
                className="tech-transition flex h-5 shrink-0 items-center gap-1 rounded-full border border-primary/50 px-2 text-[10px] font-semibold text-primary hover:bg-primary/10"
              >
                <Play className="h-2.5 w-2.5" fill="currentColor" />
                Start
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpen(current.item.id)}
              className="flex min-w-0 flex-1 flex-col items-start text-left"
            >
              <span className="w-full truncate text-[13px] font-medium text-foreground">
                {current.item.title}
              </span>
              <span className="mt-1 flex w-full items-center gap-1.5">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-primary/15">
                  <span
                    className={[
                      "block h-full rounded-full",
                      running ? "bg-primary animate-pulse" : "bg-primary/70",
                    ].join(" ")}
                    style={{ width: `${progress}%` }}
                  />
                </span>
                <span className="shrink-0 text-[10px] font-medium tabular-nums text-primary">
                  {running ? `▶ ${fmtLeft(focusMins)}` : `${fmtLeft(minsLeft)} left`}
                </span>
              </span>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onGoToToday}
            title="Nothing scheduled at the moment"
            className="min-w-0 flex-1 truncate text-left text-[12px] text-muted-foreground hover:text-foreground"
          >
            Open right now — nothing scheduled.
          </button>
        )}
      </div>

      {/* NEXT */}
      {next && (
        <button
          type="button"
          onClick={() => onOpen(next.item.id)}
          className="flex min-w-0 max-w-[42%] shrink items-center gap-2 border-l border-border pl-3 text-left"
        >
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Next
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12.5px] text-foreground">
              {next.item.title}
            </span>
            <span className="block text-[10px] tabular-nums text-muted-foreground">
              {fmtClock(next.start)}
              {" · "}
              {nextIsNow ? "starting now" : `in ${fmtLeft(minsToNext)}`}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

// ── End-of-day review ────────────────────────────────────────────────────────
// A 2-minute reflection (calendar_ux_review §3 P3): what got DONE (celebrated,
// with planned-vs-actual), what carries FORWARD (framed kindly, not as failure),
// and how your estimates are trending — the loop that builds trust + accuracy.
function EndOfDayReview({
  now,
  items,
  onOpen,
  onClose,
}: {
  now: Date;
  items: GtdItem[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [stats, setStats] = useState<EstimateStats | null>(null);
  useEffect(() => {
    let alive = true;
    apiEstimateStats()
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const blocks = blocksForDay(items, startOfDay(now));
  const done = blocks.filter((b) => b.item.disposition === "DONE");
  const unfinished = blocks.filter((b) => b.item.disposition !== "DONE");
  const doneHrs =
    Math.round(
      (done.reduce(
        (n, b) => n + (b.end.getTime() - b.start.getTime()) / 60000,
        0,
      ) /
        60) *
        10,
    ) / 10;
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const fmtClock = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <ClipboardCheck className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">
              Day review
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {dateLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* At-a-glance tally */}
          <div className="mb-3 flex gap-2">
            <div className="flex-1 rounded-lg border border-border bg-background/60 p-2.5 text-center">
              <div className="text-lg font-semibold tabular-nums text-success">
                {done.length}
              </div>
              <div className="text-[10px] text-muted-foreground">
                done · {doneHrs}h
              </div>
            </div>
            <div className="flex-1 rounded-lg border border-border bg-background/60 p-2.5 text-center">
              <div className="text-lg font-semibold tabular-nums text-foreground">
                {unfinished.length}
              </div>
              <div className="text-[10px] text-muted-foreground">
                carry forward
              </div>
            </div>
          </div>

          {/* Estimate accuracy — the learned-estimate signal */}
          {stats && stats.samples >= 5 ? (
            <div className="mb-3 rounded-lg bg-primary/5 p-2.5 text-[12px] text-foreground">
              <span className="font-medium">Estimate accuracy.</span> Over{" "}
              {stats.samples} timed tasks you typically run{" "}
              <span
                className={
                  stats.overPct > 0
                    ? "font-medium text-warning"
                    : "font-medium text-success"
                }
              >
                {stats.overPct > 0
                  ? `${stats.overPct}% over`
                  : stats.overPct < 0
                    ? `${Math.abs(stats.overPct)}% under`
                    : "right on"}
              </span>{" "}
              your estimate
              {stats.overPct > 0 ? " — the planner now pads for it." : "."}
            </div>
          ) : (
            <div className="mb-3 rounded-lg bg-secondary/50 p-2.5 text-[11px] text-muted-foreground">
              Tip: hit{" "}
              <span className="font-medium text-foreground">▶ Start</span> on your
              current block to time it. After a few, we learn how your estimates
              compare and pad future plans.
            </div>
          )}

          {/* Done — celebrate, with how the estimate held up */}
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Done today
          </p>
          {done.length === 0 ? (
            <p className="mb-3 text-[12px] text-muted-foreground">
              Nothing marked done yet — no shame, tomorrow is a fresh plan.
            </p>
          ) : (
            <div className="mb-3 flex flex-col gap-1">
              {done.map((b) => {
                const plannedMins = Math.round(
                  (b.end.getTime() - b.start.getTime()) / 60000,
                );
                const actualMins =
                  b.item.actualStart && b.item.actualEnd
                    ? Math.max(
                        1,
                        Math.round(
                          (new Date(b.item.actualEnd).getTime() -
                            new Date(b.item.actualStart).getTime()) /
                            60000,
                        ),
                      )
                    : null;
                return (
                  <button
                    key={b.item.id}
                    type="button"
                    onClick={() => onOpen(b.item.id)}
                    className="tech-transition flex items-center gap-2 rounded-md border border-border bg-background/60 p-2 text-left hover:border-primary/40"
                  >
                    <Check className="h-3.5 w-3.5 shrink-0 text-success" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground line-through decoration-muted-foreground/40">
                      {b.item.title}
                    </span>
                    {actualMins != null && (
                      <span
                        title={`Planned ${plannedMins}m · actually took ${actualMins}m`}
                        className={[
                          "shrink-0 text-[10px] font-medium tabular-nums",
                          actualMins > plannedMins
                            ? "text-warning"
                            : actualMins < plannedMins
                              ? "text-success"
                              : "text-muted-foreground",
                        ].join(" ")}
                      >
                        {actualMins === plannedMins
                          ? "on time"
                          : (actualMins > plannedMins ? "+" : "−") +
                            fmtLeft(Math.abs(actualMins - plannedMins))}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Carry forward — kindly framed, not a wall of red */}
          {unfinished.length > 0 && (
            <>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Carry forward ({unfinished.length})
              </p>
              <p className="mb-1.5 text-[11px] text-muted-foreground">
                Not a failure — just tomorrow&apos;s plan. Roll them over or replan
                from the calendar.
              </p>
              <div className="flex flex-col gap-1">
                {unfinished.map((b) => (
                  <button
                    key={b.item.id}
                    type="button"
                    onClick={() => onOpen(b.item.id)}
                    className="tech-transition flex items-center gap-2 rounded-md border border-border bg-background/60 p-2 text-left hover:border-primary/40"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/50" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                      {b.item.title}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {fmtClock(b.start)}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="tech-transition rounded-md bg-primary px-3 py-2 text-[12px] font-medium text-primary-foreground hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Schedule sheet (mobile + tap-to-schedule) ───────────────────────────────
// Touch devices have no HTML5 drag-and-drop and the unscheduled rail is
// desktop-only, so on a phone you could view but barely schedule. This
// bottom-anchored sheet is the mobile path — and also what a tap on an empty
// grid slot opens on any device. Pick a task to timebox it: at the tapped time
// when `at` is set, otherwise auto-placed into the day's first free slot. Plan
// my day is the primary CTA up top.
function ScheduleSheet({
  day,
  at,
  tasks,
  dueSoon,
  onSchedule,
  onPlan,
  onClose,
}: {
  day: Date;
  at?: Date;
  tasks: GtdItem[];
  dueSoon: { item: GtdItem; days: number }[];
  onSchedule: (t: GtdItem, at?: Date) => void;
  onPlan: () => void;
  onClose: () => void;
}) {
  const fmtClock = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dueDays = new Map(dueSoon.map((d) => [d.item.id, d.days]));
  const dayLabel = day.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        className="mx-auto flex max-h-[78vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center pt-2">
          <span className="h-1 w-10 rounded-full bg-border" />
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5">
          <CalendarPlus className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {at ? `Schedule at ${fmtClock(at)}` : "Schedule a task"}
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {dayLabel}
              {at ? "" : " · first free slot"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={onPlan}
            className="tech-transition flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
          >
            <Wand2 className="h-4 w-4" />
            Plan my day with AI
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {tasks.length === 0 ? (
            <p className="px-1 py-8 text-center text-[12px] text-muted-foreground">
              Nothing to schedule — inbox zero on next actions. 🎉
            </p>
          ) : (
            <>
              <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Unscheduled ({tasks.length})
              </p>
              <div className="flex flex-col gap-1.5">
                {tasks.map((t) => {
                  const d = dueDays.get(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onSchedule(t, at)}
                      className="tech-transition flex items-center gap-2 rounded-lg border border-border bg-background/60 p-2.5 text-left hover:border-primary/50 active:bg-primary/5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-foreground">
                          {t.title}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="inline-flex items-center gap-0.5">
                            <Clock className="h-3 w-3" />
                            {durationLabel(t.timeEstimateMins ?? DEFAULT_BLOCK_MINS)}
                          </span>
                          {t.energy && (
                            <span className="inline-flex items-center gap-0.5 capitalize">
                              <Zap className="h-3 w-3" />
                              {t.energy}
                            </span>
                          )}
                          {d !== undefined && (
                            <span
                              className={`font-medium ${
                                d <= 1 ? "text-destructive" : "text-warning"
                              }`}
                            >
                              {d <= 0
                                ? "due today"
                                : d === 1
                                  ? "due tomorrow"
                                  : `due in ${d}d`}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
                        <CalendarPlus className="h-3.5 w-3.5" />
                        {at ? fmtClock(at) : "Timebox"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── AI "Plan my day" review panel ────────────────────────────────────────────
function PlanDayPanel({
  mode = "plan",
  target,
  dayStart,
  dayEnd,
  capacityMins,
  bufferMins,
  energyWindows,
  onClose,
}: {
  mode?: "plan" | "replan";
  target: Date;
  dayStart: number;
  dayEnd: number;
  capacityMins: number;
  bufferMins: number;
  energyWindows: EnergyWindow[];
  onClose: () => void;
}) {
  const isReplan = mode === "replan";
  const updateItem = useTaskStore((s) => s.updateItem);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<DayPlanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (n: string) => {
    setLoading(true);
    setError(null);
    const dayStartAt = new Date(target);
    dayStartAt.setHours(dayStart, 0, 0, 0);
    const dayEndAt = new Date(target);
    dayEndAt.setHours(dayEnd, 0, 0, 0);
    try {
      setPlan(
        await (isReplan ? apiReplan : apiPlanDay)({
          day_start: dayStartAt.toISOString(),
          day_end: dayEndAt.toISOString(),
          energy_windows: energyWindows.map((w) => {
            const ws = new Date(target);
            ws.setHours(w.start_hour, 0, 0, 0);
            const we = new Date(target);
            we.setHours(w.end_hour, 0, 0, 0);
            return {
              start: ws.toISOString(),
              end: we.toISOString(),
              energy: w.energy,
            };
          }),
          capacity_mins: capacityMins,
          buffer_mins: bufferMins,
          energy_note: n.trim() || undefined,
        }),
      );
    } catch (err) {
      setError((err as Error)?.message || "Couldn't plan your day right now.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    // Plan once when the panel opens (data fetch on mount).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = () => {
    if (!plan) return;
    for (const b of plan.blocks) {
      updateItem(b.itemId, { scheduledStart: b.start, scheduledEnd: b.end });
    }
    onClose();
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  const dateLabel = target.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          {isReplan ? (
            <CalendarClock className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <Wand2 className="h-4 w-4 shrink-0 text-primary" />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {isReplan ? "Replan the rest of my day" : "Plan my day"}
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {isReplan ? `From now · ${dateLabel}` : dateLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run(note);
            }}
            placeholder="How's your energy? e.g. “low energy, lots of meetings”"
            className="min-w-0 flex-1 rounded-md border border-border bg-background/60 px-3 py-2 text-base text-foreground focus:border-primary/50 focus:outline-none sm:text-sm"
          />
          <button
            type="button"
            onClick={() => void run(note)}
            disabled={loading}
            className="tech-transition inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            Re-plan
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <p className="flex items-center gap-1.5 text-[12px] text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
            </p>
          ) : loading && !plan ? (
            <p className="flex items-center gap-1.5 py-6 text-[12px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Planning your day…
            </p>
          ) : plan ? (
            <>
              {plan.notes && (
                <p className="mb-2 rounded-md bg-primary/5 px-2.5 py-2 text-[12px] text-muted-foreground">
                  {plan.notes}
                </p>
              )}
              <p className="mb-2 text-[11px] text-muted-foreground">
                {plan.blocks.length} block{plan.blocks.length === 1 ? "" : "s"} ·{" "}
                {Math.round((plan.usedMins / 60) * 10) / 10}h of{" "}
                {Math.round((plan.capacityMins / 60) * 10) / 10}h capacity
              </p>
              <div className="flex flex-col gap-1.5">
                {plan.blocks.map((b) => {
                  const dot =
                    b.energy === "high"
                      ? "bg-destructive"
                      : b.energy === "low"
                        ? "bg-success"
                        : "bg-warning";
                  return (
                    <div
                      key={b.itemId}
                      className="rounded-md border border-border bg-background/60 p-2"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="shrink-0 text-[11px] font-medium tabular-nums text-primary">
                          {fmt(b.start)}–{fmt(b.end)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                          {b.title}
                        </span>
                        {b.energy && (
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`}
                          />
                        )}
                      </div>
                      {b.rationale && (
                        <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                          {b.rationale}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {plan.unplaced.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Not scheduled ({plan.unplaced.length})
                  </p>
                  <div className="flex flex-col gap-1">
                    {plan.unplaced.map((u) => (
                      <div
                        key={u.itemId}
                        className="flex items-baseline gap-2 text-[11.5px]"
                      >
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {u.title}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground/70">
                          {u.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {plan.blocks.length === 0 && plan.unplaced.length === 0 && (
                <p className="py-4 text-center text-[12px] text-muted-foreground">
                  Nothing to schedule — no unscheduled next actions.
                </p>
              )}
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-[12px] font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!plan || plan.blocks.length === 0}
            className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            Apply
            {plan?.blocks.length
              ? ` ${plan.blocks.length} block${plan.blocks.length === 1 ? "" : "s"}`
              : " plan"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Settings popover (day window, capacity, buffer, energy windows) ──────────
function CalendarSettings({
  settings,
  onChange,
  onClose,
}: {
  settings: TaskSettings;
  onChange: (patch: Partial<TaskSettings>) => void;
  onClose: () => void;
}) {
  const wins = settings.energyWindows ?? [];
  const num = (v: string, fallback: number) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const setWin = (i: number, patch: Partial<EnergyWindow>) =>
    onChange({
      energyWindows: wins.map((w, idx) => (idx === i ? { ...w, ...patch } : w)),
    });
  const inputCls =
    "rounded border border-border bg-background px-1 py-0.5 text-right text-foreground focus:border-primary/50 focus:outline-none";
  return (
    <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-lg border border-border bg-card p-3 text-[12px] shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-foreground">Calendar settings</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <label className="mb-2 flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Day window</span>
        <span className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={23}
            value={settings.dayStartHour}
            onChange={(e) => onChange({ dayStartHour: num(e.target.value, 7) })}
            className={`w-12 ${inputCls}`}
          />
          <span className="text-muted-foreground">–</span>
          <input
            type="number"
            min={1}
            max={24}
            value={settings.dayEndHour}
            onChange={(e) => onChange({ dayEndHour: num(e.target.value, 22) })}
            className={`w-12 ${inputCls}`}
          />
        </span>
      </label>

      <label className="mb-2 flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Daily focus capacity (h)</span>
        <input
          type="number"
          min={0}
          max={16}
          step={0.5}
          value={Math.round((settings.dailyCapacityMins / 60) * 10) / 10}
          onChange={(e) =>
            onChange({ dailyCapacityMins: Math.round(num(e.target.value, 6) * 60) })
          }
          className={`w-14 ${inputCls}`}
        />
      </label>

      <label className="mb-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Buffer between blocks (min)</span>
        <input
          type="number"
          min={0}
          max={60}
          step={5}
          value={settings.bufferMins}
          onChange={(e) => onChange({ bufferMins: num(e.target.value, 0) })}
          className={`w-14 ${inputCls}`}
        />
      </label>

      <label className="mb-3 flex cursor-pointer items-center justify-between gap-2">
        <span className="min-w-0 text-muted-foreground">
          Auto roll-over overdue tasks daily
        </span>
        <input
          type="checkbox"
          checked={settings.autoRollover}
          onChange={(e) => onChange({ autoRollover: e.target.checked })}
          className="h-4 w-4 shrink-0 accent-primary"
        />
      </label>

      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-foreground">Energy windows</span>
        <button
          type="button"
          onClick={() =>
            onChange({
              energyWindows: [
                ...wins,
                { start_hour: 9, end_hour: 12, energy: "high" },
              ],
            })
          }
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
        >
          <Plus className="h-3 w-3" /> Add
        </button>
      </div>
      <p className="mb-1.5 text-[10px] text-muted-foreground">
        The planner puts high-energy work in peak windows, admin in low ones.
      </p>
      {wins.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/70">None set.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {wins.map((w, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={23}
                value={w.start_hour}
                onChange={(e) => setWin(i, { start_hour: num(e.target.value, 9) })}
                className={`w-11 ${inputCls}`}
              />
              <span className="text-muted-foreground">–</span>
              <input
                type="number"
                min={1}
                max={24}
                value={w.end_hour}
                onChange={(e) => setWin(i, { end_hour: num(e.target.value, 12) })}
                className={`w-11 ${inputCls}`}
              />
              <select
                value={w.energy}
                onChange={(e) =>
                  setWin(i, { energy: e.target.value as EnergyWindow["energy"] })
                }
                className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-foreground"
              >
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
              <button
                type="button"
                onClick={() =>
                  onChange({ energyWindows: wins.filter((_, idx) => idx !== i) })
                }
                aria-label="Remove window"
                className="rounded p-0.5 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Day / Week hour grid ─────────────────────────────────────────────────────
function TimeGrid({
  days,
  items,
  now,
  dayStart,
  dayEnd,
  energyWindows,
  onOpen,
  onUnschedule,
  onComplete,
  reschedule,
  onPickSlot,
  onSetFlexible,
}: {
  days: Date[];
  items: GtdItem[];
  now: Date;
  dayStart: number;
  dayEnd: number;
  energyWindows: EnergyWindow[];
  onOpen: (id: string) => void;
  onUnschedule: (item: GtdItem) => void;
  onComplete: (item: GtdItem) => void;
  reschedule: (id: string, start: Date, end: Date) => void;
  /** Tap an empty grid slot → schedule a task at that snapped time. */
  onPickSlot: (day: Date, at: Date) => void;
  /** Pin (false) / unpin (true) a block so the auto-mover skips / includes it. */
  onSetFlexible: (item: GtdItem, flexible: boolean) => void;
}) {
  const hours = Array.from({ length: dayEnd - dayStart }, (_, i) => dayStart + i);
  const gridHeight = hours.length * HOUR_PX;
  // Live resize (transient end while dragging the handle) + drop-target column.
  const [resizing, setResizing] = useState<{ id: string; endMs: number } | null>(null);
  const resizingRef = useRef(false); // suppress the native block-drag while resizing
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  // Drop a dragged task/block onto `day` at the cursor's Y → snapped start+end.
  const handleDrop = (e: React.DragEvent, day: Date) => {
    e.preventDefault();
    setDragOverKey(null);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    let p: DragPayload;
    try {
      p = JSON.parse(raw) as DragPayload;
    } catch {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const windowMins = (dayEnd - dayStart) * 60;
    let mins = snap(((e.clientY - rect.top) / HOUR_PX) * 60 - p.grabOffsetMins);
    mins = Math.max(0, Math.min(mins, windowMins - p.durationMins));
    const start = new Date(day);
    start.setHours(dayStart, 0, 0, 0);
    start.setMinutes(start.getMinutes() + mins);
    reschedule(p.id, start, new Date(start.getTime() + p.durationMins * 60000));
  };

  const onBlockDragStart = (e: React.DragEvent, b: Block) => {
    if (resizingRef.current) {
      e.preventDefault(); // grabbing the resize handle, not moving the block
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const grabOffsetMins = ((e.clientY - rect.top) / HOUR_PX) * 60;
    const durationMins = (b.end.getTime() - b.start.getTime()) / 60000;
    e.dataTransfer.setData(
      DRAG_TYPE,
      JSON.stringify({ id: b.item.id, durationMins, grabOffsetMins }),
    );
    e.dataTransfer.effectAllowed = "move";
  };

  // Resize via pointer events (native DnD is poor for edge-drag). Window
  // listeners track the drag; commit on pointer-up.
  const startResize = (e: React.PointerEvent, b: Block) => {
    e.stopPropagation();
    e.preventDefault();
    resizingRef.current = true;
    const startY = e.clientY;
    const startMs = b.start.getTime();
    const originEndMs = b.end.getTime();
    const dayEndAt = new Date(b.start);
    dayEndAt.setHours(dayEnd, 0, 0, 0);
    const clampEnd = (clientY: number) => {
      const dyMins = ((clientY - startY) / HOUR_PX) * 60;
      const endMs = originEndMs + snap(dyMins) * 60000;
      return Math.max(
        startMs + SNAP_MINS * 60000,
        Math.min(endMs, dayEndAt.getTime()),
      );
    };
    const onMove = (ev: PointerEvent) =>
      setResizing({ id: b.item.id, endMs: clampEnd(ev.clientY) });
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      reschedule(b.item.id, new Date(startMs), new Date(clampEnd(ev.clientY)));
      resizingRef.current = false;
      setResizing(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="min-w-fit">
      {/* Column headers (week) */}
      {days.length > 1 && (
        <div className="sticky top-0 z-10 flex border-b border-border bg-background">
          <div className="w-14 shrink-0" />
          {days.map((d) => {
            const today = sameDay(d, now);
            return (
              <div
                key={d.toISOString()}
                className="flex-1 border-l border-border px-2 py-1.5 text-center"
              >
                <div className="text-[10px] font-medium uppercase text-muted-foreground">
                  {DOW[(d.getDay() + 6) % 7]}
                </div>
                <div
                  className={[
                    "text-sm font-semibold",
                    today ? "text-primary" : "text-foreground",
                  ].join(" ")}
                >
                  {d.getDate()}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex">
        {/* Hour gutter */}
        <div className="w-14 shrink-0">
          {hours.map((h) => (
            <div
              key={h}
              style={{ height: HOUR_PX }}
              className="relative -mt-2 pr-2 text-right text-[10px] text-muted-foreground"
            >
              <span className="absolute right-2 top-2">
                {h % 12 === 0 ? 12 : h % 12}
                {h < 12 ? "am" : "pm"}
              </span>
            </div>
          ))}
        </div>

        {/* Day columns */}
        {days.map((day) => {
          const blocks = blocksForDay(items, day);
          const deadlines = deadlinesForDay(items, day);
          const today = sameDay(day, now);
          const dayKey = day.toISOString();
          const nowTop =
            ((minutesInto(now) - dayStart * 60) / 60) * HOUR_PX;
          return (
            <div
              key={dayKey}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverKey !== dayKey) setDragOverKey(dayKey);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target) setDragOverKey(null);
              }}
              onDrop={(e) => handleDrop(e, day)}
              onClick={(e) => {
                // Empty-slot tap → schedule-here sheet. Blocks and deadline
                // markers stopPropagation, so this only fires on bare grid.
                const rect = e.currentTarget.getBoundingClientRect();
                const rawMins = ((e.clientY - rect.top) / HOUR_PX) * 60;
                const at = new Date(day);
                at.setHours(dayStart, 0, 0, 0);
                at.setMinutes(at.getMinutes() + Math.max(0, snap(rawMins)));
                onPickSlot(day, at);
              }}
              className={[
                "relative flex-1 cursor-pointer border-l border-border",
                dragOverKey === dayKey ? "bg-primary/5" : "",
              ].join(" ")}
              style={{ height: gridHeight }}
            >
              {/* hour lines */}
              {hours.map((h) => (
                <div
                  key={h}
                  style={{ height: HOUR_PX }}
                  className="border-b border-border/60"
                />
              ))}

              {/* energy windows — peak/trough tint the planner places work into */}
              {energyWindows.map((w, wi) => {
                const bandTop = (w.start_hour - dayStart) * HOUR_PX;
                const bandH = (w.end_hour - w.start_hour) * HOUR_PX;
                if (bandH <= 0) return null;
                const tone =
                  w.energy === "high"
                    ? "bg-success/10"
                    : w.energy === "low"
                      ? "bg-muted/40"
                      : "bg-warning/10";
                return (
                  <div
                    key={`ew-${wi}`}
                    title={`${w.energy} energy ${w.start_hour}:00–${w.end_hour}:00`}
                    className={`pointer-events-none absolute inset-x-0 ${tone}`}
                    style={{ top: Math.max(0, bandTop), height: bandH }}
                  />
                );
              })}

              {/* deadline markers (all-day, pinned top) */}
              {deadlines.length > 0 && (
                <div className="absolute inset-x-1 top-0 flex flex-col gap-0.5">
                  {deadlines.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(d.id);
                      }}
                      title={`Due today: ${d.title}`}
                      className="tech-transition truncate rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-left text-[10px] font-medium text-destructive hover:bg-destructive/20"
                    >
                      ⚑ {d.title}
                    </button>
                  ))}
                </div>
              )}

              {/* now line — pulses so "where am I in the day" is glanceable; a
                  live time pill (day view) makes the exact time readable. */}
              {today && nowTop >= 0 && nowTop <= gridHeight && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-primary"
                  style={{ top: nowTop }}
                >
                  <span className="absolute -left-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-primary" />
                  {days.length === 1 && (
                    <span className="absolute left-1 -top-2 rounded bg-primary px-1 text-[9px] font-semibold leading-tight text-primary-foreground shadow-sm">
                      {now.toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                </div>
              )}

              {/* scheduled blocks — overlaps split into side-by-side lanes */}
              {layoutBlocks(blocks).map(({ block: b, lane, lanes }) => {
                const end =
                  resizing?.id === b.item.id ? new Date(resizing.endMs) : b.end;
                const top =
                  ((minutesInto(b.start) - dayStart * 60) / 60) * HOUR_PX;
                const mins = (end.getTime() - b.start.getTime()) / 60000;
                const height = Math.max(20, (mins / 60) * HOUR_PX - 2);
                const conflict = lanes > 1;
                const isDone = b.item.disposition === "DONE";
                // The block that contains "now" — the one you should be in.
                const isNow =
                  !isDone &&
                  b.start.getTime() <= now.getTime() &&
                  b.end.getTime() > now.getTime();
                // Fixed (meeting) block — roll-over/replan leave it put.
                const isFixed = b.item.flexible === false;
                // Planned-vs-actual: for a completed, timed block, how far off
                // the plan the real work-time was (the estimate-accuracy signal).
                const plannedMins = Math.round(
                  (b.end.getTime() - b.start.getTime()) / 60000,
                );
                const actualMins =
                  isDone && b.item.actualStart && b.item.actualEnd
                    ? Math.max(
                        1,
                        Math.round(
                          (new Date(b.item.actualEnd).getTime() -
                            new Date(b.item.actualStart).getTime()) /
                            60000,
                        ),
                      )
                    : null;
                const leftPct = (lane / lanes) * 100;
                const widthPct = 100 / lanes;
                return (
                  <div
                    key={b.item.id}
                    draggable
                    onDragStart={(e) => onBlockDragStart(e, b)}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      top: Math.max(0, top),
                      height,
                      left: `calc(${leftPct}% + 2px)`,
                      width: `calc(${widthPct}% - 4px)`,
                    }}
                    title={
                      conflict ? "Overlaps another block — double-booked" : undefined
                    }
                    className={[
                      "group absolute cursor-grab overflow-hidden rounded-md border px-1.5 py-0.5 text-left active:cursor-grabbing",
                      isDone
                        ? "border-success/40 bg-success/10"
                        : conflict
                          ? "border-destructive/60 bg-destructive/10"
                          : isNow
                            ? "border-primary bg-primary/20"
                            : "border-primary/40 bg-primary/10",
                      isNow
                        ? "z-10 ring-2 ring-primary ring-offset-1 ring-offset-background shadow-md"
                        : "",
                      // A pinned block gets a solid left accent so "this won't
                      // move" is glanceable, not only on the lock icon.
                      isFixed && !isDone ? "border-l-2 border-l-primary" : "",
                    ].join(" ")}
                  >
                    <div className="flex items-start gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onComplete(b.item);
                        }}
                        aria-label={isDone ? "Mark not done" : "Mark done"}
                        title={isDone ? "Mark as not done" : "Mark done"}
                        className={[
                          "mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                          isDone
                            ? "border-success bg-success text-white"
                            : "border-muted-foreground/50 text-transparent hover:border-success hover:text-success/70",
                        ].join(" ")}
                      >
                        <Check className="h-2.5 w-2.5" strokeWidth={3} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpen(b.item.id)}
                        className={[
                          "min-w-0 flex-1 truncate text-left text-[11px] font-medium",
                          isDone
                            ? "text-muted-foreground line-through"
                            : "text-foreground",
                        ].join(" ")}
                      >
                        {b.item.title}
                      </button>
                    </div>
                    <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                      {b.start.toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {b.item.energy && (
                        <span className="capitalize">· {b.item.energy}</span>
                      )}
                      {isNow && (
                        <span className="ml-auto inline-flex items-center gap-0.5 pr-3 font-semibold text-primary">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                          now
                        </span>
                      )}
                      {actualMins != null && (
                        <span
                          title={`Planned ${plannedMins}m · actually took ${actualMins}m`}
                          className={[
                            "ml-auto inline-flex shrink-0 items-center pr-3 font-medium tabular-nums",
                            actualMins > plannedMins
                              ? "text-warning"
                              : actualMins < plannedMins
                                ? "text-success"
                                : "text-muted-foreground",
                          ].join(" ")}
                        >
                          {actualMins === plannedMins
                            ? "on time"
                            : (actualMins > plannedMins ? "+" : "−") +
                              fmtLeft(Math.abs(actualMins - plannedMins))}
                        </span>
                      )}
                    </div>
                    {/* Fixed ↔ flexible. A fixed (meeting) block is skipped by
                        roll-over/replan; the lock is persistent when fixed and
                        hover-to-pin when flexible. */}
                    <button
                      type="button"
                      aria-label={isFixed ? "Make flexible" : "Pin as fixed"}
                      title={
                        isFixed
                          ? "Fixed — the planner won't move this. Click to make flexible."
                          : "Flexible — auto-moves when you replan. Click to pin as fixed."
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onSetFlexible(b.item, isFixed);
                      }}
                      className={[
                        "tech-transition absolute right-[18px] top-0.5 rounded p-0.5",
                        isFixed
                          ? "text-primary hover:bg-black/10"
                          : "text-muted-foreground opacity-0 hover:bg-black/10 hover:text-foreground group-hover:opacity-100",
                      ].join(" ")}
                    >
                      {isFixed ? (
                        <Lock className="h-3 w-3" />
                      ) : (
                        <Unlock className="h-3 w-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label="Unschedule"
                      title="Remove from calendar"
                      onClick={() => onUnschedule(b.item)}
                      className="tech-transition absolute right-0.5 top-0.5 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-black/10 hover:text-destructive group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                    {/* drag the bottom edge to change duration */}
                    <div
                      onPointerDown={(e) => startResize(e, b)}
                      title="Drag to change duration"
                      className="absolute inset-x-0 bottom-0 flex h-2 cursor-ns-resize items-end justify-center pb-0.5 opacity-0 group-hover:opacity-100"
                    >
                      <div className="h-0.5 w-6 rounded-full bg-primary/60" />
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Month grid ───────────────────────────────────────────────────────────────
function MonthGrid({
  anchor,
  items,
  onPickDay,
  onOpen,
}: {
  anchor: Date;
  items: GtdItem[];
  onPickDay: (d: Date) => void;
  onOpen: (id: string) => void;
}) {
  const gridStart = startOfMonthGrid(anchor);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const now = new Date();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid grid-cols-7 border-b border-border">
        {DOW.map((d) => (
          <div
            key={d}
            className="px-2 py-1 text-center text-[10px] font-medium uppercase text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 grid-rows-6">
        {cells.map((day) => {
          const inMonth = day.getMonth() === anchor.getMonth();
          const blocks = blocksForDay(items, day);
          const deadlines = deadlinesForDay(items, day);
          const chips = [
            ...blocks.map((b) => ({ id: b.item.id, title: b.item.title, kind: "block" as const })),
            ...deadlines.map((d) => ({ id: d.id, title: d.title, kind: "deadline" as const })),
          ];
          const today = sameDay(day, now);
          return (
            <button
              key={day.toISOString()}
              type="button"
              onClick={() => onPickDay(day)}
              className={[
                "flex min-h-0 flex-col gap-0.5 border-b border-l border-border p-1 text-left align-top",
                inMonth ? "" : "bg-secondary/30",
              ].join(" ")}
            >
              <span
                className={[
                  "text-[11px] font-medium",
                  today
                    ? "flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                    : inMonth
                      ? "text-foreground"
                      : "text-muted-foreground/50",
                ].join(" ")}
              >
                {day.getDate()}
              </span>
              <div className="flex flex-col gap-0.5 overflow-hidden">
                {chips.slice(0, 3).map((c) => (
                  <span
                    key={c.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(c.id);
                    }}
                    className={[
                      "truncate rounded px-1 text-[9px]",
                      c.kind === "deadline"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-primary/10 text-primary",
                    ].join(" ")}
                  >
                    {c.kind === "deadline" ? "⚑ " : ""}
                    {c.title}
                  </span>
                ))}
                {chips.length > 3 && (
                  <span className="px-1 text-[9px] text-muted-foreground">
                    +{chips.length - 3} more
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Unscheduled rail ─────────────────────────────────────────────────────────
function UnscheduledRail({
  tasks,
  focusedDayLabel,
  capacityMins,
  capacityTarget,
  dueSoon,
  doneStats,
  onPlan,
  onSchedule,
  onScheduleToday,
  onOpen,
}: {
  tasks: GtdItem[];
  focusedDayLabel: string;
  capacityMins: number;
  capacityTarget: number;
  dueSoon: { item: GtdItem; days: number }[];
  doneStats: { count: number; mins: number };
  onPlan: () => void;
  onSchedule: (t: GtdItem) => void;
  onScheduleToday: (t: GtdItem) => void;
  onOpen: (id: string) => void;
}) {
  const over = capacityMins > capacityTarget;
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-l border-border bg-card md:flex">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
          <CalendarPlus className="h-3.5 w-3.5 text-primary" />
          Unscheduled
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          Drag onto the grid, or click Timebox ({focusedDayLabel}).
        </p>
        <div
          className={[
            "mt-1 text-[10px]",
            over ? "font-medium text-warning" : "text-muted-foreground",
          ].join(" ")}
        >
          {Math.round((capacityMins / 60) * 10) / 10}h /{" "}
          {Math.round((capacityTarget / 60) * 10) / 10}h booked
          {over ? " — over capacity" : ""}
        </div>
        {doneStats.count > 0 && (
          <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium text-success">
            <Check className="h-3 w-3" />
            {doneStats.count} done ·{" "}
            {Math.round((doneStats.mins / 60) * 10) / 10}h
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {/* Deadline radar — due-soon tasks that aren't timeboxed yet. */}
        {dueSoon.length > 0 && (
          <div className="mb-2">
            <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-warning">
              <AlertTriangle className="h-3 w-3" /> Due soon
            </p>
            <div className="flex flex-col gap-1">
              {dueSoon.map(({ item, days }) => (
                <div
                  key={item.id}
                  className="rounded-md border border-warning/40 bg-warning/5 p-1.5"
                >
                  <button
                    type="button"
                    onClick={() => onOpen(item.id)}
                    className="block w-full truncate text-left text-[12px] text-foreground"
                  >
                    {item.title}
                  </button>
                  <div className="mt-0.5 flex items-center justify-between">
                    <span
                      className={`text-[10px] font-medium ${
                        days <= 1 ? "text-destructive" : "text-warning"
                      }`}
                    >
                      {days <= 0
                        ? "due today"
                        : days === 1
                          ? "due tomorrow"
                          : `due in ${days}d`}
                    </span>
                    <button
                      type="button"
                      onClick={() => onScheduleToday(item)}
                      title="Timebox into today"
                      className="tech-transition inline-flex items-center gap-0.5 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning hover:bg-warning/30"
                    >
                      <CalendarPlus className="h-3 w-3" /> Today
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {tasks.length === 0 ? (
          <p className="px-1 py-4 text-center text-[11px] text-muted-foreground">
            Nothing to schedule — inbox zero on next actions. 🎉
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {tasks.map((t) => (
              <div
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    DRAG_TYPE,
                    JSON.stringify({
                      id: t.id,
                      durationMins: t.timeEstimateMins ?? DEFAULT_BLOCK_MINS,
                      grabOffsetMins: 0,
                    }),
                  );
                  e.dataTransfer.effectAllowed = "move";
                }}
                className="group cursor-grab rounded-md border border-border bg-background/60 p-2 hover:border-primary/40 active:cursor-grabbing"
              >
                <button
                  type="button"
                  onClick={() => onOpen(t.id)}
                  className="block w-full truncate text-left text-[12px] text-foreground"
                >
                  {t.title}
                </button>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                  {t.timeEstimateMins ? (
                    <span className="inline-flex items-center gap-0.5">
                      <Clock className="h-3 w-3" />
                      {durationLabel(t.timeEstimateMins)}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-0.5">
                      <Clock className="h-3 w-3" />
                      {DEFAULT_BLOCK_MINS}m
                    </span>
                  )}
                  {t.energy && (
                    <span className="inline-flex items-center gap-0.5 capitalize">
                      <Zap className="h-3 w-3" />
                      {t.energy}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onSchedule(t)}
                  className="tech-transition mt-1.5 inline-flex w-full items-center justify-center gap-1 rounded bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/20"
                >
                  <CalendarPlus className="h-3 w-3" />
                  Timebox
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {/* AI plan-my-day — the assistant timeboxes your Next Actions. */}
      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={onPlan}
          title="AI-plan your day around priority, energy + deadlines"
          className="tech-transition flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 px-2 py-2 text-[11px] font-medium text-primary hover:bg-primary/20"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Plan my day
        </button>
      </div>
    </aside>
  );
}
