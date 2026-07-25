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
}

/** One workspace file from GET /api/apps/{slug}/files. */
export interface AppFile {
  path: string;
  size: number;
  modified_at: string;
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
