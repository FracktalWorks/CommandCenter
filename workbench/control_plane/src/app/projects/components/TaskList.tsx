"use client";

/**
 * Projects · the list view.
 *
 * The same task set as the board, read from the same endpoint — Paca's lesson
 * that list and board are one query with different presentation, so growing a
 * second endpoint per surface is how the filters start disagreeing about what a
 * member may see.
 *
 * Grouping is that same presentation choice (WS-27k): the list draws the groups
 * the board would have drawn as columns, as headed sections. Switching between
 * board and list must not change which tasks are on screen or how they are
 * gathered, which is why both take the output of one `groupTasks` call.
 */
import { AvatarStack, TaskMeta } from "@/components/TaskMeta";

import type { StatusRow, TaskRow } from "../lib/api";
import { sortForView } from "../lib/board";
import { cardChips, taskRef } from "../lib/card";
import { type GroupBy, type TaskGroup, personLabel } from "../lib/grouping";

interface Props {
  groups: TaskGroup[];
  groupBy: GroupBy;
  statuses: StatusRow[];
  /** WS-27n — ids currently multi-selected. */
  selected?: ReadonlySet<string>;
  onToggle?: (id: string, shift: boolean) => void;
  onToggleAll?: () => void;
  allChecked?: boolean;
  onSelect: (task: TaskRow) => void;
}

export function TaskList({
  groups,
  groupBy,
  statuses,
  selected,
  onToggle,
  onToggleAll,
  allChecked = false,
  onSelect,
}: Props) {
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const total = groups.reduce((sum, group) => sum + group.tasks.length, 0);

  if (total === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No tasks here yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            {onToggle ? (
              <th className="px-3 py-2 font-medium">
                <input
                  type="checkbox"
                  aria-label="Select every task on this page"
                  checked={allChecked}
                  onChange={() => onToggleAll?.()}
                />
              </th>
            ) : null}
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Assignees</th>
            {/* Was "Due", showing a bare locale date. The shared chip row
                (WS-27s) carries the due date *and* says when it is overdue,
                what is blocking, and how far a checklist has got — the same
                strip the board card draws, so the two views describe a task
                identically. Renamed because it is no longer only the date. */}
            <th className="px-3 py-2 font-medium">Details</th>
          </tr>
        </thead>
        {groups.map((group) => {
          // An empty status lane is kept on the board so a missing column reads
          // as a missing state; a list has no columns, so an empty section is
          // just a heading with nothing under it. Drop it.
          if (group.tasks.length === 0) return null;
          return (
            <tbody key={group.key}>
              {groupBy === "none" ? null : (
                <tr className="bg-muted">
                  <th
                    colSpan={onToggle ? 6 : 5}
                    className="px-3 py-1.5 text-left text-xs font-medium text-foreground"
                  >
                    {group.label}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {group.tasks.length}
                    </span>
                  </th>
                </tr>
              )}
              {sortForView(group.tasks).map((task) => {
                const status = statusById.get(task.status_id);
                return (
                  <tr
                    key={task.id}
                    onClick={() => onSelect(task)}
                    className={`cursor-pointer border-b border-border last:border-0 hover:bg-muted ${
                      selected?.has(task.id) ? "bg-accent/40" : ""
                    }`}
                  >
                    {onToggle ? (
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${task.title}`}
                          checked={selected?.has(task.id) ?? false}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            onToggle(
                              task.id,
                              (e.nativeEvent as MouseEvent).shiftKey,
                            )
                          }
                        />
                      </td>
                    ) : null}
                    <td className="px-3 py-2 text-muted-foreground">
                      {taskRef(task) ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      <span
                        className={task.completed_at ? "line-through opacity-60" : ""}
                      >
                        {task.title}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {status?.name ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {task.assignees?.length ? (
                        <AvatarStack people={task.assignees} label={personLabel} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      <TaskMeta chips={cardChips(task)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
