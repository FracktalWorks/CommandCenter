"use client";

import { Mail, Paperclip, ArrowRight, Trash2, Lightbulb } from "lucide-react";
import { GtdItem } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import { proposeClarification } from "../lib/clarify";
import { relativeTime } from "../lib/utils";
import { SourceBadge } from "./SourceBadge";

// Dense Notion-style list view for the inbox: one row per capture with the
// attributes that matter at triage time as columns — far more items on
// screen than the card view. Someday · clarify reveal on hover; the trash
// icon is always visible (removing a capture is never buried). Row click
// selects, title click opens Clarify.
export function InboxTable({
  items,
  cursorId,
  selectedIds,
  onSelectToggle,
}: {
  items: GtdItem[];
  cursorId: string | null;
  selectedIds: Set<string>;
  onSelectToggle: (id: string) => void;
}) {
  const people = useTaskStore((s) => s.people);
  const projects = useTaskStore((s) => s.projects);
  const openClarify = useTaskStore((s) => s.openClarify);
  const quickDispose = useTaskStore((s) => s.quickDispose);
  const deleteItem = useTaskStore((s) => s.deleteItem);
  const selectItem = useTaskStore((s) => s.selectItem);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border bg-secondary/40 text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="w-7 px-2 py-1.5" aria-label="Select" />
            <th className="px-2 py-1.5 font-medium">Capture</th>
            <th className="w-28 px-2 py-1.5 font-medium">AI suggests</th>
            <th className="w-32 px-2 py-1.5 font-medium">From</th>
            <th className="w-20 px-2 py-1.5 font-medium">Source</th>
            <th className="w-20 px-2 py-1.5 font-medium">Age</th>
            <th className="w-24 px-2 py-1.5 font-medium" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const p = proposeClarification(item, people, projects);
            const selected = selectedIds.has(item.id);
            return (
              <tr
                key={item.id}
                onClick={() => selectItem(item.id)}
                className={[
                  "group cursor-pointer border-b border-border/60 text-[13px] last:border-b-0",
                  cursorId === item.id ? "bg-primary/5" : "hover:bg-secondary/50",
                ].join(" ")}
              >
                <td className="px-2 py-1.5 align-middle">
                  <button
                    type="button"
                    aria-label={selected ? "Deselect" : "Select"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectToggle(item.id);
                    }}
                    className={[
                      "tech-transition h-3.5 w-3.5 rounded-full border-2",
                      selected ? "border-primary bg-primary" : "border-border group-hover:border-primary/50",
                    ].join(" ")}
                  />
                </td>
                <td className="max-w-0 px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openClarify(item.id);
                      }}
                      className="tech-transition min-w-0 truncate text-left text-foreground hover:text-primary"
                      title={item.title}
                    >
                      {item.title}
                    </button>
                    {item.attachments && item.attachments.length > 0 && (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
                        title={item.attachments.map((a) => a.name).join(", ")}
                      >
                        <Paperclip className="h-3 w-3" />
                        {item.attachments.length}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <span className="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {p.disposition.replace("_", " ").toLowerCase()}
                  </span>
                </td>
                <td className="max-w-0 truncate px-2 py-1.5 text-muted-foreground">
                  {item.origin?.kind === "email" ? (
                    <span
                      className="inline-flex max-w-full items-center gap-1"
                      title={item.origin.subject}
                    >
                      <Mail className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {item.origin.fromName || item.origin.fromEmail}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <SourceBadge source={item.source} provider={item.provider} size="xs" />
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-[11px] text-muted-foreground">
                  {relativeTime(item.createdAt)}
                </td>
                <td className="px-2 py-1.5">
                  <span className="flex items-center justify-end gap-0.5">
                    <button
                      type="button"
                      title="Someday / maybe"
                      onClick={(e) => {
                        e.stopPropagation();
                        quickDispose(item.id, "SOMEDAY");
                      }}
                      className="tech-transition rounded p-1 text-muted-foreground opacity-0 hover:bg-secondary hover:text-foreground group-hover:opacity-100"
                    >
                      <Lightbulb className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Clarify"
                      onClick={(e) => {
                        e.stopPropagation();
                        openClarify(item.id);
                      }}
                      className="tech-transition rounded p-1 text-primary opacity-0 hover:bg-primary/10 group-hover:opacity-100"
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                    {/* Trash always visible — never hover-gated. */}
                    <button
                      type="button"
                      title="Delete"
                      aria-label="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteItem(item.id);
                      }}
                      className="tech-transition rounded p-1 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
