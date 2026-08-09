"use client";

/**
 * Projects · the board.
 *
 * Columns are whatever `lib/grouping.groupTasks` produced — status lanes by
 * default, but also assignee, project or priority (WS-27k). The grouping
 * decision is the page's; this component only draws it.
 *
 * WS-27y adds the second axis: with a sub-grouping chosen, the board becomes
 * group columns × sub-group swimlanes, computed by `lib/swimlanes.ts`. Lanes
 * collapse (state travels with the saved view), empty lanes hide unless
 * asked, and a drop into a lane cell writes BOTH axes at once through
 * `buildCellDropPatch`.
 *
 * **Dragging is always offered; refusing is explained.** Where the old board
 * silently disabled dragging off the status axis, a drag over a target that
 * cannot take the drop now overlays the target with `dropRefusal`'s reason —
 * a card that snaps back wordlessly teaches people the board is broken, not
 * that assignees are many-valued.
 *
 * Ordering is per view (D-PM-5): a drop writes fractional positions through
 * `planDrop`, which is one row in the normal case and the whole group on the
 * first drag into an unordered column.
 */
import { AvatarStack, TaskMeta } from "@/components/TaskMeta";
import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";
import { useMemo, useState } from "react";

import type { StatusRow, TaskRow } from "../lib/api";
import { projectsApi } from "../lib/api";
import {
  buildCellDropPatch,
  dropRefusal,
  planDrop,
  sortForView,
} from "../lib/board";
import { cardChips } from "../lib/card";
import { clampCursor, stepCursor } from "../lib/cursor";
import {
  type BoardLanes,
  type GroupBy,
  type TaskGroup,
  personLabel,
} from "../lib/grouping";
import { mergePlans, quickAddPrefill } from "../lib/quickAdd";
import {
  type Swimlane,
  buildSwimlanes,
  hiddenLaneCount,
  visibleLanes,
} from "../lib/swimlanes";
import { QuickAdd } from "./QuickAdd";
import { useFlash } from "./useFlash";

const NOBODY: ReadonlySet<string> = new Set();

interface Props {
  groups: TaskGroup[];
  groupBy: GroupBy;
  /** WS-27y — the second axis and its lane state. */
  lanes: BoardLanes;
  onToggleLane: (key: string) => void;
  onShowEmptyLanes: (show: boolean) => void;
  /** Context the lane computation needs — same as the page's `groupTasks` call. */
  statuses: StatusRow[];
  projectName?: (id: string) => string;
  /** Where a quick-added task is created (the selected node). */
  projectId: string;
  onCreated: (task: TaskRow) => void;
  /** WS-27n — ids currently multi-selected. Empty when nobody is bulk editing. */
  selected?: ReadonlySet<string>;
  onToggle?: (id: string, shift: boolean) => void;
  /** WS-27y — Shift+Arrow grew the selection to exactly these ids. */
  onExtendSelection?: (ids: string[]) => void;
  onSelect: (task: TaskRow) => void;
  onDrop: (
    task: TaskRow,
    writes: ReturnType<typeof planDrop>,
    patch: Record<string, string | number | null> | null
  ) => void;
}

