"use client";

import { AlertTriangle, Clock, Paperclip, ListTree, Zap } from "lucide-react";
import { GtdItem } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { durationLabel, isOverdue, relativeTime } from "../lib/utils";
import { PriorityBadge } from "./PriorityControls";
import { ACTION_MODE_META, actionMode, type ActionMode } from "../lib/priority";
import { MODE_ICON } from "../lib/priorityIcons";
import { contextAccent } from "../lib/contextColors";
import type { ColumnDef } from "../lib/columns";

// The desktop columnar cells for the Next-Actions list. Each renders the SAME
// visual that signal has as a card pill — just placed in its own aligned grid
// column instead of wrapping under the title. Mobile never uses these (it keeps
// the stacked TaskCard row); see TaskListGrouped's sm: breakpoint.

const MOCK_NOW = Date.UTC(2026, 5, 30, 9, 0, 0);

const ENERGY_DOT: Record<string, string> = {
  low: "bg-success",
  medium: "bg-warning",
  high: "bg-destructive",
};

// Action-mode pill tint. "Do It" reads calm/affirmative; the "?" nudges use the
// same tones as the card SuggestionBadge so the language is consistent.
const MODE_TONE: Record<ActionMode, string> = {
  do: "border-primary/40 bg-primary/10 text-primary",
  delegate: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  schedule: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  drop: "border-border bg-secondary/60 text-muted-foreground",
};

const ALIGN: Record<ColumnDef["align"], string> = {
  left: "justify-start text-left",
  center: "justify-center text-center",
  right: "justify-end text-right",
};

/** The Suggestion column's pill — and it ACTS, same as the card nudge:
 *  "Do It"/"Schedule?" open the add-to-calendar popup, "Delegate?" the
 *  eligible-people picker, "Eliminate?" the Someday-or-delete popup.
 *  stopPropagation so the row doesn't also open the task. */
function ModePill({
  item,
  urgentWindowHours,
}: {
  item: GtdItem;
  urgentWindowHours?: number;
}) {
  const openSchedule = useTaskStore((s) => s.openSchedule);
  const openEliminate = useTaskStore((s) => s.openEliminate);
  const openDelegate = useTaskStore((s) => s.openDelegate);
  const mode = actionMode(item, urgentWindowHours);
  const meta = ACTION_MODE_META[mode];
  const ModeIcon = MODE_ICON[mode];
  const titles: Record<ActionMode, string> = {
    do: "Yours to do — put it on the calendar",
    schedule: "Schedule it on the calendar",
    delegate: "Pick who to hand this to",
    drop: "Let it go — Someday, or delete",
  };
  const act = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (mode === "delegate") openDelegate(item.id);
    else if (mode === "drop") openEliminate(item.id);
    else openSchedule(item.id);
  };
  return (
    <button
      type="button"
      onClick={act}
      title={titles[mode]}
      className={[
        "tech-transition inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium hover:brightness-110",
        MODE_TONE[mode],
      ].join(" ")}
    >
      <ModeIcon className="h-3 w-3 shrink-0" aria-hidden />
      {meta.label}
    </button>
  );
}

/** The header cell (column label) — matches the grid so headers sit above their
 *  column. Name is rendered by the caller as the flexible first track. */
export function ColumnHeader({ col }: { col: ColumnDef }) {
  return (
    <span
      className={[
        "flex items-center truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground",
        ALIGN[col.align],
      ].join(" ")}
    >
      {col.label}
    </span>
  );
}

/** One column's value cell for a task. Renders nothing (an empty aligned cell)
 *  when the task has no value for that column, so the grid stays aligned. */
export function ColumnCell({
  col,
  item,
  urgentWindowHours,
}: {
  col: ColumnDef;
  item: GtdItem;
  urgentWindowHours?: number;
}) {
  return (
    <div className={["flex min-w-0 items-center", ALIGN[col.align]].join(" ")}>
      <CellBody col={col} item={item} urgentWindowHours={urgentWindowHours} />
    </div>
  );
}

function CellBody({
  col,
  item,
  urgentWindowHours,
}: {
  col: ColumnDef;
  item: GtdItem;
  urgentWindowHours?: number;
}) {
  switch (col.key) {
    case "priority":
      return (
        <PriorityBadge item={item} urgentWindowHours={urgentWindowHours} />
      );
    case "mode":
      // The suggestion of what to DO with this task — from the shared
      // actionMode() logic (same as the "Action mode" group-by lens). Shown on
      // every task: "Do It" (yours) or a "?" nudge (Delegate/Schedule/Eliminate).
      return <ModePill item={item} urgentWindowHours={urgentWindowHours} />;
    case "context":
      return item.context ? (
        <span
          className={[
            "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px]",
            contextAccent(item.context).chip,
          ].join(" ")}
        >
          {item.context}
        </span>
      ) : null;
    case "energy":
      return item.energy ? (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full ${ENERGY_DOT[item.energy]}`} />
          {item.energy}
        </span>
      ) : null;
    case "estimate":
      return item.timeEstimateMins ? (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Zap className="h-3 w-3" />
          {durationLabel(item.timeEstimateMins)}
        </span>
      ) : null;
    case "due":
      return item.dueAt ? (
        <span
          className={[
            "inline-flex items-center gap-1 text-[10px]",
            isOverdue(item, MOCK_NOW)
              ? "font-medium text-destructive"
              : "text-muted-foreground",
          ].join(" ")}
        >
          {isOverdue(item, MOCK_NOW) ? (
            <AlertTriangle className="h-3 w-3" />
          ) : (
            <Clock className="h-3 w-3" />
          )}
          {relativeTime(item.dueAt, MOCK_NOW)}
        </span>
      ) : null;
    case "attachments":
      return item.attachments?.length ? (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
          <Paperclip className="h-3 w-3" />
          {item.attachments.length}
        </span>
      ) : null;
    case "subtasks":
      return item.subtaskCount ? (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
          <ListTree className="h-3 w-3" />
          {item.subtaskCount}
        </span>
      ) : null;
    default:
      return null;
  }
}
