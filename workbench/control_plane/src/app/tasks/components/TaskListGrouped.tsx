"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronRight, GripVertical, CornerDownRight, Loader2, Circle, CheckCircle2 } from "lucide-react";
import { GtdItem, ViewKey } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { TaskCard } from "./TaskCard";
import {
  applySort,
  byManualOrder,
  statusColumnForItem,
  groupItems,
  type GroupBy,
  type TaskGroup,
} from "../lib/ordering";
import { stageAccent } from "../lib/stageColors";
import {
  readColumnVisibility,
  subscribeColumns,
  visibleColumns,
  gridTemplate,
  DEFAULT_VISIBLE,
  type ColumnDef,
} from "../lib/columns";
import { ColumnHeader, ColumnCell } from "./ListColumns";

// A status-segmented list (Jira backlog style): rows grouped under collapsible
// stage headers with counts. In Manual sort the rows are drag-reorderable —
// within a group (reposition) and across groups (re-file to that stage). A
// field sort disables dragging (the sort would override the manual position),
// matching the board and how Jira/Linear behave.
//
// Grouping axis, matching the board's columnKindFor:
//   next    → the configured workflow stages
//   else → a single flat group (no status headers)
//
// Grouping is STATUS-ONLY and applies to Next Actions alone. @context is not a
// grouping axis here — it already drives the left sidebar. Waiting/Someday/etc.
// render flat for now (their own status model is a later workstream).

const UNSET = "—";

