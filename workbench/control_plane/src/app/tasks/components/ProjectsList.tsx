"use client";

import { FolderKanban, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { SourceBadge } from "./SourceBadge";

// Projects view — first-class GTD projects (LOCAL + SYNCED), one unified list
// (§5.1). Flags any active project with no next action (the cardinal GTD
// health check).
export function ProjectsList() {
  const projects = useTaskStore((s) => s.projects);
  const items = useTaskStore((s) => s.items);
  const selectedProjectId = useTaskStore((s) => s.selectedProjectId);
  const selectProject = useTaskStore((s) => s.selectProject);

  const active = projects.filter((p) => p.status === "ACTIVE");

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <FolderKanban className="h-4 w-4 text-primary" />
          <h1 className="text-base font-bold text-foreground">Projects</h1>
          <span className="ml-auto text-xs text-muted-foreground">
            {active.length} active
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Outcomes needing more than one action. Local and synced, side by side.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-2">
          {active.map((p) => {
            const actionCount = items.filter(
              (i) => i.projectId === p.id && i.disposition === "NEXT",
            ).length;
            const selected = selectedProjectId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectProject(p.id)}
                className={[
                  "tech-transition flex flex-col gap-2 rounded-lg border p-3 text-left",
                  selected
                    ? "border-primary/50 bg-primary/5"
                    : "border-border bg-card hover:border-primary/30 hover:bg-secondary/40",
                ].join(" ")}
              >
                <div className="flex items-start gap-2">
                  <span className="flex-1 text-sm font-medium leading-snug text-foreground">
                    {p.outcome}
                  </span>
                  <SourceBadge source={p.source} provider={p.provider} size="xs" />
                </div>
                {p.purpose && (
                  <p className="text-[11px] text-muted-foreground">{p.purpose}</p>
                )}
                <div className="flex items-center gap-3 text-[11px]">
                  {p.hasNextAction ? (
                    <span className="inline-flex items-center gap-1 text-success">
                      <CheckCircle2 className="h-3 w-3" />
                      {actionCount} next action{actionCount === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 font-medium text-warning">
                      <AlertTriangle className="h-3 w-3" />
                      No next action
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
