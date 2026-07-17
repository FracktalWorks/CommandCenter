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

import { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  Zap,
  X,
  Sparkles,
  CalendarPlus,
} from "lucide-react";
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

/** First 30-min-aligned free slot on `day` at/after the window start (or now, if
 *  today), that fits `mins` without overlapping an existing block. */
function firstFreeSlot(dayBlocks: Block[], day: Date, mins: number): Date {
  const now = new Date();
  const earliest = new Date(day);
  earliest.setHours(DAY_START_HOUR, 0, 0, 0);
  if (sameDay(day, now) && now > earliest) {
    // round up to the next 30
    const m = now.getMinutes();
    earliest.setHours(now.getHours(), m <= 30 ? 30 : 60, 0, 0);
  }
  const dayEnd = new Date(day);
  dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);
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
  const [mode, setMode] = useState<Mode>("day");
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));

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
    const start = at ?? firstFreeSlot(blocksForDay(items, day), day, mins);
    const end = new Date(start.getTime() + mins * 60000);
    updateItem(item.id, {
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
    });
  };
  const unschedule = (item: GtdItem) =>
    updateItem(item.id, { scheduledStart: "", scheduledEnd: "" });

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
        <div className="ml-auto flex rounded-lg bg-secondary p-0.5 text-xs">
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
      </div>

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
              onOpen={openFocus}
              onUnschedule={unschedule}
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
            onSchedule={(t) => schedule(t, mode === "week" ? startOfWeek(anchor) : anchor)}
            onOpen={openFocus}
          />
        )}
      </div>
    </div>
  );
}

// ── Day / Week hour grid ─────────────────────────────────────────────────────
function TimeGrid({
  days,
  items,
  onOpen,
  onUnschedule,
}: {
  days: Date[];
  items: GtdItem[];
  onOpen: (id: string) => void;
  onUnschedule: (item: GtdItem) => void;
}) {
  const hours = Array.from(
    { length: DAY_END_HOUR - DAY_START_HOUR },
    (_, i) => DAY_START_HOUR + i,
  );
  const now = new Date();
  const gridHeight = hours.length * HOUR_PX;

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
          const nowTop =
            ((minutesInto(now) - DAY_START_HOUR * 60) / 60) * HOUR_PX;
          return (
            <div
              key={day.toISOString()}
              className="relative flex-1 border-l border-border"
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

              {/* scheduled blocks */}
              {blocks.map((b) => {
                const top =
                  ((minutesInto(b.start) - DAY_START_HOUR * 60) / 60) * HOUR_PX;
                const mins = (b.end.getTime() - b.start.getTime()) / 60000;
                const height = Math.max(20, (mins / 60) * HOUR_PX - 2);
                return (
                  <div
                    key={b.item.id}
                    style={{ top: Math.max(0, top), height }}
                    className="group absolute inset-x-1 overflow-hidden rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-left"
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
  onSchedule,
  onOpen,
}: {
  tasks: GtdItem[];
  focusedDayLabel: string;
  capacityMins: number;
  onSchedule: (t: GtdItem) => void;
  onOpen: (id: string) => void;
}) {
  const over = capacityMins > SOFT_CAPACITY_MINS;
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-l border-border bg-card md:flex">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
          <CalendarPlus className="h-3.5 w-3.5 text-primary" />
          Unscheduled
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          Click to timebox into {focusedDayLabel}.
        </p>
        <div
          className={[
            "mt-1 text-[10px]",
            over ? "font-medium text-warning" : "text-muted-foreground",
          ].join(" ")}
        >
          {Math.round((capacityMins / 60) * 10) / 10}h booked
          {over ? " — heavy day" : ""}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {tasks.length === 0 ? (
          <p className="px-1 py-4 text-center text-[11px] text-muted-foreground">
            Nothing to schedule — inbox zero on next actions. 🎉
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {tasks.map((t) => (
              <div
                key={t.id}
                className="group rounded-md border border-border bg-background/60 p-2 hover:border-primary/40"
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
      {/* Chat-with-calendar + plan-my-day seam (P2). */}
      <div className="border-t border-border p-2">
        <button
          type="button"
          disabled
          title="Coming soon: the assistant plans your day around energy + deadlines (spec P2)"
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-2 text-[11px] font-medium text-muted-foreground/70"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Plan my day (soon)
        </button>
      </div>
    </aside>
  );
}
