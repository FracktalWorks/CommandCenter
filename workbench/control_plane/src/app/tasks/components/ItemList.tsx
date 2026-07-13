"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
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
  ArchiveRestore,
  Trash2,
  CheckSquare,
  Target,
  Zap,
  X,
  Sparkles,
} from "lucide-react";
import { useTaskStore, itemsForView } from "../lib/taskStore";
import { modeSuggestion, isUntagged } from "../lib/priority";
import { ViewKey } from "../lib/types";
import { isOverdue } from "../lib/utils";
import { applyFilters, applySort, type GroupBy } from "../lib/ordering";
import { ProjectsList } from "./ProjectsList";
import { TaskCard } from "./TaskCard";
import { TaskBoard } from "./TaskBoard";
import { TaskListGrouped } from "./TaskListGrouped";
import { LensGroupedList } from "./LensGroupedList";
import { ModeHintBar } from "./PriorityControls";
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
  priority: { title: "Priority", icon: Target, hint: "Your open work by the founder matrix — Founder Fire first, Eliminate last." },
  engage: { title: "Engage · Now", icon: Zap, hint: "What you can pick up right now, matched to your energy." },
  waiting: { title: "Waiting For", icon: Clock, hint: "Delegated or blocked on someone else." },
  calendar: { title: "Calendar", icon: Calendar, hint: "Date-specific actions — the hard landscape." },
  someday: { title: "Someday / Maybe", icon: Lightbulb, hint: "Incubating. Reviewed weekly." },
  done: { title: "Done", icon: CheckCircle2, hint: "Completed tasks. They stay here until you archive them." },
  archive: { title: "Archive", icon: Archive, hint: "Archived tasks — hidden from active views. Restore anytime." },
};

// Fixed "now" for deterministic mock rendering (matches mockData's clock).
const MOCK_NOW = Date.UTC(2026, 5, 30, 9, 0, 0);

