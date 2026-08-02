// Waiting-For math — the pure predicates behind the "who / what / since-when"
// list (spec: ai-company-brain/specs/task_manager_app.md §1 line 46, §6).
// No React, no store: just Date arithmetic over an already-loaded GtdItem, so
// the view and its unit tests read the same rules. Same shape as
// lib/ordering.ts and lib/scheduling.ts.
//
// Two DIFFERENT clocks live here and must not be confused:
//   overdue = past `expectedBy`      — the date the thing was promised for
//   stale   = long since `delegatedAt` — nobody has heard anything in a while
// An item can be either, both, or neither.

import { GtdItem } from "./types";

/** Days of silence after which a waiting-for is "stale".
 *
 *  ⚠️ CONTRACT: this is the client half of a rule the server also states, in
 *  `GET /tasks/insights` (`apps/services/gateway/gateway/routes/tasks/ai.py`,
 *  `inbox_insights`: `w.delegated_at < now() - interval '5 days'`). The banner
 *  and `insights.stale_waiting` must never disagree about the same list, so if
 *  one side moves the other moves in the same change. */
export const STALE_WAITING_DAYS = 5;

const DAY_MS = 86_400_000;

/** ms elapsed since an ISO timestamp, or null when there isn't one / it's
 *  unparseable. Kept private: every caller below wants the null-safety. */
function elapsed(iso: string | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  return Number.isNaN(then) ? null : nowMs - then;
}

/** Whole days the item has been on the Waiting-For list — the "since-when"
 *  column (§1 line 46). Null when it was never delegated (no `delegatedAt`),
 *  which is the only honest answer: the view shows nothing rather than "0d".
 *  Floors, so it reads "3d" for anything from 3d 0h to 3d 23h. Negative
 *  elapsed (a delegation dated in the future) clamps to 0. */
export function daysWaiting(
  item: Pick<GtdItem, "delegatedAt">,
  nowMs: number = Date.now(),
): number | null {
  const ms = elapsed(item.delegatedAt, nowMs);
  if (ms === null) return null;
  return Math.max(0, Math.floor(ms / DAY_MS));
}

/** True iff the promised-by date has passed (spec §6 line 540: "flags
 *  `gtd_waiting` rows past `expected_by`"). No `expectedBy` ⇒ false: nothing
 *  was promised, so nothing can be late. This is deliberately NOT `dueAt` —
 *  a delegated item's deadline for ME and the date I asked THEM for are
 *  different facts, even when today's write sites happen to set them alike. */
export function isWaitingOverdue(
  item: Pick<GtdItem, "expectedBy">,
  nowMs: number = Date.now(),
): boolean {
  if (!item.expectedBy) return false;
  const due = new Date(item.expectedBy).getTime();
  return !Number.isNaN(due) && due < nowMs;
}

/** True iff more than STALE_WAITING_DAYS have passed since delegation — the
 *  "silently rotting" case §6 exists to prevent. Strictly greater, matching
 *  the server's `delegated_at < now() - interval '5 days'`: at exactly five
 *  days it is not yet stale. */
export function isStaleWaiting(
  item: Pick<GtdItem, "delegatedAt">,
  nowMs: number = Date.now(),
): boolean {
  const ms = elapsed(item.delegatedAt, nowMs);
  return ms !== null && ms > STALE_WAITING_DAYS * DAY_MS;
}

/** One person's Waiting-For pile. `key` is stable for React and for tests. */
export interface WaitingGroup {
  key: string;
  /** who we're waiting on ("Unassigned" when the record has no person). */
  label: string;
  items: GtdItem[];
  overdueCount: number;
}

const UNASSIGNED = "Unassigned";

/** Group a waiting list by WHO we're waiting on — the axis the view is built
 *  around, because the human action ("chase Sai") is per-person, not per-task.
 *  Within a group the longest-waiting item comes first (that's the one at risk
 *  of rotting); groups are ordered by overdue count, then by size, then name,
 *  so the person you most need to chase is at the top. Pure + deterministic. */
export function groupByWaitingOn(
  items: GtdItem[],
  nowMs: number = Date.now(),
): WaitingGroup[] {
  const byKey = new Map<string, WaitingGroup>();
  for (const item of items) {
    // Identity: email when we have one (two "Priya"s are two people), else the
    // display name, else the shared Unassigned bucket.
    const person = item.waitingOn;
    const key =
      person?.email?.toLowerCase() || person?.name?.trim() || UNASSIGNED;
    const label = person?.name?.trim() || person?.email || UNASSIGNED;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, items: [], overdueCount: 0 };
      byKey.set(key, group);
    }
    group.items.push(item);
    if (isWaitingOverdue(item, nowMs)) group.overdueCount += 1;
  }
  const groups = [...byKey.values()];
  for (const g of groups) {
    g.items.sort(
      (a, b) =>
        (daysWaiting(b, nowMs) ?? -1) - (daysWaiting(a, nowMs) ?? -1) ||
        a.title.localeCompare(b.title),
    );
  }
  return groups.sort(
    (a, b) =>
      b.overdueCount - a.overdueCount ||
      b.items.length - a.items.length ||
      a.label.localeCompare(b.label),
  );
}
