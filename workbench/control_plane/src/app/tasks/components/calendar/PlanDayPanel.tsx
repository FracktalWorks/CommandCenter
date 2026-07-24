"use client";

import { useEffect, useState } from "react";
import {
  X,
  Loader2,
  Check,
  AlertTriangle,
  Wand2,
  CalendarClock,
} from "lucide-react";
import {
  apiPlanDay,
  apiReplan,
  type EnergyWindow,
  type DayPlanResult,
} from "../../lib/api";
import { energyWindowsPayload, fmtClock } from "./shared";
import { useTaskStore } from "../../lib/taskStore";


// ── AI "Plan my day" review panel ────────────────────────────────────────────
export function PlanDayPanel({
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
          energy_windows: energyWindowsPayload(energyWindows, target),
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

  const fmt = (iso: string) => fmtClock(new Date(iso));
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

        {/* The per-run note steers the LLM ranking (plan mode only — replan/
            rollover are deterministic repacks that ignore it). Broader than
            energy: today's mood, constraints or a theme for the day. Your
            standing planning philosophy (Settings) applies on top of this. */}
        {!isReplan && (
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run(note);
              }}
              placeholder="Anything for today? e.g. “low energy”, “calls only”, “deep work”, “free after 3pm”"
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
        )}

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
