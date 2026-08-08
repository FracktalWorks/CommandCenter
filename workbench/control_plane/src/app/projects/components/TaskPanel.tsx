"use client";

/**
 * Projects · the task detail panel and its timeline.
 *
 * Comments and system events come from ONE endpoint because they are one table
 * (§3.8) — the timeline shows a status change, an assignment, an agent run and
 * a comment in the same stream, which is the point of the shared spine.
 */
import Icon from "@/components/Icon";
import { useEffect, useRef, useState } from "react";

import {
  type ActivityRow,
  type AttachmentRow,
  type FieldRow,
  type StatusRow,
  type TagRow,
  type TaskRow,
  attachmentsApi,
  projectsApi,
} from "../lib/api";
import { CustomFieldValues } from "./CustomFieldValues";
import { TagPicker } from "./TagPicker";
import { RepeatEditor } from "./RepeatEditor";
import { RelationsBlock } from "./RelationsBlock";
import { changeLabel } from "../lib/customFields";
import {
  assigneeLabel,
  classify,
  parseAssignees,
  withAssignee,
  withoutAssignee,
} from "../lib/assignees";
import { insertMention, notDeliveredNotice } from "../lib/notifications";

interface Props {
  task: TaskRow;
  statuses: StatusRow[];
  onClose: () => void;
  onChanged: (task: TaskRow) => void;
  /**
   * Fired when this panel adds a row the surrounding list does not know about.
   * `onChanged` merges one task; a new subtask is a task the board has never
   * seen, so it needs a real reload rather than a merge.
   */
  onTaskAdded?: () => void;
  /**
   * WS-27l — the project's custom field definitions. Passed in rather than
   * fetched here: they belong to the root project, the page already holds them
   * for the selected node, and re-fetching per panel open would be a request
   * per click for data that does not change between clicks.
   */
  fields?: FieldRow[];
  /** WS-27m — the project's registered tags, for the picker's suggestions. */
  tags?: TagRow[];
  /**
   * WS-27p — open another task by id, for a subtask or a linked task. The page
   * owns it because opening one has to resolve ITS project's statuses, which is
   * a decision the panel does not have the tree to make.
   */
  onOpenTask?: (taskId: string) => void;
}

function describe(activity: ActivityRow, defs: FieldRow[] = []): string {
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
      // `patch_task` files a custom edit as `custom.<key>`. Rendering that raw
      // would put a database key in front of somebody reading their own
      // history, so the definition's label is used where one is loaded.
      const named = changes.map((c) => changeLabel(c.field, defs as never));
      return `Edited ${named.join(", ") || "fields"}`;
    }
    case "agent_run":
      return `Agent run ${String(meta.agent ?? "")}`.trim();
    case "sync":
      return activity.body ?? "Synced";
    case "attachment":
      return activity.body ?? "Attachment changed";
    default:
      return activity.body ?? activity.type;
  }
}

