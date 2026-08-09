// ── Org access control — client-side types and helpers ───────────────────
//
// Spec: project-docs/specs/org_access_control.md
//
// The gateway resolves permissions and returns *outcomes* — a list of allowed
// feature slugs and runnable agent names. This module deliberately does NOT
// re-implement the wildcard matching rule: two implementations of an
// authorization rule is one too many, and the one in the browser is the one
// that drifts. Everything here is a lookup against the server's answer.
//
// Nothing here is a security boundary. Hiding a nav item is a courtesy; the
// gateway's require_permission() is what actually refuses the request.

import { CENTERS } from "@/lib/centers";

export type Access = {
  email: string;
  user_id: string;
  authenticated: boolean;
  is_active: boolean;
  organization: { id?: string; slug?: string; display_name?: string };
  roles: string[];
  legacy_role: string;
  /** Feature slugs this member may reach, e.g. ["chat", "email"]. */
  features: string[];
  /**
   * Feature slugs this member may NOT reach, each with the permission it
   * needs. The half that makes a hidden pane explainable: without it, "you
   * lack the grant", "the slug was never registered" and "the gateway is
   * down" all render as the same nothing, and the only way to tell them apart
   * is to ask somebody with database access.
   */
  features_denied: Array<{ slug: string; permission: string }>;
  /** Agent names this member may run. */
  agents: string[];
  /** Raw granted patterns (admin screens display these verbatim). */
  permissions: string[];
  /**
   * Concrete capabilities the server RESOLVED to yes for this member, e.g.
   * ["apps:publish", "workflows:publish"]. Use this — not `permissions` —
   * for "may they do X": an owner holds "*", never the literal string.
   */
  capabilities: string[];
  denied: string[];
  is_admin: boolean;
};

/** What an unresolved / signed-out viewer gets: nothing. */
export const NO_ACCESS: Access = {
  email: "",
  user_id: "",
  authenticated: false,
  is_active: false,
  organization: {},
  roles: [],
  legacy_role: "employee",
  features: [],
  features_denied: [],
  agents: [],
  permissions: [],
  capabilities: [],
  denied: [],
  is_admin: false,
};

// ── href → feature slug ───────────────────────────────────────────────────
//
// Longest-prefix match, so "/settings/models" resolves to `models` rather
// than being swallowed by a shorter "/settings" entry. Kept in sync with the
// feature_catalog table (infra/postgres/130_org_access_control.sql).

const HREF_FEATURES: ReadonlyArray<[string, string]> = [
  // Departmental Centers — each landing page is gated by its own feature
  // (feature_catalog rows seeded in 140_center_features.sql).
  ...CENTERS.map((c): [string, string] => [`/centers/${c.slug}`, c.feature]),
  ["/chat", "chat"],
  ["/email", "email"],
  ["/inbox", "email"],
  ["/whatsapp", "whatsapp"],
  ["/memory", "memory"],
  ["/tasks", "tasks"],
  ["/notes", "notes"],
  // The Sales Center's pipeline module. Gated on its own slug, not on
  // `center.sales`: a Center is a projection, and its modules carry their own
  // grants (specs/crm_app.md §5).
  ["/crm", "crm"],
  // Projects — the People Center's work-management module, projected into
  // every other Center as (app + scope). Gated on its own slug for the same
  // reason as /crm; note this feature gates DATA as well as the pane, so the
  // grant model in the API is the real boundary and this is the courtesy half
  // (specs/project_management_app.md §5).
  ["/projects", "projects"],
  ["/people", "people"],
  ["/dashboard", "dashboard"],
  ["/observability", "observability"],
  ["/artifacts", "artifacts"],
  ["/workflows", "workflows"],
  ["/settings/models", "models"],
  ["/agents", "agents"],
  ["/approvals", "approvals"],
  ["/integrations", "integrations"],
  ["/apis", "integrations"],
  ["/build/agents", "build.agents"],
  ["/build/apps", "build.apps"],
];

/** The feature slug guarding a route, or null when the route is unguarded. */
export function featureForPath(pathname: string): string | null {
  let best: string | null = null;
  let bestLength = 0;
  for (const [prefix, slug] of HREF_FEATURES) {
    if (
      (pathname === prefix || pathname.startsWith(prefix + "/")) &&
      prefix.length > bestLength
    ) {
      best = slug;
      bestLength = prefix.length;
    }
  }
  return best;
}

/**
 * Routes every signed-in member may reach regardless of feature grants —
 * the sign-in page, the access-denied page itself (a redirect loop is worse
 * than an over-permissive 200 on a page that renders "no access"), and the
 * personal settings a member needs to manage their own account.
 */
const ALWAYS_ALLOWED = [
  "/",
  "/signin",
  "/settings",
  "/settings/profile",
  // "Your access" — the page that explains why a pane is missing. It has to be
  // reachable by exactly the person who cannot reach things, so gating it on a
  // feature would make it useless in the only situation it exists for.
  "/access",
];

export function isAlwaysAllowed(pathname: string): boolean {
  return ALWAYS_ALLOWED.includes(pathname);
}

// ── Lookups ───────────────────────────────────────────────────────────────

export function canUseFeature(access: Access, slug: string): boolean {
  return access.features.includes(slug);
}

export function canRunAgent(access: Access, name: string): boolean {
  return access.agents.includes(name);
}

/**
 * Whether the member holds a concrete capability, e.g. "workflows:publish".
 * A lookup against the server's resolved answer — hiding the control is a
 * courtesy, require_permission() on the route is the actual boundary.
 */
export function hasCapability(access: Access, name: string): boolean {
  return access.capabilities.includes(name);
}

export function canSeePath(access: Access, pathname: string): boolean {
  if (isAlwaysAllowed(pathname)) return true;
  // Admin surfaces are gated on the resolved admin flag, not a feature slug —
  // they have no nav pane of their own.
  if (
    pathname.startsWith("/settings/members") ||
    pathname.startsWith("/settings/roles") ||
    pathname.startsWith("/settings/groups")
  ) {
    return access.is_admin;
  }
  const slug = featureForPath(pathname);
  if (!slug) return true;
  return canUseFeature(access, slug);
}

/** Fetch the caller's access. Never throws — failures resolve to NO_ACCESS. */
export async function fetchAccess(signal?: AbortSignal): Promise<Access> {
  try {
    const res = await fetch("/api/auth/me", { signal, cache: "no-store" });
    if (!res.ok) return NO_ACCESS;
    const raw = (await res.json()) as Partial<Access>;
    // Normalize the list fields: a payload from a gateway that predates one of
    // them must read as "nothing granted", never as undefined.
    return {
      ...NO_ACCESS,
      ...raw,
      features: raw.features ?? [],
      features_denied: raw.features_denied ?? [],
      agents: raw.agents ?? [],
      permissions: raw.permissions ?? [],
      capabilities: raw.capabilities ?? [],
      denied: raw.denied ?? [],
    };
  } catch {
    return NO_ACCESS;
  }
}
