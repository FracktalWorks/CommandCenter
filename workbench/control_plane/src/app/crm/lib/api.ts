// ── The /crm client ───────────────────────────────────────────────────────
//
// Every request goes through the BFF at /api/crm/* — never at the gateway
// directly, which carries no session (workbench/AGENTS.md, "Identity").
//
// Errors keep their status. The CRM says a lot with its codes — 422 for a
// lost status with no reason or a status filter on an entity with no
// pipeline, 409 for a re-convert or a status still in use — and a client that
// flattened them all to "request failed" would leave the UI unable to explain
// a refusal, which is the difference between a rule and a bug.

import { queryString, type ListQuery } from "./filters";
import type {
  Activity,
  Contact,
  ConvertResult,
  Deal,
  DealContact,
  EntitySlug,
  Lead,
  ListResponse,
  LostReason,
  Organization,
  Pipeline,
  Status,
  TimelineEntry,
} from "./types";

export class CrmError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CrmError";
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/crm${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      detail?: unknown;
      error?: string;
    };
    throw new CrmError(detailOf(body) || `Gateway error ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * FastAPI's `detail` is a string for our own HTTPExceptions and an array of
 * objects for a Pydantic validation failure. Rendering "[object Object]" at
 * the user is how a perfectly clear refusal becomes unreadable.
 */
function detailOf(body: { detail?: unknown; error?: string }): string {
  const { detail } = body;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        typeof item === "object" && item && "msg" in item
          ? String((item as { msg: unknown }).msg)
          : String(item)
      )
      .join("; ");
  }
  return body.error ?? "";
}

// ── Records ───────────────────────────────────────────────────────────────

export function listRecords<T = Record<string, unknown>>(
  entity: EntitySlug,
  query: ListQuery = {}
): Promise<ListResponse<T>> {
  return call<ListResponse<T>>(`/${entity}${queryString(query)}`);
}

export function getRecord<T>(entity: EntitySlug, id: string): Promise<T> {
  return call<T>(`/${entity}/${id}`);
}

export function createRecord<T>(
  entity: EntitySlug,
  body: Record<string, unknown>
): Promise<T> {
  return call<T>(`/${entity}`, { method: "POST", body: JSON.stringify(body) });
}

export function patchRecord<T>(
  entity: EntitySlug,
  id: string,
  body: Record<string, unknown>
): Promise<T> {
  return call<T>(`/${entity}/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteRecord(
  entity: EntitySlug,
  id: string
): Promise<{ deleted: string; entity: string; cascaded: Record<string, number> }> {
  return call(`/${entity}/${id}`, { method: "DELETE" });
}

// ── The board ─────────────────────────────────────────────────────────────

export function getPipeline(owner?: string | null): Promise<Pipeline> {
  return call<Pipeline>(`/pipeline${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`);
}

/** The one place a deal changes lane. `board.moveRequest` decides the shape;
 *  this issues it, so the drag and the status pill send the same request. */
export function moveDeal(
  dealId: string,
  statusId: string,
  extra: Record<string, unknown> = {}
): Promise<Deal> {
  return patchRecord<Deal>("deals", dealId, { status_id: statusId, ...extra });
}

// ── Pipeline vocabulary ───────────────────────────────────────────────────

export function listStatuses(kind: "lead" | "deal"): Promise<Status[]> {
  return call<Status[]>(`/statuses/${kind}`);
}

export function listLostReasons(): Promise<LostReason[]> {
  return call<LostReason[]>("/lost-reasons");
}

// ── Timeline ──────────────────────────────────────────────────────────────

export function getTimeline(
  entity: EntitySlug,
  id: string,
  limit = 100
): Promise<{ entries: TimelineEntry[] }> {
  return call(`/${entity}/${id}/timeline?limit=${limit}`);
}

export function logActivity(
  entity: EntitySlug,
  id: string,
  body: {
    type: "note" | "call" | "meeting" | "task";
    subject?: string;
    body?: string;
    due_at?: string;
  }
): Promise<Activity> {
  return call<Activity>(`/${entity}/${id}/activities`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function completeTask(
  activityId: string,
  completed: boolean
): Promise<Activity> {
  return call<Activity>(`/activities/${activityId}`, {
    method: "PATCH",
    body: JSON.stringify({
      completed_at: completed ? new Date().toISOString() : null,
    }),
  });
}

// ── Deal contacts (WS-26c's API addendum) ─────────────────────────────────

export function listDealContacts(
  dealId: string
): Promise<{ rows: DealContact[] }> {
  return call(`/deals/${dealId}/contacts`);
}

export function addDealContact(
  dealId: string,
  body: { contact_id: string; role?: string; is_primary?: boolean }
): Promise<DealContact> {
  return call<DealContact>(`/deals/${dealId}/contacts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function removeDealContact(
  dealId: string,
  contactId: string
): Promise<{ deleted: string; was_primary: boolean }> {
  return call(`/deals/${dealId}/contacts/${contactId}`, { method: "DELETE" });
}

// ── Conversion ────────────────────────────────────────────────────────────

export function convertLead(
  leadId: string,
  body: Record<string, unknown>
): Promise<ConvertResult> {
  return call<ConvertResult>(`/leads/${leadId}/convert`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type { Contact, Deal, Lead, Organization };
