"use client";

/**
 * Projects · the list view.
 *
 * The same task set as the board, read from the same endpoint — Paca's lesson
 * that list and board are one query with different presentation, so growing a
 * second endpoint per surface is how the filters start disagreeing about what a
 * member may see.
 */
import type { StatusRow, TaskRow } from "../lib/api";
import { sortForView } from "../lib/board";

interface Props {
  tasks: TaskRow[];
  statuses: StatusRow[];
  onSelect: (task: TaskRow) => void;
}

export function TaskList({ tasks, statuses, onSelect }: Props) {
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const rows = sortForView(tasks);

  if (rows.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No tasks here yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-border text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Assignees</th>
            <th className="px-3 py-2 font-medium">Due</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => {
            const status = statusById.get(task.status_id);
            return (
              <tr
                key={task.id}
                onClick={() => onSelect(task)}
                className="cursor-pointer border-b border-border last:border-0 hover:bg-muted"
              >
                <td className="px-3 py-2 text-muted-foreground">
                  {task.task_number ?? "—"}
                </td>
                <td className="px-3 py-2 text-foreground">
                  <span className={task.completed_at ? "line-through opacity-60" : ""}>
                    {task.title}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {status?.name ?? "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {task.assignees?.length ? task.assignees.join(", ") : "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {task.due_at ? new Date(task.due_at).toLocaleDateString() : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
