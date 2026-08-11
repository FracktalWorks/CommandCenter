"use client";

/**
 * Projects · My work — the personal lens over the one task store.
 *
 * Spec: `project-docs/specs/project_management_app.md` §3.11-§3.12, §6.1 ·
 * **D-PM-6 (revised)** · ticket WS-27e.
 *
 * This is **not a second app**. The rows here are `pm_tasks` rows — the same
 * ones on the team board — so ticking one off moves the project's status at the
 * same instant, and a captured thought can later be dragged into a team project
 * without being recreated. What is personal is the *overlay*: disposition,
 * context, defer. That is why this file selects and triages but never edits
 * shared fields, other than through `complete`, which is deliberately shared.
 *
 * WS-27bd gives its cards the same right-click menu the board has — the shared
 * `@/components/ContextMenu`, filled from the same `lib/taskMenu.ts` registry.
 * It offers strictly less here, and that is the registry doing its job rather
 * than a second menu being kinder: this lens spans many projects, so there is
 * no one status axis to move along, and it has no bulk selection to join.
 */
import { ContextMenu, type CtxItem } from "@/components/ContextMenu";
import Icon, { themedIcon } from "@/components/Icon";
import { StatusChip } from "@/components/StatusChip";
import { TaskCardShell, TaskCardTitle } from "@/components/TaskCardShell";
import { TaskMeta } from "@/components/TaskMeta";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useCallback, useEffect, useMemo, useState } from "react";

import { accentForDisposition } from "../lib/accent";
import { myWorkApi, type TaskRow } from "../lib/api";
import { cardChips, taskDeepLink } from "../lib/card";
import { type TaskMenuActions, taskMenuItems } from "../lib/taskMenu";
import {
  LANE_LABELS,
  actionLine,
  groupByDisposition,
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

/**
 * How a disposition reads on a card.
 *
 * The lane labels first (they are what the section headings say, so a card in
 * "Waiting on" must not call itself something else), then the triage buttons'
 * own words for the dispositions that are not lanes — `REFERENCE` is "File" on
 * the button and would otherwise shout `REFERENCE` on the chip. Anything left
 * is a server value no surface has named, and showing it raw beats hiding it.
 */
function dispositionLabel(disposition: string): string {
  return (
    LANE_LABELS[disposition] ??
    TRIAGE.find((t) => t.value === disposition)?.label ??
    disposition
  );
}

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
  /** WS-27bd — where the right-click landed, and on which card. */
  const [menu, setMenu] = useState<{ x: number; y: number; task: MyTaskRow } | null>(
    null
  );

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

  /**
   * WS-27bd — what a right-click can do here.
   *
   * `toggleSelect` and `setStatus` are unreachable rather than unimplemented:
   * the registry gates them on `canSelect` and on there being statuses, and
   * this lens supplies neither. They are written as no-ops (not throws) because
   * a menu row that crashes the pane would be a worse answer to a bug in the
   * gating than a row that does nothing — `taskMenu.test.ts` is what actually
   * keeps them off the screen.
   */
  const menuActions: TaskMenuActions = {
    open: (task) => onSelect(task),
    copyLink: (task) => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(
            taskDeepLink(task, window.location.origin)
          );
        } catch {
          // No "Copied" state to flip (the menu closes on select), so a denied
          // or insecure-context write claims nothing; the catch only keeps it
          // from becoming an unhandled rejection.
        }
      })();
    },
    toggleSelect: () => {},
    setStatus: () => {},
  };

  const openMenu = (task: MyTaskRow, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, task });
  };

  const menuItems = (task: MyTaskRow): CtxItem[] => {
    // Same six-line adaptation the board does: the registry names a glyph and
    // the component resolves it, so `lib/taskMenu.ts` never imports a
    // component and stays testable in this tree's node runner.
    const ctx = { task, statuses: [], canSelect: false, selected: false };
    return taskMenuItems(ctx).map((entry): CtxItem =>
      entry.kind === "item"
        ? {
            kind: "item",
            label: entry.label,
            icon: entry.icon ? themedIcon(entry.icon) : undefined,
            checked: entry.checked,
            onSelect: () => entry.run(menuActions, ctx),
          }
        : entry
    );
  };

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
        {/* The house text primitive rather than a hand-rolled field: the focus
            treatment is a theme decision (`DESIGN_SYSTEM.md` rule 3) and the
            geometry is unchanged — `lg` IS this field's old px-3/py-2/text-sm. */}
        <Input
          inputSize="lg"
          icon="Plus"
          value={capture}
          onChange={(e) => setCapture(e.target.value)}
          placeholder="Capture a thought…"
          aria-label="Capture a task"
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
          // S4 — the selected pill is `bg-primary/10 text-primary`, the house
          // active token measured across /tasks, /email and src/components
          // (AGENTS.md rule 6). Projects was the tree's only systematic
          // `bg-accent`-as-active user, which is a different colour on every
          // theme from the one every other app's selection wears.
          <span className="ml-auto flex flex-wrap gap-1">
            <button
              type="button"
              aria-pressed={context === null}
              onClick={() => setContext(null)}
              className={`tech-transition rounded-md px-2 py-1 ${
                context === null
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              All contexts
            </button>
            {contexts.map((c) => (
              <button
                key={c.context}
                type="button"
                aria-pressed={context === c.context}
                onClick={() => setContext(c.context)}
                className={`tech-transition rounded-md px-2 py-1 ${
                  context === c.context
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
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
                onContextMenu={openMenu}
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
                  onContextMenu={openMenu}
                />
              ))
            )}
          </section>
        ))}
      </div>

      {/* One menu for the pane, positioned at the pointer — the same component
          the board and /tasks raise. */}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.task)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * One task, in the shared card vocabulary (S4).
 *
 * This used to be the fourth bespoke way this workspace drew a task: a bordered
 * flex row with its own title size, its own hand-written "overdue · due · no
 * date" line and a hand-rolled square for the tick. It is the *personal* task
 * list inside Projects, so it sits directly opposite the /tasks app in the
 * owner's comparison — and it was the one surface that looked like neither.
 *
 * So the box is `TaskCardShell`, the title is `TaskCardTitle`, the due /
 * blocked / checklist facts are `TaskMeta` chips off `lib/card.cardChips`, and
 * the disposition is a `StatusChip`. Nothing here draws a colour or a shape of
 * its own; what stays local is the GTD *interaction* — completing (which moves
 * shared status) and re-triaging — exactly as `TaskCard` keeps its own GTD
 * badges inside the same shell on the /tasks side.
 */
