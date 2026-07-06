"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronRight, GripVertical } from "lucide-react";
import { GtdItem, ViewKey } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { TaskCard } from "./TaskCard";
import { applySort, byManualOrder } from "../lib/ordering";

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

  return (
    <div className="flex-1 overflow-y-auto">
      {groups.map((g) => {
        const rows = byGroup.get(g.key) ?? [];
        const isCollapsed = collapsed.has(g.key);
        const showHeader = kind !== "none";
        return (
          <section key={g.key}>
            {showHeader && (
              <button
                type="button"
                onClick={() => toggle(g.key)}
                className="tech-transition sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-border bg-secondary/60 px-3.5 py-1.5 text-left backdrop-blur"
              >
                <ChevronRight
                  className={[
                    "h-3.5 w-3.5 text-muted-foreground transition-transform",
                    isCollapsed ? "" : "rotate-90",
                  ].join(" ")}
                />
                <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
                  {g.label}
                </span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {rows.length}
                </span>
              </button>
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
                {/* trailing gap → drop at the end of the group */}
                {manual && (
                  <div
                    onDragOver={(e) => {
                      if (!dragId) return;
                      e.preventDefault();
                      setDropAt(`${g.key}:${rows.length}`);
                    }}
                    onDrop={() => onDrop(g.key, rows.length)}
                    className={[
                      "h-3 transition-colors",
                      dropAt === `${g.key}:${rows.length}`
                        ? "bg-primary/20"
                        : "",
                    ].join(" ")}
                  />
                )}
                {rows.length === 0 && showHeader && (
                  <p className="px-8 py-2 text-[11px] text-muted-foreground/60">
                    Nothing in this stage.
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
        "group/row relative flex items-stretch",
        isDropTarget ? "border-t-2 border-primary" : "border-t-2 border-transparent",
      ].join(" ")}
    >
      {manual && (
        <span className="flex w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/30 opacity-0 group-hover/row:opacity-100 active:cursor-grabbing">
          <GripVertical className="h-3.5 w-3.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <TaskCard item={item} variant="row" />
      </div>
    </div>
  );
}
