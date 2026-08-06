"use client";

/**
 * The record sheet's right panel: fields with inline edit, the status pill,
 * the deal's people, and the Convert button on a lead
 * (specs/crm_app.md §5 surface 3).
 *
 * Inline edit rather than an edit mode: a CRM record is corrected constantly
 * — a phone number, a close date, a next step — and a form that has to be
 * opened and saved is a form nobody opens.
 */

import { Check, Star, UserMinus, X } from "lucide-react";
import { useState } from "react";
import { money, shortDate } from "../lib/format";
import StatusPill from "./StatusPill";
import type { DealContact, EntitySlug, Status } from "../lib/types";

type Row = Record<string, unknown>;

type Field = {
  key: string;
  label: string;
  kind?: "text" | "number" | "date";
  /** How it reads when it is not being edited. */
  show?: (row: Row) => string;
};

const FIELDS: Record<EntitySlug, Field[]> = {
  deals: [
    { key: "name", label: "Name" },
    {
      key: "amount",
      label: "Amount",
      kind: "number",
      show: (r) => money(r.amount as number | null, (r.currency as string) || "INR"),
    },
    {
      key: "expected_close_date",
      label: "Expected close",
      kind: "date",
      show: (r) => shortDate(r.expected_close_date as string | null),
    },
    { key: "next_step", label: "Next step" },
    { key: "owner_email", label: "Owner" },
    { key: "description", label: "Notes" },
  ],
  leads: [
    { key: "lead_name", label: "Name" },
    { key: "first_name", label: "First name" },
    { key: "last_name", label: "Last name" },
    { key: "organization_name", label: "Company" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "lead_source", label: "Source" },
    { key: "owner_email", label: "Owner" },
    { key: "description", label: "Notes" },
  ],
  contacts: [
    { key: "first_name", label: "First name" },
    { key: "last_name", label: "Last name" },
    { key: "title", label: "Title" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "mobile", label: "Mobile" },
    { key: "owner_email", label: "Owner" },
    { key: "description", label: "Notes" },
  ],
  organizations: [
    { key: "name", label: "Name" },
    { key: "website", label: "Website" },
    { key: "industry", label: "Industry" },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" },
    { key: "owner_email", label: "Owner" },
    { key: "description", label: "Notes" },
  ],
};

export default function FieldsPanel({
  entity,
  record,
  statuses,
  dealContacts,
  saving,
  onPatch,
  onMoveStatus,
  onConvert,
  onSetPrimary,
  onDetach,
  onOpenContact,
}: {
  entity: EntitySlug;
  record: Row;
  statuses: Status[];
  dealContacts: DealContact[];
  saving: boolean;
  onPatch: (body: Record<string, unknown>) => void;
  onMoveStatus: (statusId: string) => void;
  onConvert: () => void;
  onSetPrimary: (contactId: string) => void;
  onDetach: (contactId: string) => void;
  onOpenContact: (contactId: string) => void;
}) {
  const status =
    statuses.find((s) => s.id === record.status_id) ?? null;
  const converted = Boolean(record.converted_deal_id);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {statuses.length > 0 && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <StatusPill
            status={status}
            statuses={statuses}
            onChange={onMoveStatus}
            disabled={saving}
          />
          {entity === "leads" &&
            (converted ? (
              <span className="ml-auto rounded-full bg-success/10 px-2 py-0.5 text-[10px] text-success">
                converted
              </span>
            ) : (
              <button
                onClick={onConvert}
                className="ml-auto rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 tech-transition"
              >
                Convert
              </button>
            ))}
        </div>
      )}

      {entity === "deals" && (
        <section className="border-b border-border px-4 py-3">
          <h3 className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            People
          </h3>
          {dealContacts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nobody is attached to this deal.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {dealContacts.map(({ contact, role, is_primary }) => (
                <li key={contact.id} className="flex items-center gap-2">
                  <button
                    onClick={() => onOpenContact(contact.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-xs text-foreground">
                      {contact.first_name} {contact.last_name ?? ""}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {role || contact.title || contact.email || "—"}
                    </span>
                  </button>
                  <button
                    onClick={() => onSetPrimary(contact.id)}
                    title={
                      is_primary
                        ? "Primary contact"
                        : "Make primary — the current primary is demoted"
                    }
                    className={`p-1 rounded tech-transition ${
                      is_primary
                        ? "text-warning"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Star
                      className="w-3.5 h-3.5"
                      fill={is_primary ? "currentColor" : "none"}
                    />
                  </button>
                  <button
                    onClick={() => onDetach(contact.id)}
                    title="Remove from this deal (the contact record is kept)"
                    className="p-1 rounded text-muted-foreground hover:text-destructive tech-transition"
                  >
                    <UserMinus className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <dl className="divide-y divide-border/60">
        {FIELDS[entity].map((field) => (
          <EditableField
            key={field.key}
            field={field}
            row={record}
            saving={saving}
            onPatch={onPatch}
          />
        ))}
      </dl>
    </div>
  );
}

function EditableField({
  field,
  row,
  saving,
  onPatch,
}: {
  field: Field;
  row: Row;
  saving: boolean;
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const raw = row[field.key];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  function begin() {
    setValue(raw === null || raw === undefined ? "" : String(raw));
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    const next = value.trim();
    const before = raw === null || raw === undefined ? "" : String(raw);
    if (next === before) return;
    // An emptied field clears to null — the gateway keeps an explicit null as
    // "clear this" and refuses it only where the column is NOT NULL with a
    // default, which is a 422 the panel surfaces rather than swallows.
    onPatch({
      [field.key]:
        next === ""
          ? null
          : field.kind === "number"
            ? Number.parseFloat(next)
            : next,
    });
  }

  return (
    <div className="flex items-start gap-3 px-4 py-2">
      <dt className="w-28 shrink-0 pt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {field.label}
      </dt>
      <dd className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              type={field.kind === "date" ? "date" : field.kind === "number" ? "number" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground focus:border-primary/40 focus:outline-none"
            />
            <button
              onClick={commit}
              disabled={saving}
              className="p-1 rounded text-muted-foreground hover:text-success tech-transition"
              aria-label="Save"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setEditing(false)}
              className="p-1 rounded text-muted-foreground hover:text-foreground tech-transition"
              aria-label="Cancel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={begin}
            className="w-full break-words text-left text-xs text-foreground hover:text-primary tech-transition"
          >
            {field.show
              ? field.show(row)
              : raw === null || raw === undefined || raw === ""
                ? "—"
                : String(raw)}
          </button>
        )}
      </dd>
    </div>
  );
}