export function TaskBoard({
  groups,
  groupBy,
  lanes,
  onToggleLane,
  onShowEmptyLanes,
  statuses,
  projectName,
  projectId,
  onCreated,
  selected,
  onToggle,
  onExtendSelection,
  onSelect,
  onDrop,
}: Props) {
  const [dragging, setDragging] = useState<TaskRow | null>(null);
  const [over, setOver] = useState<{ col: string; lane: string | null } | null>(
    null
  );
  const [cursor, setCursor] = useState(-1);
  const [anchor, setAnchor] = useState<number | null>(null);
  const { flash, attach, scrollTo } = useFlash();

  // `fromConfig` normalises an equal sub-axis away, but the axis pickers can
  // briefly say "status × status" between two keystrokes — treat it as flat.
  const subBy = lanes.subGroupBy === groupBy ? "none" : lanes.subGroupBy;
  const laned = subBy !== "none";

  const columns = useMemo(
    () => groups.map((group) => ({ ...group, tasks: sortForView(group.tasks) })),
    [groups]
  );

  const swimlanes = useMemo<Swimlane[] | null>(
    () =>
      laned ? buildSwimlanes(columns, subBy, { statuses, projectName }) : null,
    [laned, columns, subBy, statuses, projectName]
  );
  const shownLanes = useMemo(
    () => (swimlanes ? visibleLanes(swimlanes, lanes.showEmptyLanes) : null),
    [swimlanes, lanes.showEmptyLanes]
  );
  const collapsed = useMemo(
    () => new Set(lanes.collapsedLanes),
    [lanes.collapsedLanes]
  );

  // The keyboard cursor's world: every card in render order, each id once.
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (task: TaskRow) => {
      if (!seen.has(task.id)) {
        seen.add(task.id);
        out.push(task.id);
      }
    };
    if (shownLanes) {
      for (const lane of shownLanes) {
        if (collapsed.has(lane.key)) continue;
        for (const cell of lane.cells) for (const task of cell) push(task);
      }
    } else {
      for (const column of columns) for (const task of column.tasks) push(task);
    }
    return out;
  }, [shownLanes, collapsed, columns]);

  const taskById = useMemo(() => {
    const map = new Map<string, TaskRow>();
    for (const column of columns)
      for (const task of column.tasks) map.set(task.id, task);
    return map;
  }, [columns]);

  // Clamped at READ time rather than synced by an effect: the rows shrink
  // under the cursor on every reload, and a state write per reload is exactly
  // the cascading-render pattern the lint forbids.
  const cursorAt = clampCursor(rows.length, cursor);

  function onKeyDown(event: React.KeyboardEvent) {
    // Keystrokes inside a quick-add (or any control) are that control's.
    if (
      (event.target as HTMLElement).closest(
        "input, textarea, select, [contenteditable=true]"
      )
    )
      return;
    const picked = selected ?? NOBODY;
    const next = stepCursor(
      rows,
      { cursor: cursorAt, anchor, selection: picked },
      event.key,
      event.shiftKey
    );
    if (!next) return;
    event.preventDefault();
    setCursor(next.cursor);
    setAnchor(next.anchor);
    if (next.selection !== picked) onExtendSelection?.([...next.selection]);
    if (next.open) {
      const task = taskById.get(next.open);
      if (task) onSelect(task);
    }
    if (next.cursor >= 0) scrollTo(rows[next.cursor]);
  }

  /** The refusal for the target under the drag, or null. One rule for column
   *  and cell targets: a cell involves the lane axis, a plain column does not. */
  const refusalFor = (laneKey: string | null): string | null =>
    dropRefusal(groupBy, laneKey === null ? null : subBy, dragging ?? undefined);

  function dropInto(
    event: React.DragEvent,
    colKey: string,
    cellTasks: TaskRow[],
    laneKey: string | null
  ) {
    event.preventDefault();
    setOver(null);
    const task = dragging;
    setDragging(null);
    if (!task || refusalFor(laneKey)) return;
    const writes = planDrop(cellTasks, task.id, cellTasks.length, colKey);
    const patch = buildCellDropPatch(
      task,
      groupBy,
      colKey,
      laneKey === null ? null : subBy,
      laneKey
    );
    flash(task.id);
    onDrop(task, writes, patch);
  }

  const targetProps = (
    colKey: string,
    cellTasks: TaskRow[],
    laneKey: string | null
  ) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragging) return;
      // preventDefault even when refusing — the browser must keep sending
      // events or the overlay could never show; the refusal is enforced in
      // `dropInto`, and the cursor says "no" via dropEffect.
      event.preventDefault();
      event.dataTransfer.dropEffect = refusalFor(laneKey) ? "none" : "move";
      setOver((current) =>
        current?.col === colKey && current?.lane === laneKey
          ? current
          : { col: colKey, lane: laneKey }
      );
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node)) return;
      setOver((current) =>
        current?.col === colKey && current?.lane === laneKey ? null : current
      );
    },
    onDrop: (event: React.DragEvent) =>
      dropInto(event, colKey, cellTasks, laneKey),
  });

  async function quickAdd(title: string, colKey: string, laneKey: string | null) {
    const plan =
      laneKey === null
        ? quickAddPrefill(groupBy, colKey)
        : mergePlans(quickAddPrefill(groupBy, colKey), quickAddPrefill(subBy, laneKey));
    const created = await projectsApi.createTask({
      project_id: projectId,
      title,
      ...plan.create,
    });
    if (plan.assignees?.length) {
      // Best-effort: the task already exists. A failed PUT leaves it visible
      // in Unassigned, which is honest; throwing here would invite a retry
      // that creates it twice.
      try {
        await projectsApi.setAssignees(created.id, plan.assignees);
      } catch {
        /* the board will show where it actually landed */
      }
    }
    flash(created.id);
    onCreated(created);
  }

  const refusalOverlay = (laneKey: string | null, colKey: string) =>
    over?.col === colKey && over?.lane === laneKey && dragging ? (
      (() => {
        const reason = refusalFor(laneKey);
        return reason ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/85 p-3 text-center text-xs font-medium text-destructive">
            {reason}
          </div>
        ) : null;
      })()
    ) : null;

  const card = (task: TaskRow) => (
    <li key={task.id} ref={attach(task.id)} className="flex items-start gap-1.5 rounded-md">
      {onToggle ? (
        <input
          type="checkbox"
          className="mt-2 shrink-0"
          aria-label={`Select ${task.title}`}
          checked={selected?.has(task.id) ?? false}
          // The click must not also open the task — a checkbox inside a card
          // that opens on click is otherwise one gesture with two outcomes.
          onClick={(e) => e.stopPropagation()}
          onChange={(e) =>
            onToggle(task.id, (e.nativeEvent as MouseEvent).shiftKey)
          }
        />
      ) : null}
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", task.id);
          setDragging(task);
        }}
        onDragEnd={() => {
          setDragging(null);
          setOver(null);
        }}
        onClick={() => onSelect(task)}
        className={`w-full rounded-md border bg-background p-2 text-left text-sm hover:border-ring ${
          selected?.has(task.id) ? "border-primary" : "border-border"
        } ${cursorAt >= 0 && rows[cursorAt] === task.id ? "ring-2 ring-ring" : ""}`}
      >
        <span
          className={`block truncate text-foreground ${
            task.completed_at ? "line-through opacity-60" : ""
          }`}
        >
          {task.title}
        </span>
        {/* The chip row and the owner strip are the shared card vocabulary
            (WS-27s) — the same components /tasks draws, so a task looks like
            the same kind of thing in both. */}
        <TaskMeta chips={cardChips(task)} className="mt-1.5" />
        <span className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span>{task.task_number ? `#${task.task_number}` : ""}</span>
          <AvatarStack people={task.assignees} label={personLabel} />
        </span>
      </button>
    </li>
  );

  if (columns.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Nothing to show. Clear a filter, or this project has no statuses yet.
      </p>
    );
  }

  const droppable = dropRefusal(groupBy, laned ? subBy : null) === null;
  const hidden = swimlanes ? hiddenLaneCount(swimlanes) : 0;

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="outline-none"
      aria-label="Task board — arrow keys move, Shift extends the selection, Enter opens"
    >
      {laned ? (
        <div className="flex items-center gap-2 px-3 pt-2">
          <Button
            variant={lanes.showEmptyLanes ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={lanes.showEmptyLanes}
            onClick={() => onShowEmptyLanes(!lanes.showEmptyLanes)}
          >
            Show empty lanes
          </Button>
          {!lanes.showEmptyLanes && hidden > 0 ? (
            <span className="text-xs text-muted-foreground">
              {hidden} empty {hidden === 1 ? "lane" : "lanes"} hidden
            </span>
          ) : null}
        </div>
      ) : null}

      {!laned ? (
        <div className="flex gap-3 overflow-x-auto p-3">
          {columns.map((column) => (
            <section
              key={column.key}
              {...targetProps(column.key, column.tasks, null)}
              className="relative flex w-72 shrink-0 flex-col rounded-lg border border-border bg-card"
            >
              {refusalOverlay(null, column.key)}
              <header className="flex items-center justify-between rounded-t-lg bg-muted px-3 py-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {column.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {column.tasks.length}
                </span>
              </header>
              <ul className="flex-1 space-y-2 p-2">
                {column.tasks.map((task) => card(task))}
                {column.tasks.length === 0 ? (
                  <li className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                    {droppable ? "Drop here" : "Nothing here"}
                  </li>
                ) : null}
              </ul>
              <div className="p-2 pt-0">
                <QuickAdd
                  label={`Add to ${column.label}`}
                  onAdd={(title) => quickAdd(title, column.key, null)}
                />
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto p-3">
          <div className="min-w-max">
            {/* Column headers once, up top — every lane below shares them. */}
            <div className="mb-2 flex gap-3">
              {columns.map((column) => (
                <div
                  key={column.key}
                  className="flex w-72 shrink-0 items-center justify-between rounded-md bg-muted px-3 py-2"
                >
                  <span className="truncate text-sm font-medium text-foreground">
                    {column.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {column.tasks.length}
                  </span>
                </div>
              ))}
            </div>

            {(shownLanes ?? []).map((lane) => {
              const folded = collapsed.has(lane.key);
              return (
                <section key={lane.key} className="mb-2">
                  <button
                    type="button"
                    onClick={() => onToggleLane(lane.key)}
                    aria-expanded={!folded}
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm font-medium text-foreground hover:bg-muted"
                  >
                    <Icon name={folded ? "ChevronRight" : "ChevronDown"} size={14} />
                    <span className="truncate">{lane.label}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {lane.total}
                    </span>
                  </button>
                  {folded ? null : (
                    <div className="mt-1 flex gap-3">
                      {lane.cells.map((cell, columnIndex) => {
                        const column = columns[columnIndex];
                        return (
                          <div
                            key={column.key}
                            {...targetProps(column.key, cell, lane.key)}
                            className="relative flex w-72 shrink-0 flex-col rounded-lg border border-border bg-card"
                          >
                            {refusalOverlay(lane.key, column.key)}
                            <ul className="flex-1 space-y-2 p-2">
                              {cell.map((task) => card(task))}
                              {cell.length === 0 ? (
                                <li className="rounded-md border border-dashed border-border p-2 text-center text-[11px] text-muted-foreground">
                                  {droppable ? "Drop here" : "—"}
                                </li>
                              ) : null}
                            </ul>
                            <div className="p-2 pt-0">
                              <QuickAdd
                                label={`Add to ${column.label} · ${lane.label}`}
                                onAdd={(title) =>
                                  quickAdd(title, column.key, lane.key)
                                }
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
            {shownLanes && shownLanes.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                Every lane is empty. Turn on “Show empty lanes” to see them.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
