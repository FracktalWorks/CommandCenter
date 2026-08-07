/**
 * Projects · the ClickUp import wizard's pure half (WS-27b's missing UI).
 *
 * The endpoints have existed since WS-27b — `POST /projects/import/clickup/plan`
 * (reads ClickUp, writes nothing) and `POST /projects/import/clickup` (applies
 * the owner's confirmed mapping, with a `dry_run` that writes nothing either).
 * What did not exist was any way to reach them, so the empty state named an
 * action — "import a ClickUp workspace" — that had no control anywhere in the
 * product.
 *
 * The mapping is the owner's act (D-PM-10): a wrong auto-map grants a Center
 * visibility of another department's work, and that is the one error class this
 * app cannot make silently. So everything here proposes and nothing decides —
 * the suggestion is pre-filled, shown with its evidence, and overridable per
 * Space before anything is written.
 */

import { CENTERS } from "@/lib/centers";

/** One ClickUp Space as `/plan` describes it. */
export interface SpaceRow {
  space_id: string;
  name: string;
  list_count: number;
  folder_count: number;
  task_count: number;
  assignee_count: number;
  /** A mapping the owner already confirmed on an earlier import. */
  current_mapping?: string | null;
  suggestion?: {
    center?: string | null;
    confidence?: number;
    evidence?: string[];
  } | null;
}

export interface ImportPlan {
  account_id: string;
  workspace_id: string;
  spaces: SpaceRow[];
  total: number;
}

export interface ImportSummary {
  dry_run?: boolean;
  projects: { created: number; already_present: number };
  tasks: { created: number; already_present: number };
  statuses_created: number;
  grants_applied: string[];
  unmapped_spaces: string[];
  parity: Array<{ space: string; clickup_tasks: number }>;
}

/** The Centers a Space may be mapped to, plus the explicit "none". */
export function centerChoices(): Array<{ value: string; label: string }> {
  return [
    { value: "", label: "— import, map to nothing —" },
    ...CENTERS.map((c) => ({ value: c.slug, label: c.name })),
  ];
}

/**
 * The mapping the dialog opens with: `{space_id: center-or-empty}`.
 *
 * A **confirmed** mapping always wins over a fresh suggestion — an owner
 * decision must not be re-litigated by a later plan. Everything else starts
 * from the proposal, which is a starting point and not an answer: it is shown
 * with its evidence precisely so it can be overruled.
 */
export function initialMapping(plan: ImportPlan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const space of plan.spaces) {
    out[space.space_id] =
      space.current_mapping ?? space.suggestion?.center ?? "";
  }
  return out;
}

/** The wire form the import endpoint wants. `""` means "map to nothing". */
export function toMappings(
  mapping: Record<string, string>,
): Array<{ space_id: string; center: string | null }> {
  return Object.entries(mapping).map(([space_id, center]) => ({
    space_id,
    center: center || null,
  }));
}

/**
 * How much to trust a suggestion, in words.
 *
 * A bare `0.62` invites the reader to accept it without looking. Words that
 * say "check this" are the point — the whole reason the mapping is confirmed
 * by a person is that the machine is sometimes wrong.
 */
export function confidenceLabel(confidence: number | undefined): string {
  if (confidence === undefined || Number.isNaN(confidence)) return "no signal";
  if (confidence >= 1) return "confirmed previously";
  if (confidence >= 0.7) return "fairly confident";
  if (confidence >= 0.4) return "a guess — check it";
  return "little signal — check it";
}

/** Totals for the header, so "what is coming from ClickUp" is one glance. */
export function totals(plan: ImportPlan): {
  spaces: number;
  lists: number;
  folders: number;
  tasks: number;
} {
  return plan.spaces.reduce(
    (acc, s) => ({
      spaces: acc.spaces + 1,
      lists: acc.lists + s.list_count,
      folders: acc.folders + s.folder_count,
      tasks: acc.tasks + s.task_count,
    }),
    { spaces: 0, lists: 0, folders: 0, tasks: 0 },
  );
}

/** How many Spaces would land in no Center, given the current choices. */
export function unmappedCount(mapping: Record<string, string>): number {
  return Object.values(mapping).filter((c) => !c).length;
}

/**
 * One sentence for what a run did — or would do.
 *
 * `already_present` is carried, not hidden: re-running an import is the normal
 * case (the upsert is idempotent), and a second run reporting "0 created" with
 * no mention of the 400 rows it matched reads as a failure.
 */
export function describeSummary(summary: ImportSummary): string {
  const verb = summary.dry_run ? "would create" : "created";
  const kept = summary.projects.already_present + summary.tasks.already_present;
  const parts = [
    `${verb} ${summary.projects.created} project${summary.projects.created === 1 ? "" : "s"}`,
    `${summary.tasks.created} task${summary.tasks.created === 1 ? "" : "s"}`,
  ];
  if (summary.statuses_created) {
    parts.push(`${summary.statuses_created} status lanes`);
  }
  const tail = kept ? ` · ${kept} already present, left alone` : "";
  return `${parts.join(", ")}${tail}.`;
}

/**
 * The warning shown before the real run, or null when there is nothing to say.
 *
 * Unmapped Spaces are NOT a blocker — the importer takes them in full and they
 * stay reachable; refusing them would make the mapping a precondition of seeing
 * the data you need in order to decide the mapping. So this is a notice, and
 * saying it as an error would be a lie about what happens next.
 */
export function unmappedNotice(mapping: Record<string, string>): string | null {
  const n = unmappedCount(mapping);
  if (!n) return null;
  return `${n} Space${n === 1 ? "" : "s"} will import with no Center. They stay visible to org-wide readers and to anyone assigned to their tasks, and you can map them later without re-importing.`;
}
