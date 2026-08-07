// ── The /crm wire vocabulary ──────────────────────────────────────────────
//
// These mirror the gateway's Pydantic models (routes/crm/core.py) 1:1,
// snake_case included. The tasks app maps snake→camel at the client boundary;
// this one deliberately does not: the CRM's field names ARE its column names
// (row_to_model maps generically by field name), so a rename layer here would
// be a second vocabulary to keep in step with migration 144 for no gain, and
// the one that drifts is the copy.
//
// Spec: ai-company-brain/specs/crm_app.md §3, §4, §5.

/** The four record types, and the URL segment each one lives at. */
export const ENTITIES = ["deals", "leads", "contacts", "organizations"] as const;
export type EntitySlug = (typeof ENTITIES)[number];

/** `crm_*_statuses.type` — the machine-readable class the pipeline keys off. */
export type StatusType = "open" | "ongoing" | "on_hold" | "won" | "lost";

export type Status = {
  id: string;
  name: string;
  color: string;
  position: number;
  type: StatusType;
  is_default: boolean;
  /** Deal statuses only — a lead status has no win probability. */
  probability?: number | null;
};

/** The two status vocabularies, and the URL segment each lives at. */
export type StatusKind = "deal" | "lead";

export type LostReason = { id: string; label: string; position: number };

// ── The WS-26f f1 stage-metadata report ───────────────────────────────────
//
// Mirrors routes/crm/stage_metadata.py's Pydantic models. It is a REPORT, not
// a resource: the settings tab renders it verbatim so an owner can read what
// the apply would do (or did) before approving `?apply=true`, which is an
// owner gate.

export type StageChange = {
  name: string;
  action: "matched" | "created";
  changed: boolean;
  position_before?: number | null;
  position_after: number;
  type_before?: string | null;
  type_after: string;
  probability_before?: number | null;
  probability_after?: number | null;
};

export type OrphanLane = { name: string; position: number; deals: number };

export type ProbabilityProbe = {
  /**
   * "read" · "no_scope" (re-mint the token) · "no_data" (the layout WAS read
   * and carries none — set them by hand) · "unavailable" (we never got far
   * enough to look; points at the API version, not at the settings grid).
   */
  outcome: "read" | "no_scope" | "no_data" | "unavailable";
  scope?: string | null;
  detail?: string | null;
  values: number;
};

export type ClosedAtBackfill = {
  eligible: number;
  stamped: number;
  missing_close_date: number;
};

export type StageMetadataReport = {
  outcome: "dry_run" | "applied" | "stopped" | "unavailable";
  applied: boolean;
  layout_id?: string | null;
  layout_name?: string | null;
  pipelines: string[];
  stop_reason?: string | null;
  /** The exact OAuth scope an owner would have to add. */
  missing_scope?: string | null;
  probability: ProbabilityProbe;
  stages: StageChange[];
  orphans: OrphanLane[];
  /**
   * ⚠️ **null means the backfill never ran**, not "it ran and found nothing" —
   * the stop and the unavailable outcomes return before the database is
   * opened. Read it through `settings.ts::backfillRan`, never directly.
   */
  closed_at: ClosedAtBackfill | null;
  changed: number;
  notes: string[];
  errors: string[];
};

type Provenance = {
  source?: string;
  zoho_id?: string | null;
  last_activity_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  owner_email?: string | null;
};

export type Organization = Provenance & {
  id: string;
  name: string;
  website?: string | null;
  industry?: string | null;
  no_of_employees?: number | null;
  annual_revenue?: number | null;
  phone?: string | null;
  email?: string | null;
  description?: string | null;
  linkedin_url?: string | null;
};

export type Contact = Provenance & {
  id: string;
  first_name: string;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  title?: string | null;
  organization_id?: string | null;
  description?: string | null;
  linkedin_url?: string | null;
};

