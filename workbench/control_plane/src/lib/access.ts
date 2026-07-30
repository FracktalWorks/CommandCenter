// ── Org access control — client-side types and helpers ───────────────────
//
// Spec: ai-company-brain/specs/org_access_control.md
//
// The gateway resolves permissions and returns *outcomes* — a list of allowed
// feature slugs and runnable agent names. This module deliberately does NOT
// re-implement the wildcard matching rule: two implementations of an
// authorization rule is one too many, and the one in the browser is the one
// that drifts. Everything here is a lookup against the server's answer.
//
// Nothing here is a security boundary. Hiding a nav item is a courtesy; the
// gateway's require_permission() is what actually refuses the request.

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
  /** Agent names this member may run. */
  agents: string[];
  permissions: string[];
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
  agents: [],
  permissions: [],
  denied: [],
  is_admin: false,
};

// ── href → feature slug ───────────────────────────────────────────────────
//
// Longest-prefix match, so "/settings/models" resolves to `models` rather
// than being swallowed by a shorter "/settings" entry. Kept in sync with the
// feature_catalog table (infra/postgres/130_org_access_control.sql).

const HREF_FEATURES: ReadonlyArray<[string, string]> = [
  ["/chat", "chat"],
  ["/email", "email"],
  ["/inbox", "email"],
  ["/whatsapp", "whatsapp"],
  ["/memory", "memory"],
  ["/tasks", "tasks"],
  ["/notes", "notes"],
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
const ALWAYS_ALLOWED = ["/", "/signin", "/settings", "/settings/profile"];

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

export function canSeePath(access: Access, pathname: string): boolean {
  if (isAlwaysAllowed(pathname)) return true;
  // Admin surfaces are gated on the resolved admin flag, not a feature slug —
  // they have no nav pane of their own.
  if (pathname.startsWith("/settings/members") || pathname.startsWith("/settings/roles")) {
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
    return (await res.json()) as Access;
  } catch {
    return NO_ACCESS;
  }
}
