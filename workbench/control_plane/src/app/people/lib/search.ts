/**
 * People Center · capability search, the pure half (WS-28d).
 *
 * Spec: `project-docs/specs/people_center_app.md` §5.5 · D-PC-13.
 *
 * Formatting only. **The ranking is the server's** — deterministic arithmetic
 * with named weights, no LLM prompt (that is what keeps it outside §5.5's
 * eval lock) — and every signal arrives with its own points, so this module's
 * whole job is to render the argument legibly, never to re-rank.
 */

export interface SearchSignal {
  kind: "skill" | "domain" | "resume" | "semantic" | string;
  points: number;
  skill?: string;
  level?: string | null;
  last_used_year?: number | null;
  evidence?: string | null;
  domain?: string;
  quote?: string;
  cosine?: number;
}

export interface CapabilityResult {
  person_id: string;
  name: string;
  /** The assignee value "Assign to…" hands to the task flow (§6.4). */
  email?: string | null;
  title?: string | null;
  department?: string | null;
  avatar?: string | null;
  score: number;
  signals: SearchSignal[];
  load?: {
    open_tasks: number;
    estimated_hours: number;
    unestimated: number;
  } | null;
  contracted_hours?: number | null;
  away?: { kind: string; until: string } | null;
  timezone?: string | null;
  warnings: string[];
}

export interface CapabilityResponse {
  q: string;
  rows: CapabilityResult[];
  total: number;
  semantic_available: boolean;
}

/** One signal, as the sentence a reader can check: the fact, then its points. */
export function describeSignal(signal: SearchSignal): string {
  const pts = `+${signal.points}`;
  switch (signal.kind) {
    case "skill": {
      const parts = [signal.skill ?? "skill"];
      if (signal.level) parts.push(signal.level);
      if (signal.last_used_year) parts.push(`used ${signal.last_used_year}`);
      if (signal.evidence === "resume") parts.push("from CV");
      return `${parts.join(" · ")} (${pts})`;
    }
    case "domain":
      return `their field: ${signal.domain} (${pts})`;
    case "resume":
      return `CV: “${signal.quote}” (${pts})`;
    case "semantic":
      return `related work, similarity ${signal.cosine} (${pts})`;
    default:
      return `${signal.kind} (${pts})`;
  }
}

/**
 * The load line beside a result — committed hours against contracted, with
 * the unestimated caveat the People surfaces always carry: a sum over
 * un-estimated tasks is a confident number built on missing data.
 */
export function describeResultLoad(result: CapabilityResult): string {
  const load = result.load;
  if (!load) return "";
  const parts = [`${load.open_tasks} open`];
  if (load.estimated_hours > 0 || result.contracted_hours) {
    const contracted = result.contracted_hours
      ? ` of ${result.contracted_hours}h`
      : "";
    parts.push(`${load.estimated_hours}h${contracted} committed`);
  }
  if (load.unestimated > 0) {
    parts.push(`${load.unestimated} with no estimate`);
  }
  return parts.join(" · ");
}

/**
 * Sorted as received. Deliberately exported as a pass-through with a name:
 * the server's order IS the ranking, and a client-side `sort()` here would be
 * a second ranker — the exact drift §5.5 exists to prevent. The function
 * exists so the intent is visible where a sort would otherwise creep in.
 */
export function rankedRows(res: CapabilityResponse): CapabilityResult[] {
  return res.rows;
}
