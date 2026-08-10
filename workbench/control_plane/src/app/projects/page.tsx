"use client";

/**
 * Projects — departments, projects, subprojects, tasks and subtasks.
 *
 * Spec: `project-docs/specs/project_management_app.md` §5 · ticket WS-27d.
 *
 * ONE app, projected into every Center. `?center=<slug>` pre-filters the tree
 * to that Center's granted departments — **presentation only**: the server's
 * grant model already decided which projects came back at all, so a
 * hand-edited slug shows nothing the caller could not already reach (R9, and
 * `lib/tree.filterByCenter`'s own test says so).
 */
import Icon from "@/components/Icon";
import Button from "@/components/ui/Button";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  type GrantRow,
  type ProjectRow,
  type StatusRow,
  type TaskRow,
  type FieldRow,
  type TagRow,
  type ViewRow,
  projectsApi,
} from "./lib/api";
import { FieldManager } from "./components/FieldManager";
import { LifecyclePolicy } from "./components/LifecyclePolicy";
import { TagManager } from "./components/TagManager";
import { BulkBar } from "./components/BulkBar";
import { FilterBar } from "./components/FilterBar";
import { ImportClickUp } from "./components/ImportClickUp";
import { MyWork } from "./components/MyWork";
import { NotificationBell } from "./components/NotificationBell";
import { ProjectTree } from "./components/ProjectTree";
import { CalendarView } from "./components/CalendarView";
import { SearchPalette } from "./components/SearchPalette";
import { TimelineView } from "./components/TimelineView";
import { TableView } from "./components/TableView";
import { TaskBoard } from "./components/TaskBoard";
import { TaskList } from "./components/TaskList";
import { TaskPanel } from "./components/TaskPanel";
import { TriageRail } from "./components/TriageRail";
import { SAVED_VIEW_POSITION, orderBearingView, type planDrop } from "./lib/board";
import { calendarWindow, dayKey, monthGrid, shiftMonth } from "./lib/calendar";
import { isOpenShortcut } from "./lib/search";
import type { Edge } from "./lib/timeline";
import {
  type BoardLanes,
  EMPTY_FILTERS,
  type Filters,
  type GroupBy,
  NO_LANES,
  fromConfig,
  groupTasks,
  toConfig,
  toQuery,
} from "./lib/grouping";
import { DEFAULT_SHOWN } from "./lib/shownFields";
import { toggleLane } from "./lib/swimlanes";
import { type TableSort, sortQuery } from "./lib/table";
import {
  allSelected as everySelected,
  buildRequest,
  describeOutcome,
  prune,
  range as selectRange,
  toggle as toggleId,
  visibleIds,
} from "./lib/selection";
import { fetchAccess } from "@/lib/access";
import { filterByCenter, flatten } from "./lib/tree";

type ViewMode = "board" | "list" | "table" | "calendar" | "timeline";

/** An empty calendar window — the shape before anything has been fetched, and
 *  the shape after a failure, so the view never renders a stale month. */
