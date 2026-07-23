"use client";

import {
  X,
  Plus,
  Trash2,
} from "lucide-react";
import {
  type TaskSettings,
  type EnergyWindow,
  type DayTemplate,
} from "../../lib/api";

const DOW_LABELS = ["S", "M", "T", "W", "T", "F", "S"]; // 0=Sun … 6=Sat


// ── Settings popover (day window, capacity, buffer, energy windows) ──────────
export function CalendarSettings({
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
  // Lunch is "on" only when a valid window is stored (end > start); we toggle it
  // off by storing 0–0 rather than nulling (the settings PUT is additive).
  const lunchOn =
    settings.lunchStartHour != null &&
    settings.lunchEndHour != null &&
    settings.lunchEndHour > settings.lunchStartHour;
  const DEFAULT_PROMPT_HINT =
    "e.g. Leave breathing room — don't cram every minute. Front-load deep work in the morning, batch calls in the afternoon, protect time to think.";
  return (
    <div className="absolute right-0 top-full z-30 mt-2 max-h-[80vh] w-80 overflow-y-auto rounded-lg border border-border bg-card p-3 text-[12px] shadow-xl">
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

      {/* How the AI plans your day — the standing planning philosophy. */}
      <div className="mb-3 rounded-md border border-primary/20 bg-primary/[0.04] p-2">
        <label className="mb-1 block font-medium text-foreground">
          How should the AI plan your day?
        </label>
        <p className="mb-1.5 text-[10px] text-muted-foreground">
          A standing instruction the planner follows every time. Leave blank for
          a sensible, humane default.
        </p>
        <textarea
          value={settings.planningPrompt ?? ""}
          onChange={(e) => onChange({ planningPrompt: e.target.value })}
          placeholder={DEFAULT_PROMPT_HINT}
          rows={4}
          className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-[11px] leading-snug text-foreground focus:border-primary/50 focus:outline-none"
        />
      </div>

      <label className="mb-1 flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Working hours</span>
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
      <p className="mb-2 text-[10px] text-muted-foreground">
        The grid always shows all 24 hours — these just shade your off-hours and
        set where the AI planner places work by default. You can still schedule
        any time.
      </p>

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

      <label className="mb-2 flex items-center justify-between gap-2">
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

      {/* Breaks — so the day isn't wall-to-wall focus work. */}
      <label className="mb-2 flex items-center justify-between gap-2">
        <span className="min-w-0 text-muted-foreground">
          Break after focus run (min, 0 = off)
        </span>
        <input
          type="number"
          min={0}
          max={240}
          step={15}
          value={settings.maxFocusRunMins}
          onChange={(e) => onChange({ maxFocusRunMins: num(e.target.value, 90) })}
          className={`w-14 ${inputCls}`}
        />
      </label>
      <label className="mb-2 flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Break length (min)</span>
        <input
          type="number"
          min={5}
          max={60}
          step={5}
          value={settings.breakMins}
          onChange={(e) => onChange({ breakMins: num(e.target.value, 10) })}
          className={`w-14 ${inputCls}`}
        />
      </label>

      {/* Protected lunch — the planner won't book over it. */}
      <label className="mb-2 flex cursor-pointer items-center justify-between gap-2">
        <span className="min-w-0 text-muted-foreground">Protect a lunch break</span>
        <input
          type="checkbox"
          checked={lunchOn}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? { lunchStartHour: 13, lunchEndHour: 14 }
                : { lunchStartHour: 0, lunchEndHour: 0 },
            )
          }
          className="h-4 w-4 shrink-0 accent-primary"
        />
      </label>
      {lunchOn && (
        <label className="mb-3 flex items-center justify-between gap-2 pl-2">
          <span className="text-muted-foreground">Lunch window</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={23}
              value={settings.lunchStartHour ?? 13}
              onChange={(e) =>
                onChange({ lunchStartHour: num(e.target.value, 13) })
              }
              className={`w-12 ${inputCls}`}
            />
            <span className="text-muted-foreground">–</span>
            <input
              type="number"
              min={1}
              max={24}
              value={settings.lunchEndHour ?? 14}
              onChange={(e) =>
                onChange({ lunchEndHour: num(e.target.value, 14) })
              }
              className={`w-12 ${inputCls}`}
            />
          </span>
        </label>
      )}

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

      {/* Recurring windows — block out habits, reserve times for a kind of work.
          Flexible: add/edit/remove freely. */}
      {(() => {
        const tpls = settings.dayTemplates ?? [];
        const setTpls = (next: DayTemplate[]) =>
          onChange({ dayTemplates: next });
        const patch = (i: number, p: Partial<DayTemplate>) =>
          setTpls(tpls.map((t, idx) => (idx === i ? { ...t, ...p } : t)));
        const toggleDay = (i: number, d: number) => {
          const cur = tpls[i].days ?? [];
          patch(i, {
            days: cur.includes(d)
              ? cur.filter((x) => x !== d)
              : [...cur, d].sort((a, b) => a - b),
          });
        };
        return (
          <div className="mt-3 border-t border-border pt-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-medium text-foreground">
                Recurring windows
              </span>
              <button
                type="button"
                onClick={() =>
                  setTpls([
                    ...tpls,
                    {
                      days: [],
                      start_hour: 12,
                      end_hour: 13,
                      kind: "block",
                      label: "",
                      theme: "",
                    },
                  ])
                }
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            <p className="mb-1.5 text-[10px] text-muted-foreground">
              <b className="text-foreground">Block</b> = protected time, no tasks
              (lunch, gym, family). <b className="text-foreground">Focus</b> =
              reserve for a kind of work (deep work, calls, meetings).
            </p>
            {tpls.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/70">None set.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {tpls.map((t, i) => (
                  <div
                    key={i}
                    className="rounded-md border border-border bg-background/50 p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <select
                        value={t.kind}
                        onChange={(e) =>
                          patch(i, { kind: e.target.value as DayTemplate["kind"] })
                        }
                        className="rounded border border-border bg-background px-1 py-0.5 text-foreground"
                      >
                        <option value="block">Block</option>
                        <option value="focus">Focus</option>
                      </select>
                      <input
                        value={t.label}
                        onChange={(e) => patch(i, { label: e.target.value })}
                        placeholder={t.kind === "block" ? "Lunch, Gym…" : "Deep work…"}
                        className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-foreground focus:border-primary/50 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setTpls(tpls.filter((_, idx) => idx !== i))
                        }
                        aria-label="Remove window"
                        className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={t.start_hour}
                        onChange={(e) =>
                          patch(i, { start_hour: num(e.target.value, 9) })
                        }
                        className={`w-11 ${inputCls}`}
                      />
                      <span className="text-muted-foreground">–</span>
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={t.end_hour}
                        onChange={(e) =>
                          patch(i, { end_hour: num(e.target.value, 10) })
                        }
                        className={`w-11 ${inputCls}`}
                      />
                      {t.kind === "focus" && (
                        <input
                          value={t.theme}
                          onChange={(e) => patch(i, { theme: e.target.value })}
                          placeholder="theme: calls, deep…"
                          className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground focus:border-primary/50 focus:outline-none"
                        />
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1">
                      {DOW_LABELS.map((d, di) => {
                        const on = (t.days ?? []).includes(di);
                        return (
                          <button
                            key={di}
                            type="button"
                            onClick={() => toggleDay(i, di)}
                            className={[
                              "h-5 w-5 rounded text-[10px] font-medium",
                              on
                                ? "bg-primary text-primary-foreground"
                                : "bg-secondary text-muted-foreground hover:text-foreground",
                            ].join(" ")}
                          >
                            {d}
                          </button>
                        );
                      })}
                      <span className="ml-1 text-[10px] text-muted-foreground/70">
                        {(t.days ?? []).length === 0 ? "every day" : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
