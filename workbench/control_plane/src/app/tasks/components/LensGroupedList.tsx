"use client";

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { GtdItem } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { groupItems, type GroupBy } from "../lib/ordering";
import { TaskCard } from "./TaskCard";

// Renders a list sliced by a "lens" (priority / action-mode / energy / context)
// into collapsible, labelled sections. Separate from TaskListGrouped (which owns
// the drag-reorderable workflow-stage board grouping) — this one is read-only
// grouping for the non-board lenses, so it stays simple.
//
// One-badge-per-lens rule: the section HEADER carries the priority signal (the
// cell name, the mode, the energy), so the cards inside don't repeat it. Group
// by X → X is the header, not a chip on every row.

export function LensGroupedList({
  items,
  by,
}: {
  items: GtdItem[];
  by: GroupBy;
}) {
  const urgentWindowHours = useTaskStore((s) => s.settings.urgentWindowHours);
  const groups = useMemo(
    () => groupItems(items, by, urgentWindowHours),
    [items, by, urgentWindowHours],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="flex-1 overflow-y-auto">
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        return (
          <section key={g.key}>
            {g.label && (
              <button
                type="button"
                onClick={() => toggle(g.key)}
                className="tech-transition sticky top-0 z-10 flex w-full items-center gap-2 border-b border-border bg-card/95 px-3 py-1.5 text-left backdrop-blur hover:bg-secondary/40"
              >
                <ChevronRight
                  className={[
                    "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                    isCollapsed ? "" : "rotate-90",
                  ].join(" ")}
                />
                {g.emoji && <span aria-hidden>{g.emoji}</span>}
                <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-foreground">
                  {g.label}
                </span>
                <span className="shrink-0 rounded-full bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {g.items.length}
                </span>
              </button>
            )}
            {!isCollapsed && (
              <div>
                {g.items.map((item) => (
                  <TaskCard key={item.id} item={item} variant="row" />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
