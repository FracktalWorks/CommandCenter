"use client";

import { useCallback, useMemo, useState } from "react";
import { GtdItem, ViewKey } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { TaskCard } from "./TaskCard";

// A Kanban board over the current view's items (Jira/ClickUp-style). Columns:
//   next     → the user's configured WORKFLOW STAGES (settings.workflowStages);
//              context becomes a card chip. Dropping on the LAST stage marks the
//              task DONE (backend). Fixed columns — empty stages still show.
//   waiting  → by provider stage (or "No stage")
//   someday  → by provider stage (or a single column)
//   default  → by disposition
// Dragging a card re-files it via updateItem — for a SYNCED task that back-syncs
// to the connected tool through the PATCH path. Native HTML5 DnD, no extra deps.

type ColumnKind = "workflow" | "stage" | "disposition";

function columnKindFor(view: ViewKey): ColumnKind {
  if (view === "next") return "workflow";
  if (view === "waiting" || view === "someday") return "stage";
  return "disposition";
}

const UNSET = "—"; // em-dash sentinel for the "no value" column

export function TaskBoard({ items, view }: { items: GtdItem[]; view: ViewKey }) {
  const accounts = useTaskStore((s) => s.accounts);
  const workflowStages = useTaskStore((s) => s.settings.workflowStages);
  const updateItem = useTaskStore((s) => s.updateItem);

  const kind = columnKindFor(view);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  // For the workflow board an unstaged task sits in the FIRST configured stage.
  const firstStage = workflowStages[0];
  const stageOf = useCallback(
    (i: GtdItem): string =>
      kind === "workflow"
        ? (i.workflowStage && workflowStages.includes(i.workflowStage)
            ? i.workflowStage
            : firstStage)
        : (colValue(i, kind) ?? UNSET),
    [kind, workflowStages, firstStage],
  );

  // Column keys for this view — a stable, ordered set.
  const columns = useMemo(() => {
    if (kind === "workflow") {
      return workflowStages.map((s) => ({ key: s, label: s }));
    }
    const present = new Set<string>();
    for (const i of items) present.add(colValue(i, kind) ?? UNSET);
    const ordered: { key: string; label: string }[] = [];
    if (kind === "stage") {
      const stages = accounts.flatMap((a) => a.statuses ?? []);
      const seen = new Set<string>();
      for (const s of stages)
        if (present.has(s) && !seen.has(s)) { seen.add(s); ordered.push({ key: s, label: s }); }
      for (const v of present)
        if (v !== UNSET && !seen.has(v)) { seen.add(v); ordered.push({ key: v, label: v }); }
      if (present.has(UNSET)) ordered.push({ key: UNSET, label: "No stage" });
    } else {
      for (const v of present) ordered.push({ key: v, label: v });
    }
    return ordered.length ? ordered : [{ key: UNSET, label: "All" }];
  }, [items, kind, accounts, workflowStages]);

  const byColumn = useMemo(() => {
    const m = new Map<string, GtdItem[]>();
    for (const c of columns) m.set(c.key, []);
    for (const i of items) {
      const k = stageOf(i);
      (m.get(k) ?? m.set(k, []).get(k)!).push(i);
    }
    return m;
  }, [items, columns, stageOf]);

  const drop = (colKey: string) => {
    setOverCol(null);
    if (!dragId) return;
    const item = items.find((i) => i.id === dragId);
    setDragId(null);
    if (!item) return;
    if (stageOf(item) === colKey) return; // no move
    if (kind === "workflow") updateItem(item.id, { workflowStage: colKey });
    else if (kind === "stage")
      updateItem(item.id, { providerStatus: colKey === UNSET ? "" : colKey });
  };

  return (
    <div className="flex h-full gap-3 overflow-x-auto p-4">
      {columns.map((col) => {
        const colItems = byColumn.get(col.key) ?? [];
        const isOver = overCol === col.key;
        return (
          <div
            key={col.key}
            onDragOver={(e) => { e.preventDefault(); setOverCol(col.key); }}
            onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
            onDrop={() => drop(col.key)}
            className={[
              "flex h-full w-72 shrink-0 flex-col rounded-xl border bg-secondary/30",
              isOver ? "border-primary bg-primary/5" : "border-border",
            ].join(" ")}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span className="truncate text-xs font-semibold text-foreground">
                {col.label}
              </span>
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {colItems.length}
              </span>
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
              {colItems.map((i) => (
                <TaskCard
                  key={i.id}
                  item={i}
                  draggable
                  onDragStart={() => setDragId(i.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); }}
                />
              ))}
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

/** The value that decides which column an item sits in, for the stage/
 *  disposition kinds. (The "workflow" kind is handled by stageOf.) */
function colValue(i: GtdItem, kind: ColumnKind): string | undefined {
  if (kind === "stage") return i.providerStatus || undefined;
  return i.disposition;
}
