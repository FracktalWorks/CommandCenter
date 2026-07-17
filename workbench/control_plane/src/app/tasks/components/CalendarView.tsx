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
} from "lucide-react";
import {
  apiPlanDay,
  apiRollover,
  type TaskSettings,
  type EnergyWindow,
  type DayPlanResult,
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

export function CalendarView() {
  const items = useTaskStore((s) => s.items);
  const updateItem = useTaskStore((s) => s.updateItem);
  const openFocus = useTaskStore((s) => s.openFocus);
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
  const [planOpen, setPlanOpen] = useState(false);
  const [rolling, setRolling] = useState(false);

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
    <div className="flex h-full min-h-0 flex-col bg-background">
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
          <button
            type="button"
            onClick={() => setPlanOpen(true)}
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
              dayStart={dayStart}
              dayEnd={dayEnd}
              energyWindows={energyWindows}
              onOpen={openFocus}
              onUnschedule={unschedule}
              reschedule={reschedule}
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
            onPlan={() => setPlanOpen(true)}
            onSchedule={(t) => schedule(t, mode === "week" ? startOfWeek(anchor) : anchor)}
            onScheduleToday={(t) => schedule(t, startOfDay(new Date()))}
            onOpen={openFocus}
          />
        )}
      </div>

      {planOpen && (
        <PlanDayPanel
          target={mode === "day" ? anchor : startOfDay(new Date())}
          dayStart={dayStart}
          dayEnd={dayEnd}
          capacityMins={capacityTarget}
          bufferMins={settings.bufferMins ?? 0}
          energyWindows={energyWindows}
          onClose={() => setPlanOpen(false)}
        />
      )}
    </div>
  );
}

// ── AI "Plan my day" review panel ────────────────────────────────────────────
function PlanDayPanel({
  target,
  dayStart,
  dayEnd,
  capacityMins,
  bufferMins,
  energyWindows,
  onClose,
}: {
  target: Date;
  dayStart: number;
  dayEnd: number;
  capacityMins: number;
  bufferMins: number;
  energyWindows: EnergyWindow[];
  onClose: () => void;
}) {
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
        await apiPlanDay({
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
          <Wand2 className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">
              Plan my day
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
  dayStart,
  dayEnd,
  energyWindows,
  onOpen,
  onUnschedule,
  reschedule,
}: {
  days: Date[];
  items: GtdItem[];
  dayStart: number;
  dayEnd: number;
  energyWindows: EnergyWindow[];
  onOpen: (id: string) => void;
  onUnschedule: (item: GtdItem) => void;
  reschedule: (id: string, start: Date, end: Date) => void;
}) {
  const hours = Array.from({ length: dayEnd - dayStart }, (_, i) => dayStart + i);
  const now = new Date();
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
              className={[
                "relative flex-1 border-l border-border",
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
                      onClick={() => onOpen(d.id)}
                      title={`Due today: ${d.title}`}
                      className="tech-transition truncate rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-left text-[10px] font-medium text-destructive hover:bg-destructive/20"
                    >
                      ⚑ {d.title}
                    </button>
                  ))}
                </div>
              )}

              {/* now line */}
              {today && nowTop >= 0 && nowTop <= gridHeight && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-primary"
                  style={{ top: nowTop }}
                >
                  <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-primary" />
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
                const leftPct = (lane / lanes) * 100;
                const widthPct = 100 / lanes;
                return (
                  <div
                    key={b.item.id}
                    draggable
                    onDragStart={(e) => onBlockDragStart(e, b)}
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
                      conflict
                        ? "border-destructive/60 bg-destructive/10"
                        : "border-primary/40 bg-primary/10",
                    ].join(" ")}
                  >
                    <button
                      type="button"
                      onClick={() => onOpen(b.item.id)}
                      className="block w-full truncate text-left text-[11px] font-medium text-foreground"
                    >
                      {b.item.title}
                    </button>
                    <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                      {b.start.toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {b.item.energy && (
                        <span className="capitalize">· {b.item.energy}</span>
                      )}
                    </div>
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
