"use client";

import { ListFilter } from "lucide-react";
import { useEmailStore } from "../lib/emailStore";
import { SearchFilter, addFilter, filterKey } from "../lib/searchFilters";
import { chipColors } from "../lib/labelColors";

/**
 * QuickFilters — a one-click chip row above the mail list.
 *
 * These reproduce the old "Rapid Inbox" buckets (Needs reply, Awaiting,
 * Follow-up, Newsletter, Marketing, …) as ordinary search filters, so the same
 * triage lives inside the regular inbox instead of a separate view. Each chip
 * toggles a search pill — the SearchBar shows the same pills, and both read the
 * one store, so they stay in sync. Tag chips wear the app-wide category colour.
 */

/** Curated triage buckets. Order = most-actionable first. */
const CHIPS: { label: string; f: SearchFilter }[] = [
  { label: "Unread", f: { kind: "unread", value: "" } },
  // Conversation-status labels the reply pipeline writes to em.categories.
  { label: "Needs reply", f: { kind: "tag", value: "Reply" } },
  { label: "Awaiting", f: { kind: "tag", value: "Awaiting Reply" } },
  { label: "Follow-up", f: { kind: "tag", value: "Follow-up" } },
  // Cleanup categories the rules engine writes to em.categories.
  { label: "Newsletter", f: { kind: "tag", value: "Newsletter" } },
  { label: "Marketing", f: { kind: "tag", value: "Marketing" } },
  { label: "Notification", f: { kind: "tag", value: "Notification" } },
  { label: "Cold Email", f: { kind: "tag", value: "Cold Email" } },
];

export function QuickFilters() {
  const searchFilters = useEmailStore((s) => s.searchFilters);
  const setSearchFilters = useEmailStore((s) => s.setSearchFilters);
  const labelColors = useEmailStore((s) => s.labelColors);

  const isActive = (f: SearchFilter) =>
    searchFilters.some((x) => filterKey(x) === filterKey(f));

  const toggle = (f: SearchFilter) => {
    if (isActive(f)) {
      setSearchFilters(searchFilters.filter((x) => filterKey(x) !== filterKey(f)));
    } else {
      setSearchFilters(addFilter(searchFilters, f));
    }
  };

  return (
    <div className="flex items-center gap-1.5 px-3 sm:px-4 py-1.5 border-b border-border overflow-x-auto scrollbar-hide flex-shrink-0 bg-card/40">
      <ListFilter size={13} className="text-muted-foreground flex-shrink-0" />
      {CHIPS.map(({ label, f }) => {
        const active = isActive(f);
        const c = f.kind === "tag" ? chipColors(f.value, labelColors) : null;
        return (
          <button
            key={label}
            onClick={() => toggle(f)}
            style={active && c ? { backgroundColor: c.bg, color: c.text } : undefined}
            className={`flex items-center gap-1.5 flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium border transition-colors ${
              active
                ? c
                  ? "border-transparent"
                  : "bg-primary text-primary-foreground border-transparent"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
            }`}
          >
            {c && !active && (
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: c.bg }}
              />
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}
