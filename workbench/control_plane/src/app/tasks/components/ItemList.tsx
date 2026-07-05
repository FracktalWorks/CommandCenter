"use client";

import { useMemo } from "react";
import {
  Inbox,
  ListChecks,
  Clock,
  Calendar,
  Lightbulb,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  HardDrive,
  Cloud,
} from "lucide-react";
import { useTaskStore, itemsForView } from "../lib/taskStore";
import { ViewKey } from "../lib/types";
import { isOverdue } from "../lib/utils";
import { ItemRow } from "./ItemRow";
import { ProjectsList } from "./ProjectsList";

const VIEW_META: Record<
  string,
  { title: string; icon: typeof Inbox; hint: string }
> = {
  inbox: { title: "Inbox", icon: Inbox, hint: "Capture, then clarify each item to zero." },
  next: { title: "Next Actions", icon: ListChecks, hint: "The very next physical step for each commitment." },
  waiting: { title: "Waiting For", icon: Clock, hint: "Delegated or blocked on someone else." },
  calendar: { title: "Calendar", icon: Calendar, hint: "Date-specific actions — the hard landscape." },
  someday: { title: "Someday / Maybe", icon: Lightbulb, hint: "Incubating. Reviewed weekly." },
};

// Fixed "now" for deterministic mock rendering (matches mockData's clock).
const MOCK_NOW = Date.UTC(2026, 5, 30, 9, 0, 0);

export function ItemList() {
  const items = useTaskStore((s) => s.items);
  const loading = useTaskStore((s) => s.loading);
  const view = useTaskStore((s) => s.selectedView);
  const context = useTaskStore((s) => s.selectedContext);
  const sourceFilter = useTaskStore((s) => s.sourceFilter);
  const hasSynced = useTaskStore((s) => s.accounts.length > 0);

  const visible = useMemo(
    () => itemsForView(items, view, context, sourceFilter),
    [items, view, context, sourceFilter],
  );

  if (view === "projects") {
    return <ProjectsList />;
  }

  const meta = VIEW_META[view] ?? VIEW_META.inbox;
  const Icon = meta.icon;
  const overdueCount = visible.filter((i) => isOverdue(i, MOCK_NOW)).length;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <h1 className="text-base font-bold text-foreground">
            {meta.title}
            {context && (
              <span className="ml-2 font-mono text-sm font-normal text-primary/80">
                {context}
              </span>
            )}
          </h1>
          {/* The source toggle lives in the sidebar (governs every view). When
              it's narrowed, show a small chip here so the active scope is
              obvious on this page too. */}
          {hasSynced && sourceFilter !== "all" && (
            <span
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
              title="Filtered by source — change it in the sidebar"
            >
              {sourceFilter === "local" ? (
                <HardDrive className="h-3 w-3" />
              ) : (
                <Cloud className="h-3 w-3" />
              )}
              {sourceFilter === "local" ? "Mine" : "ClickUp"}
            </span>
          )}
          <span
            className={
              (hasSynced && sourceFilter !== "all" ? "ml-2" : "ml-auto") +
              " text-xs text-muted-foreground"
            }
          >
            {visible.length} item{visible.length === 1 ? "" : "s"}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{meta.hint}</p>
        {view === "waiting" && overdueCount > 0 && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {overdueCount} overdue — needs a nudge
          </p>
        )}
      </header>

      {loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/60" />
          <p className="text-xs text-muted-foreground">Loading…</p>
        </div>
      ) : visible.length === 0 ? (
        <EmptyState view={view} />
      ) : (
        <div className="flex-1 overflow-y-auto">
          {visible.map((item) => (
            <ItemRow key={item.id} item={item} now={MOCK_NOW} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ view }: { view: ViewKey }) {
  const msg =
    view === "inbox"
      ? "Inbox zero. Mind like water."
      : view === "waiting"
        ? "Nothing on your Waiting-For list."
        : "Nothing here yet.";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <CheckCircle2 className="h-8 w-8 text-success/70" />
      <p className="text-sm text-muted-foreground">{msg}</p>
    </div>
  );
}
