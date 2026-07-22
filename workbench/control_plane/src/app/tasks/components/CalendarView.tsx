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
  Star,
  Sun,
  Moon,
  ExternalLink,
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
import { priorityRank } from "../lib/priority";
import {
  DEFAULT_BLOCK_MINS,
  startOfDay,
  addDays,
  sameDay,
  type Block,
  blocksForDay,
  firstFreeSlot,
} from "../lib/scheduling";
import { FocusMode } from "./FocusMode";
import { StartupRitual } from "./StartupRitual";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import {
  dayKey,
  loadFocusPrefs,
  oneThingIdFor,
  saveFocusPrefs,
  toggleOneThing,
} from "../lib/focusPrefs";

/** Truncated project-outcome lookup for the outcome ribbon on blocks. */
export type OutcomeById = Map<string, string>;

type Mode = "day" | "week" | "month";

const DAY_START_HOUR = 7; // grid window; energy-window config is P1
const DAY_END_HOUR = 22;
const HOUR_PX = 46;
const SOFT_CAPACITY_MINS = 6 * 60; // "you've booked >6h of focus" flag (P1 setting)

// ── date helpers (plain Date math; no date lib in the bundle). The core slot
// geometry (startOfDay/sameDay/addDays/blocksForDay/firstFreeSlot) lives in
// lib/scheduling.ts so the Schedule popup reuses the exact same logic. ────────
const addMonths = (d: Date, n: number) => {
  const x = startOfDay(d);
  x.setMonth(x.getMonth() + n, 1);
  return x;
};
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
  const projects = useTaskStore((s) => s.projects);
  const updateItem = useTaskStore((s) => s.updateItem);
  const applySchedule = useTaskStore((s) => s.applySchedule);
  const openSchedule = useTaskStore((s) => s.openSchedule);
  const requestDelete = useTaskStore((s) => s.requestDelete);
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
  // Focus Mode — the full-screen "Do" room for one block (F1). null = closed.
  const [focusModeId, setFocusModeId] = useState<string | null>(null);
  // Startup ritual (F0): the modal itself + the once-a-day offer banner. Both
  // resolve client-side from focusPrefs in an effect (localStorage isn't
  // available during SSR, and reading it in render would mismatch hydration).
  const [startupOpen, setStartupOpen] = useState(false);
  const [startupOffered, setStartupOffered] = useState(false);
  const [dayClosed, setDayClosed] = useState(false);
  // Today's ★ One Thing (per-day, prefs-backed). Re-read on the clock tick so
  // midnight rolls it over without a reload.
  const [oneThingId, setOneThingId] = useState<string | null>(null);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- prefs live in
       localStorage (client-only); reading them in render would mismatch the
       SSR hydration, so they resolve here on mount + the clock tick. */
    const prefs = loadFocusPrefs();
    setOneThingId(oneThingIdFor(new Date(), prefs));
    setStartupOffered(prefs.startupDoneOn !== dayKey());
    setDayClosed(prefs.dayClosedOn === dayKey());
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [now]);
  const handleToggleOneThing = (id: string) => {
    toggleOneThing(new Date(), id);
    setOneThingId((cur) => (cur === id ? null : id));
  };
  const oneThingItem = items.find((i) => i.id === oneThingId) ?? null;

  // project outcome lookup — the outcome ribbon on blocks (§4.7).
  const outcomeById: OutcomeById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.outcome])),
    [projects],
  );

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

  // Every scheduling mutation goes through applySchedule so it lands in the
  // undo toast — a mis-drag or stray unschedule is always one tap from safe.
  const schedule = (item: GtdItem, day: Date, at?: Date) => {
    const mins = item.timeEstimateMins ?? DEFAULT_BLOCK_MINS;
    const start =
      at ?? firstFreeSlot(blocksForDay(items, day), day, mins, dayStart, dayEnd);
    const end = new Date(start.getTime() + mins * 60000);
    applySchedule("Scheduled", [
      {
        id: item.id,
        patch: {
          scheduledStart: start.toISOString(),
          scheduledEnd: end.toISOString(),
        },
      },
    ]);
  };
  const unschedule = (item: GtdItem) =>
    applySchedule("Removed from calendar", [
      { id: item.id, patch: { scheduledStart: "", scheduledEnd: "" } },
    ]);
  // Move/resize a block to an exact start+end (drag-drop + resize commit here).
  const reschedule = (
    id: string,
    start: Date,
    end: Date,
    label = "Moved block",
  ) =>
    applySchedule(label, [
      {
        id,
        patch: {
          scheduledStart: start.toISOString(),
          scheduledEnd: end.toISOString(),
        },
      },
    ]);

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
  // The list itself feeds the startup ritual's carry-forward step.
  const overdueItems = useMemo(() => {
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
    );
  }, [items]);
  const overdueCount = overdueItems.length;

  // Leverage meter (80/20): of the focused day's booked focus-time, how much
  // sits on leveraged/important work (the ★ One Thing always counts — it IS
  // the 20%). Rendered beside the capacity meter.
  const leverageStats = useMemo(() => {
    const blocks = blocksForDay(items, anchor);
    const mins = (b: Block) => (b.end.getTime() - b.start.getTime()) / 60000;
    const total = blocks.reduce((n, b) => n + mins(b), 0);
    const lev = blocks
      .filter(
        (b) => b.item.leveraged || b.item.important || b.item.id === oneThingId,
      )
      .reduce((n, b) => n + mins(b), 0);
    return { totalMins: total, leveragedMins: lev };
  }, [items, anchor, oneThingId]);

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
      applySchedule(
        `Rolled ${res.blocks.length} block${res.blocks.length === 1 ? "" : "s"} into today`,
        res.blocks.map((b) => ({
          id: b.itemId,
          patch: { scheduledStart: b.start, scheduledEnd: b.end },
        })),
      );
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
        {/* Actions: share the row with the title on desktop (ml-auto), but on
            mobile take a FULL second row so the pills never get squeezed into
            wrapping against the date. */}
        <div className="relative flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          {dueSoon.length > 0 && (
            <span
              title={`${dueSoon.length} unscheduled task(s) due within 2 weeks`}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning"
            >
              <AlertTriangle className="h-3 w-3" />
              {dueSoon.length} due soon
            </span>
          )}
          {/* (Re)start the day — the ritual is never locked out: skipped the
              morning banner, or want to re-pick the One Thing? Run it again. */}
          {!dayClosed && (
            <button
              type="button"
              onClick={() => setStartupOpen(true)}
              title="Start (or restart) your day — breathe · review · commit the One Thing"
              className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            >
              <Sun className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Start day</span>
            </button>
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
          <div className="ml-auto flex rounded-lg bg-secondary p-0.5 text-xs sm:ml-0">
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
        onStart={(item) => {
          startFocus(item);
          setFocusModeId(item.id);
        }}
        onFillGap={() => {
          // idle gap → the Gap Filler sheet, anchored to right now
          const at = new Date(Math.ceil(Date.now() / 300000) * 300000);
          setSheet({ day: startOfDay(new Date()), at });
        }}
      />

      {/* Startup ritual offer — once per local day, dismissible. Habits form
          around rituals; the banner invites, it never ambushes. */}
      {startupOffered && !startupOpen && !dayClosed && (
        <div className="flex items-center gap-2 border-b border-border bg-warning/5 px-4 py-2 text-[12px]">
          <Sun className="h-4 w-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-foreground">
            Start your day — breathe · review · commit the One Thing.
          </span>
          <button
            type="button"
            onClick={() => setStartupOpen(true)}
            className="tech-transition shrink-0 rounded-md bg-warning/20 px-2.5 py-1 font-medium text-warning hover:bg-warning/30"
          >
            Begin (5 min)
          </button>
          <button
            type="button"
            onClick={() => {
              saveFocusPrefs({ startupDoneOn: dayKey() });
              setStartupOffered(false);
            }}
            className="tech-transition shrink-0 rounded-md px-2 py-1 text-muted-foreground hover:text-foreground"
          >
            Skip
          </button>
        </div>
      )}

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
              oneThingId={oneThingId}
              outcomeById={outcomeById}
              onToggleOneThing={handleToggleOneThing}
              onFocusMode={(item) => {
                if (!item.actualStart || item.actualEnd) startFocus(item);
                setFocusModeId(item.id);
              }}
              onOpen={openFocus}
              onUnschedule={unschedule}
              onComplete={completeBlock}
              reschedule={reschedule}
              onPickSlot={(day, at) => setSheet({ day, at })}
              onSetFlexible={(item, flexible) =>
                updateItem(item.id, { flexible })
              }
              onReschedulePopup={openSchedule}
              onDelete={(id) => requestDelete([id])}
            />
          )}
        </div>

        {/* Unscheduled rail — click a task to timebox it into the focused day.
            Hidden in month mode. */}
        {mode !== "month" && (
          <UnscheduledRail
            tasks={unscheduled}
            capacityMins={leverageStats.totalMins}
            capacityTarget={capacityTarget}
            leveragedMins={leverageStats.leveragedMins}
            oneThingId={oneThingId}
            onToggleOneThing={handleToggleOneThing}
            dueSoon={dueSoon}
            urgentWindowHours={settings.urgentWindowHours}
            doneStats={doneStats}
            onPlan={() => setPlanMode("plan")}
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
          items={items}
          dueSoon={dueSoon}
          urgentWindowHours={settings.urgentWindowHours}
          dayEndHour={dayEnd}
          onSchedule={(t, at) => {
            schedule(t, sheet.day, at);
            setSheet(null);
            // Scheduling INTO the live moment flows straight into the Focus
            // room — the Gap Filler's zero-ceremony start (§4.5).
            if (at && Math.abs(at.getTime() - Date.now()) < 5 * 60000) {
              startFocus(t);
              setFocusModeId(t.id);
            }
          }}
          onDoNow={(t) => quickDispose(t.id, "DONE")}
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
          oneThingId={oneThingId}
          urgentWindowHours={settings.urgentWindowHours}
          onOpen={openFocus}
          onCloseDay={() => {
            setDayClosed(true);
            setReviewOpen(false);
          }}
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
          extraNote={
            oneThingItem
              ? `The user's ONE Thing for today (top priority): "${oneThingItem.title}" — place it in the first high-energy window and protect it.`
              : undefined
          }
          onClose={() => setPlanMode(null)}
        />
      )}

      {startupOpen && (
        <StartupRitual
          items={items}
          urgentWindowHours={settings.urgentWindowHours}
          carryForward={overdueItems}
          rolling={rolling}
          onRollover={() => void rollOver()}
          onPlan={() => setPlanMode("plan")}
          onClose={() => {
            setStartupOpen(false);
            setStartupOffered(false);
            setOneThingId(oneThingIdFor(new Date()));
          }}
        />
      )}

      {focusModeId && (
        <FocusMode itemId={focusModeId} onClose={() => setFocusModeId(null)} />
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
  onFillGap,
}: {
  now: Date;
  items: GtdItem[];
  onOpen: (id: string) => void;
  onComplete: (item: GtdItem) => void;
  /** enter the Focus room for the current block (stamps actualStart). */
  onStart: (item: GtdItem) => void;
  /** open right now with nothing scheduled → the Gap Filler (§4.5). */
  onFillGap: () => void;
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
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStart(current.item);
              }}
              aria-label="Enter Focus Mode"
              title={
                running
                  ? "Re-enter the Focus room"
                  : "Focus — full-screen room + timer (tracks how long this actually takes)"
              }
              className="tech-transition flex h-5 shrink-0 items-center gap-1 rounded-full border border-primary/50 px-2 text-[10px] font-semibold text-primary hover:bg-primary/10"
            >
              <Play className="h-2.5 w-2.5" fill="currentColor" />
              Focus
            </button>
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
            onClick={onFillGap}
            title="See what fits in this gap — 2-minute pile first"
            className="min-w-0 flex-1 truncate text-left text-[12px] text-muted-foreground hover:text-foreground"
          >
            Open right now —{" "}
            <span className="font-medium text-primary">
              fill the gap with quick wins?
            </span>
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

