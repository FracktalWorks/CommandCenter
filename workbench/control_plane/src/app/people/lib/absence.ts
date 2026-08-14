/**
 * People Center · absences, the pure half (WS-28k).
 *
 * Spec: `project-docs/specs/people_center_app.md` §5.8 · **D-PC-7**.
 *
 * Formatting and ordering only. **The availability arithmetic is the
 * server's** — "how many working hours are left before this deadline" needs
 * the work schedule, the org policy and the absences together, and computing
 * a second answer here would be a second number for the same question.
 */

import type { Absence } from "./api";

/** The three words, mirrored from the gateway's tuple and migration 173's CHECK. */
export const ABSENCE_KINDS = ["away", "holiday", "partial"] as const;

/** Soonest first — the order somebody reads a list of upcoming absences in. */
export function sortAbsences(absences: readonly Absence[]): Absence[] {
  return [...absences].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
}

/** `2026-08-10` → `10 Aug`, dropping the year when it is this one. */
export function shortDate(iso: string, today = new Date()): string {
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  const sameYear = parsed.getFullYear() === today.getFullYear();
  return parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * One line: `10–14 Aug · away · at a conference`.
 *
 * A single-day absence renders as one date, not a range — "10 Aug – 10 Aug" is
 * the same fact spelled so nobody reads it, and it is the commonest case.
 */
export function describeAbsence(absence: Absence, today = new Date()): string {
  const from = shortDate(absence.starts_on, today);
  const to = shortDate(absence.ends_on, today);
  const when = absence.starts_on === absence.ends_on ? from : `${from} – ${to}`;
  const parts = [when, absence.kind];
  if (absence.kind === "partial" && absence.hours_per_day) {
    parts.push(`${absence.hours_per_day}h/day`);
  }
  if (absence.note) parts.push(absence.note);
  return parts.join(" · ");
}

/** Is this span in the past? Used to grey out what has already happened. */
export function isPast(absence: Absence, today = new Date()): boolean {
  return absence.ends_on < today.toISOString().slice(0, 10);
}
