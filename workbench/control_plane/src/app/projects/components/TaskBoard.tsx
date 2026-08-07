"use client";

/**
 * Projects · the board.
 *
 * Columns are whatever `lib/grouping.groupTasks` produced — status lanes by
 * default, but also assignee, project or priority (WS-27k). The grouping
 * decision is the page's; this component only draws it.
 *
 * **Dragging is offered only when the columns are statuses.** A drop is a write
 * to the field the columns represent, and status is the one that is a plain
 * `PATCH status_id`: assignees are a separate PUT, priority is an integer, and
 * moving a task between projects crosses a grant boundary. Letting a card be
 * dragged into a column that cannot accept it — and snap back — is worse than
 * the column being honestly static.
 *
 * Ordering is per view (D-PM-5): a drop writes fractional positions through
 * `planDrop`, which is one row in the normal case and the whole group on the
 * first drag into an unordered column.
 */
import { useMemo, useState } from "react";

import type { TaskRow } from "../lib/api";
import { buildColumnDropUpdate, planDrop, sortForView } from "../lib/board";
import { type GroupBy, type TaskGroup, personLabel } from "../lib/grouping";

interface Props {
  groups: TaskGroup[];
  groupBy: GroupBy;
  onSelect: (task: TaskRow) => void;
  onDrop: (
    task: TaskRow,
    writes: ReturnType<typeof planDrop>,
    patch: Record<string, string | null> | null
  ) => void;
}

export function TaskBoard({ groups, groupBy, onSelect, onDrop }: Props) {
  const [dragging, setDragging] = useState<TaskRow | null>(null);
  const draggable = groupBy === "status";

  const columns = useMemo(
    () => groups.map((group) => ({ ...group, tasks: sortForView(group.tasks) })),
    [groups]
  );

  if (columns.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Nothing to show. Clear a filter, or this project has no statuses yet.
      </p>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto p-3">
      {columns.map((column) => (
        <section
          key={column.key}
          onDragOver={(e) => {
            if (draggable) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!draggable) return;
            e.preventDefault();
            if (!dragging) return;
            const writes = planDrop(
              column.tasks,
              dragging.id,
              column.tasks.length,
              column.key
            );
            const patch =
              dragging.status_id === column.key
                ? null
                : buildColumnDropUpdate(groupBy, column.key);
            onDrop(dragging, writes, patch);
            setDragging(null);
          }}
          className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-card"
        >
          <header className="flex items-center justify-between rounded-t-lg bg-muted px-3 py-2">
            <span className="truncate text-sm font-medium text-foreground">
              {column.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {column.tasks.length}
            </span>
          </header>
          <ul className="flex-1 space-y-2 p-2">
            {column.tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  draggable={draggable}
                  onDragStart={() => setDragging(task)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => onSelect(task)}
                  className="w-full rounded-md border border-border bg-background p-2 text-left text-sm hover:border-ring"
                >
                  <span className="block truncate text-foreground">{task.title}</span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    {task.task_number ? <span>#{task.task_number}</span> : null}
                    {task.assignees?.length ? (
                      <span className="truncate">
                        {task.assignees.map(personLabel).join(", ")}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
            {column.tasks.length === 0 ? (
              <li className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                {draggable ? "Drop here" : "Nothing here"}
              </li>
            ) : null}
          </ul>
        </section>
      ))}
    </div>
  );
}
