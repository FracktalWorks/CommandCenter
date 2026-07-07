// Gateway client for the /tasks API (proxied via /api/tasks/[...path]).
// Mirrors the email app's lib/api.ts: snake_case backend ↔ camelCase UI types.
// The store hydrates from here when the gateway is reachable and silently
// falls back to the bundled mock data when it isn't (UI-first demo mode).

import { GtdItem, GtdProject, Person, Source, ProviderKind, Disposition, TaskAttachment, WorkspaceHierarchySpace } from "./types";
import type { ClarifyProposal, ClarifyDisposition, Confidence } from "./clarify";
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
    workflowStage: raw.workflow_stage ? String(raw.workflow_stage) : undefined,
    sortKey: raw.sort_key == null ? undefined : Number(raw.sort_key),
    parentItemId: raw.parent_item_id ? String(raw.parent_item_id) : undefined,
    subtaskCount: raw.subtask_count == null ? 0 : Number(raw.subtask_count),
    archivedAt: raw.archived_at ? String(raw.archived_at) : undefined,
    providerUrl: raw.provider_url ? String(raw.provider_url) : undefined,
    syncState: (raw.sync_state ?? "local") as GtdItem["syncState"],
    dueAt: raw.due_at ? String(raw.due_at) : undefined,
    isHardDate: Boolean(raw.is_hard_date),
    createdAt: String(raw.created_at ?? ""),
    attachments: Array.isArray(raw.attachments)
      ? (raw.attachments as TaskAttachment[])
      : undefined,
    origin: raw.origin && typeof raw.origin === "object"
      ? {
          kind: String((raw.origin as Raw).kind ?? ""),
          accountId: (raw.origin as Raw).account_id ? String((raw.origin as Raw).account_id) : undefined,
          emailId: (raw.origin as Raw).email_id ? String((raw.origin as Raw).email_id) : undefined,
          subject: (raw.origin as Raw).subject ? String((raw.origin as Raw).subject) : undefined,
          fromName: (raw.origin as Raw).from_name ? String((raw.origin as Raw).from_name) : undefined,
          fromEmail: (raw.origin as Raw).from_email ? String((raw.origin as Raw).from_email) : undefined,
        }
      : undefined,
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
    providerRef: raw.provider_ref ? String(raw.provider_ref) : undefined,
    spaceId: raw.space_id ? String(raw.space_id) : undefined,
    folderId: raw.folder_id ? String(raw.folder_id) : undefined,
    outcome: String(raw.outcome ?? ""),
    purpose: raw.purpose ? String(raw.purpose) : undefined,
    status: String(raw.status ?? "ACTIVE") as GtdProject["status"],
    hasNextAction: Boolean(raw.has_next_action),
  };
}

export interface TaskAccount {
  id: string;
  provider: string;
  hierarchy: WorkspaceHierarchySpace[];
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
    hierarchy: Array.isArray(raw.hierarchy) ? (raw.hierarchy as WorkspaceHierarchySpace[]) : [],
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

export async function fetchItems(
  view = "all",
  source: "" | "local" | "synced" = "",
): Promise<GtdItem[]> {
  const qs = source ? `?view=${view}&source=${source}` : `?view=${view}`;
  const rows = await gatewayFetch<Raw[]>(`/items${qs}`);
  return rows.map(mapItem);
}

// ── Rich provider detail (comments / attachments / subtasks) ────────────────

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAtMs?: number;
}
export interface TaskSubtask {
  providerTaskId: string;
  title: string;
  status?: string;
  statusType?: string;
  providerUrl?: string;
  assignees: Person[];
}
export interface ProviderTaskDetail {
  comments: TaskComment[];
  attachments: TaskAttachment[];
  subtasks: TaskSubtask[];
  error?: string;
}

/** Pull the connected tool's comments/attachments/subtasks for one task.
 *  Returns empty sections for a LOCAL / not-yet-pushed item. */
