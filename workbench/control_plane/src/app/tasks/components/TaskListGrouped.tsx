"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, GripVertical, CornerDownRight, Loader2, Circle, CheckCircle2 } from "lucide-react";
import { GtdItem, ViewKey } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { TaskCard } from "./TaskCard";
import {
  applySort,
  byManualOrder,
  statusColumns,
  statusColumnForItem,
} from "../lib/ordering";
import { stageAccent } from "../lib/stageColors";

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
}: {
  items: GtdItem[];
  view: ViewKey;
  /** Explicit ordered stage set (e.g. a project's ClickUp statuses). When
   *  omitted on Next Actions, the groups are the union of the local workflow
   *  stages and the connected tools' statuses. */
  stages?: string[];
}) {
  const workflowSettingStages = useTaskStore((s) => s.settings.workflowStages);
  const providerStatuses = useTaskStore((s) => s.providerStatuses);
  const sort = useTaskStore((s) => s.sort);
  const reorderItem = useTaskStore((s) => s.reorderItem);

  // Next Actions groups by the STATUS axis (local stages ∪ ClickUp statuses);
  // other views render a single flat group. A LOCAL row keys off `workflowStage`,
  // a SYNCED row off `providerStatus` (statusColumnForItem).
  const grouped = view === "next";
  const stageKeys = useMemo(
    () => stages ?? statusColumns(workflowSettingStages, providerStatuses),
    [stages, workflowSettingStages, providerStatuses],
  );
  const manual = sort.field === "manual";
  const firstStage = stageKeys[0];

  const [dragId, setDragId] = useState<string | null>(null);
  // The drop target as "<groupKey>:<index>" so a highlight can mark the exact
  // gap the card would land in.
  const [dropAt, setDropAt] = useState<string | null>(null);

  const groupOf = useCallback(
    (i: GtdItem): string =>
      grouped ? statusColumnForItem(i, stageKeys, firstStage) : UNSET,
    [grouped, stageKeys, firstStage],
  );

  const groups = useMemo(() => {
    if (!grouped) return [{ key: UNSET, label: "" }];
    return stageKeys.map((s) => ({ key: s, label: s }));
  }, [grouped, stageKeys]);

  const byGroup = useMemo(() => {
    const m = new Map<string, GtdItem[]>();
    for (const g of groups) m.set(g.key, []);
    for (const i of items) {
      const k = groupOf(i);
      (m.get(k) ?? m.set(k, []).get(k)!).push(i);
    }
    // Order each group by the active sort (manual → sortKey; else the field).
    for (const [k, arr] of m) m.set(k, applySort(arr, sort));
    return m;
  }, [items, groups, groupOf, sort]);

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
    // Dropping into a stage group re-files the status, SOURCE-AWARE: a SYNCED
    // (ClickUp) row sets `providerStatus` (back-syncs to the tool); a LOCAL row
    // sets its `workflowStage`. The flat (non-grouped) view just reorders.
    const dragged = items.find((i) => i.id === id);
    const refile = !grouped
      ? undefined
      : dragged?.source === "LOCAL"
        ? { workflowStage: groupKey }
        : { providerStatus: groupKey };
    reorderItem(id, dest, index, refile);
  };

  const total = groups.length;

  return (
    <div className="flex-1 overflow-y-auto">
      {groups.map((g, gi) => {
        const rows = byGroup.get(g.key) ?? [];
        const isCollapsed = collapsed.has(g.key);
        const showHeader = grouped;
        const accent = stageAccent(g.label || g.key, gi, total);
        const isDone = gi === total - 1;
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
                  "sticky top-0 z-10 flex items-center gap-2 border-b border-border border-l-2 px-3 py-1.5 backdrop-blur",
                  accent.soft,
                  accent.bar,
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
                  <span className={`h-2 w-2 shrink-0 rounded-full ${accent.dot}`} />
                  <span
                    className={`truncate text-[11px] font-semibold uppercase tracking-wide ${accent.text}`}
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
                    {dragId ? "Drop here to move to this stage" : "No tasks in this stage"}
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
  isDropTarget,
  onDragStart,
  onDragEnd,
  onDragOverGap,
  onDropGap,
}: {
  item: GtdItem;
  manual: boolean;
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
      <div className="flex items-stretch">
        {manual && (
          <span className="flex w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/25 transition-colors group-hover/row:text-muted-foreground/60 active:cursor-grabbing">
            <GripVertical className="h-3.5 w-3.5" />
          </span>
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
        <div className="min-w-0 flex-1">
          <TaskCard item={item} variant="row" />
        </div>
      </div>
      {hasSubtasks && expanded && <SubtaskRows parent={item} />}
    </div>
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
