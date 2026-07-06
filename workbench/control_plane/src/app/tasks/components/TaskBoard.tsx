"use client";

import { useCallback, useMemo, useState } from "react";
import { GtdItem, ViewKey } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { TaskCard } from "./TaskCard";
import { applySort, byManualOrder } from "../lib/ordering";
import { stageAccent } from "../lib/stageColors";

// A Kanban board over the Next Actions items (Jira/ClickUp-style). Columns are
// the user's configured WORKFLOW STAGES (settings.workflowStages) — a single,
// GLOBAL, status-only axis (@context is a card chip, not a column; it already
// drives the left sidebar). Dropping on the LAST stage marks the task DONE
// (backend). Fixed columns — empty stages still show.
//
// Cards render in manual (sortKey) order within a column and are drag-
// reorderable: a drop computes a fractional rank between its new neighbours
// (reorderItem), and a cross-column drop ALSO re-files the stage in the same
// write. A field sort disables reordering (the sort overrides manual position).
// Native HTML5 DnD, no extra deps.
//
// The board is only offered for Next Actions (see ItemList `boardable`); other
// views render list-only until their own status model is designed.

type ColumnKind = "workflow" | "disposition";

function columnKindFor(view: ViewKey): ColumnKind {
  return view === "next" ? "workflow" : "disposition";
}

const UNSET = "—"; // em-dash sentinel for the "no value" column

