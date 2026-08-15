/**
 * People Center · the rebalancing suggestions, wire types + wording (WS-28j3).
 *
 * Spec: `project-docs/specs/people_center_app.md` §5.7.4 · D-PC-13, D-PC-14.
 *
 * The ranking is the server's (§5.5's ranker × spare hours × availability) and
 * every factor arrives on the row; this module renders the argument. Nothing
 * here re-ranks, and nothing here writes — the assign click goes through
 * `peopleApi.assignHelper`, which is the Projects app's ordinary assignees
 * PUT behind a human's explicit confirm.
 */

export interface Candidate {
  person_id: string | null;
  name: string;
  email: string;
  skill_points: number;
  matched_skills: string[];
  spare_hours: number;
  away?: { kind: string; until: string } | null;
  rank: number;
}

export interface AtRiskSuggestion {
  task_id: string;
  title: string;
  project_name?: string | null;
  due_on?: string | null;
  shortfall_hours?: number | null;
  holder: { person_id?: string | null; name?: string; email?: string | null };
  candidates: Candidate[];
}

export interface PickupTask {
  task_id: string;
  title: string;
  project_name?: string | null;
  kind: "unassigned" | "at_risk_help" | string;
  skill_points: number;
  matched_skills: string[];
  holder?: string | null;
}

export interface PickupSuggestion {
  person_id: string | null;
  name: string;
  email: string;
  tasks: PickupTask[];
}

export interface SuggestionsResponse {
  at_risk: AtRiskSuggestion[];
  pickups: PickupSuggestion[];
  truncated: boolean;
  partial: boolean;
}

/**
 * One candidate as the checkable sentence: the matched skill, then the three
 * factors whose product is the rank — §5.7.4's "shows all three numbers".
 */
export function describeCandidate(c: Candidate): string {
  const skills = c.matched_skills.join(", ") || "match";
  let line = `${skills} ×${c.skill_points} · ${c.spare_hours}h spare`;
  if (c.away) line += ` · away until ${c.away.until}`;
  return `${line} → ${c.rank}`;
}

/** A pickup line: what it is, why them, and whose week it rescues. */
export function describePickup(task: PickupTask): string {
  const parts = [task.matched_skills.join(", ") || "match"];
  if (task.project_name) parts.push(task.project_name);
  if (task.kind === "at_risk_help" && task.holder) {
    parts.push(`helps ${task.holder}`);
  }
  return parts.join(" · ");
}
