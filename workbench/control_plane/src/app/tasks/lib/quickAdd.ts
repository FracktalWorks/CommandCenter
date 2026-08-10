// /tasks · group-context quick-add (the WS-27y pattern, backported).
//
// A quick-add lives inside a group — a board column, a grouped-list section —
// and the task it creates must LAND in that group, or the add reads as a
// failure while the task sits in some default bucket off-screen. The mapping
// from "where the input is" to "what the created item must carry" is this
// module, pure and surface-agnostic, exactly like `app/projects/lib/quickAdd`
// on the other side of the wall: the payloads differ (`gtd_items` speaks
// workflowStage/context/energy, `pm_tasks` speaks status_id/tags), the
// grammar is the same.
//
// One divergence from the Projects mapping, and it is deliberate: /tasks has
// COMPUTED axes. The priority and mode groups are projections of
// important × leveraged × urgent-from-dueAt (`priority.ts`), so no create
// payload can promise the new task lands in "Critical" — urgency needs a due
// date nobody typed. Where Projects answers an unknown axis with "a plain add,
// never an error", these axes answer `null` — the surface offers no quick-add
// there at all — because in a grouped list a plain add that visibly files
// itself into a SIBLING group is not a plain add, it is a lie about where the
// task went.

import type { GroupBy } from "./ordering";
import { NO_CONTEXT_GROUP } from "./priority";
import type { Energy } from "./types";

/** What a quick-added task must carry to belong to its group. */
export interface QuickAddPrefill {
  workflowStage?: string;
  context?: string;
  energy?: Energy;
  deepWork?: boolean;
}

/** The axes a /tasks quick-add can sit inside: the status axis (`""`, the
 *  grouped list's default and the board's columns) or a toolbar lens. */
export type QuickAddAxis = GroupBy | "";

const ENERGIES: ReadonlySet<string> = new Set(["low", "medium", "high"]);

/**
 * (axis, group key) → the prefill, or `null` when the group cannot honestly
 * take a quick-add (a computed axis — see the header).
 *
 * The unset buckets ("No context", "No energy set", "Shallow") ask for
 * nothing: a bare next action is already context-less, energy-less and
 * shallow, so "create it in this group" is what a bare create does.
 */
export function quickAddPrefill(
  axis: QuickAddAxis,
  key: string,
): QuickAddPrefill | null {
  switch (axis) {
    case "":
      // The status axis: the board's columns and the grouped list's stage
      // sections. The key IS the stage.
      return { workflowStage: key };
    case "context":
      return key === NO_CONTEXT_GROUP ? {} : { context: key };
    case "energy":
      return ENERGIES.has(key) ? { energy: key as Energy } : {};
    case "depth":
      return key === "deep" ? { deepWork: true } : {};
    case "none":
      return {};
    case "priority":
    case "mode":
      // Computed from flags + due date — a create cannot promise the landing.
      return null;
  }
}