export function TaskBoard({
  items,
  view,
  stageMode,
  stages,
}: {
  items: GtdItem[];
  view: ViewKey;
  /** Override the column axis. "provider" groups by the connected tool's
   *  status (ClickUp list stages) and drags re-file `providerStatus` (which
   *  back-syncs). Omitted → the view-derived axis (workflow stages for Next). */
  stageMode?: "workflow" | "provider";
  /** Explicit ordered column set (e.g. a project's own ClickUp statuses). When
   *  omitted the global workflow stages are used. */
  stages?: string[];
}) {
  const workflowSettingStages = useTaskStore((s) => s.settings.workflowStages);
  const workflowStages = stages ?? workflowSettingStages;
  const sort = useTaskStore((s) => s.sort);
  const reorderItem = useTaskStore((s) => s.reorderItem);
  const updateItem = useTaskStore((s) => s.updateItem);

  // "provider" mode groups by the connected tool's own stages; else the
  // view decides (workflow stages for Next, disposition elsewhere).
  const kind: "workflow" | "provider" | "disposition" =
    stageMode ?? columnKindFor(view);
  const manual = sort.field === "manual";
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  // Exact gap "<colKey>:<index>" the card would drop into (manual mode only).
  const [dropAt, setDropAt] = useState<string | null>(null);

  // An unstaged task sits in the FIRST configured stage of its axis.
  const firstStage = workflowStages[0];
  const stageOf = useCallback(
    (i: GtdItem): string => {
      if (kind === "workflow")
        return i.workflowStage && workflowStages.includes(i.workflowStage)
          ? i.workflowStage
          : firstStage;
      if (kind === "provider")
        return i.providerStatus && workflowStages.includes(i.providerStatus)
          ? i.providerStatus
          : firstStage;
      return i.disposition ?? UNSET;
    },
    [kind, workflowStages, firstStage],
  );

  // Column keys — the stage set for this axis. workflow/provider use the ordered
  // `workflowStages` (global stages or a project's ClickUp statuses); the
  // disposition fallback derives columns from the items present.
  const columns = useMemo(() => {
    if (kind === "workflow" || kind === "provider") {
      return workflowStages.map((s) => ({ key: s, label: s }));
    }
    const present = new Set<string>();
    for (const i of items) present.add(i.disposition ?? UNSET);
    const ordered = [...present].map((v) => ({ key: v, label: v }));
    return ordered.length ? ordered : [{ key: UNSET, label: "All" }];
  }, [items, kind, workflowStages]);

  const byColumn = useMemo(() => {
    const m = new Map<string, GtdItem[]>();
    for (const c of columns) m.set(c.key, []);
    for (const i of items) {
      const k = stageOf(i);
      (m.get(k) ?? m.set(k, []).get(k)!).push(i);
    }
    // Cards within a column follow the active sort (manual → sortKey order).
    for (const [k, arr] of m) m.set(k, applySort(arr, sort));
    return m;
  }, [items, columns, stageOf, sort]);

  const refileFor = (colKey: string) =>
    kind === "workflow"
      ? { workflowStage: colKey }
      : kind === "provider"
        ? { providerStatus: colKey }
        : undefined;

  // Drop onto a specific gap (index) within a column — reorder + re-file.
  const dropAtIndex = (colKey: string, index: number) => {
    setDropAt(null);
    setOverCol(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const dest = byManualOrder(byColumn.get(colKey) ?? []);
    reorderItem(id, dest, index, refileFor(colKey));
  };

  // Drop anywhere in a column (not on a card gap): keep the old semantics —
  // in a field sort we can't rank, so just re-file the stage/status.
  const dropColumn = (colKey: string) => {
    setOverCol(null);
    setDropAt(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const item = items.find((i) => i.id === id);
    if (!item) return;
    if (manual) {
      // append to the end of the column
      const dest = byManualOrder(byColumn.get(colKey) ?? []);
      reorderItem(id, dest, dest.length, refileFor(colKey));
      return;
    }
    if (stageOf(item) === colKey) return; // no move
    const refile = refileFor(colKey);
    if (refile) updateItem(id, refile);
  };

  return (
    <div className="flex h-full gap-3 overflow-x-auto p-4">
      {columns.map((col, ci) => {
        const colItems = byColumn.get(col.key) ?? [];
        const isOver = overCol === col.key;
        const accent = stageAccent(col.label || col.key, ci, columns.length);
        return (
          <div
            key={col.key}
            onDragOver={(e) => { e.preventDefault(); setOverCol(col.key); }}
            onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
            onDrop={() => dropColumn(col.key)}
            className={[
              "flex h-full w-72 shrink-0 flex-col overflow-hidden rounded-xl border bg-secondary/30",
              isOver ? "border-primary bg-primary/5" : "border-border",
            ].join(" ")}
          >
            {/* accent cap so each stage column is identifiable at a glance */}
            <div className={`h-1 w-full ${accent.dot}`} />
            <div
              className={[
                "flex items-center justify-between gap-2 border-b border-border px-3 py-2",
                accent.soft,
              ].join(" ")}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${accent.dot}`} />
                <span className={`truncate text-xs font-semibold ${accent.text}`}>
                  {col.label}
                </span>
              </span>
              <span className="shrink-0 rounded-full bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {colItems.length}
              </span>
            </div>
            <div className="flex flex-1 flex-col overflow-y-auto p-2">
              {colItems.map((i, idx) => (
                <div key={i.id}>
                  {/* drop gap ABOVE this card (manual reorder) */}
                  {manual && (
                    <DropGap
                      active={dropAt === `${col.key}:${idx}`}
                      onOver={() => dragId && setDropAt(`${col.key}:${idx}`)}
                      onDrop={() => dropAtIndex(col.key, idx)}
                    />
                  )}
                  <div className="pb-2">
                    <TaskCard
                      item={i}
                      draggable
                      onDragStart={() => setDragId(i.id)}
                      onDragEnd={() => { setDragId(null); setOverCol(null); setDropAt(null); }}
                    />
                  </div>
                </div>
              ))}
              {/* trailing gap → drop at the end */}
              {manual && colItems.length > 0 && (
                <DropGap
                  active={dropAt === `${col.key}:${colItems.length}`}
                  onOver={() => dragId && setDropAt(`${col.key}:${colItems.length}`)}
                  onDrop={() => dropAtIndex(col.key, colItems.length)}
                />
              )}
              {colItems.length === 0 && (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border/60 py-6 text-[11px] text-muted-foreground/60">
                  {isOver ? "Drop here" : "Empty"}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A thin, highlight-on-hover drop target between cards for manual reorder. */
function DropGap({
  active,
  onOver,
  onDrop,
}: {
  active: boolean;
  onOver: () => void;
  onDrop: () => void;
}) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDrop();
      }}
      className={[
        "-my-1 h-2 rounded transition-colors",
        active ? "bg-primary/40" : "bg-transparent",
      ].join(" ")}
    />
  );
}
