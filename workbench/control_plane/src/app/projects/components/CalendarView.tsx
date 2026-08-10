"use client";

/**
 * Projects · the month calendar (WS-27q).
 *
 * The third view, after list and board. All of the arithmetic — which days the
 * grid covers, which cells a task occupies, what a drop should write — is in
 * `lib/calendar.ts` and tested there; this file only draws it and wires the
 * gestures, because a calendar bug is a task on the wrong Tuesday and that is
 * not something a component test would catch either.
 *
 * **Two honest admissions on the surface, both deliberate.** A calendar that
 * silently omits tasks is worse than one that looks incomplete: `truncated`
 * says when the window hit its cap, and `undated` says how many tasks have no
 * dates at all and therefore cannot be here. Without those two the view reads
 * as the whole workspace while showing part of it.
 */

import { TaskMeta } from "@/components/TaskMeta";
import Button from "@/components/ui/Button";
import { useMemo } from "react";

import type { TagRow, TaskRow } from "../lib/api";
import { projectsApi } from "../lib/api";
import {
  type MonthGrid,
  isOutsideMonth,
  monthLabel,
  placeTasks,
  rescheduleTo,
} from "../lib/calendar";
import { tagColours, visibleChips } from "../lib/card";
import { quickAddPrefill } from "../lib/quickAdd";
import { QuickAdd } from "./QuickAdd";
import { useFlash } from "./useFlash";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  grid: MonthGrid;
  tasks: TaskRow[];
  /** How many matching tasks have no dates and so cannot be drawn. */
  undated: number;
  /** The window hit the server's cap; some tasks are missing. */
  truncated: boolean;
  today?: string;
  /** WS-27y — where a day's quick-added task is created (the selected node). */
  /** WS-27x — the view's shown fields; chips a hidden field earned are not drawn. */
  shownFields: readonly string[];
  /** S6 — the project's tag registry, so a tag chip is the colour its owner
   *  chose here too. One tag, one colour, on every surface of the project. */
  tags?: readonly TagRow[];
  projectId: string;
  onCreated: (task: TaskRow) => void;
  onSelect: (task: TaskRow) => void;
  onMove: (task: TaskRow, patch: Record<string, string | null>) => void;
  onStep: (months: number) => void;
  onToday: () => void;
}

export function CalendarView({
  grid,
  tasks,
  undated,
  truncated,
  today,
  projectId,
  shownFields,
  tags,
  onCreated,
  onSelect,
  onMove,
  onStep,
  onToday,
}: Props) {
  const byDay = placeTasks(tasks, grid);
  const { flash, attach } = useFlash();
  // Once per registry, not once per card.
  const tagHues = useMemo(() => tagColours(tags ?? []), [tags]);

  /** WS-27y — a title typed into a day creates a task DUE that day, through
   *  the same axis→payload mapping every other quick-add uses. */
  async function quickAdd(title: string, day: string) {
    const plan = quickAddPrefill("day", day);
    const created = await projectsApi.createTask({
      project_id: projectId,
      title,
      ...plan.create,
    });
    flash(created.id);
    onCreated(created);
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <header className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="icon-sm"
          icon="ChevronLeft"
          aria-label="Previous month"
          onClick={() => onStep(-1)}
        />
        <Button
          variant="secondary"
          size="icon-sm"
          icon="ChevronRight"
          aria-label="Next month"
          onClick={() => onStep(1)}
        />
        <Button variant="ghost" size="sm" onClick={onToday}>
          Today
        </Button>
        <h2 className="text-sm font-medium text-foreground">{monthLabel(grid)}</h2>
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {undated > 0 ? (
            <span title="These have no start or due date, so no day to sit on.">
              {undated} unscheduled
            </span>
          ) : null}
          {truncated ? (
            <span className="font-medium text-destructive">
              Too many tasks in this month to show them all — narrow the filters.
            </span>
          ) : null}
        </span>
      </header>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {WEEKDAYS.map((label) => (
          <div
            key={label}
            className="bg-muted px-2 py-1 text-center text-xs font-medium text-muted-foreground"
          >
            {label}
          </div>
        ))}
        {grid.days.map((day) => {
          const outside = isOutsideMonth(day, grid);
          return (
            <div
              key={day}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/plain");
                const task = tasks.find((t) => t.id === id);
                if (!task) return;
                // `rescheduleTo` returns null for a drop that changes nothing,
                // so a task dropped back on its own day writes nothing rather
                // than posting an activity saying it moved to where it was.
                const patch = rescheduleTo(task, day);
                if (patch) {
                  // The landing flash finds the card after the month reloads
                  // and re-keys it under its new day (WS-27y).
                  flash(task.id);
                  onMove(task, patch as Record<string, string | null>);
                }
              }}
              className={`min-h-24 bg-card p-1 ${outside ? "opacity-50" : ""}`}
            >
              <div className="flex items-center justify-between px-1">
                <span
                  className={`text-xs ${
                    day === today
                      ? "rounded bg-primary px-1.5 font-medium text-primary-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {Number(day.slice(8))}
                </span>
              </div>
              <ul className="mt-1 space-y-1">
                {(byDay.get(day) ?? []).map((task) => (
                  <li key={`${day}:${task.id}`} ref={attach(task.id)} className="rounded">
                    <button
                      type="button"
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
                      onClick={() => onSelect(task)}
                      className="w-full rounded border border-border bg-background px-1.5 py-1 text-left hover:border-ring"
                    >
                      <span
                        className={`block truncate text-xs text-foreground ${
                          task.completed_at ? "line-through opacity-60" : ""
                        }`}
                      >
                        {task.title}
                      </span>
                      <TaskMeta
                        chips={visibleChips(
                          task,
                          shownFields,
                          undefined,
                          tagHues
                        )}
                      />
                    </button>
                  </li>
                ))}
              </ul>
              {/* WS-27y — a title typed here is due THIS day. */}
              <QuickAdd
                compact
                label={`Add a task due ${day}`}
                onAdd={(title) => quickAdd(title, day)}
                className="mt-1"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
