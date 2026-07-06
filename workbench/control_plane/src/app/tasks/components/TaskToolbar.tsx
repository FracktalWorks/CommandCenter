"use client";

import { useMemo } from "react";
import {
  Search,
  X,
  ArrowUpNarrowWide,
  ArrowDownWideNarrow,
  ListFilter,
} from "lucide-react";
import { GtdItem } from "../lib/types";
import { useTaskStore } from "../lib/taskStore";
import {
  filtersActive,
  type SortField,
} from "../lib/ordering";

// The filter + sort bar shared by the list and board views (Jira/Linear-style).
// Search + @context + assignee narrow the set; the sort field + direction order
// it. "Manual" is the drag-reorder order and the only mode where cards can be
// repositioned — picking any field sort disables dragging (with a hint), which
// is how Jira/Linear/ClickUp behave.

const SORT_LABEL: Record<SortField, string> = {
  manual: "Manual",
  due: "Due date",
  created: "Created",
  title: "Title",
  energy: "Energy",
};

const SORT_FIELDS: SortField[] = ["manual", "due", "created", "title", "energy"];

export function TaskToolbar({ items }: { items: GtdItem[] }) {
  const filters = useTaskStore((s) => s.filters);
  const setFilters = useTaskStore((s) => s.setFilters);
  const clearFilters = useTaskStore((s) => s.clearFilters);
  const sort = useTaskStore((s) => s.sort);
  const setSort = useTaskStore((s) => s.setSort);

  // The option lists come from the items actually in view, so the dropdowns
  // never offer a context/assignee that would return nothing.
  const contexts = useMemo(
    () =>
      Array.from(new Set(items.map((i) => i.context).filter(Boolean))).sort() as string[],
    [items],
  );
  const assignees = useMemo(
    () =>
      Array.from(
        new Set(items.map((i) => i.assignee?.name).filter(Boolean)),
      ).sort() as string[],
    [items],
  );

  const active = filtersActive(filters);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2">
      {/* Search */}
      <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={filters.query}
          onChange={(e) => setFilters({ query: e.target.value })}
          placeholder="Search tasks…"
          className="tech-transition h-7 w-full rounded-md border border-border bg-background pl-7 pr-6 text-xs text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
        />
        {filters.query && (
          <button
            type="button"
            onClick={() => setFilters({ query: "" })}
            title="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Context filter */}
      {contexts.length > 0 && (
        <Select
          label="Context"
          value={filters.context}
          onChange={(v) => setFilters({ context: v })}
          options={contexts}
          anyLabel="Any context"
        />
      )}

      {/* Assignee filter */}
      {assignees.length > 0 && (
        <Select
          label="Assignee"
          value={filters.assignee}
          onChange={(v) => setFilters({ assignee: v })}
          options={assignees}
          anyLabel="Anyone"
        />
      )}

      {active && (
        <button
          type="button"
          onClick={clearFilters}
          className="tech-transition inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      )}

      {/* Sort — pushed to the right */}
      <div className="ml-auto flex items-center gap-1">
        <ListFilter className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="relative">
          <select
            value={sort.field}
            onChange={(e) => setSort({ field: e.target.value as SortField })}
            aria-label="Sort by"
            className="tech-transition h-7 rounded-md border border-border bg-background pl-2 pr-6 text-xs text-foreground focus:border-primary focus:outline-none"
          >
            {SORT_FIELDS.map((f) => (
              <option key={f} value={f}>
                {SORT_LABEL[f]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => setSort({ dir: sort.dir === "asc" ? "desc" : "asc" })}
          disabled={sort.field === "manual"}
          title={
            sort.field === "manual"
              ? "Manual order (drag cards to reorder)"
              : sort.dir === "asc"
                ? "Ascending — click for descending"
                : "Descending — click for ascending"
          }
          className={[
            "tech-transition inline-flex h-7 w-7 items-center justify-center rounded-md border border-border",
            sort.field === "manual"
              ? "cursor-not-allowed text-muted-foreground/40"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground",
          ].join(" ")}
        >
          {sort.dir === "asc" ? (
            <ArrowUpNarrowWide className="h-3.5 w-3.5" />
          ) : (
            <ArrowDownWideNarrow className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  anyLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  anyLabel: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className={[
        "tech-transition h-7 rounded-md border bg-background pl-2 pr-6 text-xs focus:border-primary focus:outline-none",
        value ? "border-primary/50 text-foreground" : "border-border text-muted-foreground",
      ].join(" ")}
    >
      <option value="">{anyLabel}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
