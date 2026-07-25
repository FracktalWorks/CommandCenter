/**
 * genUiText — pure coercion helpers for the generative-UI renderer.
 *
 * Agents author these trees as free-form JSON, so a prop that the schema calls
 * a string arrives as an object often enough to matter. `String(value)` on one
 * of those renders the literal "[object Object]" into the page — it shipped
 * that way in a table header row (columns emitted as `{key,label}`).
 *
 * These helpers are the single funnel every node type goes through, so the
 * "never render [object Object]" guarantee is tree-wide rather than
 * per-renderer. Framework-free on purpose: unit-tested in genUiText.test.ts.
 */

/**
 * Coerce an agent-supplied value to display text.
 *
 * Objects degrade to their obvious text field, arrays to a comma list, and
 * anything unusable to `fallback` — a shape mismatch looks empty, never broken.
 */
export function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  if (Array.isArray(value)) {
    return value.map((v) => text(v)).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const pick = o.text ?? o.label ?? o.value ?? o.name ?? o.title;
    return pick == null || typeof pick === "object" ? fallback : text(pick);
  }
  return String(value);
}

/** A table column normalised to a lookup key plus a header label. */
export interface TableColumn {
  key: string;
  label: string;
}

/**
 * Normalise one column: a plain header string, or an object carrying the label
 * under any of the names models reach for (`label`/`title`/`header`/`name`)
 * and optionally a row-lookup `key`/`field`.
 */
export function toColumn(col: unknown): TableColumn {
  if (col && typeof col === "object" && !Array.isArray(col)) {
    const o = col as Record<string, unknown>;
    return {
      key: text(o.key ?? o.field ?? o.name ?? o.label ?? o.title ?? o.header),
      label: text(o.label ?? o.title ?? o.header ?? o.name ?? o.key ?? o.field),
    };
  }
  return { key: text(col), label: text(col) };
}

/**
 * Resolve a table's columns: the declared ones when present, otherwise derived
 * from the keys of the first object row (so keyed rows still render headers
 * instead of dropping every cell).
 */
export function tableColumns(columns: unknown, rows: unknown[]): TableColumn[] {
  if (Array.isArray(columns) && columns.length > 0) return columns.map(toColumn);
  const firstObjRow = rows.find(
    (r) => r && typeof r === "object" && !Array.isArray(r),
  ) as Record<string, unknown> | undefined;
  if (!firstObjRow) return [];
  return Object.keys(firstObjRow).map((k) => ({ key: k, label: k }));
}

/** Cells for one row — positional arrays and objects keyed by column both work. */
export function tableCells(row: unknown, columns: TableColumn[]): string[] {
  if (Array.isArray(row)) return row.map((v) => text(v));
  if (row && typeof row === "object") {
    const o = row as Record<string, unknown>;
    return columns.map((c) => text(o[c.key]));
  }
  return [];
}
