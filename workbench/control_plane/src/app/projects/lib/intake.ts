/**
 * Projects · intake — pure logic for the triage rail (WS-27u).
 *
 * Spec: `ai-company-brain/specs/project_management_app.md` §9.1 (WS-27u).
 *
 * Pure functions only, the package's standing split: the SERVER decides which
 * captures the caller may see (the queue is scoped by the same grants as the
 * tasks it wraps, and snoozes reappear by being read), and this module decides
 * only how the rail lays them out and what the pickers may offer. A browser
 * that re-derived queue membership would be a second, drifting answer to
 * "what is pending".
 */

import type { TaskRow } from "./api";

/** The wrapper — permanent provenance, 1:1 with a captured task. */
export interface IntakeInfo {
  id: string;
  task_id: string;
  status: string;
  snoozed_until?: string | null;
  source?: string | null;
  source_ref?: string | null;
  duplicate_of_task_id?: string | null;
  created_at?: string | null;
}

/** A queue row: the ordinary task row with its wrapper attached. */
export interface IntakeItem extends TaskRow {
  intake: IntakeInfo;
}

/**
 * One line saying where a capture came from, or `null` when nobody said.
 *
 * `null` rather than an empty string, so the rail can omit the line entirely —
 * a blank "from:" row would imply provenance was lost rather than never given.
 */
export function describeSource(
  intake: Pick<IntakeInfo, "source" | "source_ref">
): string | null {
  const source = (intake.source ?? "").trim();
  const ref = (intake.source_ref ?? "").trim();
  if (source && ref) return `${source} · ${ref}`;
  return source || ref || null;
}

/**
 * Oldest capture first. The queue is a line, and the front of the line is
 * whoever has waited longest — newest-first would let fresh captures bury the
 * one that has been ignored for a week, which is the failure mode a front
 * door exists to prevent. Ties break on id so a reload never reshuffles.
 */
export function sortQueue(rows: readonly IntakeItem[]): IntakeItem[] {
  return [...rows].sort((a, b) => {
    const at = a.intake.created_at ?? a.created_at ?? "";
    const bt = b.intake.created_at ?? b.created_at ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Statuses legal as an accept destination: every lane EXCEPT triage ones.
 *
 * The gateway refuses a triage destination with a 422 (accepting into triage
 * rules nothing); filtering here is the picker-exclusion rule — a picker must
 * not offer what the write will refuse.
 */
export function acceptTargets<S extends { category: string }>(
  statuses: readonly S[]
): S[] {
  return statuses.filter((status) => status.category !== "triage");
}

/**
 * Search hits the duplicate picker may offer: never the capture itself.
 * The gateway 422s a self-duplicate; same picker-exclusion rule as above.
 */
export function duplicateTargets<H extends { id: string }>(
  hits: readonly H[],
  selfId: string
): H[] {
  return hits.filter((hit) => hit.id !== selfId);
}

/**
 * A date input's `YYYY-MM-DD` → the snooze instant, or `null` when unusable.
 *
 * 9am LOCAL on the chosen day, then serialised as an instant: snoozing is a
 * human deferring to "that morning", and the viewer's browser is the only
 * party that knows when their morning is (the WS-27q lesson — the server
 * works in instants, the browser owns placement). Deliberately NOT routed
 * through `new Date("YYYY-MM-DD")`, which is midnight UTC and lands the
 * snooze on the previous evening anywhere west of Greenwich.
 */
export function snoozeInstant(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = new Date(`${day}T09:00:00`);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString();
}
