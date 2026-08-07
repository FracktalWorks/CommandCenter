/**
 * Projects · grouping and the filter query (WS-27k).
 *
 * *"My open bugs in Ops, grouped by assignee"* — the grouping half. Filters are
 * SQL and live on the gateway (`routes/projects/filters.py`); grouping is
 * presentation and belongs here, over rows the list endpoint now returns with
 * their assignees attached.
 *
 * Everything is a pure function over plain data: what a board draws is easy to
 * get subtly wrong (a task with two assignees, a task with none, a lane with
 * nothing in it) and each of those is one assertion here.
 */

import type { StatusRow, TaskRow } from "./api";

export type GroupBy =
  | "status"
  | "assignee"
  | "project"
  | "importance"
  | "tag"
  | "none";

/** Mirrors the gateway's `filters.GROUP_BY`. */
export const GROUP_OPTIONS: GroupBy[] = [
  "status",
  "assignee",
  "project",
  "importance",
  "tag",
  "none",
];

export interface TaskGroup {
  /** Stable identity — a status id, an address, a project id, or a sentinel. */
  key: string;
  label: string;
  tasks: TaskRow[];
}

/** The bucket for "this task has no value for the thing we grouped by". */
export const UNSET = "__unset__";

export interface Filters {
  q: string;
  statusCategory: string;
  assignee: string;
  unassigned: boolean;
  overdue: boolean;
  /** WS-27m — ANY of these tags. `tags_all` on the wire is not exposed here yet. */
  tags: string[];
}

export const EMPTY_FILTERS: Filters = {
  q: "",
  statusCategory: "",
  assignee: "",
  unassigned: false,
  overdue: false,
  tags: [],
};

/**
 * Filters → query parameters for `GET /projects/tasks`.
 *
 * Only non-empty values are emitted. A `?overdue=false` would be indistinguishable
 * from "the client forgot to send it" on the server side, and sending every key
 * every time makes a saved view's stored config noisier than the choice it
 * records.
 */
export function toQuery(filters: Filters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.q.trim()) out.q = filters.q.trim();
  if (filters.statusCategory) out.status_category = filters.statusCategory;
  if (filters.assignee.trim()) out.assignee = filters.assignee.trim();
  if (filters.unassigned) out.unassigned = "true";
  if (filters.overdue) out.overdue = "true";
  // CSV, matching `split_csv` on the gateway. A tag containing a comma would
  // break this — which is why the picker treats a comma as a separator, so
  // one can never be stored.
  if (filters.tags.length) out.tags = filters.tags.join(",");
  return out;
}

/** A stored view's `config.filters` → the form state, defaults filled in. */
export function fromConfig(config: unknown): { filters: Filters; groupBy: GroupBy } {
  const raw = (config ?? {}) as Record<string, unknown>;
  const stored = (raw.filters ?? {}) as Record<string, unknown>;
  const groupBy = raw.group_by;
  return {
    filters: {
      ...EMPTY_FILTERS,
      q: typeof stored.q === "string" ? stored.q : "",
      statusCategory:
        typeof stored.status_category === "string" ? stored.status_category : "",
      assignee: typeof stored.assignee === "string" ? stored.assignee : "",
      unassigned: stored.unassigned === true,
      overdue: stored.overdue === true,
      tags:
        typeof stored.tags === "string" && stored.tags
          ? stored.tags.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
    },
    groupBy: GROUP_OPTIONS.includes(groupBy as GroupBy)
      ? (groupBy as GroupBy)
      : "status",
  };
}

/**
 * The form state → what gets stored on a view. Mirrors `fromConfig`.
 *
 * Deliberately *not* `toQuery`: a query string has only text, so `toQuery`
 * writes `"true"`, whereas a config is JSON and keeps a boolean a boolean.
 * `fromConfig` refuses a string where a toggle belongs — a hand-edited
 * `"false"` must not read as on — so a view built from query shape would come
 * back with its toggles silently cleared.
 */
