/**
 * People Center · presentation logic for the directory and person page.
 *
 * Spec: `project-docs/specs/people_center_app.md` §3.1, §3.2, §5.2.
 *
 * Pure functions only. The server already decided which rows come back and
 * whether the HR half is filled in; this decides how they read. Keeping the
 * projection server-side and the presentation here is what stops the browser
 * growing a second, weaker answer to "may this person see skills".
 */

import type { PersonDetail, PersonRow } from "./api";

/** How many skills a directory row shows before collapsing into "＋N". */
export const SKILLS_SHOWN = 3;

/**
 * The initials for an avatar fallback.
 *
 * First and last token, so "Vijay Raghav Varada" reads VV rather than VRV —
 * a three-letter monogram in a 24px circle is a smudge.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

export type SkillsState =
  | { kind: "restricted" }
  | { kind: "empty" }
  | { kind: "some"; shown: string[]; more: number };

/**
 * What the skills strip should render — and the distinction §3.1 insists on.
 *
 * "You may not see this" and "nobody filled it in" are different facts, and a
 * blank strip cannot tell them apart. `hrVisible` comes from the server's own
 * statement about what it projected, never from guessing at a null.
 */
export function skillsState(
  skills: readonly string[] | undefined,
  hrVisible: boolean
): SkillsState {
  if (!hrVisible) return { kind: "restricted" };
  const list = (skills ?? []).filter((s) => (s ?? "").trim().length > 0);
  if (list.length === 0) return { kind: "empty" };
  return {
    kind: "some",
    shown: list.slice(0, SKILLS_SHOWN),
    more: Math.max(0, list.length - SKILLS_SHOWN),
  };
}

/**
 * Where a skill came from: typed by a human, or extracted from a résumé.
 *
 * A skill nobody stated and a parser inferred should not look like a claim the
 * person made (§3.2 panel 2). Unknown provenance reads as `resume` rather than
 * `stated`, because over-claiming on someone's behalf is the worse error.
 */
export function skillOrigin(
  skill: string,
  source: Record<string, string> | undefined
): "stated" | "resume" {
  // ⚠️ The backend's word for "a person typed it" is `manual` — written by
  // create_person and every PATCH since WS-24 — and `observed` (derived from
  // shipped work, WS-28h's vocabulary) is likewise not a parser inference.
  // The first version of this matched only the literal "stated", which no
  // write path has ever produced, so every hand-typed skill in the product
  // rendered as "extracted from a résumé" — over-claiming in the OTHER
  // direction from the one the docstring above worries about. Found while
  // WS-28h made evidence a real column; `directory.test.ts` pins each word.
  const evidence = (source ?? {})[skill];
  return evidence === "resume" || evidence === undefined ? "resume" : "stated";
}

export interface LoadBar {
  /** 0-100, clamped. */
  percent: number;
  label: string;
  /** True when the bar is built on nothing and should be drawn as unknown. */
  unknown: boolean;
}

/**
 * The capacity bar (§3.2 panel 3, §5.2).
 *
 * One bar, not three numbers. Load is the **computed** figure — hours from open
 * assigned tasks — not `current_load_hours_per_week`, which is a number
 * somebody typed once and which is stale the moment anyone assigns anything.
 *
 * The honest part is `unestimated`. A task with no estimate contributes zero
 * hours, so a bar built only from the sum would show somebody holding thirty
 * un-estimated tasks as completely free. When nothing is estimated the bar
 * refuses to draw a percentage at all rather than drawing a confident zero.
 */
export function loadBar(person: Pick<PersonDetail, "capacity_hours_per_week" | "load">): LoadBar {
  const capacity = person.capacity_hours_per_week ?? 0;
  const load = person.load;
  if (!load || (load.open_tasks === 0 && capacity <= 0)) {
    return { percent: 0, label: "No capacity data", unknown: true };
  }
  const hours = load.estimated_hours ?? 0;
  const tail =
    load.unestimated > 0 ? ` · ${load.unestimated} with no estimate` : "";
  if (capacity <= 0) {
    return {
      percent: 0,
      label: `${load.open_tasks} open${tail}`,
      unknown: true,
    };
  }
  if (hours === 0 && load.unestimated > 0) {
    // Everything they hold is un-estimated: a 0% bar would read as "free".
    return {
      percent: 0,
      label: `${load.open_tasks} open, none estimated`,
      unknown: true,
    };
  }
  return {
    percent: Math.min(100, Math.round((hours / capacity) * 100)),
    label: `${hours}h of ${capacity}h · ${load.open_tasks} open${tail}`,
    unknown: false,
  };
}

/**
 * Group directory rows by department for the list's section headers.
 *
 * People with no department land in one trailing group rather than being
 * dropped — a directory that quietly omits somebody is worse than one with an
 * untidy last section.
 */
export const NO_DEPARTMENT = "Unassigned";

export function groupByDepartment(
  rows: readonly PersonRow[]
): Array<{ department: string; people: PersonRow[] }> {
  const groups = new Map<string, PersonRow[]>();
  for (const row of rows) {
    const key = (row.department ?? "").trim() || NO_DEPARTMENT;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  const named = [...groups.entries()]
    .filter(([d]) => d !== NO_DEPARTMENT)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const rest = groups.get(NO_DEPARTMENT);
  return [
    ...named.map(([department, people]) => ({ department, people })),
    ...(rest ? [{ department: NO_DEPARTMENT, people: rest }] : []),
  ];
}

/** The pill styling class for a status, so the vocabulary lives in one place. */
export function statusTone(status: string): "active" | "muted" | "warn" {
  switch (status) {
    case "active":
      return "active";
    case "contractor":
    case "invited":
      return "warn";
    default:
      return "muted";
  }
}
