"use client";

/**
 * Projects · the timeline (WS-27t).
 *
 * A sticky task column beside a scrolling chart of bars, with `blocks`
 * dependencies drawn as arrows between them and created by dragging from one
 * bar's handle to another. The geometry, the depth grouping and the conflict
 * rule are all in `lib/timeline.ts` and tested there; this draws them.
 *
 * **The layout is Paca's** (`roadmap-view.tsx`, Apache-2.0): sticky left
 * column, fixed pixels-per-day, month header cells, a today line, and an
 * undated task listed on the left with no bar. **The wiring is not** — Paca's
 * roadmap draws no dependency arrows and is entirely read-only, so from here on
 * the reference was Jira and ClickUp and the interaction is ours.
 *
 * **An arrow warns; it never reschedules (D-PM-12).** A dependency whose
 * blocker finishes after the blocked task starts is drawn in the danger tone
 * and says so on hover. Nothing is written. The alternative — dragging
 * dependents forward, which is what Jira does — was rejected because it
 * contradicts WS-27p's "derived and shown, never enforced" and turns one drag
 * into a cascade of writes nobody asked for.
 */

import Icon from "@/components/Icon";
import { TaskMeta } from "@/components/TaskMeta";
import Button from "@/components/ui/Button";
import { useMemo, useState } from "react";

import type { TaskRow } from "../lib/api";
import { visibleChips } from "../lib/card";
import { dayKey, shiftDay } from "../lib/calendar";
import {
  type Edge,
  PX_PER_DAY,
  ROW_H,
  bar,
  canLink,
  conflictLabel,
  conflicts,
  dayPx,
  edgePath,
  monthCells,
  timelineRange,
  timelineRows,
} from "../lib/timeline";

const LEFT_COL = 260;

interface Props {
  tasks: TaskRow[];
  links: Edge[];
  undated: number;
  truncated: boolean;
  /** WS-27x — the view's shown fields; chips a hidden field earned are not drawn. */
  shownFields: readonly string[];
  today?: string;
  onSelect: (task: TaskRow) => void;
  onLink: (blockerId: string, blockedId: string) => void;
  onRefuse: (reason: string) => void;
}

