"use client";

import { useState } from "react";
import {
  MousePointerClick,
  ArrowRight,
  Clock,
  AlertTriangle,
  FolderKanban,
  Zap,
  CalendarClock,
  UploadCloud,
  ExternalLink,
} from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import {
  DISPOSITION_LABEL,
  ENERGY_LABEL,
  durationLabel,
  initials,
  isOverdue,
  relativeTime,
} from "../lib/utils";
import { SourceBadge } from "./SourceBadge";
import { ClarifyPanel } from "./ClarifyPanel";

const MOCK_NOW = Date.UTC(2026, 5, 30, 9, 0, 0);

export function ItemDetail() {
  const items = useTaskStore((s) => s.items);
  const projects = useTaskStore((s) => s.projects);
  const backend = useTaskStore((s) => s.backend);
  const pushItem = useTaskStore((s) => s.pushItem);
  const [pushState, setPushState] = useState<"idle" | "busy" | string>("idle");
  const selectedItemId = useTaskStore((s) => s.selectedItemId);
  const view = useTaskStore((s) => s.selectedView);
  const selectedProjectId = useTaskStore((s) => s.selectedProjectId);

  const item = selectedItemId
    ? items.find((i) => i.id === selectedItemId)
    : undefined;

  // Inbox items get the Clarify decision tree (F2); everything else is read-only.
  // Keyed by id so the wizard resets when a different item is selected.
  if (item && item.disposition === "INBOX") {
    return <ClarifyPanel key={item.id} item={item} />;
  }

  if (item) {
    const project = item.projectId
      ? projects.find((p) => p.id === item.projectId)
      : undefined;
    const overdue = isOverdue(item, MOCK_NOW);
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <div className="border-b border-border bg-card px-5 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {DISPOSITION_LABEL[item.disposition]}
            </span>
            <SourceBadge source={item.source} provider={item.provider} />
          </div>
          <h1 className="text-lg font-bold leading-snug text-foreground">
            {item.title}
          </h1>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          {item.nextAction && (
            <Field label="Next action" icon={ArrowRight}>
              <p className="text-sm text-foreground">{item.nextAction}</p>
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            {item.context && (
              <Meta label="Context">
                <span className="font-mono text-primary/90">{item.context}</span>
              </Meta>
            )}
            {item.energy && <Meta label="Energy">{ENERGY_LABEL[item.energy]}</Meta>}
            {item.timeEstimateMins ? (
              <Meta label="Estimate">
                <span className="inline-flex items-center gap-1">
                  <Zap className="h-3 w-3" />
                  {durationLabel(item.timeEstimateMins)}
                </span>
              </Meta>
            ) : null}
            {item.dueAt && (
              <Meta label="Due">
                <span
                  className={`inline-flex items-center gap-1 ${overdue ? "font-medium text-destructive" : ""}`}
                >
                  {overdue ? (
                    <AlertTriangle className="h-3 w-3" />
                  ) : item.isHardDate ? (
                    <CalendarClock className="h-3 w-3" />
                  ) : (
                    <Clock className="h-3 w-3" />
                  )}
                  {relativeTime(item.dueAt, MOCK_NOW)}
                  {item.isHardDate && (
                    <span className="text-[10px] text-muted-foreground">(hard)</span>
                  )}
                </span>
              </Meta>
            )}
            {item.providerStatus && <Meta label="Stage">{item.providerStatus}</Meta>}
            {item.assignee && (
              <Meta label="Assignee">
                <span className="inline-flex items-center gap-1.5">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 text-[8px] font-bold text-primary">
                    {initials(item.assignee.name)}
                  </span>
                  {item.assignee.name}
                </span>
              </Meta>
            )}
            {item.syncState === "pending" && (
              <Meta label="Sync">
                <span className="inline-flex items-center gap-1 text-warning">
                  <Clock className="h-3 w-3" />
                  Pending push
                </span>
                {backend === "live" && (
                  <button
                    type="button"
                    disabled={pushState === "busy"}
                    onClick={async () => {
                      setPushState("busy");
                      try {
                        await pushItem(item.id);
                        setPushState("idle");
                      } catch (e) {
                        setPushState(e instanceof Error ? e.message : "Push failed");
                      }
                    }}
                    className="tech-transition mt-1 inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
                  >
                    <UploadCloud className="h-3 w-3" />
                    {pushState === "busy" ? "Pushing…" : `Push to ${item.provider ?? "tool"}`}
                  </button>
                )}
                {pushState !== "idle" && pushState !== "busy" && (
                  <p className="mt-1 text-[10px] text-destructive">{pushState}</p>
                )}
              </Meta>
            )}
            {item.syncState === "synced" && item.providerUrl && (
              <Meta label="Sync">
                <a
                  href={item.providerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open in {item.provider}
                </a>
              </Meta>
            )}
          </div>

          {item.waitingOn && (
            <Field label="Waiting on" icon={Clock}>
              <span className="inline-flex items-center gap-2 text-sm text-foreground">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
                  {initials(item.waitingOn.name)}
                </span>
                {item.waitingOn.name}
                {item.delegatedAt && (
                  <span className="text-xs text-muted-foreground">
                    · since {relativeTime(item.delegatedAt, MOCK_NOW)}
                  </span>
                )}
              </span>
            </Field>
          )}

          {project && (
            <Field label="Project" icon={FolderKanban}>
              <span className="text-sm text-foreground">{project.outcome}</span>
            </Field>
          )}

          {item.notes && (
            <Field label="Notes">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {item.notes}
              </p>
            </Field>
          )}

          <p className="mt-2 border-t border-border pt-3 text-[11px] text-muted-foreground">
            Clarify, organize, and delegate actions arrive in the next slices — this
            panel is read-only for now.
          </p>
        </div>
      </div>
    );
  }

  // Project selected (projects view) → show its actions.
  if (view === "projects" && selectedProjectId) {
    const project = projects.find((p) => p.id === selectedProjectId);
    const actions = items.filter((i) => i.projectId === selectedProjectId);
    if (project) {
      return (
        <div className="flex h-full flex-col overflow-y-auto">
          <div className="border-b border-border bg-card px-5 py-4">
            <div className="mb-2 flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-primary" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Project
              </span>
              <SourceBadge source={project.source} provider={project.provider} />
            </div>
            <h1 className="text-lg font-bold leading-snug text-foreground">
              {project.outcome}
            </h1>
            {project.purpose && (
              <p className="mt-1 text-sm text-muted-foreground">{project.purpose}</p>
            )}
          </div>
          <div className="px-5 py-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Actions ({actions.length})
            </h2>
            <div className="flex flex-col gap-1.5">
              {actions.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground"
                >
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
                    {DISPOSITION_LABEL[a.disposition]}
                  </span>
                  <span className="flex-1 truncate">{a.title}</span>
                  {a.context && (
                    <span className="font-mono text-[11px] text-primary/80">
                      {a.context}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <MousePointerClick className="h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">
        Select an item to see its details.
      </p>
    </div>
  );
}

function Field({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon?: typeof Clock;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </h3>
      {children}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md bg-secondary/50 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-sm text-foreground">{children}</div>
    </div>
  );
}
