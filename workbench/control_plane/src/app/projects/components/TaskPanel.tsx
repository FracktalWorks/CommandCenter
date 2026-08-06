"use client";

/**
 * Projects · the task detail panel and its timeline.
 *
 * Comments and system events come from ONE endpoint because they are one table
 * (§3.8) — the timeline shows a status change, an assignment, an agent run and
 * a comment in the same stream, which is the point of the shared spine.
 */
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import {
  type ActivityRow,
  type StatusRow,
  type TaskRow,
  projectsApi,
} from "../lib/api";

interface Props {
  task: TaskRow;
  statuses: StatusRow[];
  onClose: () => void;
  onChanged: (task: TaskRow) => void;
}

function describe(activity: ActivityRow): string {
  const meta = (activity.meta ?? {}) as Record<string, unknown>;
  switch (activity.type) {
    case "comment":
      return activity.body ?? "";
    case "status_change":
      return activity.body ?? "Status changed";
    case "assignment": {
      const added = (meta.added as string[] | undefined) ?? [];
      const removed = (meta.removed as string[] | undefined) ?? [];
      const parts: string[] = [];
      if (added.length) parts.push(`assigned ${added.join(", ")}`);
      if (removed.length) parts.push(`unassigned ${removed.join(", ")}`);
      return parts.join("; ") || "Assignment changed";
    }
    case "field_change": {
      const changes = (meta.changes as Array<{ field: string }> | undefined) ?? [];
      return `Edited ${changes.map((c) => c.field).join(", ") || "fields"}`;
    }
    case "agent_run":
      return `Agent run ${String(meta.agent ?? "")}`.trim();
    case "sync":
      return activity.body ?? "Synced";
    default:
      return activity.body ?? activity.type;
  }
}

export function TaskPanel({ task, statuses, onClose, onChanged }: Props) {
  const [timeline, setTimeline] = useState<ActivityRow[]>([]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    projectsApi
      .timeline(task.id)
      .then((res) => {
        if (live) setTimeline(res.rows);
      })
      .catch((err) => live && setError(String(err.message ?? err)));
    return () => {
      live = false;
    };
  }, [task.id]);

  async function reload() {
    const [fresh, tl] = await Promise.all([
      projectsApi.task(task.id),
      projectsApi.timeline(task.id),
    ]);
    setTimeline(tl.rows);
    onChanged(fresh);
  }

  async function changeStatus(statusId: string) {
    setBusy(true);
    setError(null);
    try {
      await projectsApi.patchTask(task.id, { status_id: statusId });
      await reload();
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function addComment() {
    const body = comment.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await projectsApi.comment(task.id, body);
      setComment("");
      await reload();
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-card">
      <header className="flex items-start justify-between gap-2 border-b border-border p-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {task.task_number ? `#${task.task_number}` : "Task"}
          </p>
          <h2 className="truncate text-sm font-medium text-foreground">{task.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close task"
          className="rounded p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="space-y-3 border-b border-border p-3 text-sm">
        <label className="block">
          <span className="text-xs text-muted-foreground">Status</span>
          <select
            value={task.status_id}
            disabled={busy}
            onChange={(e) => changeStatus(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {task.assignees?.length ? (
          <p className="text-xs text-muted-foreground">
            Assigned to {task.assignees.join(", ")}
          </p>
        ) : null}
        {task.description ? (
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {task.description}
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="border-b border-border bg-muted px-3 py-2 text-xs text-foreground">
          {error}
        </p>
      ) : null}

      <ol className="flex-1 space-y-3 overflow-y-auto p-3">
        {timeline.map((activity) => (
          <li key={activity.id} className="text-sm">
            <p className="text-xs text-muted-foreground">
              {activity.created_by ?? "system"}
              {activity.created_at
                ? ` · ${new Date(activity.created_at).toLocaleString()}`
                : ""}
            </p>
            <p className="whitespace-pre-wrap text-foreground">{describe(activity)}</p>
          </li>
        ))}
        {timeline.length === 0 ? (
          <li className="text-sm text-muted-foreground">Nothing on the timeline yet.</li>
        ) : null}
      </ol>

      <div className="border-t border-border p-3">
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add a comment…"
          rows={2}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
        <button
          type="button"
          onClick={addComment}
          disabled={busy || !comment.trim()}
          className="mt-2 w-full rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          Comment
        </button>
      </div>
    </aside>
  );
}
