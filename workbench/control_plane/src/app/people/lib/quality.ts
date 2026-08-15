/**
 * People Center · skills coverage & data quality, wire types + wording
 * (WS-28m).
 *
 * Spec: `project-docs/specs/people_center_app.md` §5.10 · D-PC-13, D-PC-14.
 *
 * Every list here is a defect in the RECORD, never in a person: the server
 * sends them alphabetical and this module keeps them that way — no score, no
 * sort, no "worst profile". And nothing here writes: each row links to the
 * record's own surface, where fixing it happens under that surface's own
 * authorization.
 */

export interface PersonRef {
  id: string;
  name: string;
}

export interface SingleHolderSkill {
  skill: string;
  person: PersonRef;
}

export interface TitleTerm {
  term: string;
  people: string[];
}

export interface UnusedSkill {
  skill: string;
  holders: number;
}

export interface ConflictRow {
  id: string;
  name: string;
  email_conflict: string;
}

export interface BadStatusRow {
  id: string;
  name: string;
  status: string;
}

export interface ManagerAlumniRow {
  id: string;
  name: string;
  manager_name: string;
}

export interface MissingFieldsRow {
  id: string;
  name: string;
  missing: string[];
}

export interface Coverage {
  single_holder: SingleHolderSkill[];
  title_terms: TitleTerm[];
  unused_skills: UnusedSkill[];
  tasks_scanned: number;
  tasks_partial: boolean;
  scope_partial: boolean;
  scan_ran: boolean;
  scan_error: boolean;
}

export interface Quality {
  no_email: PersonRef[];
  email_conflict: ConflictRow[];
  bad_status: BadStatusRow[];
  manager_alumni: ManagerAlumniRow[];
  no_manager: PersonRef[];
  missing_ai_fields: MissingFieldsRow[];
}

export interface QualityResponse {
  coverage: Coverage;
  quality: Quality;
  counts: Record<string, number>;
  truncated: boolean;
}

/**
 * What the "never used on a task" claim actually rests on — an unused-skill
 * finding over no scan, a failed scan, a sample, or somebody else's slice is
 * a different claim each time, and the panel must say which one it is making.
 * Four states, four sentences; none may draw as another.
 */
export function describeScan(c: Coverage): string {
  if (c.scan_error) {
    return "The task scan failed — nothing here claims a skill is unused. The error is logged server-side.";
  }
  if (!c.scan_ran) {
    return "The task scan did not run — it needs declared skills and access to the Projects app.";
  }
  if (c.tasks_scanned === 0) {
    return "No visible tasks to check against, so nothing here claims a skill is unused.";
  }
  let line = `Checked against ${c.tasks_scanned.toLocaleString()} task titles (done work included — historical use counts)`;
  if (c.tasks_partial) line += ", newest only — the scan hit its cap";
  if (c.scope_partial) line += ", within the projects you can see";
  return `${line}.`;
}

/** "Showing 50 of 87" when a list was capped; null when it was not. */
export function overflow(shown: number, total: number): string | null {
  return total > shown ? `Showing ${shown} of ${total}` : null;
}

/** The missing AI-relevant fields as the sentence the person can act on. */
export function describeMissing(row: MissingFieldsRow): string {
  const names: Record<string, string> = {
    timezone: "timezone",
    working_hours: "working hours",
    skills: "skills",
  };
  return row.missing.map((f) => names[f] ?? f).join(", ");
}
