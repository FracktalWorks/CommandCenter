// Gateway client for the /tasks API (proxied via /api/tasks/[...path]).
// Mirrors the email app's lib/api.ts: snake_case backend ↔ camelCase UI types.
// The store hydrates from here when the gateway is reachable and silently
// falls back to the bundled mock data when it isn't (UI-first demo mode).

import { GtdItem, GtdProject, Person, Source, ProviderKind, Disposition } from "./types";
import type { ConnectedProvider } from "./mockData";

async function gatewayFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/tasks${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(
      (body as { detail?: string; error?: string }).detail ||
        (body as { error?: string }).error ||
        `Gateway error ${res.status}`
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

function asPerson(v: unknown): Person | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Raw;
  if (!p.name && !p.email) return undefined;
  return {
    name: String(p.name ?? p.email ?? ""),
    email: p.email ? String(p.email) : undefined,
    providerUserId: p.provider_user_id ? String(p.provider_user_id) : undefined,
  };
}

function mapItem(raw: Raw): GtdItem {
  return {
    id: String(raw.id ?? ""),
    source: (raw.source === "SYNCED" ? "SYNCED" : "LOCAL") as Source,
    provider: (raw.provider ?? undefined) as ProviderKind | undefined,
    accountId: raw.account_id ? String(raw.account_id) : undefined,
    title: String(raw.title ?? ""),
    notes: raw.notes ? String(raw.notes) : undefined,
    disposition: String(raw.disposition ?? "INBOX") as Disposition,
    nextAction: raw.next_action ? String(raw.next_action) : undefined,
    context: raw.context ? String(raw.context) : undefined,
    energy: (raw.energy ?? undefined) as GtdItem["energy"],
    timeEstimateMins: raw.time_estimate_mins
      ? Number(raw.time_estimate_mins)
      : undefined,
    isTwoMinute: Boolean(raw.is_two_minute),
    projectId: raw.project_id ? String(raw.project_id) : undefined,
    isMine: Boolean(raw.is_mine ?? true),
    waitingOn: asPerson(raw.waiting_on),
    delegatedAt: raw.delegated_at ? String(raw.delegated_at) : undefined,
    assignee: asPerson(raw.assignee),
    providerStatus: raw.provider_status ? String(raw.provider_status) : undefined,
    providerUrl: raw.provider_url ? String(raw.provider_url) : undefined,
    syncState: (raw.sync_state ?? "local") as GtdItem["syncState"],
    dueAt: raw.due_at ? String(raw.due_at) : undefined,
    isHardDate: Boolean(raw.is_hard_date),
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    completedAt: raw.completed_at ? String(raw.completed_at) : undefined,
    clarifiedAt: raw.clarified_at ? String(raw.clarified_at) : undefined,
    deferUntil: raw.defer_until ? String(raw.defer_until) : undefined,
  };
}

function mapProject(raw: Raw): GtdProject {
  return {
    id: String(raw.id ?? ""),
    source: (raw.source === "SYNCED" ? "SYNCED" : "LOCAL") as Source,
    provider: (raw.provider ?? undefined) as ProviderKind | undefined,
    accountId: raw.account_id ? String(raw.account_id) : undefined,
    outcome: String(raw.outcome ?? ""),
    purpose: raw.purpose ? String(raw.purpose) : undefined,
    status: String(raw.status ?? "ACTIVE") as GtdProject["status"],
    hasNextAction: Boolean(raw.has_next_action),
  };
}

export interface TaskAccount {
  id: string;
  provider: string;
  workspaceId: string;
  label: string;
  syncEnabled: boolean;
  syncStatus: string;
  syncError?: string;
  lastSyncedAt?: string;
  statuses: string[];
  members: Person[];
  projectCount: number;
}

function mapAccount(raw: Raw): TaskAccount {
  return {
    id: String(raw.id ?? ""),
    provider: String(raw.provider ?? ""),
    workspaceId: String(raw.workspace_id ?? ""),
    label: String(raw.label ?? ""),
    syncEnabled: Boolean(raw.sync_enabled ?? true),
    syncStatus: String(raw.sync_status ?? "idle"),
    syncError: raw.sync_error ? String(raw.sync_error) : undefined,
    lastSyncedAt: raw.last_synced_at ? String(raw.last_synced_at) : undefined,
    statuses: Array.isArray(raw.statuses) ? raw.statuses.map(String) : [],
    members: Array.isArray(raw.members)
      ? (raw.members.map(asPerson).filter(Boolean) as Person[])
      : [],
    projectCount: Number(raw.project_count ?? 0),
  };
}

/** Live accounts → the destination entries the Clarify UI renders. */
export function accountToProviderEntry(a: TaskAccount): ConnectedProvider {
  return {
    id: a.id,
    label: a.label || a.provider,
    provider: a.provider as ProviderKind,
    source: "SYNCED",
    statuses: a.statuses,
  };
}

// ── Calls ────────────────────────────────────────────────────────────────────

export async function fetchItems(view = "all"): Promise<GtdItem[]> {
  const rows = await gatewayFetch<Raw[]>(`/items?view=${view}`);
  return rows.map(mapItem);
}

export async function fetchProjects(): Promise<GtdProject[]> {
  const rows = await gatewayFetch<Raw[]>(`/projects`);
  return rows.map(mapProject);
}

export async function fetchAccounts(): Promise<TaskAccount[]> {
  const rows = await gatewayFetch<Raw[]>(`/accounts`);
  return rows.map(mapAccount);
}

/** The org's people (roles/skills/capacity — §6.1), mapped to picker Persons. */
export async function fetchPeople(): Promise<Person[]> {
  const rows = await gatewayFetch<Raw[]>(`/people`);
  return rows
    .map((r) => ({
      name: String(r.name ?? ""),
      email: r.email ? String(r.email) : undefined,
      providerUserId: r.provider_user_id ? String(r.provider_user_id) : undefined,
    }))
    .filter((p) => p.name);
}

export async function apiCapture(title: string, notes?: string): Promise<GtdItem> {
  return mapItem(
    await gatewayFetch<Raw>(`/items`, {
      method: "POST",
      body: JSON.stringify({ title, notes: notes || null }),
    })
  );
}

export async function apiCaptureBatch(titles: string[]): Promise<GtdItem[]> {
  const rows = await gatewayFetch<Raw[]>(`/items/batch`, {
    method: "POST",
    body: JSON.stringify({ titles }),
  });
  return rows.map(mapItem);
}

export async function apiPatchItem(
  id: string,
  patch: {
    title?: string;
    notes?: string;
    disposition?: Disposition;
    defer_until?: string;
    due_at?: string;
  }
): Promise<GtdItem> {
  return mapItem(
    await gatewayFetch<Raw>(`/items/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  );
}

export async function apiBulkDispose(
  ids: string[],
  disposition: Disposition
): Promise<GtdItem[]> {
  const rows = await gatewayFetch<Raw[]>(`/items/bulk`, {
    method: "POST",
    body: JSON.stringify({ ids, disposition }),
  });
  return rows.map(mapItem);
}

export interface OrganizeBody {
  kind: string;
  next_action?: string;
  outcome?: string;
  context?: string;
  energy?: string;
  time_estimate_mins?: number;
  due_at?: string;
  account_id?: string;
  project_id?: string;
  status?: string;
  assignee?: { name: string; email?: string; provider_user_id?: string };
}

export async function apiOrganize(id: string, body: OrganizeBody): Promise<GtdItem> {
  return mapItem(
    await gatewayFetch<Raw>(`/items/${id}/organize`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

export async function apiPushItem(id: string): Promise<GtdItem> {
  return mapItem(await gatewayFetch<Raw>(`/items/${id}/push`, { method: "POST" }));
}

export async function apiDeleteItem(id: string): Promise<void> {
  await gatewayFetch<void>(`/items/${id}`, { method: "DELETE" });
}

export async function apiListWorkspaces(
  provider: string,
  apiToken: string
): Promise<{ id: string; name: string; memberCount: number }[]> {
  const res = await gatewayFetch<Raw>(`/providers/${provider}/workspaces`, {
    method: "POST",
    body: JSON.stringify({ api_token: apiToken }),
  });
  const list = (res.workspaces as Raw[]) ?? [];
  return list.map((w) => ({
    id: String(w.id ?? ""),
    name: String(w.name ?? ""),
    memberCount: Number(w.member_count ?? 0),
  }));
}

export async function apiConnectWorkspace(req: {
  provider: string;
  apiToken: string;
  workspaceId: string;
  label?: string;
}): Promise<TaskAccount> {
  return mapAccount(
    await gatewayFetch<Raw>(`/accounts`, {
      method: "POST",
      body: JSON.stringify({
        provider: req.provider,
        api_token: req.apiToken,
        workspace_id: req.workspaceId,
        label: req.label ?? "",
      }),
    })
  );
}

export async function apiDeleteAccount(id: string): Promise<void> {
  await gatewayFetch<void>(`/accounts/${id}`, { method: "DELETE" });
}

export async function apiRefreshSchema(id: string): Promise<TaskAccount> {
  return mapAccount(
    await gatewayFetch<Raw>(`/accounts/${id}/schema/refresh`, { method: "POST" })
  );
}
