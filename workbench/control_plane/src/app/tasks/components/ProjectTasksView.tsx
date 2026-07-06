"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  FolderKanban,
  LayoutList,
  Columns3,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { GtdProject } from "../lib/types";
import { applyFilters, applySort } from "../lib/ordering";
import { SourceBadge } from "./SourceBadge";
import { TaskToolbar } from "./TaskToolbar";
import { TaskListGrouped } from "./TaskListGrouped";
import { TaskBoard } from "./TaskBoard";

// The right-hand pane for a selected project: its tasks as a list OR Kanban
// board — the SAME UI as Next Actions. Stages come from the project's home:
//   SYNCED (ClickUp) → that workspace's own statuses, two-way synced (a drag
//                      re-files provider_status → ClickUp update_task).
//   LOCAL            → the global workflow stages.
// Clicking a task opens it (with subtasks) in the focus modal, as elsewhere.

// Same sticky List/Board toggle recipe as ItemList (per-browser, SSR-safe).
const MODE_KEY = "cc.tasks.projectViewMode";
const listeners = new Set<() => void>();
function subscribeMode(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === MODE_KEY) cb(); };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}
function readMode(): "list" | "board" {
  try {
    return window.localStorage.getItem(MODE_KEY) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}
function setModePersist(m: "list" | "board") {
  try { window.localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ }
  listeners.forEach((cb) => cb());
}

export function ProjectTasksView({ project }: { project: GtdProject }) {
  const items = useTaskStore((s) => s.items);
  const accounts = useTaskStore((s) => s.accounts);
  const filters = useTaskStore((s) => s.filters);
  const sort = useTaskStore((s) => s.sort);
  const mode = useSyncExternalStore(subscribeMode, readMode, () => "list");

  const isSynced = project.source !== "LOCAL";
  // A ClickUp project's stages are its workspace's statuses; a local project
  // uses the global workflow stages (handled by the child when stages omitted).
  const providerStages = useMemo(() => {
    if (!isSynced) return undefined;
    const acct = accounts.find((a) => a.id === project.accountId);
    return acct?.statuses?.length ? acct.statuses : undefined;
  }, [isSynced, accounts, project.accountId]);

  // Top-level project tasks (subtasks stay nested in the task detail).
  const projectTasks = useMemo(
    () =>
      items.filter(
        (i) => i.projectId === project.id && !i.parentItemId,
      ),
    [items, project.id],
  );
  const visible = useMemo(
    () => applySort(applyFilters(projectTasks, filters), sort),
    [projectTasks, filters, sort],
  );

  const openCount = projectTasks.filter(
    (t) => t.disposition === "NEXT",
  ).length;
  const stageMode = isSynced ? "provider" : "workflow";

  return (
    <div className="flex h-full flex-col">
      {/* Project header */}
      <header className="border-b border-border bg-card px-5 py-3">
        <div className="mb-1 flex items-center gap-2">
          <FolderKanban className="h-4 w-4 text-primary" />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Project
          </span>
          <SourceBadge source={project.source} provider={project.provider} />
          {project.hasNextAction || openCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-success">
              <CheckCircle2 className="h-3 w-3" />
              {openCount} next action{openCount === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning">
              <AlertTriangle className="h-3 w-3" />
              No next action
            </span>
          )}
          <span className="ml-auto flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5">
            <ModeButton
              active={mode === "list"}
              onClick={() => setModePersist("list")}
              icon={LayoutList}
              label="List"
            />
            <ModeButton
              active={mode === "board"}
              onClick={() => setModePersist("board")}
              icon={Columns3}
              label="Board"
            />
          </span>
        </div>
        <h1 className="text-lg font-bold leading-snug text-foreground">
          {project.outcome}
        </h1>
        {project.purpose && (
          <p className="mt-1 text-sm text-muted-foreground">{project.purpose}</p>
        )}
        {isSynced && !providerStages && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <ExternalLink className="h-3 w-3" />
            Sync the workspace to load this project&apos;s ClickUp stages.
          </p>
        )}
      </header>

      {projectTasks.length > 0 && <TaskToolbar items={projectTasks} />}

      {visible.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <CheckCircle2 className="h-8 w-8 text-success/60" />
          <p className="text-sm text-muted-foreground">
            {projectTasks.length === 0
              ? "No tasks in this project yet."
              : "No tasks match your filters."}
          </p>
        </div>
      ) : mode === "board" ? (
        <div className="min-h-0 flex-1">
          <TaskBoard
            items={visible}
            view="next"
            stageMode={stageMode}
            stages={providerStages}
          />
        </div>
      ) : (
        <TaskListGrouped
          items={visible}
          view="next"
          stageMode={stageMode}
          stages={providerStages}
        />
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof LayoutList;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`${label} view`}
      className={[
        "tech-transition inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}
