import type { Rule as RecurrenceRule } from "./recurrence";

/**
 * Projects · the browser's client for /api/projects/*.
 *
 * Every call goes through the BFF proxy, never at the gateway directly — the
 * proxy is what carries the session identity the whole grant model scopes on.
 */

export interface ProjectRow {
  id: string;
  name: string;
  description?: string | null;
  parent_project_id?: string | null;
  status?: string | null;
  lead?: string | null;
  clickup_id?: string | null;
  clickup_kind?: string | null;
  children?: ProjectRow[];
}

export interface TaskRow {
  id: string;
  project_id: string;
  root_project_id: string;
  task_number?: number | null;
  parent_task_id?: string | null;
  type_id?: string | null;
  status_id: string;
  title: string;
  description?: string | null;
  importance?: number | null;
  estimate_mins?: number | null;
  /**
   * WS-27q — a floating calendar date (`DATE`, not an instant), which is why
   * it is never routed through `new Date()`: that would read it as midnight
   * UTC and move it a day west of Greenwich. A column that has existed since
   * migration 146 and had no surface until the calendar.
   */
  start_date?: string | null;
  due_at?: string | null;
  completed_at?: string | null;
  tags?: string[];
  created_at?: string | null;
  assignees?: string[];
  view_position?: number | null;
  view_group_key?: string | null;
  /**
   * WS-27l — values keyed by `field_key`. Always an object, never absent: the
   * column is `NOT NULL DEFAULT '{}'`, so a missing key means the field is
   * unset rather than that the values have not loaded.
   */
  custom_fields?: Record<string, unknown>;
  /**
   * WS-27s — the two counts a card draws, aggregated for the whole page rather
   * than fetched per row. Always present on the list endpoint; optional here
   * because the same type describes a row from `getTask`, where the panel reads
   * the full relations block instead.
   */
  subtasks?: { done: number; total: number };
  blocked_by_count?: number;
}

export interface StatusRow {
  id: string;
  project_id: string;
  name: string;
  color: string;
  position: number;
  category: string;
  is_default: boolean;
}

export interface ActivityRow {
  id: string;
  task_id?: string | null;
  type: string;
  body?: string | null;
  meta?: Record<string, unknown> | null;
  created_by?: string | null;
  created_at?: string | null;
  /**
   * WS-27j — people this comment named who could not be notified, because they
   * cannot see the task. Present on the POST response only; the timeline does
   * not carry it, since who was reachable is a fact about the moment of
   * posting rather than about the comment.
   */
  not_notified?: string[];
}

export interface ViewRow {
  id: string;
  project_id: string;
  name: string;
  view_type: string;
  /**
   * Filters and grouping, in the gateway's key names. Read it through
   * `grouping.fromConfig` rather than indexing into it — the server drops keys
   * it does not know, so a view written by a newer client comes back thinner
   * than it went in, and every field here is optional in practice.
   */
  config: Record<string, unknown>;
  position?: number | null;
}

/** WS-27m — a registered tag. `task_count` is present on the list endpoint. */
export interface TagRow {
  id: string;
  project_id: string;
  name: string;
  color: string;
  description?: string | null;
  task_count?: number;
  /** How many tasks a rename rewrote. Present on the PATCH response only. */
  retagged?: number;
}

/** WS-27l — a custom field definition. Shape mirrors the gateway's row. */
export interface FieldRow {
  id: string;
  project_id: string;
  field_key: string;
  name: string;
  description?: string | null;
  field_type:
    | "text"
    | "number"
    | "date"
    | "select"
    | "multi_select"
    | "boolean"
    | "url";
  options: string[];
  position: number;
  created_by?: string | null;
}

export interface GrantRow {
  id: string;
  project_id: string;
  subject: string;
}

export class ProjectsApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ProjectsApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/projects/${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // The API answers 404 for "not yours" as well as "no such thing" (R5), so
    // the message is deliberately not embellished here — the UI must not
    // invent a distinction the server refuses to make.
    throw new ProjectsApiError(
      body?.detail ?? `Request failed (${res.status})`,
      res.status
    );
  }
  return body as T;
}