export function TaskListGrouped({
  items,
  view,
  stages,
  groupBy = "",
}: {
  items: GtdItem[];
  view: ViewKey;
  /** Explicit ordered stage set (a project's ClickUp statuses). When omitted on
   *  Next Actions, the groups are the user's 4 fixed workflow stages. */
  stages?: string[];
  /** The grouping axis. "" (default) groups by STATUS (drag-reorderable stages).
   *  A lens ("priority" | "mode" | "energy" | "context") groups by that signal —
   *  read-only (you can't drag to change a computed attribute), but columns and
   *  multi-select still work. */
  groupBy?: GroupBy | "";
}) {
  const workflowSettingStages = useTaskStore((s) => s.settings.workflowStages);
  const statusStageMap = useTaskStore((s) => s.settings.statusStageMap);
  const urgentWindowHours = useTaskStore((s) => s.settings.urgentWindowHours);
  const sort = useTaskStore((s) => s.sort);
  const reorderItem = useTaskStore((s) => s.reorderItem);
  // Multi-select: when active, rows show a checkbox and drag is suppressed
  // (selecting and dragging the same card would conflict).
  const selectMode = useTaskStore((s) => s.selectMode);
  const selectedIds = useTaskStore((s) => s.selectedIds);
  const toggleSelected = useTaskStore((s) => s.toggleSelected);

  // Status grouping (the default): the drag-reorderable workflow-stage swimlanes.
  // A lens grouping (priority/mode/energy/context) is read-only swimlanes over
  // the same set — you can't drag to change a computed attribute. Both keep the
  // columns. Only Next Actions groups at all; other views are a single group.
  const isLens = groupBy !== "" && groupBy !== "none";
  const statusGrouped = view === "next" && !isLens;
  const grouped = view === "next"; // any grouping (status or lens) shows headers
  // Columnar list (desktop) applies to ALL Next-Actions groupings now — the same
  // aligned columns whether you group by status, priority, energy, etc. The
  // project view (explicit `stages`) keeps the simple stacked row. Mobile always
  // falls back to the stacked card (handled per-row via the sm: breakpoint).
  const columnVis = useSyncExternalStore(
    subscribeColumns,
    readColumnVisibility,
    () => DEFAULT_VISIBLE,
  );
  const columnar = view === "next" && !stages;
  const cols = useMemo(
    () => (columnar ? visibleColumns(columnVis) : []),
    [columnar, columnVis],
  );
  const grid = useMemo(() => gridTemplate(cols), [cols]);
  const stageKeys = useMemo(
    () => stages ?? workflowSettingStages,
    [stages, workflowSettingStages],
  );
  const effectiveMap = useMemo(
    () => (stages ? {} : statusStageMap),
    [stages, statusStageMap],
  );
  // Drag-reorder is a manual-sort affordance on the STATUS axis only; off while
  // multi-selecting and off for a lens grouping (can't drag to change priority).
  const manual = sort.field === "manual" && !selectMode && statusGrouped;
  const firstStage = stageKeys[0];

  const [dragId, setDragId] = useState<string | null>(null);
  // The drop target as "<groupKey>:<index>" so a highlight can mark the exact
  // gap the card would land in.
  const [dropAt, setDropAt] = useState<string | null>(null);

  // A lens grouping delegates to groupItems() (the shared slicer) — precomputed
  // once, since a lens can't reorder mid-render. Status grouping keys off the
  // stage each item resolves to. Non-next views are a single flat group.
  const lensGroups = useMemo<TaskGroup[]>(
    () =>
      isLens && view === "next"
        ? groupItems(items, groupBy as GroupBy, urgentWindowHours)
        : [],
    [isLens, view, items, groupBy, urgentWindowHours],
  );

  const groupOf = useCallback(
    (i: GtdItem): string =>
      statusGrouped
        ? statusColumnForItem(i, stageKeys, firstStage, effectiveMap)
        : UNSET,
    [statusGrouped, stageKeys, firstStage, effectiveMap],
  );

  const groups = useMemo(() => {
    if (isLens && view === "next") {
      return lensGroups.map((g) => ({ key: g.key, label: g.label, emoji: g.emoji }));
    }
    if (!statusGrouped) return [{ key: UNSET, label: "" }];
    return stageKeys.map((s) => ({ key: s, label: s }));
  }, [isLens, view, lensGroups, statusGrouped, stageKeys]);

  const byGroup = useMemo(() => {
    const m = new Map<string, GtdItem[]>();
    for (const g of groups) m.set(g.key, []);
    if (isLens && view === "next") {
      // The lens slicer already bucketed the items; just sort within each group.
      for (const g of lensGroups) m.set(g.key, applySort(g.items, sort));
      return m;
    }
    for (const i of items) {
      const k = groupOf(i);
      (m.get(k) ?? m.set(k, []).get(k)!).push(i);
    }
    // Order each group by the active sort (manual → sortKey; else the field).
    for (const [k, arr] of m) m.set(k, applySort(arr, sort));
    return m;
  }, [items, groups, groupOf, sort, isLens, view, lensGroups]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const onDrop = (groupKey: string, index: number) => {
    setDropAt(null);
    const id = dragId;
    setDragId(null);
    if (!id || !manual) return;
    const dest = byManualOrder(byGroup.get(groupKey) ?? []);
    // Re-file into the group's stage. Global board (local stage axis): set
    // `workflowStage` for all — the backend maps a synced task's stage to its
    // ClickUp status. Project view (raw-status axis, `stages` given): a SYNCED
    // row sets `providerStatus` directly; a LOCAL row its `workflowStage`. The
    // flat (non-grouped) view just reorders.
    const dragged = items.find((i) => i.id === id);
    const refile = !grouped
      ? undefined
      : stages
        ? dragged?.source === "LOCAL"
          ? { workflowStage: groupKey }
          : { providerStatus: groupKey }
        : { workflowStage: groupKey };
    reorderItem(id, dest, index, refile);
  };

  const total = groups.length;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Desktop column header row (Context list only). Hidden on mobile, where
          rows stay stacked. The left spacer matches a row's grip+expand gutters
          so "Name" and the cells sit above their columns. */}
      {columnar && cols.length > 0 && (
        <div className="sticky top-0 z-20 hidden border-b border-border bg-card/95 px-3.5 py-1.5 backdrop-blur sm:block">
          <div
            className="grid items-center gap-2"
            style={{ gridTemplateColumns: grid }}
          >
            <span className="pl-10 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Name
            </span>
            {cols.map((c) => (
              <ColumnHeader key={c.key} col={c} />
            ))}
          </div>
        </div>
      )}
      {groups.map((g, gi) => {
        const rows = byGroup.get(g.key) ?? [];
        const isCollapsed = collapsed.has(g.key);
        const showHeader = grouped;
        // Status swimlanes get the per-stage accent; a lens grouping uses a plain
        // neutral header + its own emoji (the accent is a stage concept).
        const accent = stageAccent(g.label || g.key, gi, total);
        const emoji = (g as { emoji?: string }).emoji;
        const isDone = statusGrouped && gi === total - 1;
        // Highlight the whole group while a card hovers anywhere over it, so a
        // cross-stage move reads clearly even before hitting a precise gap.
        const groupHot = dropAt?.startsWith(`${g.key}:`) ?? false;
        return (
          <section
            key={g.key}
            className={groupHot ? "bg-primary/[0.03]" : undefined}
          >
            {showHeader && (
              <div
                className={[
                  "sticky top-0 z-10 flex items-center gap-2 border-b border-border px-3 py-1.5 backdrop-blur",
                  statusGrouped ? `border-l-2 ${accent.soft} ${accent.bar}` : "bg-card/95",
                ].join(" ")}
              >
                <button
                  type="button"
                  onClick={() => toggle(g.key)}
                  className="tech-transition flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <ChevronRight
                    className={[
                      "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                      isCollapsed ? "" : "rotate-90",
                    ].join(" ")}
                  />
                  {statusGrouped ? (
                    <span className={`h-2 w-2 shrink-0 rounded-full ${accent.dot}`} />
                  ) : emoji ? (
                    <span aria-hidden className="shrink-0 text-xs">{emoji}</span>
                  ) : null}
                  <span
                    className={[
                      "truncate text-[11px] font-semibold uppercase tracking-wide",
                      statusGrouped ? accent.text : "text-foreground",
                    ].join(" ")}
                  >
                    {g.label}
                  </span>
                  <span
                    className={[
                      "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                      "bg-background/60 text-muted-foreground",
                    ].join(" ")}
                  >
                    {rows.length}
                  </span>
                  {isDone && (
                    <span className="shrink-0 rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-success">
                      Done
                    </span>
                  )}
                </button>
              </div>
            )}
            {!isCollapsed && (
              <div>
                {rows.map((item, idx) => (
                  <DraggableRow
                    key={item.id}
                    item={item}
                    manual={manual}
                    selectMode={selectMode}
                    selected={selectedIds.has(item.id)}
                    onToggleSelected={() => toggleSelected(item.id)}
                    columns={cols}
                    grid={grid}
                    isDropTarget={dropAt === `${g.key}:${idx}`}
                    onDragStart={() => setDragId(item.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropAt(null);
                    }}
                    onDragOverGap={() => setDropAt(`${g.key}:${idx}`)}
                    onDropGap={() => onDrop(g.key, idx)}
                  />
                ))}
                {/* trailing gap → drop at the end of the group. Taller when a
                    drag is active so an empty/short stage is an easy target. */}
                {manual && (
                  <div
                    onDragOver={(e) => {
                      if (!dragId) return;
                      e.preventDefault();
                      setDropAt(`${g.key}:${rows.length}`);
                    }}
                    onDrop={() => onDrop(g.key, rows.length)}
                    className={[
                      "transition-all",
                      dragId ? "h-6" : "h-2",
                      dropAt === `${g.key}:${rows.length}`
                        ? "border-t-2 border-primary bg-primary/10"
                        : "border-t-2 border-transparent",
                    ].join(" ")}
                  />
                )}
                {rows.length === 0 && showHeader && (
                  <p className="px-9 py-2.5 text-[11px] italic text-muted-foreground/50">
                    {dragId
                      ? "Drop here to move to this stage"
                      : statusGrouped
                        ? "No tasks in this stage"
                        : "No tasks in this group"}
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function DraggableRow({
  item,
  manual,
  selectMode,
  selected,
  onToggleSelected,
  columns,
  grid,
  isDropTarget,
  onDragStart,
  onDragEnd,
  onDragOverGap,
  onDropGap,
}: {
  item: GtdItem;
  manual: boolean;
  selectMode: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  /** Visible desktop columns (empty → no columnar layout, stacked card only). */
  columns: ColumnDef[];
  /** grid-template-columns matching the header (only used when columns set). */
  grid: string;
  isDropTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverGap: () => void;
  onDropGap: () => void;
}) {
  // Jira/ClickUp-style nesting: a task with subtasks shows ONE row with an
  // expand chevron + a progress count; expanding lazily loads and reveals the
  // child subtasks (the actual next actions) indented beneath it.
  const [expanded, setExpanded] = useState(false);
  const hasSubtasks = (item.subtaskCount ?? 0) > 0;

  return (
    <div
      draggable={manual}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!manual) return;
        e.preventDefault();
        onDragOverGap();
      }}
      onDrop={(e) => {
        if (!manual) return;
        e.preventDefault();
        onDropGap();
      }}
      className={[
        "group/row relative border-t-2 transition-colors",
        isDropTarget ? "border-primary" : "border-transparent",
      ].join(" ")}
    >
      {/* a precise drop line that reads even over a dense row */}
      {isDropTarget && (
        <span className="pointer-events-none absolute -top-[3px] left-0 h-1 w-1.5 rounded-full bg-primary" />
      )}
      <div className={["flex items-stretch", selected ? "bg-primary/5" : ""].join(" ")}>
        {selectMode ? (
          <label className="flex w-9 shrink-0 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelected}
              className="h-4 w-4 accent-primary"
              aria-label={selected ? "Deselect task" : "Select task"}
            />
          </label>
        ) : (
          manual && (
            <span className="flex w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/25 transition-colors group-hover/row:text-muted-foreground/60 active:cursor-grabbing">
              <GripVertical className="h-3.5 w-3.5" />
            </span>
          )
        )}
        {/* expand toggle — only for parents; keeps a fixed-width gutter so all
            rows stay left-aligned whether or not they have subtasks. */}
        <span className="flex w-5 shrink-0 items-center justify-center">
          {hasSubtasks && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? "Collapse subtasks" : "Expand subtasks"}
              aria-expanded={expanded}
              className="tech-transition rounded p-0.5 text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
            >
              <ChevronRight
                className={[
                  "h-3.5 w-3.5 transition-transform",
                  expanded ? "rotate-90" : "",
                ].join(" ")}
              />
            </button>
          )}
        </span>
        {selectMode ? (
          // In select mode the whole row toggles selection; the content is inert
          // so a click selects rather than opening the task.
          <button
            type="button"
            onClick={onToggleSelected}
            className="min-w-0 flex-1 text-left"
            aria-pressed={selected}
          >
            <div className="pointer-events-none">
              <RowContent item={item} columns={columns} grid={grid} />
            </div>
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <RowContent item={item} columns={columns} grid={grid} />
          </div>
        )}
      </div>
      {hasSubtasks && expanded && <SubtaskRows parent={item} />}
    </div>
  );
}

/** The row's body. With columns (desktop, Context view) it renders as an aligned
 *  grid — Name in the flexible track, then one cell per visible column. Mobile
 *  always falls back to the stacked TaskCard row (title + pills beneath), and so
 *  does the project view (no columns). */
function RowContent({
  item,
  columns,
  grid,
}: {
  item: GtdItem;
  columns: ColumnDef[];
  grid: string;
}) {
  const urgentWindowHours = useTaskStore((s) => s.settings.urgentWindowHours);
  const openFocus = useTaskStore((s) => s.openFocus);
  if (columns.length === 0) {
    return <TaskCard item={item} variant="row" />;
  }
  return (
    <>
      {/* Mobile: the stacked card (title + wrapping pills) — clickable itself. */}
      <div className="sm:hidden">
        <TaskCard item={item} variant="row" />
      </div>
      {/* Desktop: aligned columns matching the header grid. The row opens the
          focus modal on click (Enter/Space too) — same affordance as the card,
          so the columnar list is clickable. Column cells that carry their own
          interactive controls stop propagation. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => openFocus(item.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openFocus(item.id);
          }
        }}
        className="tech-transition hidden cursor-pointer items-center gap-2 py-2.5 pr-3.5 hover:bg-secondary/40 sm:grid"
        style={{ gridTemplateColumns: grid }}
      >
        <span className="min-w-0 truncate text-sm text-foreground">
          {item.title}
        </span>
        {columns.map((c) => (
          <ColumnCell
            key={c.key}
            col={c}
            item={item}
            urgentWindowHours={urgentWindowHours}
          />
        ))}
      </div>
    </>
  );
}

// The lazily-loaded child subtasks of an expanded parent row. Each is the next
// physical action for finishing the parent; clicking opens it, and the leading
// dot toggles completion (a one-tap "did this step").
function SubtaskRows({ parent }: { parent: GtdItem }) {
  const loadSubtasks = useTaskStore((s) => s.loadSubtasks);
  const openFocus = useTaskStore((s) => s.openFocus);
  const quickDispose = useTaskStore((s) => s.quickDispose);
  const [children, setChildren] = useState<GtdItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSubtasks(parent.id).then((rows) => {
      if (!cancelled) setChildren(rows);
    });
    return () => {
      cancelled = true;
    };
    // Re-load when the parent's subtask count changes (added/removed elsewhere).
  }, [parent.id, parent.subtaskCount, loadSubtasks]);

  if (children === null) {
    return (
      <div className="flex items-center gap-2 py-2 pl-14 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading subtasks…
      </div>
    );
  }
  if (children.length === 0) {
    return (
      <p className="py-1.5 pl-14 text-[11px] italic text-muted-foreground/50">
        No subtasks.
      </p>
    );
  }
  return (
    <div className="border-l border-border/60 ml-[26px]">
      {children.map((c) => {
        const done = c.disposition === "DONE";
        return (
          <div
            key={c.id}
            className="tech-transition group/sub flex items-center gap-2 py-1.5 pl-4 pr-3.5 hover:bg-secondary/40"
          >
            <button
              type="button"
              onClick={() => quickDispose(c.id, done ? "NEXT" : "DONE")}
              aria-label={done ? "Mark not done" : "Mark done"}
              title={done ? "Mark not done" : "Mark done"}
              className="tech-transition shrink-0 text-muted-foreground/50 hover:text-success"
            >
              {done ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <Circle className="h-4 w-4" />
              )}
            </button>
            <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground/30" />
            <button
              type="button"
              onClick={() => openFocus(c.id)}
              className={[
                "min-w-0 flex-1 truncate text-left text-[13px]",
                done
                  ? "text-muted-foreground line-through"
                  : "text-foreground hover:text-primary",
              ].join(" ")}
            >
              {c.nextAction || c.title}
            </button>
          </div>
        );
      })}
    </div>
  );
}
