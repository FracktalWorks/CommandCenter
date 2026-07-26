/**
 * Custom Apps (App Workshop) — shared types for the /build/apps pages.
 *
 * Shapes mirror the gateway routes/apps API surface proxied at /api/apps
 * (see docs/app-workshop/README.md §4.9–4.10).
 */

/** Viewer's relationship to an app (from app_grants). */
export type AppRole = "own" | "edit" | "use";

export type AppStatus = "draft" | "live" | "archived";

export type AppVisibility = "private" | "people" | "org";

/** One app as returned by GET /api/apps (list) and GET /api/apps/{slug}. */
export interface AppMeta {
  slug: string;
  name: string;
  /** Emoji / short glyph shown in the gradient tile. */
  icon?: string;
  description?: string;
  status: AppStatus;
  visibility: AppVisibility;
  /** Currently published version number; null/undefined = never published. */
  live_version?: number | null;
  owner_email: string;
  updated_at: string;
  /** Viewer's role on this app. */
  role: AppRole;
  /** Detail route only. The app.json manifest (LLM-drafted). */
  manifest?: Record<string, unknown>;
  /** Detail route only, editors only — the builder session's working dir. */
  workspace_path?: string;
  /** Detail route only. true = the viewer must clear the first-open consent
   * interstitial before the run page fetches the live bundle (§4.8). */
  needs_consent?: boolean | null;
  /** Detail route only. The manifest scopes of the LIVE (published, reviewed)
   * version — NOT the draft's, which may have moved on since the last
   * publish. Populated whenever `needs_consent` is relevant. */
  live_scopes?: string[] | null;
  /** Detail route only. Echoed back verbatim in POST /consent to detect a
   * scope-set change between page load and the viewer's "Allow" click. */
  live_scope_set_hash?: string | null;
}

/** One sharing grant from GET/POST /api/apps/{slug}/grants — "specific
 * people" visibility's per-viewer allow list (§4.8). */
export interface GrantEntry {
  subject: string;
  role: "use" | "edit" | "own";
  consented_scope_hash?: string | null;
  granted_by: string;
  created_at: string;
}

/** One workspace file from GET /api/apps/{slug}/files. */
export interface AppFile {
  path: string;
  size: number;
  modified_at: string;
}

/** One draft git checkpoint from GET /api/apps/{slug}/checkpoints. */
export interface Checkpoint {
  sha: string;
  message: string;
  /** ISO timestamp of the checkpoint commit. */
  at: string;
  files_changed: number;
}

/** One immutable published snapshot from GET /api/apps/{slug}/versions. */
export interface AppVersion {
  version: number;
  release_notes?: string;
  published_by: string;
  published_at: string;
}

/** AI usage aggregates from GET /api/apps/{slug}/usage. */
export interface AppUsage {
  month_tokens: number;
  month_cost_usd: number;
  month_calls: number;
  budget_tokens?: number | null;
}
