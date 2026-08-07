/**
 * People Center · the browser's client for /api/people/*.
 *
 * Read-only, matching the proxy. Writes live on the tasks API under
 * `admin:members:manage` and go through `./write.ts`, not through here.
 *
 * The reads do carry `can_manage` — whether the caller MAY write is a fact
 * about the viewer that only the gateway can answer, and the editor has to
 * know it before it draws rather than discover it on the click.
 */

export interface PersonRow {
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
    }>(`${query ? `?${query}` : ""}`);
  },

  facets: () =>
    call<{
      departments: Array<{ department: string; total: number }>;
      teams: Array<{ department: string; team: string; total: number }>;
      statuses: string[];
    }>("facets"),

  person: (id: string) => call<PersonDetail>(id),

  work: (id: string) =>
    call<{ rows: WorkRow[]; total: number; available: boolean }>(`${id}/work`),
};
