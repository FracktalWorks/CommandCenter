"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronRight, GripVertical } from "lucide-react";
import { GtdItem, ViewKey } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { TaskCard } from "./TaskCard";
import { applySort, byManualOrder } from "../lib/ordering";
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

type GroupKind = "workflow" | "none";

function groupKindFor(view: ViewKey): GroupKind {
  return view === "next" ? "workflow" : "none";
}

export function TaskListGrouped({
  items,
  view,
}: {
  items: GtdItem[];
  view: ViewKey;
}) {
  const workflowStages = useTaskStore((s) => s.settings.workflowStages);
  const sort = useTaskStore((s) => s.sort);
  const reorderItem = useTaskStore((s) => s.reorderItem);

  const kind = groupKindFor(view);
  const manual = sort.field === "manual";
  const firstStage = workflowStages[0];

  const [dragId, setDragId] = useState<string | null>(null);
  // The drop target as "<groupKey>:<index>" so a highlight can mark the exact
  // gap the card would land in.
  const [dropAt, setDropAt] = useState<string | null>(null);

  const groupOf = useCallback(
    (i: GtdItem): string =>
      kind === "workflow"
        ? (i.workflowStage && workflowStages.includes(i.workflowStage)
            ? i.workflowStage
            : firstStage)
        : UNSET,
    [kind, workflowStages, firstStage],
  );

  const groups = useMemo(() => {
    if (kind === "none") return [{ key: UNSET, label: "" }];
    return workflowStages.map((s) => ({ key: s, label: s }));
  }, [kind, workflowStages]);

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
    // Dropping into a stage group re-files the workflow stage (Next Actions
    // only); the flat "none" view just reorders.
    const refile =
      kind === "workflow" ? { workflowStage: groupKey } : undefined;
    reorderItem(id, dest, index, refile);
  };

  const total = groups.length;

  return (
    <div className="flex-1 overflow-y-auto">
      {groups.map((g, gi) => {
        const rows = byGroup.get(g.key) ?? [];
        const isCollapsed = collapsed.has(g.key);
        const showHeader = kind !== "none";
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
        "group/row relative flex items-stretch border-t-2 transition-colors",
        isDropTarget ? "border-primary" : "border-transparent",
      ].join(" ")}
    >
      {/* a precise drop line that reads even over a dense row */}
      {isDropTarget && (
        <span className="pointer-events-none absolute -top-[3px] left-0 h-1 w-1.5 rounded-full bg-primary" />
      )}
      {manual && (
        <span className="flex w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/25 transition-colors group-hover/row:text-muted-foreground/60 active:cursor-grabbing">
          <GripVertical className="h-3.5 w-3.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <TaskCard item={item} variant="row" />
      </div>
    </div>
  );
}
