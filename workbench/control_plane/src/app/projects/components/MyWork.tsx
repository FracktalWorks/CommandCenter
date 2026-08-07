"use client";

/**
 * Projects · My work — the personal lens over the one task store.
 *
 * Spec: `ai-company-brain/specs/project_management_app.md` §3.11-§3.12, §6.1 ·
 * **D-PM-6 (revised)** · ticket WS-27e.
 *
 * This is **not a second app**. The rows here are `pm_tasks` rows — the same
 * ones on the team board — so ticking one off moves the project's status at the
 * same instant, and a captured thought can later be dragged into a team project
 * without being recreated. What is personal is the *overlay*: disposition,
 * context, defer. That is why this file selects and triages but never edits
 * shared fields, other than through `complete`, which is deliberately shared.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { myWorkApi, type TaskRow } from "../lib/api";
import {
  actionLine,
  groupByDisposition,
  isOverdue,
  twoMinuteTasks,
  untriagedCount,
  type MyTaskRow,
} from "../lib/mywork";

const TRIAGE: Array<{ value: string; label: string }> = [
  { value: "NEXT", label: "Next" },
  { value: "WAITING", label: "Waiting" },
  { value: "SOMEDAY", label: "Someday" },
  { value: "REFERENCE", label: "File" },
];

interface Props {
  onSelect: (task: TaskRow) => void;
}

export function MyWork({ onSelect }: Props) {
  const [rows, setRows] = useState<MyTaskRow[]>([]);
  const [contexts, setContexts] = useState<Array<{ context: string; total: number }>>([]);
  const [context, setContext] = useState<string | null>(null);
  const [capture, setCapture] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reloading is a dependency bump rather than a callback, so every fetch —
  // the first one, a context switch, and the one after a mutation — runs
  // through the same cancellable effect. The `live` guard is what keeps a slow
  // response from a context the member has already left off the screen.
  //
  // The error clears on SUCCESS, not on entry: blanking it while the retry is
  // in flight hides the failure at the moment it is being read.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [inbox, ctx] = await Promise.all([
          myWorkApi.inbox(context ? { context } : {}),
          myWorkApi.contexts(),
        ]);
        if (!live) return;
        setRows(inbox.rows as MyTaskRow[]);
        setContexts(ctx.rows);
        setError(null);
      } catch (err) {
        if (live) setError(String((err as Error).message));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [context, reloadKey]);

  const lanes = useMemo(() => groupByDisposition(rows), [rows]);
  const untriaged = useMemo(() => untriagedCount(rows), [rows]);
  const quick = useMemo(() => twoMinuteTasks(rows), [rows]);
  // Read fresh on every render, deliberately: "overdue" must not be pinned to
  // whenever this pane first mounted.
  const now = new Date();

  // Every mutation reloads rather than patching local state. The endpoints here
  // move SHARED status (complete) and derive dispositions server-side, so a
  // locally-guessed row would be a guess about two other systems.
  const run = useCallback(
    async (taskId: string, work: () => Promise<unknown>) => {
      setBusy(taskId);
      try {
        await work();
        setReloadKey((k) => k + 1);
      } catch (err) {
        setError(String((err as Error).message));
      } finally {
        setBusy(null);
      }
    },
    []
  );

  async function submitCapture(event: React.FormEvent) {
    event.preventDefault();
    const title = capture.trim();
    if (!title) return;
    setCapture("");
    await run("capture", () => myWorkApi.capture({ title }));
  }

  if (loading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading your work…</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Capture first, and above everything: GTD's one non-negotiable is that
          getting a thought out of your head must cost nothing. No project to
          pick, no status to choose — a title and Enter. */}
      <form onSubmit={submitCapture} className="border-b border-border p-3">
        <input
          value={capture}
          onChange={(e) => setCapture(e.target.value)}
          placeholder="Capture a thought…"
          aria-label="Capture a task"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
        />
      </form>

      {error ? (
        <p className="border-b border-border bg-muted px-3 py-2 text-xs text-foreground">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          {untriaged > 0
            ? `${untriaged} not yet triaged`
            : "Everything here has been triaged"}
        </span>
        {contexts.length > 0 ? (
          <span className="ml-auto flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setContext(null)}
              className={`rounded-md px-2 py-1 ${
                context === null
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              All contexts
            </button>
            {contexts.map((c) => (
              <button
                key={c.context}
                type="button"
                onClick={() => setContext(c.context)}
                className={`rounded-md px-2 py-1 ${
                  context === c.context
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {c.context} ({c.total})
              </button>
            ))}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {quick.length > 0 ? (
          <section className="mb-4 rounded-md border border-border p-2">
            <h3 className="mb-1 px-1 text-xs font-medium text-foreground">
              Under two minutes ({quick.length})
            </h3>
            <p className="px-1 pb-1 text-xs text-muted-foreground">
              The one part of the method that pays off before you stand up.
            </p>
            {quick.map((task) => (
              <Row
                key={task.id}
                task={task}
                now={now}
                busy={busy === task.id}
                onSelect={onSelect}
                onRun={run}
              />
            ))}
          </section>
        ) : null}

        {lanes.map((lane) => (
          <section key={lane.lane} className="mb-4">
            <h3 className="mb-1 px-1 text-xs font-medium text-foreground">
              {lane.label}{" "}
              <span className="text-muted-foreground">({lane.tasks.length})</span>
            </h3>
            {lane.tasks.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">
                {lane.lane === "INBOX"
                  ? "Nothing waiting to be clarified."
                  : "Nothing here."}
              </p>
            ) : (
              lane.tasks.map((task) => (
                <Row
                  key={task.id}
                  task={task}
                  now={now}
                  busy={busy === task.id}
                  onSelect={onSelect}
                  onRun={run}
                />
              ))
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function Row({
  task,
  now,
  busy,
  onSelect,
  onRun,
}: {
  task: MyTaskRow;
  now: Date;
  busy: boolean;
  onSelect: (task: TaskRow) => void;
  onRun: (taskId: string, work: () => Promise<unknown>) => Promise<void>;
}) {
  const overdue = isOverdue(task, now);
  return (
    <div
      className={`flex items-center gap-2 border-b border-border px-1 py-2 last:border-0 ${
        busy ? "opacity-50" : ""
      }`}
    >
      <button
        type="button"
        disabled={busy}
        aria-label={`Complete ${task.title}`}
        title="Completing this moves the task's status for everyone — there is one row."
        onClick={() => void onRun(task.id, () => myWorkApi.complete(task.id))}
        className="size-4 shrink-0 rounded-sm border border-border hover:bg-accent"
      />
      <button
        type="button"
        onClick={() => onSelect(task)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-sm text-foreground">{actionLine(task)}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {/* Untriaged is stated, not implied by a missing badge — it is the
              Weekly Review's whole question. */}
          {!task.is_triaged ? "untriaged · " : ""}
          {task.context ? `${task.context} · ` : ""}
          {task.due_at ? (
            <span className={overdue ? "text-foreground" : ""}>
              {overdue ? "overdue " : "due "}
              {new Date(task.due_at).toLocaleDateString()}
            </span>
          ) : (
            "no date"
          )}
        </span>
      </button>
      <span className="flex shrink-0 gap-1">
        {TRIAGE.filter((t) => t.value !== task.disposition).map((t) => (
          <button
            key={t.value}
            type="button"
            disabled={busy}
            onClick={() =>
              void onRun(task.id, () =>
                myWorkApi.setPersonal(task.id, { disposition: t.value })
              )
            }
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {t.label}
          </button>
        ))}
      </span>
    </div>
  );
}
