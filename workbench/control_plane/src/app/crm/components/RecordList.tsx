"use client";

/**
 * The shared list — one component, four entities (specs/crm_app.md §5
 * surface 2, §4's list contract).
 *
 * Four list components is how a shared contract stops being shared: one grows
 * a different page cap, another a different sort key, and the endpoint's
 * single contract becomes four. The request is built once in ../lib/filters.ts.
 *
 * ⚠️ **The columns are declared in ../lib/columns.ts, not here** (WS-26i-export).
 * The CSV export writes the same set in the same order, and a file whose
 * columns differ from the screen's is a second opinion about the same rows —
 * so the vocabulary is one declaration, read by a Python fence
 * (`tests/unit/test_crm_export.py`). What stays here is RENDERING, which is
 * JSX and per-theme and could not live in a `.ts` file anyway.
 */

import Icon from "@/components/Icon";
import { COLUMNS } from "../lib/columns";
import { SORTS } from "../lib/filters";
import { money, shortDate, shortEmail } from "../lib/format";
import type { EntitySlug } from "../lib/types";

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  return value === null || value === undefined || value === ""
    ? "—"
    : String(value);
}

/**
 * How a cell draws, when it is not just its own text.
 *
 * Keyed by column key rather than by entity+key because every one of these is
 * the same decision wherever it appears: an owner is always an initial, an
 * amount is always money. A key with no entry falls through to `text`, which
 * is what most columns want — so adding a plain column to `columns.ts` needs
 * no edit here, and adding a formatted one fails visibly (raw value on screen)
 * rather than silently.
 */
const RENDERERS: Record<string, (row: Row) => React.ReactNode> = {
  amount: (r) => money(r.amount as number | null, (r.currency as string) || "INR"),
  expected_close_date: (r) => shortDate(r.expected_close_date as string | null),
  owner_email: (r) => shortEmail(r.owner_email as string | null),
  first_name: (r) => `${text(r, "first_name")} ${r.last_name ?? ""}`.trim(),
  converted_deal_id: (r) =>
    r.converted_deal_id ? (
      <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] text-success">
        converted
      </span>
    ) : null,
};

function cell(key: string, row: Row): React.ReactNode {
  return (RENDERERS[key] ?? ((r: Row) => text(r, key)))(row);
}

export default function RecordList({
  entity,
  rows,
  total,
  loading,
  sort,
  direction,
  onSort,
  onOpen,
}: {
  entity: EntitySlug;
  rows: Row[];
  total: number;
  loading: boolean;
  sort: string | null;
  direction: "asc" | "desc";
  onSort: (key: string) => void;
  onOpen: (id: string) => void;
}) {
  const columns = COLUMNS[entity];
  const sortable = new Set(SORTS[entity].map((s) => s.key));

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b border-border">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className="px-4 py-2 text-left font-medium text-muted-foreground"
                >
                  {column.sort && sortable.has(column.sort) ? (
                    <button
                      onClick={() => onSort(column.sort!)}
                      className="inline-flex items-center gap-1 hover:text-foreground tech-transition"
                    >
                      {column.label}
                      {sort === column.sort &&
                        (direction === "asc" ? (
                          <Icon name="ArrowUp" className="w-3 h-3" />
                        ) : (
                          <Icon name="ArrowDown" className="w-3 h-3" />
                        ))}
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={String(row.id)}
                onClick={() => onOpen(String(row.id))}
                className="cursor-pointer border-b border-border/60 hover:bg-secondary/40 tech-transition"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-4 py-2 text-muted-foreground ${column.className ?? ""}`}
                  >
                    {cell(column.key, row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && (
          <p className="p-8 text-center text-xs text-muted-foreground">
            Nothing matches this view.
          </p>
        )}
      </div>
      <footer className="shrink-0 border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
        {loading ? "Loading…" : `${rows.length} of ${total}`}
      </footer>
    </div>
  );
}
