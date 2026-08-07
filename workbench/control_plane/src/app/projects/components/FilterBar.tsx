"use client";

/**
 * Projects · the filter bar and saved-view chips (WS-27k).
 *
 * Spec: `ai-company-brain/specs/project_management_app.md` §11.2 item 3.
 *
 * *"My open bugs in Ops, grouped by assignee"* — this is where that sentence
 * gets typed. Filters go to the server (`routes/projects/filters.py` turns them
 * into WHERE clauses, so paging stays correct); grouping is applied in the
 * browser by `lib/grouping.groupTasks`.
 *
 * A saved view is nothing more than these controls' state written to
 * `pm_views.config`, which is why applying one and typing the same thing by
 * hand must produce an identical board — `toConfig`/`fromConfig` are each
 * other's inverse and their round trip is tested.
 */

import Icon from "@/components/Icon";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useEffect, useState } from "react";

import type { ViewRow } from "../lib/api";
import {
  EMPTY_FILTERS,
  type Filters,
  GROUP_OPTIONS,
  type GroupBy,
  isFiltered,
} from "../lib/grouping";

/** The status categories, labelled. Mirrors the gateway's `STATUS_CATEGORIES`. */
const CATEGORIES: Array<[string, string]> = [
  ["", "Any status"],
  ["backlog", "Backlog"],
  ["todo", "To do"],
  ["in_progress", "In progress"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
];

const GROUP_LABELS: Record<GroupBy, string> = {
  status: "Status",
  assignee: "Assignee",
  project: "Project",
  importance: "Priority",
  none: "Nothing",
};

const SELECT =
  "cc-control rounded-lg border border-border bg-background px-2 py-1.5 " +
  "text-xs text-foreground outline-none focus:border-primary/50";

interface Props {
  filters: Filters;
  onFilters: (next: Filters) => void;
  groupBy: GroupBy;
  onGroupBy: (next: GroupBy) => void;
  /** The signed-in member's address, for the "Mine" toggle. Empty while loading. */
  me: string;
  views: ViewRow[];
  activeViewId: string | null;
  onApplyView: (view: ViewRow) => void;
  onSaveView: (name: string) => void;
  onDeleteView: (view: ViewRow) => void;
  /** Saving needs a project to hang the view off; My work has none. */
  canSave: boolean;
}

export function FilterBar({
  filters,
  onFilters,
  groupBy,
  onGroupBy,
  me,
  views,
  activeViewId,
  onApplyView,
  onSaveView,
  onDeleteView,
  canSave,
}: Props) {
  // The search box is held locally and pushed up on a delay. Refetching on
  // every keystroke turns a five-letter word into five round trips, and the
  // board flickering through four wrong answers reads as a broken filter.
  const [draft, setDraft] = useState(filters.q);
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState("");

  useEffect(() => setDraft(filters.q), [filters.q]);

  useEffect(() => {
    if (draft === filters.q) return;
    const timer = setTimeout(() => onFilters({ ...filters, q: draft }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });
  const mine = Boolean(me) && filters.assignee.toLowerCase() === me.toLowerCase();

  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[10rem] flex-1">
          <Input
            icon="Search"
            inputSize="sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search titles and descriptions…"
            aria-label="Search tasks"
          />
        </div>

        <select
          aria-label="Status"
          className={SELECT}
          value={filters.statusCategory}
          onChange={(e) => set({ statusCategory: e.target.value })}
        >
          {CATEGORIES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        {/* "Mine" writes the viewer's own address into the assignee filter
            rather than being a separate server-side flag: one filter, so a
            saved view carries WHOSE work it meant instead of resolving to
            whoever opens it later. */}
        <Button
          variant={mine ? "primary" : "secondary"}
          size="sm"
          disabled={!me}
          aria-pressed={mine}
          onClick={() => set({ assignee: mine ? "" : me, unassigned: false })}
        >
          Mine
        </Button>
        <Button
          variant={filters.unassigned ? "primary" : "secondary"}
          size="sm"
          aria-pressed={filters.unassigned}
          onClick={() =>
            set({ unassigned: !filters.unassigned, assignee: "" })
          }
        >
          Unassigned
        </Button>
        <Button
          variant={filters.overdue ? "primary" : "secondary"}
          size="sm"
          aria-pressed={filters.overdue}
          onClick={() => set({ overdue: !filters.overdue })}
        >
          Overdue
        </Button>

        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Group by
          <select
            aria-label="Group by"
            className={SELECT}
            value={groupBy}
            onChange={(e) => onGroupBy(e.target.value as GroupBy)}
          >
            {GROUP_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {GROUP_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        {isFiltered(filters) ? (
          <Button
            variant="ghost"
            size="sm"
            icon="X"
            onClick={() => onFilters(EMPTY_FILTERS)}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {/* Saved views. Chips rather than a dropdown: the point of saving one is
          that it is one click away, and a menu puts it two. */}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {views.map((view) => (
          <span key={view.id} className="inline-flex items-center">
            <button
              type="button"
              onClick={() => onApplyView(view)}
              className={`rounded-l-md px-2 py-1 text-xs ${
                view.id === activeViewId
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {view.name}
            </button>
            <button
              type="button"
              aria-label={`Delete view ${view.name}`}
              title={`Delete view ${view.name}`}
              onClick={() => onDeleteView(view)}
              className="rounded-r-md px-1 py-1 text-muted-foreground hover:bg-muted"
            >
              <Icon name="X" size={11} />
            </button>
          </span>
        ))}

        {naming ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const name = viewName.trim();
              if (!name) return;
              onSaveView(name);
              setViewName("");
              setNaming(false);
            }}
          >
            <Input
              autoFocus
              inputSize="sm"
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNaming(false);
              }}
              placeholder="View name"
              aria-label="View name"
            />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        ) : canSave ? (
          <Button
            variant="text"
            size="sm"
            icon="Bookmark"
            disabled={!isFiltered(filters) && groupBy === "status"}
            title={
              !isFiltered(filters) && groupBy === "status"
                ? "Filter or regroup the board first — an unfiltered view is the board"
                : "Save these filters as a view"
            }
            onClick={() => setNaming(true)}
          >
            Save view
          </Button>
        ) : null}

        {isFiltered(filters) ? (
          <Badge tone="primary" icon="Filter">
            filtered
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
