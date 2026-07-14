"use client";

import { AlertTriangle, Clock, Paperclip, ListTree, Zap } from "lucide-react";
import { GtdItem } from "../lib/types";
import { durationLabel, initials, isOverdue, relativeTime } from "../lib/utils";
import { PriorityBadge } from "./PriorityControls";
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

const ALIGN: Record<ColumnDef["align"], string> = {
  left: "justify-start text-left",
  center: "justify-center text-center",
  right: "justify-end text-right",
};

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
    case "context":
      return item.context ? (
        <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary/90">
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
    case "assignee":
      return item.assignee ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[8px] font-bold text-primary">
            {initials(item.assignee.name)}
          </span>
          <span className="truncate">{item.assignee.name}</span>
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
