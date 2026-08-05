// ── The URL is the view state ─────────────────────────────────────────────
//
// v1 has no saved-views table (specs/crm_app.md §1 non-goals): view state
// lives in the URL and canned views are code. The record sheet follows the
// same rule — `?deal=<id>` opens it OVER the list rather than navigating to
// `/crm/deals/<id>`, so Back closes the sheet instead of leaving the app and
// a link to a record carries the list the reader was looking at.
//
// All of it is parse/serialize over URLSearchParams, so it is pure and the
// deep-link behaviour is testable without a browser.

import { ENTITIES, type EntitySlug } from "./types";

/** The four sheet parameters, in the order a conflict resolves. */
export const SHEET_PARAMS = ["deal", "lead", "contact", "organization"] as const;
export type SheetParam = (typeof SHEET_PARAMS)[number];

/** `?deal=` → the `deals` collection its record belongs to. */
export const SHEET_ENTITY: Record<SheetParam, EntitySlug> = {
  deal: "deals",
  lead: "leads",
  contact: "contacts",
  organization: "organizations",
};

export type OpenRecord = { param: SheetParam; entity: EntitySlug; id: string };

export type CrmView = {
  /** Which list is behind the sheet. `board` is the landing tab. */
  tab: "board" | EntitySlug;
  /** The record the sheet is showing, or null when it is closed. */
  record: OpenRecord | null;
  /** Free-text search on the list. */
  q: string;
  /** The status lane a list is filtered to (leads and deals only). */
  statusId: string | null;
  /** Leads only: show the ones that already became deals. */
  includeConverted: boolean;
  /** Restrict to one owner's records. `owner_email` is assignment, not an
   *  ACL (D-CRM-3), so this is a filter and never a permission. */
  owner: string | null;
};

export const DEFAULT_VIEW: CrmView = {
  tab: "board",
  record: null,
  q: "",
  statusId: null,
  includeConverted: false,
  owner: null,
};

function isEntity(value: string | null): value is EntitySlug {
  return !!value && (ENTITIES as readonly string[]).includes(value);
}

/**
 * Read the view out of a query string.
 *
 * Tolerant on the way in and strict about what it produces: an unknown tab
 * falls back to the board rather than rendering an empty list for a
 * collection that does not exist, because the URL is a shared artefact and
 * somebody will hand-edit it.
 */
export function parseView(search: string | URLSearchParams): CrmView {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const tab = params.get("tab");
  return {
    tab: isEntity(tab) ? tab : "board",
    record: parseRecord(params),
    q: params.get("q") ?? "",
    statusId: params.get("status") || null,
    includeConverted: params.get("converted") === "1",
    owner: params.get("owner") || null,
  };
}

/**
 * Which record the sheet shows.
 *
 * SHEET_PARAMS order is the tiebreak, and it exists because a hand-edited URL
 * can name two: showing the first in a stated order beats showing whichever
 * one URLSearchParams happened to iterate first, and beats showing none (a
 * link that opens nothing looks broken to the person who sent it).
 */
export function parseRecord(params: URLSearchParams): OpenRecord | null {
  for (const param of SHEET_PARAMS) {
    const id = params.get(param);
    if (id) return { param, entity: SHEET_ENTITY[param], id };
  }
  return null;
}

/**
 * The view as a query string — omitting every default.
 *
 * A URL that spells out its defaults is one nobody can read, and it makes two
 * identical views produce two different history entries.
 */
export function serializeView(view: CrmView): string {
  const params = new URLSearchParams();
  if (view.tab !== "board") params.set("tab", view.tab);
  if (view.q.trim()) params.set("q", view.q.trim());
  if (view.statusId) params.set("status", view.statusId);
  if (view.includeConverted) params.set("converted", "1");
  if (view.owner) params.set("owner", view.owner);
  if (view.record) params.set(view.record.param, view.record.id);
  return params.toString();
}

/** `/crm?tab=leads&lead=…` — what the address bar shows. */
export function viewHref(view: CrmView, base = "/crm"): string {
  const qs = serializeView(view);
  return qs ? `${base}?${qs}` : base;
}

/** Open a record over whatever list is showing. The list state is kept, which
 *  is the whole reason the sheet is URL state and not a route. */
export function openRecord(
  view: CrmView,
  param: SheetParam,
  id: string
): CrmView {
  return { ...view, record: { param, entity: SHEET_ENTITY[param], id } };
}

export function closeRecord(view: CrmView): CrmView {
  return { ...view, record: null };
}

/** Switching tabs closes the sheet and drops the filters that do not travel:
 *  a status lane from the deal pipeline means nothing on the leads list. */
export function selectTab(view: CrmView, tab: CrmView["tab"]): CrmView {
  if (tab === view.tab) return view;
  return {
    ...view,
    tab,
    record: null,
    statusId: null,
    includeConverted: false,
  };
}