function Row({
  task,
  now,
  busy,
  onSelect,
  onRun,
  onContextMenu,
}: {
  task: MyTaskRow;
  now: Date;
  busy: boolean;
  onSelect: (task: TaskRow) => void;
  onRun: (taskId: string, work: () => Promise<unknown>) => Promise<void>;
  /** WS-27bd — raises the shared right-click menu at the pointer. */
  onContextMenu: (task: MyTaskRow, event: React.MouseEvent) => void;
}) {
  const completed = Boolean(task.completed_at);
  return (
    <TaskCardShell
      className={`mb-1.5 ${busy ? "pointer-events-none opacity-50" : ""}`}
      completed={completed}
      onContextMenu={(event) => onContextMenu(task, event)}
      // Stated, not omitted: My work is a flat personal list with no keyboard
      // cursor — it is not a board lane or a grouped list, so there is nothing
      // for Arrow keys to walk. `sharedTaskUi`'s fence requires the literal
      // precisely so "this surface has no cursor" cannot be confused with
      // "somebody forgot the prop", which is how the /tasks board lost the
      // treatment for a whole release.
      atCursor={false}
      ariaLabel={actionLine(task)}
      onActivate={() => onSelect(task)}
    >
      <div className="flex items-start gap-2">
        {/* A real checkbox, `stopPropagation`'d — the same grammar both boards
            use for a control that lives inside a card that opens on click. */}
        <input
          type="checkbox"
          checked={completed}
          disabled={busy}
          aria-label={`Complete ${task.title}`}
          title="Completing this moves the task's status for everyone — there is one row."
          onClick={(e) => e.stopPropagation()}
          onChange={() => void onRun(task.id, () => myWorkApi.complete(task.id))}
          className="mt-0.5 shrink-0"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusChip
              accent={accentForDisposition(task.disposition)}
              label={dispositionLabel(task.disposition)}
            />
            {/* Untriaged is stated, not implied by a missing badge — it is the
                Weekly Review's whole question. */}
            {!task.is_triaged ? (
              <Badge
                tone="warning"
                size="xs"
                icon="Inbox"
                title="Nobody has decided what this is yet — the disposition above was derived, not chosen."
              >
                untriaged
              </Badge>
            ) : null}
            {task.context ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                <Icon name="Tag" className="h-3 w-3" aria-hidden />
                <span className="max-w-[120px] truncate">{task.context}</span>
              </span>
            ) : null}
          </span>
          <TaskCardTitle completed={completed}>{actionLine(task)}</TaskCardTitle>
          {/* The shared chip row: due (and overdue, in the danger tone with its
              own icon), blocked-by, checklist progress, tags. It replaces this
              row's hand-written date line, so a due date reads identically here
              and on the team board. A fact a task does not have earns no chip —
              which is why the old "no date" is gone rather than translated. */}
          <TaskMeta chips={cardChips(task, now.getTime())} />
        </div>
      </div>
      <span
        className="flex flex-wrap gap-1"
        // The triage buttons act on the row; they must not also open it.
        onClick={(e) => e.stopPropagation()}
      >
        {TRIAGE.filter((t) => t.value !== task.disposition).map((t) => (
          <Button
            key={t.value}
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void onRun(task.id, () =>
                myWorkApi.setPersonal(task.id, { disposition: t.value })
              )
            }
          >
            {t.label}
          </Button>
        ))}
      </span>
    </TaskCardShell>
  );
}