export const projectsApi = {
  tree: () => call<{ rows: ProjectRow[]; total: number }>("tree"),

  grants: (projectId: string) =>
    call<{ rows: GrantRow[]; total: number }>(`nodes/${projectId}/grants`),

  statuses: (projectId: string) =>
    call<{ rows: StatusRow[]; total: number }>(`nodes/${projectId}/statuses`),

  tasks: (params: Record<string, string | number | boolean | undefined>) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    return call<{ rows: TaskRow[]; total: number }>(`tasks?${qs.toString()}`);
  },

  /**
   * WS-27q — every task whose schedule overlaps a window.
   *
   * Deliberately NOT `tasks` with a date filter: that endpoint is paginated,
   * and a month read at `page_size=50` draws forty of its ninety tasks and
   * leaves the rest of the days looking empty. `truncated` is the endpoint
   * telling us when the cap was reached, so the view can say so rather than
   * present a plausible-looking short month.
   */
  calendar: (params: Record<string, string | number | boolean | undefined>) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    return call<{
      from: string;
      to: string;
      rows: TaskRow[];
      /**
       * WS-27t — the `blocks` edges with BOTH ends in the window, so an arrow
       * always has two bars to join. Empty unless `include_links`, and always
       * present: a missing key and an empty list read the same to a careless
       * client.
       */
      links: { id: string; blocker_id: string; blocked_id: string }[];
      truncated: boolean;
      cap: number;
      undated: number;
    }>(`calendar?${qs.toString()}`);
  },

  task: (taskId: string) => call<TaskRow>(`tasks/${taskId}`),

  timeline: (taskId: string) =>
    call<{ rows: ActivityRow[]; total: number }>(`tasks/${taskId}/timeline`),

  createProject: (payload: Record<string, unknown>) =>
    call<ProjectRow>("nodes", { method: "POST", body: JSON.stringify(payload) }),

  createTask: (payload: Record<string, unknown>) =>
    call<TaskRow>("tasks", { method: "POST", body: JSON.stringify(payload) }),

  patchTask: (taskId: string, payload: Record<string, unknown>) =>
    call<TaskRow>(`tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  setAssignees: (taskId: string, assignees: string[]) =>
    call<{ task_id: string; assignees: string[] }>(`tasks/${taskId}/assignees`, {
      method: "PUT",
      body: JSON.stringify({ assignees }),
    }),

  comment: (taskId: string, body: string) =>
    call<ActivityRow>(`tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),

  /**
   * WS-27p — subtasks and links in both directions, plus derived blocked-ness.
   *
   * ONE call rather than three: the panel needs all of it at once, and three
   * round trips to fill one block is three chances to paint a half-drawn
   * dependency section.
   */
  relations: (taskId: string) =>
    call<import("./relations").Relations>(`tasks/${taskId}/relations`),

  createLink: (taskId: string, targetTaskId: string, linkType: string) =>
    call<{ id: string }>(`tasks/${taskId}/links`, {
      method: "POST",
      body: JSON.stringify({ target_task_id: targetTaskId, link_type: linkType }),
    }),

  deleteLink: (taskId: string, linkId: string) =>
    call<{ deleted: string }>(`tasks/${taskId}/links/${linkId}`, {
      method: "DELETE",
    }),

  /** WS-27o — this task's repeat rule, or `{rule: null}`. */
  recurrence: (taskId: string) =>
    call<{ rule: RecurrenceRule | null }>(`tasks/${taskId}/recurrence`),

  /** Set or replace it. A task has at most one rule, so this is a PUT. */
  setRecurrence: (taskId: string, payload: Record<string, unknown>) =>
    call<{ rule: RecurrenceRule }>(`tasks/${taskId}/recurrence`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /** Stop the series. Everything it already created stays. */
  clearRecurrence: (taskId: string) =>
    call<{ cleared: boolean; cascaded?: { tasks_detached: number } }>(
      `tasks/${taskId}/recurrence`,
      { method: "DELETE" }
    ),

  /**
   * WS-27n — one edit applied to many tasks.
   *
   * Answers per-task outcomes rather than a single success: a selection can
   * span projects, so a status name valid in one and absent from another is a
   * fact about that task, not a reason to fail the batch.
   */
  bulkEdit: (payload: Record<string, unknown>) =>
    call<{
      requested: number;
      applied: number;
      results: Array<{ task_id: string; changed: string[]; status?: string | null }>;
      skipped: Array<{ task_id: string; reason: string }>;
      failed: Array<{ task_id: string; reason: string }>;
    }>("tasks/bulk", { method: "POST", body: JSON.stringify(payload) }),

  tags: (projectId: string) =>
    call<{ rows: TagRow[]; total: number }>(`nodes/${projectId}/tags`),

  createTag: (projectId: string, payload: Record<string, unknown>) =>
    call<TagRow>(`nodes/${projectId}/tags`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** Rename or recolour. A rename rewrites every task wearing the tag. */
  patchTag: (tagId: string, payload: Record<string, unknown>) =>
    call<TagRow>(`tags/${tagId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  /** Fold one tag into another. The source is deleted; the target absorbs it. */
  mergeTag: (tagId: string, intoTagId: string) =>
    call<{ merged: string; into: string; retagged: number }>(
      `tags/${tagId}/merge`,
      { method: "POST", body: JSON.stringify({ into_tag_id: intoTagId }) }
    ),

  /** Deletes the tag AND takes it off every task — the count comes back. */
  deleteTag: (tagId: string) =>
    call<{
      deleted: string;
      name: string;
      cascaded: { tasks_untagged: number };
    }>(`tags/${tagId}`, { method: "DELETE" }),

  fields: (projectId: string) =>
    call<{ rows: FieldRow[]; total: number }>(`nodes/${projectId}/fields`),

  createField: (projectId: string, payload: Record<string, unknown>) =>
    call<FieldRow>(`nodes/${projectId}/fields`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  patchField: (fieldId: string, payload: Record<string, unknown>) =>
    call<FieldRow>(`fields/${fieldId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  /** Deletes the definition AND every value filed under it — the count comes back. */
  deleteField: (fieldId: string) =>
    call<{
      deleted: string;
      field_key: string;
      cascaded: { values_cleared: number };
    }>(`fields/${fieldId}`, { method: "DELETE" }),

  views: (projectId: string) =>
    call<{ rows: ViewRow[]; total: number }>(`nodes/${projectId}/views`),

  createView: (projectId: string, payload: Record<string, unknown>) =>
    call<ViewRow>(`nodes/${projectId}/views`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  patchView: (viewId: string, payload: Record<string, unknown>) =>
    call<ViewRow>(`views/${viewId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  deleteView: (viewId: string) =>
    call<{ deleted: string; cascaded: { positions: number } }>(`views/${viewId}`, {
      method: "DELETE",
    }),

  setPositions: (
    viewId: string,
    positions: Array<{ task_id: string; position: number; group_key?: string | null }>
  ) =>
    call<{ view_id: string; written: number }>(`views/${viewId}/positions`, {
      method: "PUT",
      body: JSON.stringify({ positions }),
    }),
};

/**
 * The personal lens (WS-27e).
 *
 * Same store, same rows, same proxy — there is no second task API, because
 * there is no second task table. Identity comes from the session on the server
 * side, so nothing here takes a member parameter: no request can be shaped to
 * read or write somebody else's practice.
 */
export const myWorkApi = {
  inbox: (params: Record<string, string | boolean | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    const query = qs.toString();
    return call<{ rows: MyTaskApiRow[]; total: number }>(
      `my/inbox${query ? `?${query}` : ""}`
    );
  },

  contexts: () =>
    call<{ rows: Array<{ context: string; total: number }>; total: number }>(
      "my/contexts"
    ),

  capture: (payload: {
    title: string;
    next_action?: string | null;
    context?: string | null;
    due_at?: string | null;
  }) => call<TaskRow>("my/tasks", { method: "POST", body: JSON.stringify(payload) }),

  setPersonal: (taskId: string, payload: Record<string, unknown>) =>
    call<Record<string, unknown>>(`tasks/${taskId}/personal`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  // Completion moves the task's SHARED status — the cohesion the one-store
  // design buys. Ticking something off here ticks it off on the team's board.
  complete: (taskId: string) =>
    call<TaskRow>(`tasks/${taskId}/complete`, { method: "POST", body: "{}" }),

  defer: (taskId: string, until: string) =>
    call<Record<string, unknown>>(`tasks/${taskId}/defer`, {
      method: "POST",
      body: JSON.stringify({ until }),
    }),
};

export interface AttachmentRow {
  attachment_id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  added_by?: string | null;
  created_at?: string | null;
  url: string;
}

/**
 * Attachments (WS-27i).
 *
 * The upload is a raw multipart POST rather than a `call()` — that helper
 * forces JSON. It still goes through the BFF proxy, so identity travels the
 * same way everything else does.
 */
export const attachmentsApi = {
  list: (taskId: string) =>
    call<{ rows: AttachmentRow[]; total: number }>(`tasks/${taskId}/attachments`),

  upload: async (taskId: string, file: File): Promise<AttachmentRow> => {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch(`/api/projects/tasks/${taskId}/attachments`, {
      method: "POST",
      body,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new ProjectsApiError(
        parsed?.detail ?? `Upload failed (${res.status})`,
        res.status
      );
    }
    return parsed as AttachmentRow;
  },

  detach: (taskId: string, attachmentId: string) =>
    call<{ removed: number }>(`tasks/${taskId}/attachments/${attachmentId}`, {
      method: "DELETE",
    }),
};

/** What `/my/inbox` returns: the task row with this member's overlay merged on. */
export interface MyTaskApiRow extends TaskRow {
  disposition: string;
  is_triaged: boolean;
  next_action?: string | null;
  context?: string | null;
  energy?: string | null;
  is_two_minute?: boolean;
}

export interface NotificationRow {
  id: string;
  kind: "assigned" | "mention" | "comment";
  task_id: string;
  actor: string;
  excerpt?: string | null;
  created_at?: string | null;
  read_at?: string | null;
  task_title?: string | null;
  task_number?: number | null;
  project_id?: string | null;
}

/**
 * Notifications (WS-27j).
 *
 * No `recipient` parameter anywhere, and that is the contract rather than an
 * omission: the gateway takes the recipient from the session, so there is no
 * request shape that reads somebody else's bell.
 */
export const notificationsApi = {
  list: (unreadOnly = false) =>
    call<{ rows: NotificationRow[]; total: number; unread: number }>(
      `notifications${unreadOnly ? "?unread_only=true" : ""}`
    ),

  markRead: (ids: string[]) =>
    call<{ marked: number }>("notifications/read", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  markAllRead: () =>
    call<{ marked: number }>("notifications/read", {
      method: "POST",
      body: JSON.stringify({ all: true }),
    }),
};

export interface TaskAccountRow {
  id: string;
  provider: string;
  workspace_id: string;
  label?: string;
}

/**
 * The ClickUp import (WS-27b's endpoints, finally reachable).
 *
 * `plan` and a `dry_run` import both write NOTHING — they are what answers
 * "what is actually in ClickUp" before anything touches this database. Only
 * `run({dry_run:false})` writes, and the UI never calls it without an explicit
 * click on a button that says so.
 *
 * Accounts come from the tasks API because that is where the ClickUp
 * connection already lives; a second place to connect ClickUp would be a
 * second thing to retire at WS-27g.
 */
export const importApi = {
  accounts: async (): Promise<TaskAccountRow[]> => {
    const res = await fetch("/api/tasks/accounts");
    if (!res.ok) throw new ProjectsApiError("Couldn't list accounts", res.status);
    return (await res.json()) as TaskAccountRow[];
  },

  plan: (accountId: string, useLlm: boolean) =>
    call<unknown>("import/clickup/plan", {
      method: "POST",
      body: JSON.stringify({ account_id: accountId, use_llm: useLlm }),
    }),

  /**
   * The fast path: project the ClickUp mirror the Tasks app ALREADY holds into
   * one department. No ClickUp call, no token, no mapping decision — it reads
   * `gtd_projects`/`gtd_items` locally, so it works when the connector is
   * stale and is quick enough to run in front of an audience.
   */
  fromTasks: (department: string, dryRun: boolean) =>
    call<{
      dry_run: boolean;
      department: string;
      projects: { created: number; already_present: number };
      tasks: { created: number; already_present: number };
      lanes_created: number;
      tasks_without_a_list: number;
    }>("import/from-tasks", {
      method: "POST",
      body: JSON.stringify({ department, dry_run: dryRun }),
    }),

  run: (
    accountId: string,
    mappings: Array<{ space_id: string; center: string | null }>,
    dryRun: boolean
  ) =>
    call<unknown>("import/clickup", {
      method: "POST",
      body: JSON.stringify({
        account_id: accountId,
        mappings,
        dry_run: dryRun,
      }),
    }),
};
