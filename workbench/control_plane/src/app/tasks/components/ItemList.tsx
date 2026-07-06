"use client";

import { useMemo, useSyncExternalStore } from "react";
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
  LayoutList,
  Columns3,
  Archive,
} from "lucide-react";
import { useTaskStore, itemsForView } from "../lib/taskStore";
import { ViewKey } from "../lib/types";
import { isOverdue } from "../lib/utils";
import { applyFilters, applySort } from "../lib/ordering";
import { ProjectsList } from "./ProjectsList";
import { TaskCard } from "./TaskCard";
import { TaskBoard } from "./TaskBoard";
import { TaskListGrouped } from "./TaskListGrouped";
import { TaskToolbar } from "./TaskToolbar";

// View mode (list vs kanban board) for the processed-task views, sticky per
// browser via useSyncExternalStore (SSR-safe, same recipe as the inbox density
// toggle — avoids the useState(localStorage) hydration-mismatch bug).
const MODE_KEY = "cc.tasks.viewMode";
const modeListeners = new Set<() => void>();
function subscribeMode(cb: () => void) {
  modeListeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === MODE_KEY) cb(); };
  window.addEventListener("storage", onStorage);
  return () => {
    modeListeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}
function readMode(): "list" | "board" {
  try {
    return window.localStorage.getItem(MODE_KEY) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}
function setModePersist(m: "list" | "board") {
  try { window.localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ }
  modeListeners.forEach((cb) => cb());
}

const VIEW_META: Record<
  string,
  { title: string; icon: typeof Inbox; hint: string }
> = {
  inbox: { title: "Inbox", icon: Inbox, hint: "Capture, then clarify each item to zero." },
  next: { title: "My Next Actions", icon: ListChecks, hint: "Tasks assigned to you — the very next physical step for each." },
  waiting: { title: "Waiting For", icon: Clock, hint: "Delegated or blocked on someone else." },
  calendar: { title: "Calendar", icon: Calendar, hint: "Date-specific actions — the hard landscape." },
  someday: { title: "Someday / Maybe", icon: Lightbulb, hint: "Incubating. Reviewed weekly." },
  archive: { title: "Archive", icon: Archive, hint: "Archived tasks — hidden from active views. Restore anytime." },
};

// Fixed "now" for deterministic mock rendering (matches mockData's clock).
const MOCK_NOW = Date.UTC(2026, 5, 30, 9, 0, 0);

export function ItemList() {
  const items = useTaskStore((s) => s.items);
  const loading = useTaskStore((s) => s.loading);
  const view = useTaskStore((s) => s.selectedView);
  const context = useTaskStore((s) => s.selectedContext);
  const sourceFilter = useTaskStore((s) => s.sourceFilter);
  const filters = useTaskStore((s) => s.filters);
  const sort = useTaskStore((s) => s.sort);
  const hasSynced = useTaskStore((s) => s.accounts.length > 0);
  const mode = useSyncExternalStore(subscribeMode, readMode, () => "list");

  // The view's items (source/archive-filtered), then the toolbar's search/
  // context/assignee filter, then the active sort. `inView` is the pre-toolbar
  // set — used to populate the toolbar's context/assignee dropdowns so they
  // never offer an option that returns nothing.
  const inView = useMemo(
    () => itemsForView(items, view, context, sourceFilter),
    [items, view, context, sourceFilter],
  );
  const visible = useMemo(
    () => applySort(applyFilters(inView, filters), sort),
    [inView, filters, sort],
  );

  if (view === "projects") {
    return <ProjectsList />;
  }

  const meta = VIEW_META[view] ?? VIEW_META.inbox;
  const Icon = meta.icon;
  const overdueCount = visible.filter((i) => isOverdue(i, MOCK_NOW)).length;
  // The Kanban board is the Next Actions workflow board (columns = the global
  // workflow stages). Other views stay list-only until their own status model
  // is designed, so the List/Board toggle only appears on Next Actions.
  const boardable = view === "next";
  // The filter/sort toolbar rides above every processed-task view (inbox has
  // its own triage UI; projects is a different surface). Calendar/Archive get
  // it too — search/sort still help there — but they stay list-only.
  const showToolbar = view !== "inbox";
  // Status-segmented list: only Next Actions groups (by the global workflow
  // stages). @context is NOT a grouping axis here — it drives the left sidebar.
  const grouped = view === "next";

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
          {/* List ⇄ Board view mode toggle (Jira-style). Sticky per browser. */}
          {boardable && (
            <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5">
              <button
                type="button"
                onClick={() => setModePersist("list")}
                aria-pressed={mode === "list"}
                title="List view"
                className={[
                  "tech-transition inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
                  mode === "list"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                <LayoutList className="h-3 w-3" />
                List
              </button>
              <button
                type="button"
                onClick={() => setModePersist("board")}
                aria-pressed={mode === "board"}
                title="Board view"
                className={[
                  "tech-transition inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
                  mode === "board"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                <Columns3 className="h-3 w-3" />
                Board
              </button>
            </div>
          )}
          {/* The source toggle lives in the sidebar (governs every view). When
              it's narrowed, show a small chip here so the active scope is
              obvious on this page too. */}
          {hasSynced && sourceFilter !== "all" && (
            <span
              className={[
                "inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary",
                boardable ? "ml-2" : "ml-auto",
              ].join(" ")}
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
              (boardable || (hasSynced && sourceFilter !== "all")
                ? "ml-2"
                : "ml-auto") + " text-xs text-muted-foreground"
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

      {showToolbar && !loading && inView.length > 0 && (
        <TaskToolbar items={inView} />
      )}

      {loading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/60" />
          <p className="text-xs text-muted-foreground">Loading…</p>
        </div>
      ) : visible.length === 0 ? (
        inView.length > 0 ? (
          <NoMatchState />
        ) : (
          <EmptyState view={view} />
        )
      ) : boardable && mode === "board" ? (
        <div className="min-h-0 flex-1">
          <TaskBoard items={visible} view={view} />
        </div>
      ) : grouped ? (
        <TaskListGrouped items={visible} view={view} />
      ) : (
        <div className="flex-1 overflow-y-auto">
          {visible.map((item) => (
            <TaskCard key={item.id} item={item} variant="row" />
          ))}
        </div>
      )}
    </div>
  );
}

/** Shown when the view has items but the toolbar filters hid them all — a
 *  different message from the true-empty state so the user knows to clear. */
function NoMatchState() {
  const clearFilters = useTaskStore((s) => s.clearFilters);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm text-muted-foreground">No tasks match your filters.</p>
      <button
        type="button"
        onClick={clearFilters}
        className="tech-transition rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-secondary"
      >
        Clear filters
      </button>
    </div>
  );
}

function EmptyState({ view }: { view: ViewKey }) {
  const msg =
    view === "inbox"
      ? "Inbox zero. Mind like water."
      : view === "waiting"
        ? "Nothing on your Waiting-For list."
        : view === "next"
          ? "No next actions assigned to you."
          : "Nothing here yet.";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <CheckCircle2 className="h-8 w-8 text-success/70" />
      <p className="text-sm text-muted-foreground">{msg}</p>
    </div>
  );
}