export function ItemList() {
  const items = useTaskStore((s) => s.items);
  const loading = useTaskStore((s) => s.loading);
  const view = useTaskStore((s) => s.selectedView);
  const context = useTaskStore((s) => s.selectedContext);
  const selectedMode = useTaskStore((s) => s.selectedMode);
  const urgentWindowHours = useTaskStore((s) => s.settings.urgentWindowHours);
  const sourceFilter = useTaskStore((s) => s.sourceFilter);
  const filters = useTaskStore((s) => s.filters);
  const sort = useTaskStore((s) => s.sort);
  const hasSynced = useTaskStore((s) => s.accounts.length > 0);
  const bulkArchive = useTaskStore((s) => s.bulkArchive);
  const requestDelete = useTaskStore((s) => s.requestDelete);
  const groupByChoice = useTaskStore((s) => s.groupBy);
  const mode = useSyncExternalStore(subscribeMode, readMode, () => "list");

  // Lightweight multi-select for bulk archive/restore/delete on the flat-list
  // views (Done, Waiting, Someday, Reference, Archive). Local to the list — the
  // inbox has its own selection UI; the board/grouped views don't select.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectMode(false);
  };
  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The view's items (source/archive-filtered), then the toolbar's search/
  // context/assignee filter, then the active sort. `inView` is the pre-toolbar
  // set — used to populate the toolbar's context/assignee dropdowns so they
  // never offer an option that returns nothing.
  const inView = useMemo(() => {
    const base = itemsForView(items, view, context, sourceFilter);
    // Drilled into a delegate/schedule bucket → narrow to those suggestions.
    if (view === "next" && selectedMode) {
      return base.filter(
        (i) => modeSuggestion(i, urgentWindowHours)?.mode === selectedMode,
      );
    }
    return base;
  }, [items, view, context, sourceFilter, selectedMode, urgentWindowHours]);
  const visible = useMemo(
    () => applySort(applyFilters(inView, filters), sort),
    [inView, filters, sort],
  );
  // Offer "auto-assign contexts" when Next Actions has context-less tasks (the
  // synced ClickUp tasks that never went through Clarify → @no context bucket).
  const contextlessCount = useMemo(
    () => (view === "next" ? inView.filter((i) => !i.context).length : 0),
    [view, inView],
  );

  if (view === "projects") {
    return <ProjectsList />;
  }

  const meta = VIEW_META[view] ?? VIEW_META.inbox;
  const Icon = meta.icon;
  const overdueCount = visible.filter((i) => isOverdue(i, MOCK_NOW)).length;
  // Overload guard: on the Priority view, how many tasks the matrix is only
  // *guessing* about (neither flag set) — so the user can tell judged tasks
  // from defaulted ones and triage them.
  const untaggedCount =
    view === "priority" ? visible.filter((i) => isUntagged(i)).length : 0;
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
  // A delegate/schedule mode bucket renders as a flat list (with hint bars),
  // not the workflow board.
  const grouped = view === "next" && !selectedMode;
  // The toolbar "lens": an explicit group-by overrides the view's default. ""
  // = default (workflow stages on Next Actions, flat elsewhere). "none"/context/
  // priority/mode/energy render via LensGroupedList (read-only sections). The
  // board only applies to the default Next Actions grouping.
  // The Priority view is intrinsically the 8-cell matrix grouping; it ignores
  // the toolbar group-by (always priority). Elsewhere the toolbar choice wins.
  const lens: GroupBy | "" = view === "priority" ? "priority" : groupByChoice;
  const useLens = lens !== "" && lens !== "none" && !(boardable && mode === "board");
  // Bulk multi-select (archive / restore / delete) is offered on the flat-list
  // views — where a "done pile" or backlog builds up. Not on the inbox (its own
  // triage UI), Next Actions board/grouping, or calendar.
  const showListInBoard = boardable && mode === "board";
  const bulkSelectable = !grouped && !showListInBoard && view !== "calendar";
  const isArchiveView = view === "archive";

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
            {selectedMode && (
              <span className="ml-2 text-sm font-normal text-primary/80">
                · {selectedMode === "delegate" ? "To delegate" : "To schedule"}
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
          {hasSynced && contextlessCount > 0 && (
            <ContextBackfillButton count={contextlessCount} />
          )}
          {/* Multi-select toggle for bulk archive/restore/delete. */}
          {bulkSelectable && visible.length > 0 && (
            <button
              type="button"
              onClick={() => (selectMode ? clearSelection() : setSelectMode(true))}
              aria-pressed={selectMode}
              title={selectMode ? "Cancel selection" : "Select tasks"}
              className={[
                "tech-transition inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                boardable ||
                (hasSynced && sourceFilter !== "all") ||
                (hasSynced && contextlessCount > 0)
                  ? "ml-2"
                  : "ml-auto",
                selectMode
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
              ].join(" ")}
            >
              <CheckSquare className="h-3 w-3" />
              Select
            </button>
          )}
          <span
            className={
              (bulkSelectable && visible.length > 0) ||
              boardable ||
              (hasSynced && sourceFilter !== "all") ||
              (hasSynced && contextlessCount > 0)
                ? "ml-2 text-xs text-muted-foreground"
                : "ml-auto text-xs text-muted-foreground"
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
        {untaggedCount > 0 && (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground/80">
            <AlertTriangle className="h-3 w-3" />
            {untaggedCount} not yet judged — in{" "}
            <span className="font-medium">Eliminate</span> by default until you
            flag them important or leveraged.
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
      ) : useLens && !selectMode ? (
        // An explicit toolbar lens (priority / mode / energy / context).
        <LensGroupedList items={visible} by={lens as Exclude<typeof lens, "">} />
      ) : boardable && mode === "board" ? (
        <div className="min-h-0 flex-1">
          <TaskBoard items={visible} view={view} />
        </div>
      ) : grouped && !useLens ? (
        <TaskListGrouped items={visible} view={view} />
      ) : (
        <div className="flex-1 overflow-y-auto">
          {visible.map((item) =>
            selectMode ? (
              <label
                key={item.id}
                className="flex cursor-pointer items-center gap-2 border-b border-border/60 pl-3 hover:bg-secondary/40"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={() => toggleSelected(item.id)}
                  className="h-4 w-4 shrink-0 accent-primary"
                />
                <div className="pointer-events-none min-w-0 flex-1">
                  <TaskCard item={item} variant="row" />
                </div>
              </label>
            ) : selectedMode ? (
              <div key={item.id}>
                <ModeHintBar item={item} mode={selectedMode} />
                <TaskCard item={item} variant="row" />
              </div>
            ) : (
              <TaskCard key={item.id} item={item} variant="row" />
            ),
          )}
        </div>
      )}

      {/* Bulk action bar — archive/restore/delete the current selection. */}
      {selectMode && selectedIds.size > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-card px-4 py-2">
          <span className="text-xs text-muted-foreground">
            {selectedIds.size} selected
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {isArchiveView ? (
              <BulkAction
                icon={ArchiveRestore}
                label="Restore"
                onClick={() => {
                  bulkArchive([...selectedIds], false);
                  clearSelection();
                }}
              />
            ) : (
              <BulkAction
                icon={Archive}
                label="Archive"
                onClick={() => {
                  bulkArchive([...selectedIds], true);
                  clearSelection();
                }}
              />
            )}
            <BulkAction
              icon={Trash2}
              label="Delete"
              danger
              onClick={() => {
                requestDelete([...selectedIds]);
                clearSelection();
              }}
            />
            <button
              type="button"
              onClick={clearSelection}
              aria-label="Cancel selection"
              className="tech-transition rounded-md p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BulkAction({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: typeof Archive;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "tech-transition inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium",
        danger
          ? "border-border text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
          : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary",
      ].join(" ")}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
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

/** Auto-assign @context to the actionable tasks that have none — the synced
 *  ClickUp tasks that arrive context-less. One tap runs the assistant over them
 *  and re-pulls, so they move out of the "@no context" bucket. */
function ContextBackfillButton({ count }: { count: number }) {
  const backfill = useTaskStore((s) => s.backfillContext);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        setDone(null);
        try {
          const res = await backfill();
          setDone(res.updated > 0 ? `Set ${res.updated}` : "None to set");
        } catch {
          setDone("Failed");
        } finally {
          setBusy(false);
        }
      }}
      title="Let the assistant assign @context to tasks that have none"
      className="tech-transition ml-auto inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Sparkles className="h-3.5 w-3.5" />
      )}
      {done ?? `Assign context · ${count}`}
    </button>
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
