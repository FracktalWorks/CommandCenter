// Small presentation helpers for the GTD task UI.

import { Disposition, Energy, GtdItem, ProviderKind, Source } from "./types";

/** Relative "time ago" / "in X" label for a due or created date. */
export function relativeTime(iso: string | undefined, nowMs = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMin = Math.round((then - nowMs) / 60000);
  const past = diffMin < 0;
  const m = Math.abs(diffMin);
  const fmt = (n: number, unit: string) =>
    past ? `${n}${unit} ago` : `in ${n}${unit}`;
  if (m < 1) return "now";
  if (m < 60) return fmt(m, "m");
  const h = Math.round(m / 60);
  if (h < 24) return fmt(h, "h");
  const d = Math.round(h / 24);
  if (d < 7) return fmt(d, "d");
  const w = Math.round(d / 7);
  if (w < 5) return fmt(w, "w");
  const mo = Math.round(d / 30);
  return fmt(mo, "mo");
}

/** True if a hard-date item is overdue. */
export function isOverdue(item: GtdItem, nowMs = Date.now()): boolean {
  if (!item.dueAt) return false;
  return new Date(item.dueAt).getTime() < nowMs;
}

/** True if an item belongs in the Calendar view (date-specific actions). */
export function isCalendarItem(item: GtdItem): boolean {
  return !!item.isHardDate && !!item.dueAt;
}

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  INBOX: "Inbox",
  NEXT: "Next action",
  WAITING: "Waiting for",
  SOMEDAY: "Someday / Maybe",
  PROJECT: "Project",
  REFERENCE: "Reference",
  DONE: "Done",
  TRASH: "Trash",
};

export const ENERGY_LABEL: Record<Energy, string> = {
  low: "Low energy",
  medium: "Medium energy",
  high: "High energy",
};

/** A short, capability-free label + dot-tone for the source/provider badge. */
export function sourceBadge(source: Source, provider?: ProviderKind): {
  label: string;
  tone: "local" | "synced";
} {
  if (source === "LOCAL") return { label: "Local", tone: "local" };
  const label =
    provider && provider !== "local"
      ? provider.charAt(0).toUpperCase() + provider.slice(1)
      : "Synced";
  return { label, tone: "synced" };
}

/** Minutes → "10m" / "1h 30m". */
export function durationLabel(mins?: number): string {
  if (!mins) return "";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Initials for an avatar chip. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}