export function TimelineView({
  tasks,
  links,
  undated,
  truncated,
  today,
  shownFields,
  onSelect,
  onLink,
  onRefuse,
}: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const todayKey = today ?? dayKey(new Date());

  const rows = useMemo(() => timelineRows(tasks), [tasks]);
  const range = useMemo(() => timelineRange(rows, todayKey), [rows, todayKey]);

  // One flat list of drawn lines — parents, then their children when expanded —
  // so a row's index IS its y. Arrows are positioned from that index, and a
  // second traversal to find it would be a second chance to disagree.
  const drawn = useMemo(() => {
    const out: {
      task: TaskRow;
      children: TaskRow[];
      depth: number;
      hasKids: boolean;
    }[] = [];
    for (const row of rows) {
      out.push({
        task: row.task, children: row.children, depth: 0,
        hasKids: row.children.length > 0,
      });
      if (expanded.has(row.task.id)) {
        for (const kid of row.children) {
          out.push({ task: kid, children: [], depth: 1, hasKids: false });
        }
      }
    }
    return out;
  }, [rows, expanded]);

  const indexById = useMemo(
    () => new Map(drawn.map((row, i) => [row.task.id, i])),
    [drawn],
  );
  const barById = useMemo(
    () => new Map(drawn.map((row) => [row.task.id, bar(row.task, row.children, range)])),
    [drawn, range],
  );
  const taskById = useMemo(
    () => new Map(tasks.map((t) => [t.id, t])),
    [tasks],
  );

  const months = monthCells(range);
  const todayPx = todayKey >= range.from && todayKey <= range.to
    ? dayPx(todayKey, range) : null;
  const height = Math.max(drawn.length * ROW_H, ROW_H);

  function drop(blockedId: string) {
    const blockerId = dragging;
    setDragging(null);
    if (!blockerId) return;
    const verdict = canLink(blockerId, blockedId, links);
    if (!verdict.ok) {
      onRefuse(verdict.reason);
      return;
    }
    onLink(blockerId, blockedId);
  }

  if (drawn.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        No tasks to display.
        {undated > 0 ? ` ${undated} have no start or due date.` : ""}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <header className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="text-sm font-medium text-foreground">Timeline</span>
        <span>
          Drag the handle on a bar&apos;s right edge onto another bar to say it
          blocks that one.
        </span>
        {undated > 0 ? (
          <span title="No start or due date, so no bar to draw.">
            {undated} unscheduled
          </span>
        ) : null}
        {truncated ? (
          <span className="font-medium text-destructive">
            Too many tasks to show them all — narrow the filters.
          </span>
        ) : null}
      </header>

      <div className="overflow-x-auto rounded-lg border border-border">
        <div className="flex" style={{ minWidth: LEFT_COL + range.widthPx }}>
          {/* Task column — sticky, so the names stay while the chart scrolls. */}
          <div
            className="sticky left-0 z-20 shrink-0 border-r border-border bg-card"
            style={{ width: LEFT_COL }}
          >
            <div
              className="flex items-end border-b border-border bg-muted px-2 pb-1 text-xs font-medium text-muted-foreground"
              style={{ height: ROW_H }}
            >
              Task
            </div>
            {drawn.map((row) => (
              <div
                key={row.task.id}
                className="flex items-center gap-1 border-b border-border/50 px-2"
                style={{ height: ROW_H, paddingLeft: 8 + row.depth * 14 }}
              >
                {row.hasKids ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    icon={expanded.has(row.task.id) ? "ChevronDown" : "ChevronRight"}
                    aria-label={
                      expanded.has(row.task.id)
                        ? `Collapse ${row.task.title}`
                        : `Expand ${row.task.title}`
                    }
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(row.task.id)) next.delete(row.task.id);
                        else next.add(row.task.id);
                        return next;
                      })
                    }
                  />
                ) : (
                  <span className="w-5 shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => onSelect(row.task)}
                  className="min-w-0 flex-1 truncate text-left text-xs text-foreground hover:underline"
                >
                  {row.task.title}
                </button>
              </div>
            ))}
          </div>

          {/* Chart */}
          <div className="relative shrink-0" style={{ width: range.widthPx }}>
            <div
              className="flex border-b border-border bg-muted"
              style={{ height: ROW_H }}
            >
              {months.map((cell) => (
                <div
                  key={cell.key}
                  className="border-r border-border/60 px-2 pt-1 text-xs font-medium text-muted-foreground"
                  style={{ width: cell.widthPx }}
                >
                  {cell.widthPx > 48 ? cell.label : ""}
                </div>
              ))}
            </div>

            <div className="relative" style={{ height }}>
              {todayPx !== null ? (
                <div
                  className="absolute top-0 z-0 w-px bg-primary/60"
                  style={{ left: todayPx, height }}
                  title="Today"
                />
              ) : null}

              {/* Arrows, under the bars so a bar is never un-clickable. */}
              <svg
                className="pointer-events-none absolute inset-0 z-10"
                width={range.widthPx}
                height={height}
                aria-hidden
              >
                <defs>
                  <marker
                    id="pm-arrow"
                    markerWidth="6"
                    markerHeight="6"
                    refX="5"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6 z" className="fill-muted-foreground" />
                  </marker>
                  <marker
                    id="pm-arrow-bad"
                    markerWidth="6"
                    markerHeight="6"
                    refX="5"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6 z" className="fill-destructive" />
                  </marker>
                </defs>
                {links.map((edge) => {
                  const from = indexById.get(edge.blocker_id);
                  const to = indexById.get(edge.blocked_id);
                  if (from === undefined || to === undefined) return null;
                  const d = edgePath(
                    { bar: barById.get(edge.blocker_id) ?? null, row: from },
                    { bar: barById.get(edge.blocked_id) ?? null, row: to },
                  );
                  if (!d) return null;
                  const blocker = taskById.get(edge.blocker_id);
                  const blocked = taskById.get(edge.blocked_id);
                  const bad =
                    !!blocker && !!blocked && conflicts(blocker, blocked);
                  return (
                    <path
                      key={edge.id}
                      d={d}
                      fill="none"
                      strokeWidth={bad ? 2 : 1.5}
                      className={bad ? "stroke-destructive" : "stroke-muted-foreground"}
                      markerEnd={`url(#${bad ? "pm-arrow-bad" : "pm-arrow"})`}
                    />
                  );
                })}
              </svg>

              {drawn.map((row, index) => {
                const drawnBar = barById.get(row.task.id) ?? null;
                const blocker = links.find((l) => l.blocked_id === row.task.id);
                const blockerTask = blocker
                  ? taskById.get(blocker.blocker_id)
                  : undefined;
                const bad =
                  !!blockerTask && conflicts(blockerTask, row.task);
                return (
                  <div
                    key={row.task.id}
                    className="absolute inset-x-0 border-b border-border/50"
                    style={{ top: index * ROW_H, height: ROW_H }}
                    onDragOver={(e) => {
                      if (dragging) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      drop(row.task.id);
                    }}
                  >
                    {drawnBar ? (
                      <div
                        className="group absolute top-1.5 z-10 flex items-center"
                        style={{ left: drawnBar.leftPx, width: drawnBar.widthPx }}
                      >
                        <button
                          type="button"
                          onClick={() => onSelect(row.task)}
                          title={
                            bad && blockerTask
                              ? conflictLabel(blockerTask.title)
                              : row.task.title
                          }
                          className={`flex h-6 w-full items-center gap-1 overflow-hidden rounded px-1.5 text-left text-[11px] ${
                            drawnBar.derived
                              ? "border border-dashed border-border bg-muted text-muted-foreground"
                              : bad
                                ? "border border-destructive bg-destructive/15 text-foreground"
                                : "bg-primary/20 text-foreground hover:bg-primary/30"
                          }`}
                        >
                          {bad ? (
                            <Icon
                              name="AlertTriangle"
                              className="h-3 w-3 shrink-0 text-destructive"
                            />
                          ) : null}
                          <span className="truncate">{row.task.title}</span>
                          <TaskMeta chips={visibleChips(row.task, shownFields)} />
                        </button>
                        {/* The link handle. Only on a real bar: a derived one
                            has no dates of its own, so a dependency drawn from
                            it would be about days nobody typed. */}
                        {drawnBar.derived ? null : (
                          <span
                            draggable
                            onDragStart={() => setDragging(row.task.id)}
                            onDragEnd={() => setDragging(null)}
                            title={`Drag onto another bar: "${row.task.title}" blocks it`}
                            className="absolute -right-2 h-3 w-3 cursor-grab rounded-full border border-border bg-card opacity-0 transition-opacity group-hover:opacity-100"
                          />
                        )}
                      </div>
                    ) : (
                      <span
                        className="absolute left-1 top-2 text-[10px] text-muted-foreground"
                        title="No start or due date, so there is nothing to place."
                      >
                        unscheduled
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        A red arrow means a task starts before the thing blocking it is due to
        finish. Nothing is rescheduled automatically — the dates stay yours.
        <span className="ml-1">
          Showing {range.from} to {shiftDay(range.to, 0)}, {PX_PER_DAY}px per day.
        </span>
      </p>
    </div>
  );
}
