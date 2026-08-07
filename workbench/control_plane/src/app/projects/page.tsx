"use client";

/**
 * Projects — departments, projects, subprojects, tasks and subtasks.
 *
 * Spec: `ai-company-brain/specs/project_management_app.md` §5 · ticket WS-27d.
 *
 * ONE app, projected into every Center. `?center=<slug>` pre-filters the tree
 * to that Center's granted departments — **presentation only**: the server's
 * grant model already decided which projects came back at all, so a
 * hand-edited slug shows nothing the caller could not already reach (R9, and
 * `lib/tree.filterByCenter`'s own test says so).
 */
import Icon from "@/components/Icon";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  type GrantRow,
  type ProjectRow,
  type StatusRow,
  type TaskRow,
  projectsApi,
} from "./lib/api";
import { MyWork } from "./components/MyWork";
import { NotificationBell } from "./components/NotificationBell";
import { ProjectTree } from "./components/ProjectTree";
import { TaskBoard } from "./components/TaskBoard";
import { TaskList } from "./components/TaskList";
import { TaskPanel } from "./components/TaskPanel";
import type { planDrop } from "./lib/board";
import { filterByCenter } from "./lib/tree";

type ViewMode = "board" | "list";

function ProjectsWorkspace() {
  const searchParams = useSearchParams();
  const center = searchParams.get("center");

  const [roots, setRoots] = useState<ProjectRow[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [selected, setSelected] = useState<ProjectRow | null>(null);
  const [statuses, setStatuses] = useState<StatusRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [openTask, setOpenTask] = useState<TaskRow | null>(null);
  // The panel's statuses are held apart from the selected project's, because a
  // task opened from My work can belong to a project that is not selected —
  // and a panel offering another project's statuses would offer transitions
  // that do not exist.
  const [panelStatuses, setPanelStatuses] = useState<StatusRow[]>([]);
  const [mine, setMine] = useState(false);
  const [mode, setMode] = useState<ViewMode>("board");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Creating a project: `undefined` = not creating, `null` = a new department
  // at the root, a row = a subproject under it. Three states in one because
  // "which parent" is the only question, and a separate boolean would let the
  // two disagree.
  const [creatingUnder, setCreatingUnder] = useState<ProjectRow | null | undefined>(
    undefined
  );
  const [newName, setNewName] = useState("");
  const [newTask, setNewTask] = useState("");
  const [treeKey, setTreeKey] = useState(0);

  // The tree, plus every root's grants — the grants are what the Center filter
  // reads, and fetching them per root keeps `filterByCenter` a pure function
  // over data the page already holds.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const tree = await projectsApi.tree();
        if (!live) return;
        setRoots(tree.rows);
        const all = await Promise.all(
          tree.rows.map((root) =>
            projectsApi
              .grants(root.id)
              .then((res) => res.rows)
              .catch(() => [] as GrantRow[])
          )
        );
        if (live) setGrants(all.flat());
      } catch (err) {
        if (live) setError(String((err as Error).message));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [treeKey]);

  const visibleRoots = useMemo(
    () => filterByCenter(roots, grants, center),
    [roots, grants, center]
  );

  // Selecting nothing is a real state (an empty portfolio), so the default is
  // applied only when the current selection has fallen out of the filtered set.
  useEffect(() => {
    if (visibleRoots.length === 0) {
      setSelected(null);
      return;
    }
    const stillVisible =
      selected &&
      JSON.stringify(visibleRoots).includes(`"${selected.id}"`);
    if (!stillVisible) setSelected(visibleRoots[0]);
  }, [visibleRoots, selected]);

  const loadProject = useCallback(async (project: ProjectRow) => {
    setError(null);
    try {
      const [statusRes, taskRes] = await Promise.all([
        projectsApi.statuses(project.id),
        projectsApi.tasks({ project_id: project.id, include_subtree: true, page_size: 100 }),
      ]);
      setStatuses(statusRes.rows);
      setTasks(taskRes.rows);
    } catch (err) {
      setError(String((err as Error).message));
      setStatuses([]);
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    if (selected) void loadProject(selected);
  }, [selected, loadProject]);

  // Opening a task always resolves ITS project's statuses. From the board that
  // is the set already loaded; from My work it may be any project the member
  // is assigned into, so it is fetched.
  const openWithStatuses = useCallback(
    async (task: TaskRow) => {
      setOpenTask(task);
      if (selected && task.root_project_id === selected.id) {
        setPanelStatuses(statuses);
        return;
      }
      try {
        const res = await projectsApi.statuses(task.root_project_id);
        setPanelStatuses(res.rows);
      } catch {
        // A panel with no status options is degraded but usable; failing to
        // open the task at all because its lanes could not be listed is not.
        setPanelStatuses([]);
      }
    },
    [selected, statuses]
  );

  /**
   * Open one task by id — what a notification, and the People Center's "Open
   * work" list, both link to.
   *
   * Those links have been generating `/projects?task=<id>` since WS-28b and
   * landing on an unchanged board, because nothing here read the parameter.
   */
  const openTaskById = useCallback(
    async (taskId: string) => {
      try {
        await openWithStatuses(await projectsApi.task(taskId));
      } catch (err) {
        setError(String((err as Error).message));
      }
    },
    [openWithStatuses]
  );

  const deepLink = searchParams.get("task");
  useEffect(() => {
    // Keyed on the id alone, deliberately: `openTaskById` closes over the
    // selected project, so depending on it would reopen the task every time
    // the board reloaded — including right after somebody closed the panel.
    if (!deepLink) return;
    let live = true;
    (async () => {
      try {
        const task = await projectsApi.task(deepLink);
        if (live) await openWithStatuses(task);
      } catch (err) {
        if (live) setError(String((err as Error).message));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLink]);

  async function submitProject(event: React.FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const created = await projectsApi.createProject({
        name,
        parent_project_id: creatingUnder ? creatingUnder.id : null,
      });
      setNewName("");
      setCreatingUnder(undefined);
      setTreeKey((k) => k + 1);
      // A subproject is not selectable until the refreshed tree carries it, so
      // only a new root is selected here — selecting a stale row would show an
      // empty board and read as a failed create.
      if (!creatingUnder) {
        setMine(false);
        setSelected(created);
      }
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  async function submitTask(event: React.FormEvent) {
    event.preventDefault();
    const title = newTask.trim();
    if (!title || !selected) return;
    setNewTask("");
    setError(null);
    try {
      // Status is deliberately not sent: the API picks the project's default,
      // so the browser never has to know which lane a new task starts in.
      await projectsApi.createTask({ project_id: selected.id, title });
      await loadProject(selected);
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  async function handleDrop(
    task: TaskRow,
    writes: ReturnType<typeof planDrop>,
    patch: Record<string, string | null> | null
  ) {
    // Optimistic: the card moves now and the truth arrives on reload. A drag
    // that waits for a round trip feels broken even when it is correct.
    if (patch?.status_id) {
      setTasks((current) =>
        current.map((t) =>
          t.id === task.id ? { ...t, status_id: patch.status_id as string } : t
        )
      );
    }
    try {
      if (patch) await projectsApi.patchTask(task.id, patch);
      const views = await projectsApi.views(task.root_project_id);
      const board = views.rows.find((v) => v.view_type === "board");
      if (board) await projectsApi.setPositions(board.id, writes);
      if (selected) await loadProject(selected);
    } catch (err) {
      setError(String((err as Error).message));
      if (selected) await loadProject(selected);
    }
  }

  if (loading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading projects…</p>;
  }

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-64 shrink-0 overflow-y-auto border-r border-border p-2">
        <div className="mb-2 flex items-start gap-1 px-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold text-foreground">Projects</h1>
            <p className="text-xs text-muted-foreground">
              {center ? `${center} Center's slice` : "Every department you can see"}
            </p>
          </div>
          <button
            type="button"
            aria-label="New department"
            title="New department"
            onClick={() => {
              setCreatingUnder(null);
              setNewName("");
            }}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
          >
            <Icon name="Plus" className="h-4 w-4" />
          </button>
        </div>

        {creatingUnder !== undefined ? (
          <form onSubmit={submitProject} className="mb-2 px-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setCreatingUnder(undefined);
              }}
              placeholder={
                creatingUnder ? `Subproject of ${creatingUnder.name}` : "New department"
              }
              aria-label="Project name"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </form>
        ) : null}
        {/* My work sits ABOVE the tree, not in a separate app. The personal
            lens is a view of the same store — putting it anywhere else would
            re-teach the split that D-PM-6 was revised to remove. */}
        <button
          type="button"
          onClick={() => setMine(true)}
          className={`mb-2 w-full rounded-md px-2 py-1.5 text-left text-sm ${
            mine ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted"
          }`}
        >
          My work
        </button>
        <ProjectTree
          roots={visibleRoots}
          selectedId={mine ? null : selected?.id ?? null}
          onSelect={(project) => {
            setMine(false);
            setSelected(project);
          }}
          onAddChild={(parent) => {
            setCreatingUnder(parent);
            setNewName("");
          }}
        />
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-foreground">
              {mine ? "My work" : selected?.name ?? "No project selected"}
            </h2>
            {mine ? (
              <p className="truncate text-xs text-muted-foreground">
                Assigned to you, plus your own — one store, so finishing here
                finishes it on the board.
              </p>
            ) : selected?.description ? (
              <p className="truncate text-xs text-muted-foreground">
                {selected.description}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <NotificationBell onOpenTask={openTaskById} />
          </div>
          <div className={`flex shrink-0 gap-1 ${mine ? "hidden" : ""}`}>
            {(["board", "list"] as ViewMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md px-2 py-1 text-xs capitalize ${
                  mode === m
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </header>

        {error ? (
          <p className="border-b border-border bg-muted px-3 py-2 text-xs text-foreground">
            {error}
          </p>
        ) : null}

        {!mine && selected ? (
          // Capture-first here too: a title and Enter. Everything else about a
          // task — status, assignee, subtasks — is set from the panel once it
          // exists, because a create form that asks six questions is a create
          // form people work around.
          <form onSubmit={submitTask} className="border-b border-border px-3 py-2">
            <input
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              placeholder={`New task in ${selected.name}…`}
              aria-label="New task title"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </form>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {mine ? (
            <MyWork onSelect={(task) => void openWithStatuses(task)} />
          ) : !selected ? (
            <p className="p-6 text-sm text-muted-foreground">
              Nothing here yet. Projects appear once a department is granted to you.
            </p>
          ) : mode === "board" ? (
            <TaskBoard
              tasks={tasks}
              statuses={statuses}
              onSelect={(task) => void openWithStatuses(task)}
              onDrop={handleDrop}
            />
          ) : (
            <TaskList
              tasks={tasks}
              statuses={statuses}
              onSelect={(task) => void openWithStatuses(task)}
            />
          )}
        </div>
      </main>

      {openTask ? (
        <TaskPanel
          task={openTask}
          statuses={panelStatuses}
          onClose={() => setOpenTask(null)}
          onTaskAdded={() => {
            if (selected) void loadProject(selected);
          }}
          onChanged={(fresh) => {
            setOpenTask(fresh);
            setTasks((current) =>
              current.map((t) => (t.id === fresh.id ? { ...t, ...fresh } : t))
            );
          }}
        />
      ) : null}
    </div>
  );
}

export default function ProjectsPage() {
  // `useSearchParams` needs a Suspense boundary in the App Router.
  return (
    <Suspense
      fallback={<p className="p-6 text-sm text-muted-foreground">Loading projects…</p>}
    >
      <ProjectsWorkspace />
    </Suspense>
  );
}
