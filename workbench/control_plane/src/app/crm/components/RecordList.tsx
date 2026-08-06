"use client";

/**
 * The shared list — one component, four entities (specs/crm_app.md §5
 * surface 2, §4's list contract).
 *
 * Four list components is how a shared contract stops being shared: one grows
 * a different page cap, another a different sort key, and the endpoint's
 * single contract becomes four. Columns are declared per entity below; the
 * request is built once in ../lib/filters.ts.
 */

import { ArrowDown, ArrowUp } from "lucide-react";
import { SORTS } from "../lib/filters";
import { money, shortDate, shortEmail } from "../lib/format";
import type { EntitySlug } from "../lib/types";

type Row = Record<string, unknown>;

type Column = {
  key: string;
  label: string;
  /** The sort key this column offers, when the gateway allowlists one. */
  sort?: string;
  className?: string;
  render: (row: Row) => React.ReactNode;
};

function text(row: Row, key: string): string {
  const value = row[key];
  return value === null || value === undefined || value === ""
    ? "—"
    : String(value);
}

const COLUMNS: Record<EntitySlug, Column[]> = {
  deals: [
    {
      key: "name",
      label: "Deal",
      sort: "name",
      className: "font-medium text-foreground",
      render: (r) => text(r, "name"),
    },
    {
      key: "organization_name",
      label: "Organization",
      render: (r) => text(r, "organization_name"),
    },
    {
      key: "amount",
      label: "Amount",
      sort: "amount",
      render: (r) =>
        money(r.amount as number | null, (r.currency as string) || "INR"),
    },
    {
      key: "expected_close_date",
      label: "Closing",
      sort: "expected_close_date",
      render: (r) => shortDate(r.expected_close_date as string | null),
    },
    {
      key: "owner_email",
      label: "Owner",
      render: (r) => shortEmail(r.owner_email as string | null),
    },
  ],
  leads: [
    {
      key: "lead_name",
      label: "Lead",
      sort: "lead_name",
      className: "font-medium text-foreground",
      render: (r) => text(r, "lead_name"),
    },
    {
      key: "organization_name",
      label: "Company",
      render: (r) => text(r, "organization_name"),
    },
    { key: "email", label: "Email", sort: "email", render: (r) => text(r, "email") },
    {
      key: "owner_email",
      label: "Owner",
      sort: "owner_email",
      render: (r) => shortEmail(r.owner_email as string | null),
    },
    {
      key: "converted_deal_id",
      label: "",
      // "Converted" is the FK, never the timestamp (B6): deleting the deal
      // SET-NULLs the link and the lead comes back to the working list.
      render: (r) =>
        r.converted_deal_id ? (
          <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] text-success">
            converted
          </span>
        ) : null,
    },
  ],
  contacts: [
    {
      key: "first_name",
      label: "Name",
      sort: "first_name",
      className: "font-medium text-foreground",
      render: (r) => `${text(r, "first_name")} ${r.last_name ?? ""}`.trim(),
    },
    { key: "title", label: "Title", render: (r) => text(r, "title") },
    { key: "email", label: "Email", sort: "email", render: (r) => text(r, "email") },
    { key: "phone", label: "Phone", render: (r) => text(r, "phone") },
    {
      key: "owner_email",
      label: "Owner",
      sort: "owner_email",
      render: (r) => shortEmail(r.owner_email as string | null),
    },
  ],
  organizations: [
    {
      key: "name",
      label: "Organization",
      sort: "name",
      className: "font-medium text-foreground",
      render: (r) => text(r, "name"),
    },
    { key: "industry", label: "Industry", render: (r) => text(r, "industry") },
    { key: "phone", label: "Phone", render: (r) => text(r, "phone") },
    {
      key: "owner_email",
      label: "Owner",
      sort: "owner_email",
      render: (r) => shortEmail(r.owner_email as string | null),
    },
  ],
};

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
                          <ArrowUp className="w-3 h-3" />
                        ) : (
                          <ArrowDown className="w-3 h-3" />
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
                    {column.render(row)}
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
