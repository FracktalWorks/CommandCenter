"use client";

/**
 * The record sheet — opened OVER the list, never as its own route
 * (specs/crm_app.md §5 surface 3).
 *
 * The URL carries `?deal=<id>`, so Back closes the sheet instead of leaving
 * the app and a link to a record carries the list the sender was looking at.
 * That decision lives in ../lib/urlState.ts; this is its surface.
 *
 * Left: the timeline. Right: the fields. Both halves are their own component
 * because the sheet serves four entities and the difference between them is
 * entirely in the field list.
 */

import Icon from "@/components/Icon";
import { useViewMode } from "@/components/ViewModeProvider";
import FieldsPanel from "./FieldsPanel";
import Timeline from "./Timeline";
import type { DealContact, EntitySlug, Status, TimelineEntry } from "../lib/types";

type Row = Record<string, unknown>;

const TITLE_KEY: Record<EntitySlug, string[]> = {
  deals: ["name"],
  leads: ["lead_name"],
  contacts: ["first_name", "last_name"],
  organizations: ["name"],
};

export default function RecordSheet({
  entity,
  record,
  statuses,
  timeline,
  dealContacts,
  saving,
  onClose,
  onPatch,
  onMoveStatus,
  onLog,
  onToggleTask,
  onConvert,
  onSetPrimary,
  onDetach,
  onOpenContact,
}: {
  entity: EntitySlug;
  record: Row | null;
  statuses: Status[];
  timeline: TimelineEntry[];
  dealContacts: DealContact[];
  saving: boolean;
  onClose: () => void;
  onPatch: (body: Record<string, unknown>) => void;
  onMoveStatus: (statusId: string) => void;
  onLog: (body: {
    type: "note" | "call" | "meeting" | "task";
    subject?: string;
    body?: string;
    due_at?: string;
  }) => void;
  onToggleTask: (activityId: string, completed: boolean) => void;
  onConvert: () => void;
  onSetPrimary: (contactId: string) => void;
  onDetach: (contactId: string) => void;
  onOpenContact: (contactId: string) => void;
}) {
  const { isMobile } = useViewMode();

  const title = record
    ? TITLE_KEY[entity]
        .map((key) => record[key])
        .filter(Boolean)
        .join(" ") || "Untitled"
    : "Loading…";

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* The scrim closes the sheet, matching Back — two ways out of a
          surface that sits on top of the list somebody was reading. */}
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
      />
      <aside
        className={`relative flex h-full flex-col border-l border-border bg-card shadow-xl ${
          isMobile ? "w-full" : "w-full max-w-4xl"
        }`}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-bold text-foreground">
              {title}
            </h1>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {entity.slice(0, -1)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-secondary tech-transition"
            aria-label="Close record"
          >
            <Icon name="X" className="w-4 h-4" />
          </button>
        </header>

        {record === null ? (
          <p className="p-8 text-center text-xs text-muted-foreground">Loading…</p>
        ) : (
          <div
            className={`flex min-h-0 flex-1 ${isMobile ? "flex-col overflow-y-auto" : "flex-row"}`}
          >
            <div
              className={`min-h-0 ${isMobile ? "" : "flex-1 border-r border-border"}`}
            >
              <Timeline
                entries={timeline}
                onLog={onLog}
                onToggleTask={onToggleTask}
                saving={saving}
              />
            </div>
            <div className={isMobile ? "" : "w-[340px] shrink-0"}>
              <FieldsPanel
                entity={entity}
                record={record}
                statuses={statuses}
                dealContacts={dealContacts}
                saving={saving}
                onPatch={onPatch}
                onMoveStatus={onMoveStatus}
                onConvert={onConvert}
                onSetPrimary={onSetPrimary}
                onDetach={onDetach}
                onOpenContact={onOpenContact}
              />
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