export function TaskPanel({
  task,
  statuses,
  onClose,
  onChanged,
  onTaskAdded,
  fields = [],
  tags = [],
  onOpenTask,
}: Props) {
  const [timeline, setTimeline] = useState<ActivityRow[]>([]);
  const [comment, setComment] = useState("");
  const [notDelivered, setNotDelivered] = useState<string | null>(null);
  const commentBox = useRef<HTMLTextAreaElement | null>(null);
  const [assignee, setAssignee] = useState("");
  const [subtask, setSubtask] = useState("");
  // Bumped when this panel adds a subtask, so the relations block re-reads
  // rather than showing a list that is one item short.
  const [relationsKey, setRelationsKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<AttachmentRow[]>([]);
  const assignees = task.assignees ?? [];
  // Agents are excluded: an agent cannot receive a notification (migration
  // 152's CHECK), so offering to mention one would promise nothing.
  const mentionable = assignees.filter((who) => !who.startsWith("agent:"));

  useEffect(() => {
    let live = true;
    projectsApi
      .timeline(task.id)
      .then((res) => {
        if (live) setTimeline(res.rows);
      })
      .catch((err) => live && setError(String(err.message ?? err)));
    attachmentsApi
      .list(task.id)
      .then((res) => {
        if (live) setFiles(res.rows);
      })
      // Attachments failing must not blank the panel: the timeline and the
      // status control are the reason somebody opened it.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [task.id]);

  async function uploadFiles(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Sequential, not Promise.all: each upload writes a timeline row, and a
      // burst of parallel writes would interleave them into an order that does
      // not match what the person did.
      for (const file of Array.from(picked)) {
        await attachmentsApi.upload(task.id, file);
      }
      const [fresh, tl] = await Promise.all([
        attachmentsApi.list(task.id),
        projectsApi.timeline(task.id),
      ]);
      setFiles(fresh.rows);
      setTimeline(tl.rows);
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function detach(attachmentId: string) {
    setBusy(true);
    setError(null);
    try {
      await attachmentsApi.detach(task.id, attachmentId);
      const fresh = await attachmentsApi.list(task.id);
      setFiles(fresh.rows);
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

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

  async function saveAssignees(next: string[]) {
    setBusy(true);
    setError(null);
    try {
      await projectsApi.setAssignees(task.id, next);
      await reload();
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function addAssignees() {
    // A whole pasted list at once, not one at a time: the PUT replaces the set
    // anyway, so batching them is one event rather than N.
    let next = assignees;
    for (const who of parseAssignees(assignee)) next = withAssignee(next, who);
    // Identity means nothing changed — skipping the PUT is what stops a
    // re-assert emitting pm.task.assigned and re-dispatching an agent run.
    if (next === assignees) {
      setAssignee("");
      return;
    }
    setAssignee("");
    await saveAssignees(next);
  }

  async function addSubtask() {
    const title = subtask.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    try {
      // A subtask is a task with a parent (§3.5) — no second endpoint and no
      // second table, so it inherits statuses, timeline and assignment whole.
      await projectsApi.createTask({
        project_id: task.project_id,
        parent_task_id: task.id,
        title,
      });
      setSubtask("");
      await reload();
      onTaskAdded?.();
      setRelationsKey((k) => k + 1);
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
    setNotDelivered(null);
    try {
      const posted = await projectsApi.comment(task.id, body);
      setComment("");
      // WS-27j: a mention that reached nobody is said out loud. The comment
      // still posted, so this is a notice rather than an error — but silence
      // would leave the author believing a colleague was pulled in.
      setNotDelivered(notDeliveredNotice(posted.not_notified ?? []));
      await reload();
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  /** Insert `@address` at the caret, so nobody has to type the token by hand. */
  function mention(who: string) {
    const box = commentBox.current;
    const at = box ? box.selectionStart : comment.length;
    const next = insertMention(comment, at, who);
    setComment(next.body);
    // Restoring the caret is what makes the picker usable twice in a row:
    // React resets it to the end of the new value otherwise.
    requestAnimationFrame(() => {
      box?.focus();
      box?.setSelectionRange(next.caret, next.caret);
    });
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
          <Icon name="X" className="h-4 w-4" />
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
        <div>
          <span className="text-xs text-muted-foreground">Assignees</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {assignees.map((who) => {
              const kind = classify(who);
              return (
                <span
                  key={who}
                  title={kind === "unknown" ? "Not an email or agent:<name>" : who}
                  className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
                    kind === "unknown"
                      ? "border border-border text-muted-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {/* Agents and people are one vocabulary (D-PM-4), so the
                      difference is an icon, never a separate field. */}
                  {kind === "agent" ? <Icon name="Bot" className="h-3 w-3" /> : null}
                  {assigneeLabel(who)}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Unassign ${who}`}
                    onClick={() => void saveAssignees(withoutAssignee(assignees, who))}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="X" className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
            {assignees.length === 0 ? (
              <span className="text-xs text-muted-foreground">Nobody yet</span>
            ) : null}
          </div>
          <input
            value={assignee}
            disabled={busy}
            onChange={(e) => setAssignee(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addAssignees();
              }
            }}
            onBlur={() => void addAssignees()}
            placeholder="email or agent:name"
            aria-label="Add an assignee"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        {task.description ? (
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {task.description}
          </p>
        ) : null}
        {/* Renders nothing at all when the project has no custom fields, so a
            project that never wanted them never grows an empty heading. */}
        {/* Saved on every change rather than behind a button: a chip is a
            single decision, and a Save beside it would be a second click for
            something that is already unambiguous. */}
        <TagPicker
          value={task.tags ?? []}
          registry={tags}
          disabled={busy}
          onChange={(next) => {
            void (async () => {
              try {
                onChanged(await projectsApi.patchTask(task.id, { tags: next }));
              } catch (err) {
                setError(String((err as Error).message));
              }
            })();
          }}
        />
        {/* Both halves existed in the schema since WS-27a with no surface:
            links could be created and deleted but never listed, and subtasks
            could be created but never shown. */}
        {onOpenTask ? (
          <RelationsBlock
            taskId={task.id}
            task={task}
            refreshKey={relationsKey}
            onOpenTask={onOpenTask}
          />
        ) : null}
        <RepeatEditor taskId={task.id} />
        <CustomFieldValues task={task} fields={fields} onChanged={onChanged} />
        <div>
          <span className="text-xs text-muted-foreground">Files</span>
          <div className="mt-1 space-y-1">
            {files.map((f) => (
              <div key={f.attachment_id} className="flex items-center gap-2 text-xs">
                {f.kind === "image" ? (
                  <Icon name="Image" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Icon name="Paperclip" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-foreground hover:underline"
                >
                  {f.name}
                </a>
                <span className="shrink-0 text-muted-foreground">
                  {Math.max(1, Math.round(f.size / 1024))} KB
                </span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${f.name}`}
                  title="Removes it from this task; the file itself is kept"
                  onClick={() => void detach(f.attachment_id)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Icon name="X" className="h-3 w-3" />
                </button>
              </div>
            ))}
            {files.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing attached.</p>
            ) : null}
          </div>
          <input
            type="file"
            multiple
            disabled={busy}
            aria-label="Attach files"
            onChange={(e) => {
              void uploadFiles(e.target.files);
              // Reset so picking the SAME file twice still fires a change.
              e.target.value = "";
            }}
            className="mt-1 w-full text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-background file:px-2 file:py-1 file:text-xs file:text-foreground"
          />
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Subtask</span>
          <input
            value={subtask}
            disabled={busy}
            onChange={(e) => setSubtask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addSubtask();
              }
            }}
            placeholder="Break this down…"
            aria-label="Add a subtask"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
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
            <p className="whitespace-pre-wrap text-foreground">{describe(activity, fields)}</p>
          </li>
        ))}
        {timeline.length === 0 ? (
          <li className="text-sm text-muted-foreground">Nothing on the timeline yet.</li>
        ) : null}
      </ol>

      <div className="border-t border-border p-3">
        <textarea
          ref={commentBox}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add a comment…"
          rows={2}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
        {/* Mentionable people are this task's assignees. A full directory
            picker is WS-28e's job; these are who a comment names in practice,
            and typing the address by hand still works for anyone else. */}
        {mentionable.length ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-muted-foreground">Mention</span>
            {mentionable.map((who) => (
              <button
                key={who}
                type="button"
                onClick={() => mention(who)}
                className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                @{who.split("@")[0]}
              </button>
            ))}
          </div>
        ) : null}
        {notDelivered ? (
          <p className="mt-1 text-[11px] text-muted-foreground">{notDelivered}</p>
        ) : null}
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
