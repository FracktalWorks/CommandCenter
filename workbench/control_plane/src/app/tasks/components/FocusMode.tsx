"use client";

// Focus Mode — the full-screen "Do" surface (calendar_focus_os.md §4.1).
// One block, one timer, the outcome it advances — and nothing else. Pomodoro
// (25/5, 50/10) or Flow (count-up against the block). The ring and countdowns
// are client-side; the durable signal is the existing actuals pair
// (actualStart/actualEnd) that already powers planned-vs-actual + learned
// estimates, so no new backend is needed.
//
// Layering: z-[70] — deliberately BELOW QuickCapture (z-[80]) so the global
// `C` capture hotkey (page.tsx) opens the capture palette on top of the room:
// a stray thought is one keystroke to the inbox and the timer never stops.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Coffee,
  Footprints,
  Pause,
  Play,
  Plus,
  StretchHorizontal,
  Wind,
  X,
} from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { GtdItem } from "../lib/types";
import { blocksForDay, startOfDay, type Block } from "../lib/scheduling";
import {
  loadFocusPrefs,
  saveFocusPrefs,
  type FocusTimerMode,
} from "../lib/focusPrefs";

const TIMER_MODES: { key: FocusTimerMode; label: string; work: number | null; brk: number }[] = [
  { key: "pomo25", label: "25 / 5", work: 25, brk: 5 },
  { key: "pomo50", label: "50 / 10", work: 50, brk: 10 },
  { key: "flow", label: "Flow", work: null, brk: 10 },
];

const BREAK_KINDS: { key: string; label: string; icon: typeof Wind }[] = [
  { key: "walk", label: "Walk", icon: Footprints },
  { key: "breathe", label: "Breathe", icon: Wind },
  { key: "stretch", label: "Stretch", icon: StretchHorizontal },
  { key: "coffee", label: "Coffee", icon: Coffee },
];

