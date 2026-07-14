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
import {
  useTaskStore,
  itemsForView,
  contextCounts,
  NO_CONTEXT,
} from "../lib/taskStore";
import { isUntagged } from "../lib/priority";
import { ViewKey } from "../lib/types";
import { isOverdue } from "../lib/utils";
import { applyFilters, applySort, type GroupBy } from "../lib/ordering";
import { ProjectsList } from "./ProjectsList";
import { TaskCard } from "./TaskCard";
import { TaskBoard } from "./TaskBoard";
import { TaskListGrouped } from "./TaskListGrouped";
import { LensGroupedList } from "./LensGroupedList";
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
  next: { title: "My Next Actions", icon: ListChecks, hint: "Tasks assigned to you, grouped by status and sorted by priority — the very next physical step for each." },
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
  const sourceFilter = useTaskStore((s) => s.sourceFilter);
  const filters = useTaskStore((s) => s.filters);
  const sort = useTaskStore((s) => s.sort);
  const hasSynced = useTaskStore((s) => s.accounts.length > 0);
  const bulkArchive = useTaskStore((s) => s.bulkArchive);
  const requestDelete = useTaskStore((s) => s.requestDelete);
  const groupByChoice = useTaskStore((s) => s.groupBy);
  const contexts = useTaskStore((s) => s.contexts);
  const selectContext = useTaskStore((s) => s.selectContext);
  const mode = useSyncExternalStore(subscribeMode, readMode, () => "list");

  // Multi-select for bulk archive/restore/delete. Lifted into the store so it
  // works on every Next-Actions surface — the flat lists (Done/Waiting/…), the
  // status-grouped list, AND the Kanban board — and survives the list/board
  // toggle within a view. The inbox keeps its own selection UI.
  const selectMode = useTaskStore((s) => s.selectMode);
  const selectedIds = useTaskStore((s) => s.selectedIds);
  const setSelectMode = useTaskStore((s) => s.setSelectMode);
  const toggleSelected = useTaskStore((s) => s.toggleSelected);
  const clearSelection = useTaskStore((s) => s.clearSelection);

  // The view's items (source/archive-filtered), then the toolbar's search/
  // context/assignee filter, then the active sort. `inView` is the pre-toolbar
  // set — used to populate the toolbar's context/assignee dropdowns so they
  // never offer an option that returns nothing.
  const inView = useMemo(
    () => itemsForView(items, view, context, sourceFilter),
    [items, view, context, sourceFilter],
  );
  // The Priority view is GROUPED by priority level (Critical → Low Priority
  // section headers, ranked 1→7 by LensGroupedList). It forces the priority
  // sort so within each section tasks are rank-ordered; every other view honours
  // the toolbar sort.
  const visible = useMemo(() => {
    const effectiveSort =
      view === "priority" ? ({ field: "priority", dir: "asc" } as const) : sort;
    return applySort(applyFilters(inView, filters), effectiveSort);
  }, [inView, filters, sort, view]);
  // Offer "auto-assign contexts" when Next Actions has context-less tasks (the
  // synced ClickUp tasks that never went through Clarify → @no context bucket).
  const contextlessCount = useMemo(
    () => (view === "next" ? inView.filter((i) => !i.context).length : 0),
    [view, inView],
  );
  // Per-@context counts for the in-header context pills (Next Actions only) —
  // the same source the sidebar drill-down uses, so the pill counts match.
  const ctxCounts = useMemo(
    () => (view === "next" ? contextCounts(items) : {}),
    [view, items],
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
  // Status-segmented list: only Next Actions groups (by the status axis — local
  // stages ∪ ClickUp statuses). @context is NOT a grouping axis here — it drives
  // the left sidebar.
  const grouped = view === "next";
  // The toolbar "lens": an explicit group-by slices a view into labelled
  // sections via LensGroupedList. "" = default (status axis on Next Actions,
  // flat elsewhere). The Priority view always groups by priority LEVEL (the
  // 7-level matrix), ignoring the toolbar group-by; elsewhere the toolbar wins.
  const lens: GroupBy | "" = view === "priority" ? "priority" : groupByChoice;
  const useLens = lens !== "" && lens !== "none" && !(boardable && mode === "board");
  // Bulk multi-select (archive / restore / delete) is offered on every
  // processed-task surface — the flat lists (Done/Waiting/…), the Next-Actions
  // status-grouped list, AND the Kanban board — so you can check off a batch and
  // archive/delete it anywhere. Only the inbox (its own triage UI) and calendar
  // opt out.
  const isBoard = boardable && mode === "board";
  const bulkSelectable = view !== "calendar";
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
        {/* @context filter pills (Next Actions) — the Engage-style pill row in
            place of a dropdown. "All" clears the context; each pill mirrors the
            sidebar drill-down (sets selectedContext). Only shown when there's
            more than one bucket to choose between. */}
        {view === "next" && (
          <ContextPills
            contexts={contexts.map((c) => c.name)}
            counts={ctxCounts}
            selected={context}
            onSelect={selectContext}
          />
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
      ) : isBoard && !selectMode ? (
        // The Kanban board (drag-to-refile). In select mode we fall through to
        // the status-grouped list instead — checkboxes + drag on the same cards
        // would fight each other, and the grouped list shows the same stages.
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
            ) : (
              <TaskCard
                key={item.id}
                item={item}
                variant="row"
                showPriority={view === "priority"}
              />
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

/** The Engage-style @context filter for Next Actions: an "All" pill plus one
 *  pill per @context that currently has tasks (and the "@no context" bucket when
 *  present). Selecting a pill sets the store's selectedContext — the same signal
 *  the sidebar drill-down uses — so the two stay in lock-step. Hidden when there
 *  is only the "All" option (nothing to narrow to). */
function ContextPills({
  contexts,
  counts,
  selected,
  onSelect,
}: {
  contexts: string[];
  counts: Record<string, number>;
  selected: string | null;
  onSelect: (c: string | null) => void;
}) {
  // Only offer @contexts that actually have tasks right now, in the sidebar's
  // order: named contexts alphabetically-ish (as configured), then "@no context"
  // last so the unclarified bucket doesn't lead.
  const named = contexts.filter((c) => (counts[c] ?? 0) > 0);
  const hasNoCtx = (counts[NO_CONTEXT] ?? 0) > 0;
  const pills: { key: string; label: string; value: string | null; count: number }[] = [
    { key: "__all__", label: "All", value: null, count: 0 },
    ...named.map((c) => ({ key: c, label: c, value: c, count: counts[c] ?? 0 })),
    ...(hasNoCtx
      ? [{ key: NO_CONTEXT, label: NO_CONTEXT, value: NO_CONTEXT, count: counts[NO_CONTEXT] ?? 0 }]
      : []),
  ];
  // Nothing to choose between (only "All") → don't render a lonely pill row.
  if (pills.length <= 1) return null;
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
      {pills.map((p) => {
        const on = selected === p.value;
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => onSelect(p.value)}
            aria-pressed={on}
            className={[
              "tech-transition inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
              on
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/40",
            ].join(" ")}
          >
            {p.label}
            {p.count > 0 && (
              <span
                className={[
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  on ? "bg-primary/15 text-primary" : "bg-background/60 text-muted-foreground",
                ].join(" ")}
              >
                {p.count}
              </span>
            )}
          </button>
        );
      })}
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