// ── End-of-day review / shutdown ─────────────────────────────────────────────
// A 2-minute reflection (calendar_ux_review §3 P3, extended per
// calendar_focus_os.md §4.2): what got DONE (celebrated, with planned-vs-
// actual), the leverage ratio (80/20 scoreboard), the One-Thing verdict, what
// carries FORWARD (framed kindly), estimate trends — and "seed tomorrow", the
// ≤3 picks that pre-load tomorrow's startup ritual. "Close the day" is the
// explicit permission-to-stop end state.
function EndOfDayReview({
  now,
  items,
  oneThingId,
  urgentWindowHours,
  onOpen,
  onCloseDay,
  onClose,
}: {
  now: Date;
  items: GtdItem[];
  oneThingId: string | null;
  urgentWindowHours: number;
  onOpen: (id: string) => void;
  /** "Close the day" — persists tomorrow's seeds + the closed stamp. */
  onCloseDay: () => void;
  onClose: () => void;
}) {
  const [stats, setStats] = useState<EstimateStats | null>(null);
  const [seedIds, setSeedIds] = useState<string[]>([]);
  const toggleSeed = (id: string) =>
    setSeedIds((cur) =>
      cur.includes(id)
        ? cur.filter((x) => x !== id)
        : cur.length >= 3
          ? cur
          : [...cur, id],
    );
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
  const doneMins = done.reduce(
    (n, b) => n + (b.end.getTime() - b.start.getTime()) / 60000,
    0,
  );
  const doneHrs = Math.round((doneMins / 60) * 10) / 10;
  // Leverage ratio — done-hours can flatter a busy, pointless day; this can't.
  const leveragedDoneMins = done
    .filter(
      (b) => b.item.leveraged || b.item.important || b.item.id === oneThingId,
    )
    .reduce((n, b) => n + (b.end.getTime() - b.start.getTime()) / 60000, 0);
  const leveragePct =
    doneMins > 0 ? Math.round((leveragedDoneMins / doneMins) * 100) : null;
  // One-Thing verdict: if it got done, the day was a win regardless of the rest.
  const oneThing = oneThingId
    ? items.find((i) => i.id === oneThingId) ?? null
    : null;
  const oneThingDone = oneThing?.disposition === "DONE";
  // Seed-tomorrow candidates: today's unfinished blocks first, then the
  // highest-ranked unscheduled next actions. Up to 6 choices, ≤3 picks.
  const seedCandidates: GtdItem[] = (() => {
    const seen = new Set<string>();
    const out: GtdItem[] = [];
    for (const b of unfinished) {
      if (!seen.has(b.item.id)) {
        seen.add(b.item.id);
        out.push(b.item);
      }
    }
    const pool = items
      .filter(
        (i) =>
          i.disposition === "NEXT" &&
          i.isMine &&
          !i.archivedAt &&
          !i.scheduledStart &&
          !seen.has(i.id),
      )
      .sort(
        (a, b) =>
          priorityRank(a, urgentWindowHours) - priorityRank(b, urgentWindowHours),
      );
    return [...out, ...pool].slice(0, 6);
  })();
  const closeDay = () => {
    saveFocusPrefs({
      seeds: { date: dayKey(addDays(now, 1)), ids: seedIds },
      dayClosedOn: dayKey(now),
    });
    onCloseDay();
  };
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
          {/* At-a-glance tally — done · leverage ratio · carry forward */}
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
              <div className="text-lg font-semibold tabular-nums text-amber-500">
                {leveragePct == null ? "—" : `${leveragePct}%`}
              </div>
              <div className="text-[10px] text-muted-foreground">leveraged</div>
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

          {/* One-Thing verdict */}
          {oneThing && (
            <div
              className={[
                "mb-3 flex items-center gap-2 rounded-lg border p-2.5 text-[12px]",
                oneThingDone
                  ? "border-amber-500/40 bg-amber-500/10 text-foreground"
                  : "border-border bg-background/60 text-muted-foreground",
              ].join(" ")}
            >
              <Star
                className={[
                  "h-4 w-4 shrink-0",
                  oneThingDone
                    ? "fill-amber-400 text-amber-400"
                    : "text-amber-500/60",
                ].join(" ")}
              />
              {oneThingDone ? (
                <span>
                  <span className="font-semibold">One Thing done</span> —{" "}
                  {oneThing.title}. That was the day.
                </span>
              ) : (
                <span>
                  One Thing still open — {oneThing.title}. Seed it for tomorrow?
                </span>
              )}
            </div>
          )}

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

        {/* Seed tomorrow — ≤3 picks pre-load the morning startup ritual, so
            planning tomorrow takes 5 minutes, not 20. */}
        {seedCandidates.length > 0 && (
          <div className="border-t border-border px-4 py-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Seed tomorrow · pick up to 3
            </p>
            <div className="flex flex-wrap gap-1.5">
              {seedCandidates.map((c) => {
                const on = seedIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleSeed(c.id)}
                    className={[
                      "tech-transition max-w-full truncate rounded-full border px-2.5 py-1 text-[11px] font-medium",
                      on
                        ? "border-primary/50 bg-primary/15 text-primary"
                        : "border-border bg-secondary/60 text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                  >
                    {on ? "✓ " : ""}
                    {c.title}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-[12px] font-medium text-muted-foreground hover:text-foreground"
          >
            Not yet
          </button>
          <button
            type="button"
            onClick={closeDay}
            title="Save tomorrow's seeds and end the work day — permission to stop"
            className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[12px] font-medium text-primary-foreground hover:opacity-90"
          >
            <Moon className="h-3.5 w-3.5" />
            Close the day
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Schedule sheet / Gap Filler (mobile + tap-to-schedule) ──────────────────
// Touch devices have no HTML5 drag-and-drop and the unscheduled rail is
// desktop-only, so on a phone you could view but barely schedule. This
// bottom-anchored sheet is the mobile path — and also what a tap on an empty
// grid slot opens on any device. With `at` set it becomes the GAP FILLER
// (calendar_focus_os.md §4.5): it measures the free minutes until the next
// block and answers "you have N minutes — here's what fits": the 2-minute
// pile first (done on the spot, tip 9 — never scheduled individually), then
// tasks whose estimate fits the gap, ranked by the priority matrix.
function ScheduleSheet({
  day,
  at,
  tasks,
  items,
  dueSoon,
  urgentWindowHours,
  dayEndHour,
  onSchedule,
  onDoNow,
  onPlan,
  onClose,
}: {
  day: Date;
  at?: Date;
  tasks: GtdItem[];
  /** full store rows — for measuring the gap against the day's blocks. */
  items: GtdItem[];
  dueSoon: { item: GtdItem; days: number }[];
  urgentWindowHours: number;
  dayEndHour: number;
  onSchedule: (t: GtdItem, at?: Date) => void;
  /** the 2-minute rule: just do it — mark done without ever scheduling. */
  onDoNow: (t: GtdItem) => void;
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
  // Track 2-minute tasks done from this sheet so they collapse in place — the
  // satisfying "clear the pile" loop instead of rows vanishing abruptly.
  const [clearedIds, setClearedIds] = useState<string[]>([]);

  // ── the gap: free minutes from `at` until the next block (or day end) ──────
  const gap = useMemo(() => {
    if (!at) return null;
    const atMs = at.getTime();
    const nextBlock = blocksForDay(items, day).find(
      (b) => b.item.disposition !== "DONE" && b.start.getTime() > atMs,
    );
    const dayEndAt = new Date(day);
    dayEndAt.setHours(dayEndHour, 0, 0, 0);
    const until = nextBlock ? nextBlock.start : dayEndAt;
    const mins = Math.max(0, Math.round((until.getTime() - atMs) / 60000));
    return {
      mins,
      untilLabel: nextBlock ? nextBlock.item.title : "end of day",
    };
  }, [at, items, day, dayEndHour]);

  // The 2-minute pile: flagged at clarify, or tiny by estimate.
  const twoMinute = useMemo(
    () =>
      tasks.filter(
        (t) =>
          !clearedIds.includes(t.id) &&
          (t.isTwoMinute || (t.timeEstimateMins != null && t.timeEstimateMins <= 5)),
      ),
    [tasks, clearedIds],
  );
  const twoMinIds = useMemo(
    () => new Set(twoMinute.map((t) => t.id)),
    [twoMinute],
  );
  // Everything else, ranked by the matrix; split around the gap when known.
  const ranked = useMemo(
    () =>
      tasks
        .filter((t) => !twoMinIds.has(t.id) && !clearedIds.includes(t.id))
        .sort(
          (a, b) =>
            priorityRank(a, urgentWindowHours) -
            priorityRank(b, urgentWindowHours),
        ),
    [tasks, twoMinIds, clearedIds, urgentWindowHours],
  );
  const fits = gap
    ? ranked.filter((t) => (t.timeEstimateMins ?? DEFAULT_BLOCK_MINS) <= gap.mins)
    : ranked;
  const tooLong = gap
    ? ranked.filter((t) => (t.timeEstimateMins ?? DEFAULT_BLOCK_MINS) > gap.mins)
    : [];
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
              {gap
                ? `${gap.mins} min until ${gap.untilLabel}`
                : "Schedule a task"}
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {dayLabel}
              {at ? ` · from ${fmtClock(at)}` : " · first free slot"}
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
              {/* the 2-minute pile — do, don't schedule (tip 9) */}
              {twoMinute.length > 0 && (
                <>
                  <p className="mb-1 flex items-center gap-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    <Zap className="h-3 w-3" /> 2-minute pile ({twoMinute.length})
                    — just do it
                  </p>
                  <div className="mb-2.5 flex flex-col gap-1">
                    {twoMinute.map((t) => (
                      <div
                        key={t.id}
                        className="flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 p-2 pl-2.5"
                      >
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                          {t.title}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setClearedIds((c) => [...c, t.id]);
                            onDoNow(t);
                          }}
                          title="Done — no scheduling ceremony for small wins"
                          className="tech-transition inline-flex shrink-0 items-center gap-1 rounded-md bg-success/15 px-2 py-1 text-[11px] font-medium text-success hover:bg-success/25"
                        >
                          <Check className="h-3 w-3" strokeWidth={3} />
                          Done
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {fits.length > 0 && (
                <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {gap ? `Fits in ${gap.mins} min` : "Unscheduled"} ({fits.length})
                </p>
              )}
              <div className="flex flex-col gap-1.5">
                {fits.map((t) => {
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
                          {t.leveraged && (
                            <span className="text-amber-500">★ </span>
                          )}
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
                        {gap ? (
                          <>
                            <Play className="h-3 w-3" fill="currentColor" />
                            Start
                          </>
                        ) : (
                          <>
                            <CalendarPlus className="h-3.5 w-3.5" />
                            {at ? fmtClock(at) : "Timebox"}
                          </>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* longer than the gap — visible (so nothing feels hidden) but
                  quiet; scheduling one anyway is allowed, eyes open. */}
              {tooLong.length > 0 && (
                <>
                  <p className="mb-1 mt-3 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    Longer than the gap ({tooLong.length})
                  </p>
                  <div className="flex flex-col gap-1">
                    {tooLong.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onSchedule(t, at)}
                        className="tech-transition flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 p-2 text-left opacity-70 hover:opacity-100"
                      >
                        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                          {t.title}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-warning">
                          {durationLabel(t.timeEstimateMins ?? DEFAULT_BLOCK_MINS)}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
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
  extraNote,
  onClose,
}: {
  mode?: "plan" | "replan";
  target: Date;
  dayStart: number;
  dayEnd: number;
  capacityMins: number;
  bufferMins: number;
  energyWindows: EnergyWindow[];
  /** standing guidance appended to every run — e.g. the ★ One Thing directive
   *  (protect it in the first peak window). Rides the existing energy_note
   *  seam so no backend change is needed. */
  extraNote?: string;
  onClose: () => void;
}) {
  const isReplan = mode === "replan";
  const applySchedule = useTaskStore((s) => s.applySchedule);
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
          energy_note:
            [n.trim(), extraNote].filter(Boolean).join(" ") || undefined,
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
    applySchedule(
      `Planned ${plan.blocks.length} block${plan.blocks.length === 1 ? "" : "s"}`,
      plan.blocks.map((b) => ({
        id: b.itemId,
        patch: { scheduledStart: b.start, scheduledEnd: b.end },
      })),
    );
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
  oneThingId,
  outcomeById,
  onToggleOneThing,
  onFocusMode,
  onOpen,
  onUnschedule,
  onComplete,
  reschedule,
  onPickSlot,
  onSetFlexible,
  onReschedulePopup,
  onDelete,
}: {
  days: Date[];
  items: GtdItem[];
  now: Date;
  dayStart: number;
  dayEnd: number;
  energyWindows: EnergyWindow[];
  /** today's ★ One Thing (gold, protected-feeling) — null when unset. */
  oneThingId: string | null;
  outcomeById: OutcomeById;
  onToggleOneThing: (id: string) => void;
  /** enter the full-screen Focus room for a block. */
  onFocusMode: (item: GtdItem) => void;
  onOpen: (id: string) => void;
  onUnschedule: (item: GtdItem) => void;
  onComplete: (item: GtdItem) => void;
  reschedule: (id: string, start: Date, end: Date, label?: string) => void;
  /** Tap an empty grid slot → schedule a task at that snapped time. */
  onPickSlot: (day: Date, at: Date) => void;
  /** Pin (false) / unpin (true) a block so the auto-mover skips / includes it. */
  onSetFlexible: (item: GtdItem, flexible: boolean) => void;
  /** "Reschedule…" → the global Schedule popup (date/time picker + Unschedule). */
  onReschedulePopup: (id: string) => void;
  /** "Delete task…" → the store's confirm-first delete flow. */
  onDelete: (id: string) => void;
}) {
  const hours = Array.from({ length: dayEnd - dayStart }, (_, i) => dayStart + i);
  const gridHeight = hours.length * HOUR_PX;
  // Live resize (transient end while dragging the handle) + drop-target column.
  const [resizing, setResizing] = useState<{ id: string; endMs: number } | null>(null);
  const resizingRef = useRef(false); // suppress the native block-drag while resizing
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  // Block context menu — right-click on desktop, LONG-PRESS on touch (the
  // hover micro-buttons don't exist on a phone, so this menu IS the mobile
  // path to unschedule / pin / star / focus / reschedule / delete).
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    item: GtdItem;
    day: Date;
  } | null>(null);
  const lpTimer = useRef<number | null>(null);
  const lpFired = useRef(false);
  const startLongPress = (e: React.PointerEvent, item: GtdItem, day: Date) => {
    if (e.pointerType === "mouse") return; // mouse has real right-click
    const { clientX, clientY } = e;
    lpFired.current = false;
    lpTimer.current = window.setTimeout(() => {
      lpFired.current = true;
      setCtx({ x: clientX, y: clientY, item, day });
    }, 450);
  };
  const cancelLongPress = () => {
    if (lpTimer.current != null) {
      clearTimeout(lpTimer.current);
      lpTimer.current = null;
    }
  };

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
    // Honest undo label: a rail card lands as "Scheduled", an existing block
    // as "Moved block".
    const wasScheduled = !!items.find((i) => i.id === p.id)?.scheduledStart;
    reschedule(
      p.id,
      start,
      new Date(start.getTime() + p.durationMins * 60000),
      wasScheduled ? "Moved block" : "Scheduled",
    );
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
      reschedule(
        b.item.id,
        new Date(startMs),
        new Date(clampEnd(ev.clientY)),
        "Resized block",
      );
      setResizing(null);
      // Release AFTER the trailing click event, so finishing a resize doesn't
      // also open the task card (the block's click handler checks this ref).
      window.setTimeout(() => {
        resizingRef.current = false;
      }, 0);
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
                style={{ minWidth: 96 }}
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
              // Week view on a phone: 7 columns keep a readable minimum width
              // and the grid scrolls horizontally instead of crushing blocks.
              style={{
                height: gridHeight,
                minWidth: days.length > 1 ? 96 : undefined,
              }}
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
                // Leverage lens (80/20): leveraged work reads gold at a glance;
                // the ★ One Thing gets the strongest treatment on the grid.
                const isOneThing = b.item.id === oneThingId && !isDone;
                const isLeveraged =
                  !isDone && !conflict && (b.item.leveraged || isOneThing);
                const outcome = b.item.projectId
                  ? outcomeById.get(b.item.projectId)
                  : undefined;
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
                    onClick={(e) => {
                      // Click anywhere on the block → open the task card
                      // (controls stopPropagation; drag/resize never emit a
                      // plain click). stopPropagation keeps the day column's
                      // empty-slot tap from also firing.
                      e.stopPropagation();
                      if (resizingRef.current) return; // trailing resize click
                      onOpen(b.item.id);
                    }}
                    onClickCapture={(e) => {
                      // a long-press already opened the menu — swallow the
                      // click that follows so it doesn't also open the task
                      if (lpFired.current) {
                        e.preventDefault();
                        e.stopPropagation();
                        lpFired.current = false;
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCtx({ x: e.clientX, y: e.clientY, item: b.item, day });
                    }}
                    onPointerDown={(e) => startLongPress(e, b.item, day)}
                    onPointerMove={cancelLongPress}
                    onPointerUp={cancelLongPress}
                    onPointerCancel={cancelLongPress}
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
                          : isOneThing
                            ? "border-amber-400/80 bg-amber-500/15 shadow-[0_0_12px_rgba(245,158,11,0.18)]"
                            : isLeveraged
                              ? "border-amber-500/50 bg-amber-500/10"
                              : isNow
                                ? "border-primary bg-primary/20"
                                : "border-primary/40 bg-primary/10",
                      isNow
                        ? "z-10 ring-2 ring-primary ring-offset-1 ring-offset-background shadow-md"
                        : "",
                      // A pinned block gets a solid left accent so "this won't
                      // move" is glanceable, not only on the lock icon.
                      isFixed && !isDone ? "border-l-2 border-l-primary" : "",
                      // Leveraged work carries a gold left edge even when other
                      // states (now/fixed) win the fill.
                      isLeveraged && !isFixed
                        ? "border-l-2 border-l-amber-400"
                        : "",
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
                        {isOneThing && (
                          <span className="text-amber-400">★ </span>
                        )}
                        {b.item.title}
                      </button>
                    </div>
                    {/* outcome ribbon — why this block matters (tall blocks) */}
                    {outcome && mins >= 45 && (
                      <div className="truncate pr-3 text-[9px] font-medium text-amber-500/90">
                        → {outcome}
                      </div>
                    )}
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
                    {/* ▶ enter the Focus room. Always visible on the current
                        block (the one you should be in), hover elsewhere. */}
                    {!isDone && (
                      <button
                        type="button"
                        aria-label="Focus on this block"
                        title="Focus — full-screen room + timer"
                        onClick={(e) => {
                          e.stopPropagation();
                          onFocusMode(b.item);
                        }}
                        className={[
                          "tech-transition absolute right-[54px] top-0.5 rounded p-0.5",
                          isNow
                            ? "text-primary hover:bg-black/10"
                            : "text-muted-foreground opacity-0 hover:bg-black/10 hover:text-primary group-hover:opacity-100",
                        ].join(" ")}
                      >
                        <Play className="h-3 w-3" fill="currentColor" />
                      </button>
                    )}
                    {/* ★ commit / uncommit the One Thing (today only). */}
                    {!isDone && sameDay(day, now) && (
                      <button
                        type="button"
                        aria-label={
                          isOneThing ? "Unset the One Thing" : "Make this the One Thing"
                        }
                        title={
                          isOneThing
                            ? "Your One Thing today. Click to unset."
                            : "If only one thing gets done today… make it this."
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleOneThing(b.item.id);
                        }}
                        className={[
                          "tech-transition absolute right-[36px] top-0.5 rounded p-0.5",
                          isOneThing
                            ? "text-amber-400 hover:bg-black/10"
                            : "text-muted-foreground opacity-0 hover:bg-black/10 hover:text-amber-400 group-hover:opacity-100",
                        ].join(" ")}
                      >
                        <Star
                          className="h-3 w-3"
                          fill={isOneThing ? "currentColor" : "none"}
                        />
                      </button>
                    )}
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
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnschedule(b.item);
                      }}
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

      {/* block context menu (right-click / long-press) */}
      {ctx &&
        (() => {
          const it = ctx.item;
          const isDone = it.disposition === "DONE";
          const isFixed = it.flexible === false;
          const isOT = it.id === oneThingId;
          const today = sameDay(ctx.day, now);
          const menu: CtxItem[] = [
            {
              kind: "item",
              label: "Open task",
              icon: ExternalLink,
              onSelect: () => onOpen(it.id),
            },
            ...(!isDone
              ? [
                  {
                    kind: "item",
                    label: "Focus on this",
                    icon: Play,
                    onSelect: () => onFocusMode(it),
                  } as CtxItem,
                ]
              : []),
            {
              kind: "item",
              label: isDone ? "Mark not done" : "Mark done",
              icon: Check,
              onSelect: () => onComplete(it),
            },
            { kind: "sep" },
            ...(!isDone && today
              ? [
                  {
                    kind: "item",
                    label: isOT ? "Unset One Thing" : "Make it the One Thing",
                    icon: Star,
                    checked: isOT,
                    onSelect: () => onToggleOneThing(it.id),
                  } as CtxItem,
                ]
              : []),
            ...(!isDone
              ? [
                  {
                    kind: "item",
                    label: isFixed
                      ? "Make flexible (auto-moves)"
                      : "Pin as fixed (won't move)",
                    icon: isFixed ? Unlock : Lock,
                    checked: isFixed,
                    onSelect: () => onSetFlexible(it, isFixed),
                  } as CtxItem,
                ]
              : []),
            { kind: "sep" },
            {
              kind: "item",
              label: "Reschedule…",
              icon: CalendarClock,
              onSelect: () => onReschedulePopup(it.id),
            },
            {
              kind: "item",
              label: "Remove from calendar",
              icon: X,
              onSelect: () => onUnschedule(it),
            },
            {
              kind: "item",
              label: "Delete task…",
              icon: Trash2,
              danger: true,
              onSelect: () => onDelete(it.id),
            },
          ];
          return (
            <ContextMenu
              x={ctx.x}
              y={ctx.y}
              items={menu}
              onClose={() => setCtx(null)}
            />
          );
        })()}
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
  capacityMins,
  capacityTarget,
  leveragedMins,
  oneThingId,
  onToggleOneThing,
  dueSoon,
  urgentWindowHours,
  doneStats,
  onPlan,
  onOpen,
}: {
  tasks: GtdItem[];
  capacityMins: number;
  capacityTarget: number;
  /** of the booked minutes, how many sit on leveraged/important work (80/20). */
  leveragedMins: number;
  oneThingId: string | null;
  onToggleOneThing: (id: string) => void;
  /** approaching deadlines — rendered as a badge + sort boost ON the normal
   *  cards (one list, no duplication; every card drags + timeboxes alike). */
  dueSoon: { item: GtdItem; days: number }[];
  urgentWindowHours: number;
  doneStats: { count: number; mins: number };
  onPlan: () => void;
  onOpen: (id: string) => void;
}) {
  const over = capacityMins > capacityTarget;
  const leveragePct =
    capacityMins > 0 ? Math.round((leveragedMins / capacityMins) * 100) : 0;
  // ONE list: ★ One Thing first, then approaching deadlines (soonest first),
  // then the rest by the priority matrix. Deadline pressure is a property of
  // a card, not a separate pile.
  const dueDays = new Map(dueSoon.map((d) => [d.item.id, d.days]));
  const ordered = [...tasks].sort((a, b) => {
    const oa = a.id === oneThingId ? 0 : 1;
    const ob = b.id === oneThingId ? 0 : 1;
    if (oa !== ob) return oa - ob;
    const da = dueDays.get(a.id) ?? Infinity;
    const db = dueDays.get(b.id) ?? Infinity;
    if (da !== db) return da - db;
    return (
      priorityRank(a, urgentWindowHours) - priorityRank(b, urgentWindowHours)
    );
  });
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-l border-border bg-card md:flex">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
          <CalendarPlus className="h-3.5 w-3.5 text-primary" />
          Unscheduled
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          Drag a card onto the grid to timebox it · click to open.
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
        {/* leverage meter (80/20): how much of the booked day is the 20% */}
        {capacityMins > 0 && (
          <div
            className="mt-0.5 text-[10px] text-amber-500"
            title="Share of booked focus-time on leveraged/important work (the 80/20 scoreboard)"
          >
            ★ {Math.round((leveragedMins / 60) * 10) / 10}h leveraged ·{" "}
            {leveragePct}%
            <span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-secondary">
              <span
                className="block h-full rounded-full bg-amber-400/80"
                style={{ width: `${Math.min(100, leveragePct)}%` }}
              />
            </span>
          </div>
        )}
        {doneStats.count > 0 && (
          <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium text-success">
            <Check className="h-3 w-3" />
            {doneStats.count} done ·{" "}
            {Math.round((doneStats.mins / 60) * 10) / 10}h
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {tasks.length === 0 ? (
          <p className="px-1 py-4 text-center text-[11px] text-muted-foreground">
            Nothing to schedule — inbox zero on next actions. 🎉
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {ordered.map((t) => (
              <div
                key={t.id}
                draggable
                // Same grammar as a calendar block: CLICK opens the task card,
                // CLICK-AND-HOLD drags it onto the grid at the slot you want.
                // (A completed drag never emits the click.)
                onClick={() => onOpen(t.id)}
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
                className={[
                  "group cursor-grab rounded-md border p-2 active:cursor-grabbing",
                  t.id === oneThingId
                    ? "border-amber-400/70 bg-amber-500/10"
                    : t.leveraged
                      ? "border-amber-500/40 bg-background/60 hover:border-amber-400/60"
                      : dueDays.has(t.id)
                        ? "border-warning/40 bg-warning/5 hover:border-warning/70"
                        : "border-border bg-background/60 hover:border-primary/40",
                ].join(" ")}
              >
                <div className="flex items-start gap-1">
                  <span className="min-w-0 flex-1 truncate text-left text-[12px] text-foreground">
                    {t.id === oneThingId && (
                      <span className="text-amber-400">★ </span>
                    )}
                    {t.title}
                  </span>
                  <button
                    type="button"
                    aria-label={
                      t.id === oneThingId
                        ? "Unset the One Thing"
                        : "Make this the One Thing"
                    }
                    title={
                      t.id === oneThingId
                        ? "Your One Thing today. Click to unset."
                        : "If only one thing gets done today… make it this."
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleOneThing(t.id);
                    }}
                    className={[
                      "tech-transition shrink-0 rounded p-0.5",
                      t.id === oneThingId
                        ? "text-amber-400"
                        : "text-muted-foreground/60 opacity-0 hover:text-amber-400 group-hover:opacity-100",
                    ].join(" ")}
                  >
                    <Star
                      className="h-3 w-3"
                      fill={t.id === oneThingId ? "currentColor" : "none"}
                    />
                  </button>
                </div>
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
                  {dueDays.has(t.id) && (
                    <span
                      className={[
                        "inline-flex items-center gap-0.5 font-medium",
                        (dueDays.get(t.id) as number) <= 1
                          ? "text-destructive"
                          : "text-warning",
                      ].join(" ")}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      {(dueDays.get(t.id) as number) <= 0
                        ? "due today"
                        : dueDays.get(t.id) === 1
                          ? "due tomorrow"
                          : `due in ${dueDays.get(t.id)}d`}
                    </span>
                  )}
                </div>
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