const NO_MONTH = {
  rows: [] as TaskRow[],
  links: [] as Edge[],
  undated: 0,
  truncated: false,
};

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
  const [importing, setImporting] = useState(false);

  // WS-27k — filters go to the server, grouping is applied here. `activeView`
  // is only a highlight: applying a view copies its config into these two, so
  // editing a filter afterwards leaves the chip lit but the board honest, and
  // the chip clears the moment the state stops matching what was saved.
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  // WS-27y — the board's second axis plus its lane state; saved with a view.
  const [lanes, setLanes] = useState<BoardLanes>(NO_LANES);
  // WS-27x — the view's shown fields (table columns AND the chip gate), saved
  // with a view; and the table's header sort, which travels to the server as
  // the existing `sort`/`direction` parameters (`TASK_SORTS` keys).
  const [shownFields, setShownFields] = useState<string[]>([...DEFAULT_SHOWN]);
  const [tableSort, setTableSort] = useState<TableSort | null>(null);
  const [views, setViews] = useState<ViewRow[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [me, setMe] = useState("");

  // WS-27l — the selected node's custom field definitions. Root-scoped, so the
  // whole subtree shares one set; held here rather than in the panel because
  // the panel opens and closes far more often than these change.
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [managingFields, setManagingFields] = useState(false);

  // WS-27m — the selected node's tag registry. Root-scoped like the fields, and
  // held here for the same reason: the filter bar, the panel's picker and the
  // manager all read it, and three fetches of one list would disagree.
  const [tags, setTags] = useState<TagRow[]>([]);
  const [managingTags, setManagingTags] = useState(false);

  // WS-27z — the lifecycle-policy dialog. Root projects only: the policy is a
  // root setting the whole subtree inherits, and the gateway 422s a child.
  const [managingLifecycle, setManagingLifecycle] = useState(false);

  // WS-27n — multi-select. `anchor` is the last card clicked without shift,
  // which is what a shift-click measures its range from.
  // WS-27q — the calendar is a WINDOW, not the paged task list, so it holds
  // its own rows. Sharing `tasks` would mean either paginating the calendar
  // (a month with silently missing days) or unpaginating the board.
  // WS-27r — the search palette. Held at the page rather than in a view,
  // because the whole point is that it works from wherever you already are.
  const [searching, setSearching] = useState(false);

  const [monthAnchor, setMonthAnchor] = useState<Date>(() => new Date());
  const [month, setMonth] = useState(NO_MONTH);

  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);

  useEffect(() => {
    // ⌘K from anywhere in Projects. `preventDefault` because the browser's own
    // ⌘K is the address bar's search on some, and losing the app to it is a
    // shortcut that works once.
    function onKey(event: KeyboardEvent) {
      if (!isOpenShortcut(event)) return;
      event.preventDefault();
      setSearching(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    // Only for the "Mine" toggle. `fetchAccess` never throws, and an empty
    // address disables the button rather than filtering on nobody.
    const controller = new AbortController();
    void fetchAccess(controller.signal).then((access) => setMe(access.email));
    return () => controller.abort();
  }, []);

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

  const loadProject = useCallback(
    async (project: ProjectRow) => {
      setError(null);
      try {
        const [statusRes, taskRes] = await Promise.all([
          projectsApi.statuses(project.id),
          // Filters travel to the server, never applied to the page after it
          // arrives: paging happens in SQL, so a filter applied here would
          // return short pages and hide work that is genuinely there.
          projectsApi.tasks({
            project_id: project.id,
            include_subtree: true,
            page_size: 100,
            ...toQuery(filters),
            // WS-27x — the table's header sort; {} when none, so every other
            // surface keeps the endpoint's default ordering.
            ...sortQuery(tableSort),
          }),
        ]);
        setStatuses(statusRes.rows);
        setTasks(taskRes.rows);
      } catch (err) {
        setError(String((err as Error).message));
        setStatuses([]);
        setTasks([]);
      }
    },
    [filters, tableSort]
  );

  useEffect(() => {
    if (selected) void loadProject(selected);
  }, [selected, loadProject]);

  // WS-27q — the calendar's own fetch, because it reads a WINDOW rather than a
  // page. `grid` is derived so the effect re-runs when the month steps, and
  // `calendarWindow` adds the day of slack the endpoint's UTC reading needs.
  const grid = useMemo(() => monthGrid(monthAnchor), [monthAnchor]);

  const loadMonth = useCallback(async () => {
    if (!selected) {
      setMonth(NO_MONTH);
      return;
    }
    const { from, to } = calendarWindow(grid);
    try {
      const res = await projectsApi.calendar({
        project_id: selected.id,
        include_subtree: true,
        from,
        to,
        // WS-27t — only the timeline draws arrows, and the calendar would pay
        // for a query it never reads.
        include_links: mode === "timeline",
        ...toQuery(filters),
      });
      setMonth({
        rows: res.rows,
        links: res.links,
        undated: res.undated,
        truncated: res.truncated,
      });
    } catch (err) {
      setError(String((err as Error).message));
      // Cleared rather than left as it was: a stale month drawn under a new
      // heading is a calendar confidently showing the wrong dates.
      setMonth(NO_MONTH);
    }
  }, [selected, grid, filters, mode]);

  useEffect(() => {
    // Both date views read the same window endpoint — the WINDOW is the
    // resource, and calendar and timeline are two renderings of it.
    if (mode === "calendar" || mode === "timeline") void loadMonth();
  }, [mode, loadMonth]);

  useEffect(() => {
    if (!selected) {
      setFields([]);
      setTags([]);
      return;
    }
    let live = true;
    projectsApi
      .fields(selected.id)
      .then((res) => {
        if (live) setFields(res.rows);
      })
      // A board that works without its custom columns beats a board that
      // refuses to load because their definitions did not arrive.
      .catch(() => {
        if (live) setFields([]);
      });
    projectsApi
      .tags(selected.id)
      .then((res) => {
        if (live) setTags(res.rows);
      })
      .catch(() => {
        if (live) setTags([]);
      });
    return () => {
      live = false;
    };
  }, [selected, treeKey]);

  // Saved views belong to the selected node, and are re-read whenever it
  // changes — a chip from the previous project would apply filters that make
  // sense but claim a name that does not.
  useEffect(() => {
    if (!selected) {
      setViews([]);
      return;
    }
    let live = true;
    projectsApi
      .views(selected.id)
      .then((res) => {
        if (live) setViews(res.rows);
      })
      .catch(() => {
        // A board that works without its chips beats a board that refuses to
        // load because its view list did.
        if (live) setViews([]);
      });
    return () => {
      live = false;
    };
  }, [selected]);

  const projectName = useCallback(
    (id: string) =>
      flatten(roots).find((entry) => entry.node.id === id)?.node.name ?? "Project",
    [roots]
  );

  const groups = useMemo(
    () => groupTasks(tasks, groupBy, { statuses, projectName }),
    [tasks, groupBy, statuses, projectName]
  );

  const onScreen = useMemo(() => visibleIds(groups), [groups]);

  // A selection that outlives its filter is how a bulk edit hits tasks nobody
  // can see any more: select forty, narrow to three, press Done believing you
  // are acting on the three in front of you.
  useEffect(() => {
    setPicked((current) => {
      const pruned = prune(current, onScreen);
      return pruned.size === current.size ? current : pruned;
    });
  }, [onScreen]);

  function toggleSelection(id: string, shift: boolean) {
    setBulkNotice(null);
    setPicked((current) => {
      if (shift && anchor) {
        const next = new Set(current);
        for (const each of selectRange(onScreen, anchor, id)) next.add(each);
        return next;
      }
      return toggleId(current, id);
    });
    if (!shift) setAnchor(id);
  }

  // WS-27y — the keyboard's Shift+Arrow grew the selection; `stepCursor` only
  // ever adds, so replacing with its superset is the union.
  function extendSelection(ids: string[]) {
    setBulkNotice(null);
    setPicked(new Set(ids));
  }

  async function applyBulk(request: ReturnType<typeof buildRequest>) {
    if (!request) return;
    setBulkBusy(true);
    setBulkNotice(null);
    try {
      const outcome = await projectsApi.bulkEdit({
        ...request,
        task_ids: [...picked],
      });
      setBulkNotice(describeOutcome(outcome));
      // The selection is KEPT: a sweep is usually several passes over the same
      // set ("these fifty: status, then owner, then tag"), and clearing after
      // each would make the second pass a re-selection.
      if (selected) await loadProject(selected);
    } catch (err) {
      setBulkNotice(String((err as Error).message));
    } finally {
      setBulkBusy(false);
    }
  }

  function applyView(view: ViewRow) {
    const {
      filters: next,
      groupBy: nextGroup,
      lanes: nextLanes,
      shownFields: nextShown,
    } = fromConfig(view.config);
    setFilters(next);
    setGroupBy(nextGroup);
    setLanes(nextLanes);
    setShownFields(nextShown);
    setActiveViewId(view.id);
  }

  async function saveView(name: string) {
    if (!selected) return;
    try {
      const created = await projectsApi.createView(selected.id, {
        name,
        view_type: mode,
        config: toConfig(filters, groupBy, lanes, shownFields),
        // Above the seeded pair, so the drag handler keeps writing its order
        // into the project's original board rather than into a saved filter.
        position: SAVED_VIEW_POSITION + views.length,
      });
      setViews((current) => [...current, created]);
      setActiveViewId(created.id);
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  async function deleteView(view: ViewRow) {
    try {
      await projectsApi.deleteView(view.id);
      setViews((current) => current.filter((v) => v.id !== view.id));
      setActiveViewId((current) => (current === view.id ? null : current));
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  function changeFilters(next: Filters) {
    setFilters(next);
    // Editing after applying a view means the board is no longer that view.
    setActiveViewId(null);
  }

  // WS-27x — same rule for the shown-fields set: it is part of a view.
  function changeShownFields(next: string[]) {
    setShownFields(next);
    setActiveViewId(null);
  }

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

  /**
   * WS-27q — a task dragged to another day.
   *
   * A plain `PATCH`, deliberately: the same validation, the same
   * `field_change` activity and the same revert as an edit typed into the
   * panel. A dedicated "move" endpoint would be a second write path, which is
   * how two paths start disagreeing about what is allowed.
   *
   * Optimistic like the board's drop, and for the same reason — a drag that
   * waits for a round trip feels broken even when it is correct. `rescheduleTo`
   * has already refused a no-op, so this never posts an activity saying a task
   * moved to where it already was.
   */
  /**
   * WS-27t — a dependency drawn on the timeline.
   *
   * The SAME endpoint the task panel's dropdown posts to, so the cycle guard,
   * the activity row and the permission check are one implementation. The
   * refusal shown is the gateway's own message — `assert_no_block_cycle`
   * explains a loop better than anything this component could invent, and a
   * second wording would be a second rule to keep in step.
   *
   * **Nothing is rescheduled (D-PM-12).** Creating the link may make the arrow
   * red; that is the whole intended effect.
   */
  async function linkTasks(blockerId: string, blockedId: string) {
    try {
      await projectsApi.createLink(blockerId, blockedId, "blocks");
    } catch (err) {
      setError(String((err as Error).message));
    }
    await loadMonth();
  }

  async function moveTask(task: TaskRow, patch: Record<string, string | null>) {
    setMonth((current) => ({
      ...current,
      rows: current.rows.map((t) => (t.id === task.id ? { ...t, ...patch } : t)),
    }));
    try {
      await projectsApi.patchTask(task.id, patch);
    } catch (err) {
      setError(String((err as Error).message));
    }
    // Reloaded either way: on success to pick up anything the server derived,
    // on failure to replace the optimistic move with the truth.
    await loadMonth();
  }

  async function handleDrop(
    task: TaskRow,
    writes: ReturnType<typeof planDrop>,
    patch: Record<string, string | number | null> | null
  ) {
    // Optimistic: the card moves now and the truth arrives on reload. A drag
    // that waits for a round trip feels broken even when it is correct. The
    // WHOLE patch applies — a lane-cell drop moves two axes at once (WS-27y).
    if (patch) {
      setTasks((current) =>
        current.map((t) =>
          t.id === task.id ? { ...t, ...(patch as Partial<TaskRow>) } : t
        )
      );
    }
    try {
      if (patch) await projectsApi.patchTask(task.id, patch);
      const rootViews = await projectsApi.views(task.root_project_id);
      const board = orderBearingView(rootViews.rows);
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
          onImport={() => setImporting(true)}
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
            {/* Offered in the header too, not only from the empty state: the
                import is idempotent and re-running it is how a workspace stays
                current until WS-27g retires ClickUp. */}
            <Button
              variant="ghost"
              size="sm"
              icon="Download"
              onClick={() => setImporting(true)}
            >
              ClickUp
            </Button>
            {selected && !mine ? (
              <Button
                variant="ghost"
                size="sm"
                icon="SlidersHorizontal"
                onClick={() => setManagingFields(true)}
              >
                Fields
              </Button>
            ) : null}
            {selected && !mine ? (
              <Button
                variant="ghost"
                size="sm"
                icon="Tag"
                onClick={() => setManagingTags(true)}
              >
                Tags
              </Button>
            ) : null}
            {selected && !mine && !selected.parent_project_id ? (
              <Button
                variant="ghost"
                size="sm"
                icon="Archive"
                title="Auto-archive and auto-close policy for this project's subtree"
                onClick={() => setManagingLifecycle(true)}
              >
                Lifecycle
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              icon="Search"
              onClick={() => setSearching(true)}
              title="Search every project (⌘K)"
            >
              Search
            </Button>
            <NotificationBell onOpenTask={openTaskById} />
          </div>
          <div className={`flex shrink-0 gap-1 ${mine ? "hidden" : ""}`}>
            {(["board", "list", "table", "calendar", "timeline"] as ViewMode[]).map((m) => (
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
          <FilterBar
            filters={filters}
            onFilters={changeFilters}
            groupBy={groupBy}
            onGroupBy={(next) => {
              setGroupBy(next);
              // The new main axis may be the current sub-axis; lanes of the
              // board's own columns mean nothing, so they reset.
              setLanes((current) =>
                current.subGroupBy === next
                  ? { ...current, subGroupBy: "none", collapsedLanes: [] }
                  : current
              );
              setActiveViewId(null);
            }}
            subGroupBy={lanes.subGroupBy}
            onSubGroupBy={(next) => {
              // Collapsed-lane keys belong to the axis that made them.
              setLanes((current) => ({
                ...current,
                subGroupBy: next,
                collapsedLanes: [],
              }));
              setActiveViewId(null);
            }}
            me={me}
            tags={tags}
            shownFields={shownFields}
            onShownFields={changeShownFields}
            fields={fields}
            // The project's order-bearing board is withheld from the chips
            // entirely: it is not a saved filter, and offering its ✕ would
            // offer to delete every hand-arranged position on the project.
            views={views.filter((v) => v.id !== orderBearingView(views)?.id)}
            activeViewId={activeViewId}
            onApplyView={applyView}
            onSaveView={(name) => void saveView(name)}
            onDeleteView={(view) => void deleteView(view)}
            canSave={Boolean(selected)}
          />
        ) : null}

        {!mine && selected && picked.size > 0 ? (
          <BulkBar
            count={picked.size}
            statuses={statuses}
            busy={bulkBusy}
            notice={bulkNotice}
            onClear={() => {
              setPicked(new Set());
              setAnchor(null);
              setBulkNotice(null);
            }}
            onApply={(request) => void applyBulk(request)}
          />
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

        {/* WS-27u — the front door. Renders nothing when the queue is empty;
            a ruling reloads the board because an accept just added a card. */}
        {!mine && selected ? (
          <TriageRail
            projectId={selected.id}
            statuses={statuses}
            onOpenTask={(id) => void openTaskById(id)}
            onResolved={() => {
              if (selected) void loadProject(selected);
            }}
          />
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {mine ? (
            <MyWork onSelect={(task) => void openWithStatuses(task)} />
          ) : !selected ? (
            <p className="p-6 text-sm text-muted-foreground">
              Nothing here yet. Projects appear once a department is granted to you.
            </p>
          ) : mode === "timeline" ? (
            <TimelineView
              tasks={month.rows}
              links={month.links}
              undated={month.undated}
              truncated={month.truncated}
              today={dayKey(new Date())}
              shownFields={shownFields}
              onSelect={(task) => void openWithStatuses(task)}
              onLink={(blockerId, blockedId) => void linkTasks(blockerId, blockedId)}
              onRefuse={(reason) => setError(reason)}
            />
          ) : mode === "calendar" ? (
            <CalendarView
              grid={grid}
              tasks={month.rows}
              undated={month.undated}
              truncated={month.truncated}
              today={dayKey(new Date())}
              projectId={selected.id}
              shownFields={shownFields}
              onCreated={() => void loadMonth()}
              onSelect={(task) => void openWithStatuses(task)}
              onMove={(task, patch) => void moveTask(task, patch)}
              onStep={(months) => setMonthAnchor(shiftMonth(grid, months))}
              onToday={() => setMonthAnchor(new Date())}
            />
          ) : mode === "table" ? (
            <TableView
              groups={groups}
              groupBy={groupBy}
              statuses={statuses}
              fields={fields}
              shownFields={shownFields}
              sort={tableSort}
              onSort={setTableSort}
              projectId={selected.id}
              onCreated={() => void loadProject(selected)}
              onSaved={(fresh) =>
                setTasks((current) =>
                  current.map((t) => (t.id === fresh.id ? { ...t, ...fresh } : t))
                )
              }
              onSelect={(task) => void openWithStatuses(task)}
            />
          ) : mode === "board" ? (
            <TaskBoard
              groups={groups}
              groupBy={groupBy}
              lanes={lanes}
              onToggleLane={(key) =>
                setLanes((current) => ({
                  ...current,
                  collapsedLanes: toggleLane(current.collapsedLanes, key),
                }))
              }
              onShowEmptyLanes={(show) =>
                setLanes((current) => ({ ...current, showEmptyLanes: show }))
              }
              statuses={statuses}
              projectName={projectName}
              projectId={selected.id}
              shownFields={shownFields}
              onCreated={() => void loadProject(selected)}
              selected={picked}
              onToggle={toggleSelection}
              onExtendSelection={extendSelection}
              onSelect={(task) => void openWithStatuses(task)}
              onDrop={handleDrop}
            />
          ) : (
            <TaskList
              groups={groups}
              groupBy={groupBy}
              statuses={statuses}
              projectId={selected.id}
              shownFields={shownFields}
              onCreated={() => void loadProject(selected)}
              selected={picked}
              onToggle={toggleSelection}
              allChecked={everySelected(picked, onScreen)}
              onToggleAll={() =>
                setPicked(
                  everySelected(picked, onScreen) ? new Set() : new Set(onScreen)
                )
              }
              onExtendSelection={extendSelection}
              onSelect={(task) => void openWithStatuses(task)}
            />
          )}
        </div>
      </main>

      <SearchPalette
        open={searching}
        onClose={() => setSearching(false)}
        onOpenTask={(id) => void openTaskById(id)}
      />

      {openTask ? (
        <TaskPanel
          task={openTask}
          statuses={panelStatuses}
          fields={fields}
          tags={tags}
          // WS-27p — opening a subtask or a linked task resolves ITS project's
          // statuses, which the panel has no tree to do.
          onOpenTask={(id) => void openTaskById(id)}
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

      {managingTags && selected ? (
        <TagManager
          projectId={selected.id}
          projectName={selected.name}
          onClose={() => setManagingTags(false)}
          onChanged={setTags}
          // A rename or merge rewrites task rows, so the board is stale until
          // it reloads — the chips would otherwise show a name no card carries.
          onTasksTouched={() => {
            if (selected) void loadProject(selected);
          }}
        />
      ) : null}

      {managingLifecycle && selected ? (
        <LifecyclePolicy
          project={selected}
          onClose={() => setManagingLifecycle(false)}
          onSaved={(fresh) => {
            // The header's selected row keeps the fresh values; the tree
            // re-reads so its copy does not disagree on the next select.
            setSelected((current) =>
              current && current.id === fresh.id ? { ...current, ...fresh } : current
            );
            setTreeKey((k) => k + 1);
          }}
        />
      ) : null}

      {managingFields && selected ? (
        <FieldManager
          projectId={selected.id}
          projectName={selected.name}
          onClose={() => setManagingFields(false)}
          // Kept in sync while the dialog is open, so a field added here shows
          // on the next task opened without closing anything first.
          onChanged={setFields}
        />
      ) : null}

      {importing ? (
        <ImportClickUp
          onClose={() => setImporting(false)}
          // Re-reads the tree, so the departments appear behind the dialog
          // rather than after a manual refresh.
          onImported={() => setTreeKey((k) => k + 1)}
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
