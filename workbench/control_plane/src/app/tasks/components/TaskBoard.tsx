"use client";

import { useCallback, useMemo, useState } from "react";
import { GtdItem, ViewKey } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { TaskCard } from "./TaskCard";
import { applySort, byManualOrder, statusColumnForItem } from "../lib/ordering";
import { stageAccent } from "../lib/stageColors";

// A Kanban board over the Next Actions items (Jira/ClickUp-style). Columns are
// the user's 4 FIXED workflow stages (settings.workflowStages) — not the raw
// ClickUp statuses. A LOCAL card keys off its `workflowStage`; a SYNCED card off
// its ClickUp `providerStatus` translated through the status→stage MAP, so many
// upstream statuses collapse into one clean stage. Dragging a card writes the
// mapped status back to ClickUp (per task's project). (@context is a card chip,
// not a column.) Dropping on the LAST stage marks the task DONE (backend). The
// per-PROJECT view passes explicit `stages` (that project's real ClickUp
// statuses) and bypasses the map. Fixed columns — empty stages still show.
//
// Cards render in manual (sortKey) order within a column and are drag-
// reorderable: a drop computes a fractional rank between its new neighbours
// (reorderItem), and a cross-column drop ALSO re-files the stage in the same
// write. A field sort disables reordering (the sort overrides manual position).
// Native HTML5 DnD, no extra deps.
//
// The board is only offered for Next Actions (see ItemList `boardable`); other
// views render list-only until their own status model is designed.

export function TaskBoard({
  items,
  stages,
}: {
  items: GtdItem[];
  view: ViewKey;
  /** Explicit ordered column set (e.g. a project's own ClickUp statuses). When
   *  omitted, the columns are the union of the global local workflow stages and
   *  the connected tools' statuses (so ClickUp tasks land in their real stage,
   *  not all in the first column). */
  stages?: string[];
}) {
  const workflowSettingStages = useTaskStore((s) => s.settings.workflowStages);
  const statusStageMap = useTaskStore((s) => s.settings.statusStageMap);
  const sort = useTaskStore((s) => s.sort);
  const reorderItem = useTaskStore((s) => s.reorderItem);
  const updateItem = useTaskStore((s) => s.updateItem);
  // Multi-select for bulk archive/delete — works right on the board now. While
  // selecting, cards become selection toggles and drag is suppressed (a checkbox
  // and a drag handle on the same card would fight each other).
  const selectMode = useTaskStore((s) => s.selectMode);
  const selectedIds = useTaskStore((s) => s.selectedIds);
  const toggleSelected = useTaskStore((s) => s.toggleSelected);

  // Columns: an explicit stage set (the per-project view's real ClickUp
  // statuses) or the user's 4 fixed workflow stages. A LOCAL task keys off its
  // `workflowStage`; a SYNCED task off its ClickUp status through the status→
  // stage map (or the project view's own statuses, where the map is a no-op).
  const stageKeys = useMemo(
    () => stages ?? workflowSettingStages,
    [stages, workflowSettingStages],
  );
  // In the project view (explicit `stages`) grouping is by raw status, so the
  // map is bypassed; on the global board it translates the ClickUp status.
  const effectiveMap = useMemo(
    () => (stages ? {} : statusStageMap),
    [stages, statusStageMap],
  );
  // Manual drag-reorder is a sort affordance; suppressed while multi-selecting.
  const manual = sort.field === "manual" && !selectMode;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  // Exact gap "<colKey>:<index>" the card would drop into (manual mode only).
  const [dropAt, setDropAt] = useState<string | null>(null);

  // An unstaged task sits in the FIRST column of the axis.
  const firstStage = stageKeys[0];
  const stageOf = useCallback(
    (i: GtdItem): string =>
      statusColumnForItem(i, stageKeys, firstStage, effectiveMap),
    [stageKeys, firstStage, effectiveMap],
  );

  const columns = useMemo(
    () => stageKeys.map((s) => ({ key: s, label: s })),
    [stageKeys],
  );

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

  // Refile depends on the axis:
  //  • Global board (columns = local STAGES): set `workflowStage` for both
  //    LOCAL and SYNCED. For a synced task the backend translates the stage into
  //    that task's own ClickUp status via the status→stage map and writes it
  //    back; if nothing maps, the move stays local (workflowStage override).
  //  • Project view (columns = the project's raw ClickUp STATUSES): set
  //    `providerStatus` directly (back-syncs), as before.
  const refileFor = (colKey: string, id: string | null) => {
    const it = id ? items.find((i) => i.id === id) : undefined;
    if (!it) return undefined;
    if (stages) {
      // Project view: raw ClickUp status axis.
      return it.source === "LOCAL"
        ? { workflowStage: colKey }
        : { providerStatus: colKey };
    }
    // Global board: local stage axis (backend maps synced → ClickUp status).
    return { workflowStage: colKey };
  };

  // Drop onto a specific gap (index) within a column — reorder + re-file.
  const dropAtIndex = (colKey: string, index: number) => {
    setDropAt(null);
    setOverCol(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const dest = byManualOrder(byColumn.get(colKey) ?? []);
    reorderItem(id, dest, index, refileFor(colKey, id));
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
      reorderItem(id, dest, dest.length, refileFor(colKey, id));
      return;
    }
    if (stageOf(item) === colKey) return; // no move
    const refile = refileFor(colKey, id);
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
                      draggable={!selectMode}
                      selectMode={selectMode}
                      selected={selectedIds.has(i.id)}
                      onToggleSelected={() => toggleSelected(i.id)}
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