export function toConfig(filters: Filters, groupBy: GroupBy): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  if (filters.q.trim()) stored.q = filters.q.trim();
  if (filters.statusCategory) stored.status_category = filters.statusCategory;
  if (filters.assignee.trim()) stored.assignee = filters.assignee.trim();
  if (filters.unassigned) stored.unassigned = true;
  if (filters.overdue) stored.overdue = true;
  // A CSV string here too, not an array: `build_task_filters` parses it with
  // `split_csv`, so a saved view and a typed query string must be the same
  // shape or the view would be the one that breaks.
  if (filters.tags.length) stored.tags = filters.tags.join(",");
  return { filters: stored, group_by: groupBy };
}

/** Whether anything is actually filtering, for the "clear" affordance. */
export function isFiltered(filters: Filters): boolean {
  return Object.keys(toQuery(filters)).length > 0;
}

const localPart = (address: string): string => address.split("@")[0] || address;

/** How an assignee reads on a card: `priya`, or `builder` for an agent. */
export function personLabel(who: string): string {
  if (who.startsWith("agent:")) return who.slice("agent:".length) || who;
  return localPart(who);
}

const IMPORTANCE_LABELS: Record<string, string> = {
  "3": "Urgent",
  "2": "High",
  "1": "Normal",
  "0": "Low",
};

/**
 * Split tasks into groups.
 *
 * **A task with two assignees appears in both their columns.** That is the
 * honest rendering: it IS both people's work, and picking one arbitrarily would
 * hide it from the other. The total across groups can therefore exceed the task
 * count, which is why the header counts tasks and not group sizes.
 *
 * **Empty status lanes are kept**, because a board with a missing "In progress"
 * column reads as "this project has no in-progress state" rather than "nothing
 * is in progress". Every other grouping drops empties — there is no meaningful
 * "assignees with nothing assigned" column.
 */
export function groupTasks(
  tasks: TaskRow[],
  by: GroupBy,
  ctx: { statuses: StatusRow[]; projectName?: (id: string) => string },
): TaskGroup[] {
  if (by === "none") {
    return [{ key: "all", label: `${tasks.length} tasks`, tasks }];
  }

  if (by === "status") {
    const ordered = [...ctx.statuses].sort((a, b) => a.position - b.position);
    return ordered.map((status) => ({
      key: status.id,
      label: status.name,
      tasks: tasks.filter((t) => t.status_id === status.id),
    }));
  }

  const buckets = new Map<string, TaskGroup>();
  const put = (key: string, label: string, task: TaskRow) => {
    const existing = buckets.get(key);
    if (existing) existing.tasks.push(task);
    else buckets.set(key, { key, label, tasks: [task] });
  };

  for (const task of tasks) {
    if (by === "assignee") {
      const people = task.assignees ?? [];
      if (people.length === 0) put(UNSET, "Unassigned", task);
      else for (const who of people) put(who, personLabel(who), task);
    } else if (by === "tag") {
      // A task with three tags appears in three columns, for the same reason a
      // task with two assignees appears in both theirs: it genuinely belongs to
      // each, and picking one hides it from the others.
      const names = task.tags ?? [];
      if (names.length === 0) put(UNSET, "Untagged", task);
      else for (const name of names) put(name, name, task);
    } else if (by === "project") {
      const id = task.project_id;
      put(id, ctx.projectName?.(id) ?? "Project", task);
    } else {
      const value = task.importance;
      const key = value === null || value === undefined ? UNSET : String(value);
      put(key, key === UNSET ? "No priority" : IMPORTANCE_LABELS[key] ?? key, task);
    }
  }

  // Unassigned / no-priority last: it is a residue, not a peer of the named
  // buckets, and putting it first pushes the real work down the page.
  return [...buckets.values()].sort((a, b) => {
    if (a.key === UNSET) return 1;
    if (b.key === UNSET) return -1;
    return a.label.localeCompare(b.label);
  });
}
