/**
 * People Center · the browser's client for /api/people/*.
 *
 * Reads, plus the **self-service** write door WS-28g added (`PATCH /people/{id}`
 * and the CV upload). The ADMIN write path is unchanged and still goes through
 * `./write.ts` to `/api/tasks/people` — see that file's header for why the two
 * doors exist and why there is still only one write implementation behind them.
 *
 * The reads carry `can_manage`, `is_self` and `editable_fields`. Whether the
 * caller may write, and *which fields*, is a fact only the gateway can answer,
 * and the editor has to know it before it draws rather than discover it from a
 * 403 after the click (D-PC-4).
 */

/** The §3.1 half of a person that every `feature:people` holder may read. */
export interface PersonProfileFields {
  preferred_name?: string | null;
  pronouns?: string | null;
  location?: string | null;
  timezone?: string | null;
  working_hours?: Record<string, unknown> | null;
  bio?: string | null;
  links?: Record<string, string> | null;
  languages?: string[];
  /** HR tier (§3.2) — null-projected without `admin:members:read` or self. */
  employee_id?: string | null;
  employment_type?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  seniority?: string | null;
  cost_center?: string | null;
  interests?: string[];
  max_concurrent_tasks?: number | null;
  /** Private tier (§3.5) — self or `admin:members:manage` only (D-PC-3). */
  phone?: string | null;
  emergency_contact?: Record<string, string> | null;
  personal_email?: string | null;
  /** `MM-DD`. Never a date of birth (D-PC-9). */
  birthday?: string | null;
}

export interface PersonRow extends PersonProfileFields {
  id: string;
  name: string;
  email?: string | null;
  role?: string | null;
  title?: string | null;
  department?: string | null;
  team?: string | null;
  status: string;
  manager_id?: string | null;
  /** Null-projected without `admin:members:read` — see `hrVisible`. */
  skills?: string[];
  skills_source?: Record<string, string>;
  resume_summary?: string | null;
  years_experience?: number | null;
  capacity_hours_per_week?: number | null;
  current_load_hours_per_week?: number | null;
  available_hours_per_week?: number | null;
}

export interface PersonDetail extends PersonRow {
  has_login: boolean;
  email_conflict?: string | null;
  manager?: string | null;
  /** The ClickUp link — read under this name, written as `clickup_user_id`. */
  provider_user_id?: string | null;
  hr_visible: boolean;
  can_manage: boolean;
  /** True when this row is the caller's own (D-PC-1). */
  is_self?: boolean;
  /**
   * The effective work schedule (WS-28p) — org policy with this person's
   * override applied, `source` naming which layer decided each field. Computed
   * by the server; the client never recombines the two halves.
   */
  schedule?: import("./schedule").EffectiveSchedule | null;
  /** Derived from that schedule (D-PC-18). Null without the HR tier. */
  contracted_hours_per_week?: number | null;
  /** Set when the hand-typed capacity disagrees with the derived figure. */
  capacity_conflict?: number | null;
  /**
   * Which fields THIS caller may write on THIS row — the server's answer, and
   * the only one the UI is allowed to have. An empty array means read-only,
   * and read-only means the controls are ABSENT, never disabled.
   */
  editable_fields?: string[];
  load?: {
    open_tasks: number;
    estimated_hours: number;
    unestimated: number;
  } | null;
}

export interface WorkRow {
  id: string;
  title: string;
  task_number?: number | null;
  due_at?: string | null;
  project_id?: string | null;
  project_name?: string | null;
  status_name: string;
  status_category: string;
}

export class PeopleApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "PeopleApiError";
  }
}

async function call<T>(path: string): Promise<T> {
  const res = await fetch(`/api/people/${path}`);
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new PeopleApiError(
      body?.detail ?? `Request failed (${res.status})`,
      res.status
    );
  }
  return body as T;
}

export const peopleApi = {
  directory: (params: Record<string, string | boolean | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "" && value !== false) {
        qs.set(key, String(value));
      }
    }
    const query = qs.toString();
    return call<{
      rows: PersonRow[];
      total: number;
      hr_visible: boolean;
      can_manage: boolean;
      /** Which row is the caller's, if any — the link target for "my profile". */
      self_person_id?: string | null;
    }>(`${query ? `?${query}` : ""}`);
  },

  /** The company's working week, plus whether this caller may edit it. */
  schedule: () =>
    call<{
      policy: import("./schedule").WorkPolicy;
      defaults: import("./schedule").WorkPolicy;
      contracted_hours_per_week: number;
      can_manage: boolean;
      updated_by?: string | null;
      updated_at?: string | null;
    }>("schedule"),

  /**
   * Save the policy — or, with `dryRun`, ask what it WOULD move and write
   * nothing. The settings page previews before it applies, because this figure
   * is the denominator of every load bar in the org.
   */
  saveSchedule: async (
    policy: import("./schedule").WorkPolicy,
    dryRun: boolean
  ) => {
    const res = await fetch("/api/people/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy, dry_run: dryRun }),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new PeopleApiError(
        parsed?.detail ?? `Request failed (${res.status})`,
        res.status
      );
    }
    return parsed as {
      policy: import("./schedule").WorkPolicy;
      impact: import("./schedule").PolicyImpact;
      saved: boolean;
    };
  },

  facets: () =>
    call<{
      departments: Array<{ department: string; total: number }>;
      teams: Array<{ department: string; team: string; total: number }>;
      statuses: string[];
    }>("facets"),

  person: (id: string) => call<PersonDetail>(id),

  /**
   * The caller's own row — or WHY there isn't one (§5.3).
   *
   * Three states, kept apart deliberately: `no_directory_row` (nobody carries
   * your address; an admin can fix it) and `no_identity` (you are signed in
   * without an address) are different problems with different fixes, and an
   * empty form would report neither.
   */
  me: () =>
    call<{
      state: "resolved" | "no_directory_row" | "no_identity";
      email?: string | null;
      person?: PersonDetail | null;
      detail?: string | null;
    }>("me"),

  /**
   * Save a person through the SELF-SERVICE door.
   *
   * Sends only the keys the caller changed. The gateway answers 403 naming any
   * field outside their write classes and applies NOTHING (D-PC-5) — so a
   * partial save is impossible, and the message is shown verbatim because it is
   * the only form of it anyone can act on.
   *
   * `target` is the literal string `"me"` for your own row, or a person id for
   * somebody else's. They are DIFFERENT endpoints, not a convenience alias:
   * `/people/me` is served by a router with no feature gate, because the
   * directory is gated and your own row is not (D-PC-15). Callers pick by
   * `is_self`, so a colleague with no `feature:people` still saves.
   */
  update: async (target: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/people/${target}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new PeopleApiError(
        parsed?.detail ?? `Request failed (${res.status})`,
        res.status
      );
    }
    return parsed as PersonDetail;
  },

  /**
   * Upload one's own CV. No `Content-Type` header — the browser sets it so the
   * multipart boundary matches the body it generated, and the proxy forwards
   * both unchanged.
   */
  uploadResume: async (target: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/people/${target}/resume`, {
      method: "POST",
      body: form,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new PeopleApiError(
        parsed?.detail ?? `Upload failed (${res.status})`,
        res.status
      );
    }
    return parsed as {
      resume_id: string;
      added_skills: string[];
      person: PersonDetail;
    };
  },

  work: (id: string) =>
    call<{ rows: WorkRow[]; total: number; available: boolean }>(`${id}/work`),
};
