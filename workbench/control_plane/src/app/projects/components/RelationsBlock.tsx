"use client";

/**
 * Projects · subtasks and dependencies in the task panel (WS-27p).
 *
 * Both existed in the schema since WS-27a and neither had a surface: links
 * could be created and deleted but never listed, and subtasks could be created
 * but never shown. *"Data with no surface is a promise the product does not
 * keep."*
 *
 * **Blocked by comes first**, because it is the only section that changes what
 * somebody should do next; the rest is context. A blocker that has finished
 * disappears from it — the gateway derives that — so the section going quiet is
 * how you learn you can start.
 */

import Icon from "@/components/Icon";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useCallback, useEffect, useState } from "react";

import type { TaskRow } from "../lib/api";
import { projectsApi } from "../lib/api";
import { conflictLabel, conflicts } from "../lib/timeline";
import {
  type LinkType,
  type Relations,
  isResolved,
  populated,
  progressLabel,
  progressPercent,
} from "../lib/relations";

const SELECT =
  "cc-control rounded-lg border border-border bg-background px-2 py-1.5 " +
  "text-xs text-foreground outline-none focus:border-primary/50";

const LINK_LABELS: Array<[LinkType, string]> = [
  ["blocks", "blocks"],
  ["relates_to", "relates to"],
  ["duplicates", "duplicates"],
];

interface Props {
  taskId: string;
  /**
   * WS-27t — the task this block belongs to, so the schedule warning can be
   * computed here as well as on the timeline. Optional because the rule is a
   * courtesy: without it the block still lists everything, it just cannot say
   * that two of the dates disagree.
   */
  task?: Pick<TaskRow, "start_date" | "due_at">;
  /** Bumped by the panel when it adds a subtask, so this reloads. */
  refreshKey?: number;
  onOpenTask: (taskId: string) => void;
}

export function RelationsBlock({
  taskId,
  task,
  refreshKey = 0,
  onOpenTask,
}: Props) {
  const [data, setData] = useState<Relations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState<LinkType>("blocks");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await projectsApi.relations(taskId));
    } catch {
      // A panel that works without its relations block beats one that refuses
      // to open because the block did not load.
      setData(null);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!data) return null;

  const sections = populated(data.links);
  const hasAnything = data.subtasks.length > 0 || sections.length > 0;

  async function addLink(event: React.FormEvent) {
    event.preventDefault();
    const id = target.trim();
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await projectsApi.createLink(taskId, id, kind);
      setTarget("");
      setLinking(false);
      await load();
    } catch (err) {
      // The gateway refuses a loop with an explanation; showing it verbatim is
      // better than paraphrasing a rule the server owns.
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function removeLink(linkId: string) {
    setError(null);
    try {
      await projectsApi.deleteLink(taskId, linkId);
      await load();
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  return (
    <div className="space-y-2">
      {error ? (
        <p className="rounded-md bg-muted px-2 py-1 text-xs text-foreground">
          {error}
        </p>
      ) : null}

      {data.blocked_by.length ? (
        <Badge tone="warning" icon="Ban">
          Blocked by {data.blocked_by.length}
        </Badge>
      ) : null}

      {/* WS-27t / D-PM-12 — the warning half of "constrain, but only warn".
          Nothing here reschedules anything, and the sentence says so: a user
          who assumes the tool fixed it is worse off than one who was never
          told. Same pure rule as the timeline's red arrow. */}
      {task
        ? data.blocked_by
            .filter((blocker) => conflicts(blocker, task))
            .map((blocker) => (
              <p
                key={`clash:${blocker.link_id}`}
                className="flex items-start gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-foreground"
              >
                <Icon
                  name="AlertTriangle"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive"
                />
                <span>{conflictLabel(blocker.title)}</span>
              </p>
            ))
        : null}

      {data.subtasks.length ? (
        <div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Subtasks</span>
            <span className="text-xs text-muted-foreground">
              {progressLabel(data.progress)}
            </span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary"
              style={{ width: `${progressPercent(data.progress)}%` }}
            />
          </div>
          <ul className="mt-1 space-y-0.5">
            {data.subtasks.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => onOpenTask(child.id)}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-muted"
                >
                  <Icon
                    name={isResolved(child.category) ? "CheckCircle2" : "Circle"}
                    size={12}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span
                    className={`min-w-0 flex-1 truncate text-foreground ${
                      isResolved(child.category) ? "line-through opacity-60" : ""
                    }`}
                  >
                    {child.title}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {child.status_name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sections.map((s) => (
        <div key={s.key}>
          <span className="text-xs text-muted-foreground">{s.label}</span>
          <ul className="mt-0.5 space-y-0.5">
            {s.links.map((l) => (
              <li key={l.link_id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpenTask(l.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-muted"
                >
                  {l.task_number ? (
                    <span className="shrink-0 text-muted-foreground">
                      #{l.task_number}
                    </span>
                  ) : null}
                  <span
                    className={`min-w-0 flex-1 truncate text-foreground ${
                      isResolved(l.category) ? "line-through opacity-60" : ""
                    }`}
                  >
                    {l.title}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {l.status_name}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  icon="X"
                  aria-label={`Unlink ${l.title}`}
                  onClick={() => void removeLink(l.link_id)}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}

      {linking ? (
        <form onSubmit={addLink} className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">This</span>
          <select
            aria-label="Link type"
            className={SELECT}
            value={kind}
            onChange={(e) => setKind(e.target.value as LinkType)}
          >
            {LINK_LABELS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <Input
            autoFocus
            inputSize="sm"
            className="min-w-[12rem] flex-1"
            aria-label="Task id to link"
            placeholder="task id"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setLinking(false);
            }}
          />
          <Button type="submit" size="sm" loading={busy} disabled={!target.trim()}>
            Link
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLinking(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          icon="Link2"
          onClick={() => setLinking(true)}
        >
          {hasAnything ? "Link another task" : "Link a task"}
        </Button>
      )}
    </div>
  );
}