const fmtClock = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** mm:ss for the big countdown. */
function fmtTimer(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Conic-gradient progress ring (0..1) in the app's primary (or success) hue. */
function Ring({
  progress,
  tone,
  children,
}: {
  progress: number;
  tone: "primary" | "success";
  children: React.ReactNode;
}) {
  const pct = Math.min(100, Math.max(0, progress * 100));
  const color = tone === "success" ? "var(--success)" : "var(--primary)";
  return (
    <div
      className="mx-auto flex h-48 w-48 items-center justify-center rounded-full sm:h-56 sm:w-56"
      style={{
        background: `conic-gradient(${color} ${pct}%, var(--secondary) ${pct}% 100%)`,
      }}
    >
      <div className="flex h-[10.5rem] w-[10.5rem] flex-col items-center justify-center rounded-full bg-background sm:h-[12.5rem] sm:w-[12.5rem]">
        {children}
      </div>
    </div>
  );
}

export function FocusMode({
  itemId,
  onClose,
}: {
  itemId: string;
  onClose: () => void;
}) {
  const items = useTaskStore((s) => s.items);
  const projects = useTaskStore((s) => s.projects);
  const updateItem = useTaskStore((s) => s.updateItem);
  const quickDispose = useTaskStore((s) => s.quickDispose);
  const loadSubtasks = useTaskStore((s) => s.loadSubtasks);
  const quickCaptureOpen = useTaskStore((s) => s.quickCaptureOpen);

  const item = items.find((i) => i.id === itemId);
  const outcome = useMemo(
    () => projects.find((p) => p.id === item?.projectId)?.outcome,
    [projects, item?.projectId],
  );

  const [mode, setMode] = useState<FocusTimerMode>(
    () => loadFocusPrefs().timerMode ?? "pomo25",
  );
  const timerCfg = TIMER_MODES.find((m) => m.key === mode) ?? TIMER_MODES[0];

  // Segment state machine: work → (break due) → break → work…  "done" is the
  // celebratory end screen after completing the task.
  const [seg, setSeg] = useState<{ kind: "work" | "break"; startMs: number }>(
    () => ({ kind: "work", startMs: Date.now() }),
  );
  const [cycles, setCycles] = useState(0);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [breakKind, setBreakKind] = useState<string>("walk");
  const [finished, setFinished] = useState<null | { actualMins: number | null }>(
    null,
  );
  const [subtasks, setSubtasks] = useState<GtdItem[] | null>(null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Entering the room starts (or resumes) the real focus timer — the durable
  // actuals stamp the review + learned estimates read. Re-times cleanly if the
  // block was previously finished and reopened.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || !item) return;
    startedRef.current = true;
    if (!item.actualStart || item.actualEnd) {
      updateItem(item.id, { actualStart: new Date().toISOString(), actualEnd: "" });
    }
  }, [item, updateItem]);

  // Subtask checklist — tick off without leaving the room.
  useEffect(() => {
    let alive = true;
    if (item && (item.subtaskCount ?? 0) > 0) {
      void loadSubtasks(item.id).then((rows) => {
        if (alive) setSubtasks(rows);
      });
    }
    return () => {
      alive = false;
    };
  }, [item?.id, item?.subtaskCount, loadSubtasks, item]);

  const pickMode = (m: FocusTimerMode) => {
    setMode(m);
    saveFocusPrefs({ timerMode: m });
    setSeg(() => ({ kind: "work", startMs: Date.now() }));
    setPausedAt(null);
  };

  const togglePause = () => {
    if (pausedAt == null) setPausedAt(Date.now());
    else {
      // shift the segment forward by the paused span so elapsed freezes
      setSeg((s) => ({ ...s, startMs: s.startMs + (Date.now() - pausedAt) }));
      setPausedAt(null);
    }
  };

  const elapsedMs = (pausedAt ?? now) - seg.startMs;
  const elapsedMin = elapsedMs / 60000;
  const workDone = seg.kind === "work" && timerCfg.work != null && elapsedMin >= timerCfg.work;
  const breakLeftSec =
    seg.kind === "break" ? timerCfg.brk * 60 - elapsedMs / 1000 : 0;

  const startBreak = (kind: string) => {
    setBreakKind(kind);
    setCycles((c) => c + 1);
    setSeg(() => ({ kind: "break", startMs: Date.now() }));
    setPausedAt(null);
  };
  const startWork = useCallback((countCycle: boolean) => {
    if (countCycle) setCycles((c) => c + 1);
    setSeg(() => ({ kind: "work", startMs: Date.now() }));
    setPausedAt(null);
  }, []);

  // Break over → roll straight into the next work segment.
  useEffect(() => {
    if (seg.kind === "break" && pausedAt == null && breakLeftSec <= 0)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      startWork(false);
  }, [seg.kind, breakLeftSec, pausedAt, startWork]);

  // Today's schedule context for the footer (next block after this one).
  // Plain per-render compute — the block lists are small and `now` ticks 1s.
  const nextBlock: Block | undefined = (() => {
    if (!item?.scheduledEnd) return undefined;
    const endMs = new Date(item.scheduledEnd).getTime();
    return blocksForDay(items, startOfDay(new Date(now))).find(
      (b) =>
        b.item.id !== item.id &&
        b.item.disposition !== "DONE" &&
        b.start.getTime() >= endMs,
    );
  })();

  const complete = () => {
    if (!item) return;
    const actualMins =
      item.actualStart
        ? Math.max(1, Math.round((Date.now() - new Date(item.actualStart).getTime()) / 60000))
        : null;
    updateItem(item.id, { actualEnd: new Date().toISOString() });
    quickDispose(item.id, "DONE");
    setFinished({ actualMins });
  };

  // +15 — guilt-free overrun: extend this block and reflow the flexible rest
  // of today's plan behind it (fixed/meeting blocks stay put).
  const extend15 = () => {
    if (!item?.scheduledStart) return;
    const curEnd = item.scheduledEnd
      ? new Date(item.scheduledEnd)
      : new Date(new Date(item.scheduledStart).getTime() + 30 * 60000);
    const newEnd = new Date(curEnd.getTime() + 15 * 60000);
    updateItem(item.id, { scheduledEnd: newEnd.toISOString() });
    for (const b of blocksForDay(items, startOfDay(new Date()))) {
      if (
        b.item.id !== item.id &&
        b.item.disposition !== "DONE" &&
        (b.item.flexible ?? true) &&
        b.start.getTime() >= curEnd.getTime()
      ) {
        updateItem(b.item.id, {
          scheduledStart: new Date(b.start.getTime() + 15 * 60000).toISOString(),
          scheduledEnd: new Date(b.end.getTime() + 15 * 60000).toISOString(),
        });
      }
    }
  };

  const toggleSubtask = (st: GtdItem) => {
    const toDone = st.disposition !== "DONE";
    setSubtasks((rows) =>
      (rows ?? []).map((r) =>
        r.id === st.id ? { ...r, disposition: toDone ? "DONE" : "NEXT" } : r,
      ),
    );
    quickDispose(st.id, toDone ? "DONE" : "NEXT");
  };

  // Esc leaves the room (timer keeps running — actuals are server-side).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !quickCaptureOpen) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, quickCaptureOpen]);

  if (!item) {
    // deleted / filtered away underneath us — nothing to focus on
    return null;
  }

  const plannedMins =
    item.scheduledStart && item.scheduledEnd
      ? Math.round(
          (new Date(item.scheduledEnd).getTime() -
            new Date(item.scheduledStart).getTime()) /
            60000,
        )
      : item.timeEstimateMins ?? 30;
  const blockLeftMin = item.scheduledEnd
    ? Math.max(0, Math.ceil((new Date(item.scheduledEnd).getTime() - now) / 60000))
    : null;
  const focusMins = item.actualStart
    ? Math.max(0, Math.floor((now - new Date(item.actualStart).getTime()) / 60000))
    : 0;

  // Ring numbers: pomo counts DOWN the segment; flow counts UP vs the block.
  const workTargetSec = timerCfg.work != null ? timerCfg.work * 60 : plannedMins * 60;
  const workElapsedSec = elapsedMs / 1000;
  const ringProgress =
    seg.kind === "break"
      ? 1 - breakLeftSec / (timerCfg.brk * 60)
      : Math.min(1, workElapsedSec / workTargetSec);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-background">
      {/* top bar */}
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          Focus
        </span>
        <div className="ml-2 flex rounded-lg bg-secondary p-0.5 text-[11px]">
          {TIMER_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => pickMode(m.key)}
              className={[
                "tech-transition rounded-md px-2 py-0.5 font-medium",
                mode === m.key
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to calendar"
          title="Back to calendar (esc) — the timer keeps running"
          className="tech-transition ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-4 text-center">
        {finished ? (
          /* ── completion screen — celebrate, then bridge to what's next ── */
          <>
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success/15">
              <Check className="h-7 w-7 text-success" strokeWidth={3} />
            </div>
            <h1 className="mt-4 max-w-lg text-lg font-semibold text-foreground">
              {item.title}
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Done
              {finished.actualMins != null && (
                <>
                  {" "}
                  in{" "}
                  <span className="font-medium tabular-nums text-foreground">
                    {finished.actualMins}m
                  </span>{" "}
                  <span
                    className={
                      finished.actualMins > plannedMins
                        ? "text-warning"
                        : "text-success"
                    }
                  >
                    ({finished.actualMins > plannedMins ? "+" : "−"}
                    {Math.abs(finished.actualMins - plannedMins)}m vs plan)
                  </span>
                </>
              )}
              {cycles > 0 && <> · {cycles} focus cycle{cycles === 1 ? "" : "s"}</>}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {BREAK_KINDS.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => {
                    setFinished(null);
                    startBreak(b.key);
                  }}
                  className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-2 text-[12px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <b.icon className="h-3.5 w-3.5" />
                  {b.label} {timerCfg.brk}m
                </button>
              ))}
            </div>
            {nextBlock && (
              <button
                type="button"
                onClick={onClose}
                className="tech-transition mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-2 text-[12px] font-medium text-primary hover:bg-primary/20"
              >
                Next · {nextBlock.item.title} at {fmtClock(nextBlock.start)}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="mt-3 text-[12px] text-muted-foreground hover:text-foreground"
            >
              Back to calendar
            </button>
          </>
        ) : (
          <>
            {/* outcome first — why this block matters */}
            {outcome && (
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-500">
                → {outcome}
              </p>
            )}
            <h1 className="max-w-xl text-balance text-lg font-semibold text-foreground sm:text-xl">
              {item.leveraged && <span className="text-amber-500">★ </span>}
              {item.title}
            </h1>
            {item.nextAction && item.nextAction !== item.title && (
              <p className="mt-1 max-w-lg truncate text-[12px] text-muted-foreground">
                next action: {item.nextAction}
              </p>
            )}

            <div className="mt-6">
              {seg.kind === "break" ? (
                <Ring progress={ringProgress} tone="success">
                  <div className="text-3xl font-bold tabular-nums text-foreground">
                    {fmtTimer(breakLeftSec)}
                  </div>
                  <div className="mt-0.5 text-[11px] capitalize text-success">
                    {breakKind} break
                  </div>
                  <button
                    type="button"
                    onClick={() => startWork(false)}
                    className="mt-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    skip → back to work
                  </button>
                </Ring>
              ) : (
                <Ring progress={ringProgress} tone="primary">
                  <div className="text-3xl font-bold tabular-nums text-foreground sm:text-4xl">
                    {timerCfg.work != null
                      ? fmtTimer(workTargetSec - workElapsedSec)
                      : fmtTimer(workElapsedSec)}
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {timerCfg.work != null
                      ? `pomodoro ${cycles + 1} · ${timerCfg.label}`
                      : "flow · counting up"}
                    {pausedAt != null && " · paused"}
                  </div>
                  {blockLeftMin != null && (
                    <div className="mt-0.5 text-[10px] tabular-nums text-muted-foreground/70">
                      block ends in {blockLeftMin}m
                    </div>
                  )}
                </Ring>
              )}
            </div>

            {/* work segment elapsed (pomodoro) → offer the break */}
            {workDone && pausedAt == null && (
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2">
                <span className="text-[12px] font-medium text-success">
                  {timerCfg.work}m done — take {timerCfg.brk}?
                </span>
                {BREAK_KINDS.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => startBreak(b.key)}
                    title={`${b.label} break`}
                    className="tech-transition inline-flex items-center gap-1 rounded-md bg-success/15 px-2 py-1 text-[11px] font-medium text-success hover:bg-success/25"
                  >
                    <b.icon className="h-3 w-3" />
                    {b.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => startWork(true)}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  skip
                </button>
              </div>
            )}

            {/* subtasks tick off in place */}
            {subtasks && subtasks.length > 0 && (
              <div className="mt-5 w-full max-w-sm text-left">
                {subtasks.map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => toggleSubtask(st)}
                    className="tech-transition flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] hover:bg-secondary/60"
                  >
                    <span
                      className={[
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        st.disposition === "DONE"
                          ? "border-success bg-success text-white"
                          : "border-muted-foreground/50 text-transparent",
                      ].join(" ")}
                    >
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    </span>
                    <span
                      className={
                        st.disposition === "DONE"
                          ? "truncate text-muted-foreground line-through"
                          : "truncate text-foreground"
                      }
                    >
                      {st.title}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* controls */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={togglePause}
                className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-2 text-[12px] font-medium text-muted-foreground hover:text-foreground"
              >
                {pausedAt != null ? (
                  <>
                    <Play className="h-3.5 w-3.5" fill="currentColor" /> Resume
                  </>
                ) : (
                  <>
                    <Pause className="h-3.5 w-3.5" /> Pause
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={complete}
                className="tech-transition inline-flex items-center gap-1.5 rounded-md bg-success px-4 py-2 text-[12px] font-semibold text-success-foreground hover:opacity-90"
              >
                <Check className="h-3.5 w-3.5" strokeWidth={3} />
                Done
              </button>
              {item.scheduledStart && (
                <button
                  type="button"
                  onClick={extend15}
                  title="Running over? Extend this block 15m — the flexible rest of today shifts with it. No guilt, the plan reflows."
                  className="tech-transition inline-flex items-center gap-1 rounded-md bg-secondary px-3 py-2 text-[12px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                  15 min
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* peripheral vision — one quiet line */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          focused {focusMins}m
          {plannedMins ? ` · planned ${plannedMins}m` : ""}
        </span>
        {nextBlock && !finished && (
          <span className="min-w-0 truncate">
            next · <span className="text-foreground">{nextBlock.item.title}</span>{" "}
            {fmtClock(nextBlock.start)}
          </span>
        )}
        <span className="hidden sm:inline">
          <kbd className="rounded border border-border px-1 text-[9px]">C</kbd>{" "}
          capture a stray thought ·{" "}
          <kbd className="rounded border border-border px-1 text-[9px]">esc</kbd>{" "}
          calendar
        </span>
      </div>
    </div>
  );
}
