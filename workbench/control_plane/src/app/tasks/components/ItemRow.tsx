"use client";

import { Clock, AlertTriangle, FolderKanban, Zap, Mail } from "lucide-react";
import { GtdItem } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import {
  durationLabel,
  initials,
  isOverdue,
  relativeTime,
} from "../lib/utils";
import { SourceBadge } from "./SourceBadge";

const ENERGY_DOT: Record<string, string> = {
  low: "bg-success",
  medium: "bg-warning",
  high: "bg-destructive",
};

export function ItemRow({ item, now }: { item: GtdItem; now: number }) {
  const selectedItemId = useTaskStore((s) => s.selectedItemId);
  const selectItem = useTaskStore((s) => s.selectItem);
  const projects = useTaskStore((s) => s.projects);
  const selected = selectedItemId === item.id;
  const project = item.projectId
    ? projects.find((p) => p.id === item.projectId)
    : undefined;
  const overdue = isOverdue(item, now);

  return (
    <button
      type="button"
      onClick={() => selectItem(item.id)}
      className={[
        "tech-transition flex w-full flex-col gap-1.5 border-b border-border px-3.5 py-3 text-left",
        selected ? "bg-primary/5" : "hover:bg-secondary/60",
      ].join(" ")}
    >
      <div className="flex items-start gap-2">
        <span
          className={[
            "mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2",
            selected ? "border-primary" : "border-border",
          ].join(" ")}
        />
        <span className="flex-1 text-sm leading-snug text-foreground">
          {item.title}
        </span>
        <SourceBadge source={item.source} provider={item.provider} size="xs" />
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[22px] text-[11px] text-muted-foreground">
        {item.context && (
          <span className="font-mono text-[11px] text-primary/80">{item.context}</span>
        )}
        {item.origin?.kind === "email" && (
          <span
            className="inline-flex items-center gap-1"
            title={`Captured from email — ${item.origin.fromName || item.origin.fromEmail || ""}${item.origin.subject ? `: ${item.origin.subject}` : ""}`}
          >
            <Mail className="h-3 w-3" />
            {item.origin.fromName || "email"}
          </span>
        )}
        {item.energy && (
          <span className="inline-flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${ENERGY_DOT[item.energy]}`} />
            {item.energy}
          </span>
        )}
        {item.timeEstimateMins ? (
          <span className="inline-flex items-center gap-1">
            <Zap className="h-3 w-3" />
            {durationLabel(item.timeEstimateMins)}
          </span>
        ) : null}
        {project && (
          <span className="inline-flex items-center gap-1 truncate">
            <FolderKanban className="h-3 w-3 shrink-0" />
            <span className="max-w-[160px] truncate">{project.outcome}</span>
          </span>
        )}
        {item.waitingOn && (
          <span className="inline-flex items-center gap-1">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-[8px] font-bold text-primary">
              {initials(item.waitingOn.name)}
            </span>
            {item.waitingOn.name}
          </span>
        )}
        {item.dueAt && (
          <span
            className={[
              "inline-flex items-center gap-1",
              overdue ? "font-medium text-destructive" : "",
            ].join(" ")}
          >
            {overdue ? (
              <AlertTriangle className="h-3 w-3" />
            ) : (
              <Clock className="h-3 w-3" />
            )}
            {relativeTime(item.dueAt, now)}
          </span>
        )}
      </div>
    </button>
  );
}
