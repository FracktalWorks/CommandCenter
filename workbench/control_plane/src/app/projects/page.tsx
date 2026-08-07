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
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  type GrantRow,
  type ProjectRow,
  type StatusRow,
  type TaskRow,
  projectsApi,
} from "./lib/api";
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
  const [mode, setMode] = useState<ViewMode>("board");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  }, []);

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
        <div className="mb-2 px-2">
          <h1 className="text-sm font-semibold text-foreground">Projects</h1>
          <p className="text-xs text-muted-foreground">
            {center ? `${center} Center's slice` : "Every department you can see"}
          </p>
        </div>
        <ProjectTree
          roots={visibleRoots}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-foreground">
              {selected?.name ?? "No project selected"}
            </h2>
            {selected?.description ? (
              <p className="truncate text-xs text-muted-foreground">
                {selected.description}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-1">
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

        <div className="min-h-0 flex-1 overflow-auto">
          {!selected ? (
            <p className="p-6 text-sm text-muted-foreground">
              Nothing here yet. Projects appear once a department is granted to you.
            </p>
          ) : mode === "board" ? (
            <TaskBoard
              tasks={tasks}
              statuses={statuses}
              onSelect={setOpenTask}
              onDrop={handleDrop}
            />
          ) : (
            <TaskList tasks={tasks} statuses={statuses} onSelect={setOpenTask} />
          )}
        </div>
      </main>

      {openTask ? (
        <TaskPanel
          task={openTask}
          statuses={statuses}
          onClose={() => setOpenTask(null)}
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
