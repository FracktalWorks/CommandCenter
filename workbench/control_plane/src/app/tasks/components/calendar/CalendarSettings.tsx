"use client";

import {
  X,
  Plus,
  Trash2,
} from "lucide-react";
import {
  type TaskSettings,
  type EnergyWindow,
} from "../../lib/api";


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
