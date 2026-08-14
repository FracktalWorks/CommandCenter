/**
 * People Center · structured skills & credentials, the pure half (WS-28h).
 *
 * Spec: `project-docs/specs/people_center_app.md` §3.3 · D-PC-6.
 *
 * Formatting and editor scaffolding only. **The validation lives on the
 * server** (`gateway/person_skills.py`) and its refusals are shown verbatim —
 * a second validator here would be a second vocabulary waiting to drift, which
 * is the exact shape D-PC-4 forbids for editability. The vocabularies
 * (levels, kinds) arrive on the GET payload for the same reason.
 */

export interface SkillDetail {
  id?: string;
  skill: string;
  level?: string | null;
  years?: number | null;
  last_used_year?: number | null;
  /** `manual` | `resume` | `observed` — the server's words, never restyled. */
  evidence?: string | null;
}

export interface Credential {
  id?: string;
  kind: string;
  title: string;
  issuer?: string | null;
  year_from?: number | null;
  year_to?: number | null;
  detail?: string | null;
  source?: string | null;
}

/** One line under a skill chip: `expert · 8y · used 2026`. Empty when the row
 * carries nothing beyond its name — a chip with a blank subtitle is noise. */
export function describeSkill(row: SkillDetail): string {
  const parts: string[] = [];
  if (row.level) parts.push(row.level);
  if (row.years !== null && row.years !== undefined) {
    parts.push(Number.isInteger(row.years) ? `${row.years}y` : `${row.years}y`);
  }
  if (row.last_used_year) parts.push(`used ${row.last_used_year}`);
  return parts.join(" · ");
}

/** `BTech Mechatronics — IIT Bombay · 2012–2016`. Every part optional, and a
 * missing year never renders as "undefined". */
export function describeCredential(cred: Credential): string {
  let line = cred.title;
  if (cred.issuer) line += ` — ${cred.issuer}`;
  const years = credentialYears(cred);
  if (years) line += ` · ${years}`;
  return line;
}

export function credentialYears(cred: Credential): string {
  if (cred.year_from && cred.year_to) {
    return cred.year_from === cred.year_to
      ? String(cred.year_from)
      : `${cred.year_from}–${cred.year_to}`;
  }
  if (cred.year_from) return `${cred.year_from}–`;
  if (cred.year_to) return String(cred.year_to);
  return "";
}

export const CREDENTIAL_KIND_LABELS: Record<string, string> = {
  education: "Education",
  certification: "Certification",
  prior_role: "Prior role",
};

/**
 * Editor rows for a person who has flat skills but no structured rows yet —
 * a directory that predates migration 175, or a row nobody has enriched. The
 * names seed the editor so "add your levels" starts from what exists instead
 * of an empty table that invites retyping everything.
 */
export function seedRows(
  detail: SkillDetail[] | undefined,
  flat: string[] | undefined
): SkillDetail[] {
  if (detail && detail.length > 0) return detail.map((r) => ({ ...r }));
  return (flat ?? []).map((skill) => ({ skill, evidence: "manual" }));
}

/** A new, empty editor row. */
export function emptySkill(): SkillDetail {
  return { skill: "", level: null, years: null, last_used_year: null };
}

export function emptyCredential(): Credential {
  return { kind: "education", title: "", issuer: null, year_from: null,
           year_to: null };
}

/**
 * The wire shape for a save: drop empty rows (an editor line somebody added
 * and abandoned is not a skill) and blank strings to nulls. Duplicate names
 * are left in — the SERVER refuses them by name, and pre-filtering here would
 * silently pick one of two rows the person typed differently.
 */
export function toWire(rows: SkillDetail[]): SkillDetail[] {
  return rows
    .filter((r) => r.skill.trim().length > 0)
    .map((r) => ({
      skill: r.skill.trim(),
      level: r.level || null,
      years: r.years ?? null,
      last_used_year: r.last_used_year ?? null,
      evidence: r.evidence || null,
    }));
}

export function credentialsToWire(rows: Credential[]): Credential[] {
  return rows
    .filter((r) => r.title.trim().length > 0)
    .map((r) => ({
      kind: r.kind,
      title: r.title.trim(),
      issuer: r.issuer?.trim() || null,
      year_from: r.year_from ?? null,
      year_to: r.year_to ?? null,
      detail: r.detail?.trim() || null,
    }));
}
