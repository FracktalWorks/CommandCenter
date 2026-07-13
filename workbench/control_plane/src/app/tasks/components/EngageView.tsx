"use client";

import { useMemo, useState } from "react";
import { Battery, BatteryLow, BatteryMedium, Clock, Tag, Zap } from "lucide-react";
import { useTaskStore, itemsForView } from "../lib/taskStore";
import { GtdItem, Energy } from "../lib/types";
import { priorityRank } from "../lib/priority";
import { TaskCard } from "./TaskCard";
import { PriorityBadge } from "./PriorityControls";

// The GTD "Engage" surface — "what can I do right NOW?" — energy-first (the
// user's stated priority). You pick your current energy; it shows the do-able
// tasks at or below that energy, ranked by the founder matrix. Time-available
// and context are optional secondary narrowers (classic GTD engage criteria).
//
// This is the deliberate counterpart to the Priority view: Priority ranks ALL
// your work; Engage filters to what you can pick up given your current state.

const ENERGY_ORDER: Record<Energy, number> = { low: 0, medium: 1, high: 2 };

const ENERGY_OPTS: { value: Energy; label: string; icon: typeof Battery }[] = [
  { value: "low", label: "Low / fried", icon: BatteryLow },
  { value: "medium", label: "Medium", icon: BatteryMedium },
  { value: "high", label: "Sharp / high", icon: Battery },
];

const TIME_OPTS: { value: number; label: string }[] = [
  { value: 0, label: "Any time" },
  { value: 15, label: "≤ 15 min" },
  { value: 30, label: "≤ 30 min" },
  { value: 60, label: "≤ 1 hour" },
];

export function EngageView() {
  const items = useTaskStore((s) => s.items);
  const contexts = useTaskStore((s) => s.contexts);
  const urgentWindowHours = useTaskStore((s) => s.settings.urgentWindowHours);

  const [energy, setEnergy] = useState<Energy>("medium");
  const [maxMins, setMaxMins] = useState(0); // 0 = any
  const [context, setContext] = useState<string>(""); // "" = any

  const base = useMemo(
    () => itemsForView(items, "engage", null),
    [items],
  );

  const matched = useMemo(() => {
    const cap = ENERGY_ORDER[energy];
    const rows = base.filter((i) => {
      // Energy: a task with no energy set is always eligible (unknown ⇒ don't
      // hide it); otherwise it must be AT OR BELOW my current energy.
      if (i.energy && ENERGY_ORDER[i.energy] > cap) return false;
      // Time available (only excludes tasks that are known to be longer).
      if (maxMins > 0 && i.timeEstimateMins && i.timeEstimateMins > maxMins)
        return false;
      // Context (optional).
      if (context && i.context !== context) return false;
      return true;
    });
    // Rank by the matrix (Founder Fire → …), then by due date within a tie.
    return rows.sort((a, b) => {
      const pr =
        priorityRank(a, urgentWindowHours) - priorityRank(b, urgentWindowHours);
      if (pr !== 0) return pr;
      return (a.dueAt ?? "￿").localeCompare(b.dueAt ?? "￿");
    });
  }, [base, energy, maxMins, context, urgentWindowHours]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" />
          <h1 className="text-base font-bold text-foreground">Engage · Now</h1>
          <span className="ml-auto text-xs text-muted-foreground">
            {matched.length} pickable
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          What can you do right now? Set your energy — we&rsquo;ll surface the
          matches, most important first.
        </p>

        {/* Energy — the primary picker */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium text-muted-foreground">
            I&rsquo;m feeling
          </span>
          {ENERGY_OPTS.map((o) => {
            const Icon = o.icon;
            const on = energy === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setEnergy(o.value)}
                aria-pressed={on}
                className={[
                  "tech-transition inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                  on
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/40",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5" />
                {o.label}
              </button>
            );
          })}
        </div>

        {/* Secondary narrowers — time + context */}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <select
              value={maxMins}
              onChange={(e) => setMaxMins(Number(e.target.value))}
              className="tech-transition h-7 rounded-md border border-border bg-background pl-2 pr-6 text-xs text-foreground focus:border-primary focus:outline-none"
            >
              {TIME_OPTS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {contexts.length > 0 && (
            <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Tag className="h-3.5 w-3.5" />
              <select
                value={context}
                onChange={(e) => setContext(e.target.value)}
                className="tech-transition h-7 rounded-md border border-border bg-background pl-2 pr-6 text-xs text-foreground focus:border-primary focus:outline-none"
              >
                <option value="">Any context</option>
                {contexts.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>

      {matched.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <Zap className="h-6 w-6 text-muted-foreground/50" />
          <p className="text-sm text-foreground">Nothing matches right now</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            Try a higher energy level or a longer time window — or enjoy the
            clear runway.
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {matched.map((item) => (
            <EngageRow key={item.id} item={item} windowHours={urgentWindowHours} />
          ))}
        </div>
      )}
    </div>
  );
}

// A row that pairs the task with its single priority badge — here the matrix
// cell IS the relevant signal (you're picking by importance), so we show it.
function EngageRow({ item, windowHours }: { item: GtdItem; windowHours: number }) {
  return (
    <div className="flex items-center gap-2 border-b border-border pr-3.5">
      <div className="min-w-0 flex-1">
        <TaskCard item={item} variant="row" />
      </div>
      <PriorityBadge item={item} urgentWindowHours={windowHours} showLabel={false} />
    </div>
  );
}
