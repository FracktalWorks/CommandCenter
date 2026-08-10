/**
 * Projects · which facts this app hands the shared colour vocabulary (WS-27ad).
 *
 * `src/lib/statusAccent.ts` owns the palette and the precedence. This owns the
 * translation from a Projects thing — a status row, a board column on whatever
 * axis the view is grouped by — into the input that module reads.
 *
 * It is a separate file rather than three inline calls because the interesting
 * decision is *which axes carry meaning*. Only the status axis has a stored
 * colour and a machine-readable category; every other axis (assignee, project,
 * tag, importance) is a bag of values whose colour can only ever be positional,
 * and pretending otherwise — reading a keyword out of a person's name — is how
 * a board decides that "Mark Green" is a done lane.
 */

import { statusAccent, type StatusAccent } from "@/lib/statusAccent";

import type { StatusRow } from "./api";
import type { GroupBy } from "./grouping";
import { LANE_LABELS } from "./mywork";

/**
 * The accent for one status.
 *
 * `color` is the owner's own choice (`pm_task_statuses.color`, stored since
 * migration 146 and — until this ticket — rendered nowhere), `category` is the
 * machine-readable fallback, and the name is not consulted at all: a status
 * that HAS a category never needs guessing at, and a Projects lane called
 * "Waiting on legal" is not automatically amber the way a /tasks stage is.
 */
export function accentForStatus(
  status: Pick<StatusRow, "color" | "category"> | undefined | null,
  index = 0,
  total = 0
): StatusAccent {
  return statusAccent({
    color: status?.color,
    category: status?.category,
    index,
    total,
  });
}

/**
 * The accent for a board column / list section on any axis.
 *
 * On the status axis the column key IS a status id, so the real row is looked
 * up and its colour and category answer. Off the status axis nothing
 * meaningful is known, so the hue is purely positional — neighbouring lanes
 * differ, and nothing pretends to mean anything.
 */
export function accentForGroup(
  groupBy: GroupBy,
  groupKey: string,
  index: number,
  total: number,
  statuses: readonly StatusRow[]
): StatusAccent {
  if (groupBy === "status") {
    const status = statuses.find((row) => row.id === groupKey);
    // A key with no matching row is the UNSET lane (a task with no status) or
    // a status deleted since the page loaded. Positional is the honest answer;
    // inventing a colour for "no status" would make the empty case look
    // deliberate.
    if (status) return accentForStatus(status, index, total);
  }
  return statusAccent({ index, total });
}

/**
 * The accent for a **My Work** disposition (S4).
 *
 * The personal lens has no statuses — a row's state there is its GTD
 * disposition — so this is the fact it hands the shared vocabulary. Written as
 * hue NAMES fed through `statusAccent`, never as classes: a `Record` of
 * tailwind strings here would be the second palette `sharedTaskUi.test.ts`
 * exists to forbid.
 *
 * **The map agrees with the name-keyword route wherever that route has an
 * opinion** — `Inbox` is gray and `Waiting on` is amber by keyword, so those
 * two are pinned to what /tasks would draw for a stage of the same name
 * (AGENTS.md rule 5; `accent.test.ts` asserts the agreement rather than
 * trusting it). `NEXT` and `SOMEDAY` are free choices because no keyword
 * matches them: blue is this UI's "active" tone, which is what a next action
 * is, and violet is the one remaining distinct hue.
 *
 * An unmapped disposition — `PROJECT`, `REFERENCE`, anything the server grows
 * later — falls through to the name route rather than throwing, so a new value
 * renders quietly instead of taking the pane down.
 */
const DISPOSITION_HUES: Record<string, string> = {
  INBOX: "gray",
  NEXT: "blue",
  WAITING: "amber",
  SOMEDAY: "violet",
  OTHER: "gray",
};

export function accentForDisposition(disposition: string): StatusAccent {
  return statusAccent({
    color: DISPOSITION_HUES[disposition] ?? null,
    name: LANE_LABELS[disposition] ?? disposition,
  });
}
