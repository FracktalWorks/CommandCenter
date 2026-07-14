// The columnar list model for Next Actions. On DESKTOP the Context (list) view
// renders as aligned columns (Jira/ClickUp-style) — Name plus a chosen set of
// the same signals that are pills on the card. On MOBILE we keep the stacked
// row (title + pills wrapping beneath) since there isn't width for columns.
//
// Which columns show is a per-browser DISPLAY preference (like the list/board
// toggle) — persisted in localStorage, toggled from the Task settings modal.
// Status is intentionally NOT a column: the list is already grouped by status
// (the section headers), so a Status column would just repeat the group.

/** A toggleable list column. `key` is the stable id used in storage + settings. */
export type ColumnKey =
  | "priority"
  | "context"
  | "energy"
  | "estimate"
  | "due"
  | "assignee"
  | "attachments"
  | "subtasks";

export interface ColumnDef {
  key: ColumnKey;
  /** header label shown on the desktop column row */
  label: string;
  /** fixed track width for the CSS grid (Name takes the remaining 1fr) */
  width: string;
  /** horizontal alignment of the cell content */
  align: "left" | "center" | "right";
}

/** Columns in their fixed left→right order (Name is always first, rendered
 *  separately as the flexible 1fr track). Order here === on-screen order. */
export const COLUMNS: ColumnDef[] = [
  { key: "priority", label: "Priority", width: "150px", align: "left" },
  { key: "context", label: "Context", width: "120px", align: "left" },
  { key: "energy", label: "Energy", width: "90px", align: "left" },
  { key: "estimate", label: "Estimate", width: "80px", align: "left" },
  { key: "due", label: "Due date", width: "110px", align: "left" },
  { key: "assignee", label: "Assignee", width: "140px", align: "left" },
  { key: "attachments", label: "Files", width: "60px", align: "center" },
  { key: "subtasks", label: "Subtasks", width: "80px", align: "center" },
];

/** Default visibility — the signals that were already pills on the card, on by
 *  default; the noisier count columns (files/subtasks) start hidden. */
export const DEFAULT_VISIBLE: Record<ColumnKey, boolean> = {
  priority: true,
  context: true,
  energy: true,
  estimate: true,
  due: true,
  assignee: true,
  attachments: false,
  subtasks: false,
};

const STORAGE_KEY = "cc.tasks.listColumns";

/** Read the persisted visibility map, merged over the defaults (so a newly
 *  added column shows/hides per its default until the user touches it). */
export function readColumnVisibility(): Record<ColumnKey, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VISIBLE };
    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, boolean>>;
    const out = { ...DEFAULT_VISIBLE };
    for (const c of COLUMNS) {
      if (typeof parsed[c.key] === "boolean") out[c.key] = parsed[c.key]!;
    }
    return out;
  } catch {
    return { ...DEFAULT_VISIBLE };
  }
}

const listeners = new Set<() => void>();

/** Subscribe to visibility changes (this tab's writes + other tabs' storage
 *  events). Shaped for useSyncExternalStore. */
export function subscribeColumns(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** Persist a single column's visibility and notify subscribers. */
export function setColumnVisible(key: ColumnKey, visible: boolean): void {
  const next = { ...readColumnVisibility(), [key]: visible };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode — in-memory listeners still fire for this tab */
  }
  listeners.forEach((cb) => cb());
}

/** The visible columns, in order — the desktop grid's non-Name tracks. */
export function visibleColumns(
  vis: Record<ColumnKey, boolean>,
): ColumnDef[] {
  return COLUMNS.filter((c) => vis[c.key]);
}

/** The CSS grid-template-columns for a row: Name (flexible) + each visible
 *  column's fixed track. Kept in one place so the header and the rows align. */
export function gridTemplate(cols: ColumnDef[]): string {
  return ["minmax(0, 1fr)", ...cols.map((c) => c.width)].join(" ");
}