export async function apiItemDetail(id: string): Promise<ProviderTaskDetail> {
  const r = await gatewayFetch<Raw>(`/items/${id}/detail`);
  const asPersonList = (v: unknown): Person[] =>
    Array.isArray(v)
      ? (v.map(asPerson).filter(Boolean) as Person[])
      : [];
  return {
    comments: (Array.isArray(r.comments) ? r.comments : []).map((c) => {
      const raw = c as Raw;
      return {
        id: String(raw.id ?? ""),
        author: String(raw.author ?? "Someone"),
        text: String(raw.text ?? ""),
        createdAtMs: raw.created_at_ms ? Number(raw.created_at_ms) : undefined,
      };
    }),
    attachments: (Array.isArray(r.attachments) ? r.attachments : []).map((a) => {
      const raw = a as Raw;
      return {
        kind: "link" as const,
        name: String(raw.name ?? "attachment"),
        url: String(raw.url ?? ""),
        mime: raw.mime ? String(raw.mime) : undefined,
        size: raw.size ? Number(raw.size) : undefined,
      };
    }),
    subtasks: (Array.isArray(r.subtasks) ? r.subtasks : []).map((s) => {
      const raw = s as Raw;
      return {
        providerTaskId: String(raw.provider_task_id ?? ""),
        title: String(raw.title ?? "Untitled"),
        status: raw.status ? String(raw.status) : undefined,
        statusType: raw.status_type ? String(raw.status_type) : undefined,
        providerUrl: raw.provider_url ? String(raw.provider_url) : undefined,
        assignees: asPersonList(raw.assignees),
      };
    }),
    error: r.error ? String(r.error) : undefined,
  };
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

export async function apiCapture(
  title: string,
  notes?: string,
  attachments?: TaskAttachment[]
): Promise<GtdItem> {
  return mapItem(
    await gatewayFetch<Raw>(`/items`, {
      method: "POST",
      body: JSON.stringify({
        title,
        notes: notes ?? null,
        attachments:
          attachments && attachments.length > 0
            ? attachments.map((a) => ({
                kind: a.kind,
                name: a.name,
                url: a.url,
                attachment_id: a.attachmentId ?? null,
                mime: a.mime ?? null,
                size: a.size ?? null,
              }))
            : null,
      }),
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
    next_action?: string;
    context?: string;
    energy?: string;
    time_estimate_mins?: number;
    due_at?: string;
    provider_status?: string;
    workflow_stage?: string;
    sort_key?: number;
    assignee?: { name: string; email?: string; provider_user_id?: string };
    clear_assignee?: boolean;
    is_mine?: boolean;
  }
): Promise<GtdItem> {
  return mapItem(
    await gatewayFetch<Raw>(`/items/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  );
}

/** Archive (hide from active views) or un-archive a task. */
export async function apiArchiveItem(
  id: string,
  archived: boolean,
): Promise<GtdItem> {
  return mapItem(
    await gatewayFetch<Raw>(`/items/${id}/archive`, {
      method: "POST",
      body: JSON.stringify({ archived }),
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
  subtasks?: string[];
}

export async function apiOrganize(id: string, body: OrganizeBody): Promise<GtdItem> {
  return mapItem(
    await gatewayFetch<Raw>(`/items/${id}/organize`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

/** The child subtasks of a task (local rows), in manual order. */
export async function apiListSubtasks(id: string): Promise<GtdItem[]> {
  const rows = await gatewayFetch<Raw[]>(`/items/${id}/subtasks`);
  return rows.map(mapItem);
}

/** Add child subtasks to an existing task; returns the full ordered child list. */
export async function apiAddSubtasks(
  id: string,
  titles: string[],
): Promise<GtdItem[]> {
  const rows = await gatewayFetch<Raw[]>(`/items/${id}/subtasks`, {
    method: "POST",
    body: JSON.stringify({ titles }),
  });
  return rows.map(mapItem);
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

/** LIVE workspace-member pull — the delegate picker's freshness call.
 *  People removed in the tool disappear from the returned account. */
export async function apiRefreshMembers(id: string): Promise<TaskAccount> {
  return mapAccount(
    await gatewayFetch<Raw>(`/accounts/${id}/members/refresh`, { method: "POST" })
  );
}

/** Create a NEW project (ClickUp list) under a space/folder — an explicit
 *  user-approved provider write from the picker's "create project" action. */
export async function apiCreateAccountProject(
  accountId: string,
  req: { name: string; spaceId: string; folderId?: string }
): Promise<{ projectId: string; providerRef: string; name: string }> {
  const r = await gatewayFetch<Raw>(`/accounts/${accountId}/projects`, {
    method: "POST",
    body: JSON.stringify({
      name: req.name,
      space_id: req.spaceId,
      folder_id: req.folderId ?? null,
    }),
  });
  return {
    projectId: String(r.project_id ?? ""),
    providerRef: String(r.provider_ref ?? ""),
    name: String(r.name ?? req.name),
  };
}

// ── Local hierarchy (Spaces → Folders → Projects) ───────────────────────────

export interface LocalSpace {
  id: string;
  name: string;
}
export interface LocalFolder {
  id: string;
  spaceId: string;
  name: string;
}
export interface LocalProjectNode {
  id: string;
  outcome: string;
  spaceId?: string;
  folderId?: string;
  hasNextAction: boolean;
  status: string;
}
export interface LocalHierarchy {
  spaces: LocalSpace[];
  folders: LocalFolder[];
  projects: LocalProjectNode[];
}

/** The LOCAL Space→Folder→Project tree (SYNCED projects live on their account
 *  hierarchy, not here). */
export async function fetchLocalHierarchy(): Promise<LocalHierarchy> {
  const r = await gatewayFetch<Raw>(`/hierarchy`);
  return {
    spaces: ((r.spaces as Raw[]) ?? []).map((s) => ({
      id: String(s.id ?? ""),
      name: String(s.name ?? ""),
    })),
    folders: ((r.folders as Raw[]) ?? []).map((f) => ({
      id: String(f.id ?? ""),
      spaceId: String(f.space_id ?? ""),
      name: String(f.name ?? ""),
    })),
    projects: ((r.projects as Raw[]) ?? []).map((p) => ({
      id: String(p.id ?? ""),
      outcome: String(p.outcome ?? ""),
      spaceId: p.space_id ? String(p.space_id) : undefined,
      folderId: p.folder_id ? String(p.folder_id) : undefined,
      hasNextAction: Boolean(p.has_next_action),
      status: String(p.status ?? "ACTIVE"),
    })),
  };
}

export async function apiCreateSpace(name: string): Promise<LocalSpace> {
  const r = await gatewayFetch<Raw>(`/spaces`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return { id: String(r.id ?? ""), name: String(r.name ?? name) };
}

export async function apiCreateFolder(
  spaceId: string,
  name: string,
): Promise<LocalFolder> {
  const r = await gatewayFetch<Raw>(`/folders`, {
    method: "POST",
    body: JSON.stringify({ space_id: spaceId, name }),
  });
  return {
    id: String(r.id ?? ""),
    spaceId: String(r.space_id ?? spaceId),
    name: String(r.name ?? name),
  };
}

export async function apiCreateLocalProject(req: {
  outcome: string;
  spaceId?: string;
  folderId?: string;
  purpose?: string;
}): Promise<LocalProjectNode> {
  const r = await gatewayFetch<Raw>(`/local-projects`, {
    method: "POST",
    body: JSON.stringify({
      outcome: req.outcome,
      space_id: req.spaceId ?? null,
      folder_id: req.folderId ?? null,
      purpose: req.purpose ?? null,
    }),
  });
  return {
    id: String(r.id ?? ""),
    outcome: String(r.outcome ?? req.outcome),
    spaceId: r.space_id ? String(r.space_id) : undefined,
    folderId: r.folder_id ? String(r.folder_id) : undefined,
    hasNextAction: Boolean(r.has_next_action),
    status: String(r.status ?? "ACTIVE"),
  };
}

/** Upload one attachment (multipart through the proxy) → descriptor for the
 *  capture payload. */
export async function apiUploadAttachment(file: File): Promise<TaskAttachment> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch(`/api/tasks/attachments`, { method: "POST", body: fd });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { detail?: string }).detail || `Upload failed (${res.status})`
    );
  }
  const r = (await res.json()) as Raw;
  return {
    kind: (r.kind === "image" ? "image" : "file") as TaskAttachment["kind"],
    name: String(r.name ?? file.name),
    url: String(r.url ?? ""),
    attachmentId: r.attachment_id ? String(r.attachment_id) : undefined,
    mime: r.mime ? String(r.mime) : undefined,
    size: r.size != null ? Number(r.size) : undefined,
  };
}

export interface TaskSettings {
  chatModel: string;
  clarifyModel: string;
  atomizeModel: string;
  emailCaptureModel: string;
  captureDedup: boolean;
  autoSyncOnOpen: boolean;
  clarifyUseLlm: boolean;
  backgroundSync: boolean;
  mirrorDoneTasks: boolean;
  workflowStages: string[];
}

function mapSettings(r: Raw): TaskSettings {
  return {
    chatModel: String(r.chat_model ?? "tier-powerful"),
    clarifyModel: String(r.clarify_model ?? "tier-balanced"),
    atomizeModel: String(r.atomize_model ?? "tier-fast"),
    emailCaptureModel: String(r.email_capture_model ?? "tier-fast"),
    captureDedup: r.capture_dedup !== false,
    autoSyncOnOpen: r.auto_sync_on_open !== false,
    clarifyUseLlm: r.clarify_use_llm !== false,
    backgroundSync: r.background_sync !== false,
    mirrorDoneTasks: r.mirror_done_tasks === true,
    workflowStages: Array.isArray(r.workflow_stages)
      ? (r.workflow_stages as unknown[]).map(String).filter(Boolean)
      : ["TODO", "IN PROCESS", "WAITING FOR", "DONE"],
  };
}

export async function fetchTaskSettings(): Promise<TaskSettings> {
  return mapSettings(await gatewayFetch<Raw>(`/settings`));
}

/** Partial update — only the provided fields change. */
export async function updateTaskSettings(
  patch: Partial<TaskSettings>
): Promise<TaskSettings> {
  const body: Raw = {};
  if (patch.chatModel !== undefined) body.chat_model = patch.chatModel;
  if (patch.clarifyModel !== undefined) body.clarify_model = patch.clarifyModel;
  if (patch.atomizeModel !== undefined) body.atomize_model = patch.atomizeModel;
  if (patch.emailCaptureModel !== undefined)
    body.email_capture_model = patch.emailCaptureModel;
  if (patch.captureDedup !== undefined) body.capture_dedup = patch.captureDedup;
  if (patch.autoSyncOnOpen !== undefined)
    body.auto_sync_on_open = patch.autoSyncOnOpen;
  if (patch.clarifyUseLlm !== undefined)
    body.clarify_use_llm = patch.clarifyUseLlm;
  if (patch.backgroundSync !== undefined)
    body.background_sync = patch.backgroundSync;
  if (patch.mirrorDoneTasks !== undefined)
    body.mirror_done_tasks = patch.mirrorDoneTasks;
  if (patch.workflowStages !== undefined)
    body.workflow_stages = patch.workflowStages;
  return mapSettings(
    await gatewayFetch<Raw>(`/settings`, {
      method: "PUT",
      body: JSON.stringify(body),
    })
  );
}

export interface SyncResult {
  accountId: string;
  label: string;
  pulled: number;
  created: number;
  updated: number;
  completed: number;
  skipped: number;
  error?: string;
}

/** Pull existing provider tasks into the GTD mirror (one account, or all). */
export async function apiSyncTasks(opts?: {
  accountId?: string;
  full?: boolean;
}): Promise<SyncResult[]> {
  const res = await gatewayFetch<Raw[]>(`/sync`, {
    method: "POST",
    body: JSON.stringify({
      account_id: opts?.accountId ?? null,
      full: opts?.full ?? false,
    }),
  });
  return (res ?? []).map((r) => ({
    accountId: String(r.account_id ?? ""),
    label: String(r.label ?? ""),
    pulled: Number(r.pulled ?? 0),
    created: Number(r.created ?? 0),
    updated: Number(r.updated ?? 0),
    completed: Number(r.completed ?? 0),
    skipped: Number(r.skipped ?? 0),
    error: r.error ? String(r.error) : undefined,
  }));
}

/** Server-side AI clarify proposal for one inbox item (§2.2 agent seam).
 *  Richer than the local heuristic: org-knowledge capability matching
 *  (people skills + availability), server project auto-match, and the
 *  destination/stage defaults. Same shape as lib/clarify.ts's proposal. */
export interface AtomizedItem {
  title: string;
  verdict: "new" | "similar" | "duplicate";
  matchId?: string;
  matchTitle?: string;
  matchDisposition?: string;
  score: number;
}

/** Split a mind-dump / paragraph into atomic captures, each checked against
 *  the user's open items for duplicates (LLM-backed server-side, with a
 *  deterministic fallback — the caller shouldn't care which ran). */
export async function apiAtomize(
  text: string,
  opts?: { dedup?: boolean; excludeIds?: string[] }
): Promise<{ items: AtomizedItem[]; usedLlm: boolean }> {
  const res = await gatewayFetch<Raw>(`/ai/atomize`, {
    method: "POST",
    body: JSON.stringify({
      text,
      dedup: opts?.dedup ?? true,
      exclude_ids: opts?.excludeIds ?? [],
    }),
  });
  const items = ((res.items as Raw[]) ?? []).map((r) => ({
    title: String(r.title ?? ""),
    verdict: (["new", "similar", "duplicate"].includes(String(r.verdict))
      ? String(r.verdict)
      : "new") as AtomizedItem["verdict"],
    matchId: r.match_id ? String(r.match_id) : undefined,
    matchTitle: r.match_title ? String(r.match_title) : undefined,
    matchDisposition: r.match_disposition ? String(r.match_disposition) : undefined,
    score: Number(r.score ?? 0),
  }));
  return { items, usedLlm: Boolean(res.used_llm) };
}

export async function apiClarifyPropose(
  id: string,
  /** true → re-clarify an already-processed task (preserves a SYNCED task's
   *  ClickUp destination binding server-side). */
  reclarify = false,
): Promise<ClarifyProposal> {
  const q = reclarify ? "?reclarify=true" : "";
  const r = await gatewayFetch<Raw>(`/items/${id}/clarify${q}`, { method: "POST" });
  const accountId = r.account_id ? String(r.account_id) : undefined;
  return {
    actionable: Boolean(r.actionable),
    disposition: String(r.disposition ?? "NEXT") as ClarifyDisposition,
    nextAction: String(r.next_action ?? ""),
    outcome: r.outcome ? String(r.outcome) : undefined,
    context: r.context ? String(r.context) : undefined,
    energy: (r.energy ?? undefined) as ClarifyProposal["energy"],
    timeEstimateMins: r.time_estimate_mins
      ? Number(r.time_estimate_mins)
      : undefined,
    isTwoMinute: Boolean(r.is_two_minute),
    suggestedAssignee: asPerson(r.suggested_assignee),
    target: accountId
      ? { source: "SYNCED", accountId }
      : { source: "LOCAL", provider: "local" },
    projectId: r.project_id ? String(r.project_id) : undefined,
    projectInferred: Boolean(r.project_inferred),
    confidence: String(r.confidence ?? "medium") as Confidence,
    rationale: String(r.rationale ?? ""),
    status: r.status ? String(r.status) : undefined,
    complexity: (["single", "subtasks", "project"].includes(String(r.complexity))
      ? String(r.complexity)
      : undefined) as ClarifyProposal["complexity"],
    suggestedSubtasks: Array.isArray(r.subtasks)
      ? (r.subtasks as unknown[]).map(String).filter(Boolean)
      : undefined,
    /** true when the server locked a SYNCED task's destination (reclarify). */
    lockedDestination: Boolean(r.locked_destination),
    isVague: Boolean(r.is_vague),
    suggestedTitle: r.suggested_title ? String(r.suggested_title) : undefined,
    dueDate: r.due_date ? String(r.due_date) : undefined,
  };
}

/** Rephrase a task's title more clearly (the always-available "Improve title"
 *  affordance) and flag whether it's vague. `title` overrides the item's
 *  stored title when the user is editing it live in the card. */
export async function apiSuggestTitle(
  id: string,
  title?: string,
): Promise<{ isVague: boolean; suggestedTitle?: string }> {
  const q = title ? `?title=${encodeURIComponent(title)}` : "";
  const r = await gatewayFetch<Raw>(`/items/${id}/suggest-title${q}`, {
    method: "POST",
  });
  return {
    isVague: Boolean(r.is_vague),
    suggestedTitle: r.suggested_title ? String(r.suggested_title) : undefined,
  };
}

/** The fields an enrich pass proposed for a task's MISSING slots. Any subset. */
export interface EnrichFields {
  context?: string;
  energy?: "low" | "medium" | "high";
  timeEstimateMins?: number;
  dueAt?: string;
  assignee?: Person;
}

/** Ask the assistant to fill a task's missing details (context/energy/time/
 *  due/assignee). Proposes only — the caller applies via apiPatchItem. */
export async function apiEnrichItem(id: string): Promise<EnrichFields> {
  const r = await gatewayFetch<Raw>(`/items/${id}/enrich`, { method: "POST" });
  const f = (r.fields ?? {}) as Raw;
  return {
    context: f.context ? String(f.context) : undefined,
    energy: (["low", "medium", "high"].includes(String(f.energy))
      ? String(f.energy)
      : undefined) as EnrichFields["energy"],
    timeEstimateMins: f.time_estimate_mins
      ? Number(f.time_estimate_mins)
      : undefined,
    dueAt: f.due_at ? String(f.due_at) : undefined,
    assignee: asPerson(f.assignee),
  };
}

/** Auto-assign @context to actionable tasks that have none (the synced ClickUp
 *  tasks that arrive context-less). Writes directly; returns the count set. */
export async function apiBackfillContext(): Promise<{
  scanned: number;
  updated: number;
}> {
  const r = await gatewayFetch<Raw>(`/ai/backfill-context`, { method: "POST" });
  return { scanned: Number(r.scanned ?? 0), updated: Number(r.updated ?? 0) };
}

/** Promote a LOCAL task to a ClickUp task delegated to a teammate — re-homes it
 *  onto the chosen workspace/project and pushes it upstream in one call. */
export async function apiDelegateItem(
  id: string,
  body: {
    assignee: { name: string; email?: string; provider_user_id?: string };
    account_id: string;
    project_id: string;
    next_action?: string;
    status?: string;
    due_at?: string;
  },
): Promise<GtdItem> {
  return mapItem(
    await gatewayFetch<Raw>(`/items/${id}/delegate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}