export type Lead = Provenance & {
  id: string;
  lead_name: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  organization_name?: string | null;
  website?: string | null;
  industry?: string | null;
  annual_revenue?: number | null;
  status_id?: string | null;
  lead_source?: string | null;
  description?: string | null;
  lost_reason_id?: string | null;
  lost_note?: string | null;
  converted_at?: string | null;
  converted_contact_id?: string | null;
  converted_organization_id?: string | null;
  /** The link that decides "converted", never the timestamp (§3.3 / B6). */
  converted_deal_id?: string | null;
};

export type Deal = Provenance & {
  id: string;
  name: string;
  organization_id?: string | null;
  /** Projected by the gateway's LEFT JOIN — never client-side joined. */
  organization_name?: string | null;
  status_id?: string | null;
  status_changed_at?: string | null;
  amount?: number | null;
  currency?: string;
  probability?: number | null;
  expected_close_date?: string | null;
  closed_at?: string | null;
  lost_reason_id?: string | null;
  lost_note?: string | null;
  next_step?: string | null;
  lead_id?: string | null;
  description?: string | null;
};

export type CrmRecord = Deal | Lead | Contact | Organization;

export type ListResponse<T = Record<string, unknown>> = {
  rows: T[];
  total: number;
};

export type PipelineLane = {
  status: Status;
  rows: Deal[];
  count: number;
  amount: number;
  /**
   * Σ(amount × probability/100) over the WHOLE lane, computed by the gateway
   * (WS-26f f3). Required rather than optional on purpose: `rows` is one page
   * of the lane, so a client that recomputed this would under-report exactly
   * the busy lane somebody is looking at — and an optional field would let
   * that mistake render as a blank instead of failing to compile.
   * Zero on lanes whose type is not open/ongoing (D-CRM-10).
   */
  weighted: number;
};

export type Pipeline = { lanes: PipelineLane[] };

export type Activity = {
  id: string;
  type: "note" | "call" | "meeting" | "task" | "status_change" | "system";
  subject?: string | null;
  body?: string | null;
  occurred_at?: string | null;
  due_at?: string | null;
  completed_at?: string | null;
  created_by?: string | null;
  created_at?: string | null;
};

export type StatusChange = {
  id: string;
  from_status?: string | null;
  to_status: string;
  changed_by: string;
  changed_at?: string | null;
  dwell_seconds?: number | null;
};

/**
 * One email conversation on a CRM timeline (WS-26d-email).
 *
 * The unit is the THREAD, not the message: `thread_id` groups it and the
 * fields describe the newest message in it. `status` is the email app's own
 * per-thread classification (NEEDS_REPLY / AWAITING / FYI / DONE) and is null
 * for a thread nobody has classified.
 *
 * ⚠️ What is shown here is scoped to the SIGNED-IN CALLER's mailboxes, not to
 * the record: two colleagues opening the same lead may legitimately see
 * different threads, and somebody with no mailbox sees none. That is not a
 * bug report.
 */
export type EmailThread = {
  thread_id: string;
  account_id: string;
  message_id: string;
  subject?: string | null;
  snippet?: string | null;
  folder?: string | null;
  from_name?: string | null;
  from_email?: string | null;
  received_at?: string | null;
  status?: string | null;
};

export type TimelineEntry = {
  /**
   * A CLOSED union, deliberately: it is the fence that makes the gateway's
   * `TimelineEntry.kind` and this type impossible to update one side of.
   * Adding a kind here without adding its payload field below (and a branch in
   * `timelineBranch`) is the shape of the bug this comment exists to prevent.
   */
  kind: "activity" | "status_change" | "email_thread";
  at?: string | null;
  /** 'lead' marks a deal inheriting its originating lead's history (§5.3). */
  origin: "own" | "lead";
  activity?: Activity | null;
  status_change?: StatusChange | null;
  email_thread?: EmailThread | null;
};

export type DealContact = {
  contact: Contact;
  role?: string | null;
  is_primary: boolean;
};

export type ConvertResult = {
  lead: Lead;
  contact?: Contact | null;
  organization?: Organization | null;
  deal: Deal;
};
