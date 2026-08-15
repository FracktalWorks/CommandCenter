/**
 * People Center · the Center landing rollup, wire types + wording (WS-28l).
 *
 * Spec: `project-docs/specs/people_center_app.md` §5.9 · D-PC-14.
 *
 * The server already refused to compute anything twice — the load half is the
 * workload dashboard's own rollup and the quality half is §5.10's counts,
 * both verbatim — so this module only arranges: the headcount GROUP BY as a
 * matrix, and the quality counts as one sentence. Nothing here re-sorts,
 * re-counts or scores.
 */

import type { Rollup } from "./dashboard";

export interface HeadcountRow {
  department: string;
  status: string;
  count: number;
}

export interface OverviewResponse {
  headcount: HeadcountRow[];
  total_people: number;
  departments: Rollup[];
  org: Rollup;
  quality_counts: Record<string, number>;
  roots: { id: string; name: string }[];
  partial: boolean;
  work_visible: boolean;
}

export interface HeadcountMatrix {
  departments: string[];
  statuses: string[];
  cell: (department: string, status: string) => number;
  departmentTotal: (department: string) => number;
  statusTotal: (status: string) => number;
}

/** The status columns in vocabulary order; anything legacy renders after. */
const STATUS_ORDER = ["active", "contractor", "invited", "alumni"];

export function headcountMatrix(rows: HeadcountRow[]): HeadcountMatrix {
  const departments = [...new Set(rows.map((r) => r.department))];
  const seen = [...new Set(rows.map((r) => r.status))];
  const statuses = [
    ...STATUS_ORDER.filter((s) => seen.includes(s)),
    ...seen.filter((s) => !STATUS_ORDER.includes(s)),
  ];
  const key = (d: string, s: string) => `${d}\0${s}`;
  const cells = new Map(rows.map((r) => [key(r.department, r.status), r.count]));
  return {
    departments,
    statuses,
    cell: (d, s) => cells.get(key(d, s)) ?? 0,
    departmentTotal: (d) =>
      rows.filter((r) => r.department === d).reduce((a, r) => a + r.count, 0),
    statusTotal: (s) =>
      rows.filter((r) => r.status === s).reduce((a, r) => a + r.count, 0),
  };
}

/** Which quality counts deserve the landing page, and in what words. */
const QUALITY_LABELS: [string, string, string][] = [
  ["email_conflict", "quarantined address", "quarantined addresses"],
  ["no_email", "person without email", "people without email"],
  ["bad_status", "status outside the vocabulary", "statuses outside the vocabulary"],
  ["manager_alumni", "manager who left", "managers who left"],
  ["missing_ai_fields", "incomplete profile", "incomplete profiles"],
];

/**
 * The §5.10 counts as one sentence, zeros omitted — or null when the record
 * is clean, so the landing can say so instead of listing five zeros.
 */
export function describeQuality(counts: Record<string, number>): string | null {
  const parts = QUALITY_LABELS.filter(([k]) => (counts[k] ?? 0) > 0).map(
    ([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`
  );
  return parts.length ? parts.join(" · ") : null;
}
