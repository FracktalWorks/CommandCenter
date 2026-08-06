"use client";

/**
 * Projects · the board.
 *
 * Columns come from the statuses of the project's ROOT (statuses are
 * root-scoped and the subtree inherits), and a drop patches whatever field the
 * view groups by — `buildColumnDropUpdate`, not a hard-coded status write.
 *
 * Ordering is per view (D-PM-5): a drop writes fractional positions through
 * `planDrop`, which is one row in the normal case and the whole group on the
 * first drag into an unordered column.
 */
import { useMemo, useState } from "react";

import type { StatusRow, TaskRow } from "../lib/api";
import { buildColumnDropUpdate, planDrop, sortForView } from "../lib/board";

interface Props {
  tasks: TaskRow[];
  statuses: StatusRow[];
  columnBy?: string;
  onSelect: (task: TaskRow) => void;
  onDrop: (
    task: TaskRow,
    writes: ReturnType<typeof planDrop>,
    patch: Record<string, string | null> | null
  ) => void;
}

const CATEGORY_TINT: Record<string, string> = {
  backlog: "bg-muted",
  todo: "bg-muted",
  in_progress: "bg-muted",
  done: "bg-muted",
  cancelled: "bg-muted",
};

export function TaskBoard({
  tasks,
  statuses,
  columnBy = "status",
  onSelect,
  onDrop,
}: Props) {
  const [dragging, setDragging] = useState<TaskRow | null>(null);

  const columns = useMemo(
    () =>
      [...statuses]
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map((status) => ({
          status,
          tasks: sortForView(tasks.filter((t) => t.status_id === status.id)),
        })),
    [statuses, tasks]
  );

  if (statuses.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        This project has no statuses yet.
      </p>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto p-3">
      {columns.map(({ status, tasks: columnTasks }) => (
        <section
          key={status.id}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!dragging) return;
            const writes = planDrop(
              columnTasks,
              dragging.id,
              columnTasks.length,
              status.id
            );
            const patch =
              dragging.status_id === status.id
                ? null
                : buildColumnDropUpdate(columnBy, status.id);
            onDrop(dragging, writes, patch);
            setDragging(null);
          }}
          className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-card"
        >
          <header
            className={`flex items-center justify-between rounded-t-lg px-3 py-2 ${
              CATEGORY_TINT[status.category] ?? "bg-muted"
            }`}
          >
            <span className="text-sm font-medium text-foreground">{status.name}</span>
            <span className="text-xs text-muted-foreground">{columnTasks.length}</span>
          </header>
          <ul className="flex-1 space-y-2 p-2">
            {columnTasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  draggable
                  onDragStart={() => setDragging(task)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => onSelect(task)}
                  className="w-full rounded-md border border-border bg-background p-2 text-left text-sm hover:border-ring"
                >
                  <span className="block truncate text-foreground">{task.title}</span>
                  <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    {task.task_number ? <span>#{task.task_number}</span> : null}
                    {task.assignees?.length ? (
                      <span className="truncate">{task.assignees.join(", ")}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
            {columnTasks.length === 0 ? (
              <li className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                Drop here
              </li>
            ) : null}
          </ul>
        </section>
      ))}
    </div>
  );
}
