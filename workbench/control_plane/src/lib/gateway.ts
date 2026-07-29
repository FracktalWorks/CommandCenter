// ── Shared gateway proxy helpers ──────────────────────────────────────────
//
// Every /api/** route forwards to the FastAPI gateway with the internal bearer
// token plus the signed-in user's identity. That header-building logic was
// copy-pasted into ~50 route files, each with its own copy of the
// EXECUTIVE_EMAILS parsing — which made "who is an admin" an env var and a
// redeploy. This module is the single implementation; new routes use it, and
// existing ones are being migrated onto it.
//
// The role header only feeds the gateway's LEGACY require_role() checks. Real
// authorization is resolved server-side from the org tables keyed on the
// email (packages/acb_auth/acb_auth/access.py), so a stale role header cannot
// grant access the member does not have.

import { auth } from "@/auth";

export const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";

const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

/**
 * Bootstrap admin list. Retained because a deployment whose access tables have
 * not been migrated yet still needs someone to be an admin — see spec §7. Once
 * roles are assigned in /settings/members, the database is the source of truth
 * and the gateway upgrades the role itself.
 */
const EXECUTIVE_EMAILS = new Set(
  (process.env.EXECUTIVE_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

/** Internal bearer + the signed-in user's identity headers. */
export async function gatewayHeaders(
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${INTERNAL_TOKEN}`,
    ...extra,
  };
  try {
    const session = await auth();
    const email = session?.user?.email;
    if (email) {
      headers["X-User-Email"] = email;
      headers["X-User-Role"] = EXECUTIVE_EMAILS.has(email.toLowerCase())
        ? "executive"
        : "employee";
    }
  } catch {
    // auth() throws outside a request context; an unauthenticated forward is
    // resolved to no-access by the gateway, which is the correct outcome.
  }
  return headers;
}

/** Forward a request to the gateway and pass its response straight through. */
export async function proxyToGateway(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const upstream = `${GATEWAY_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(upstream, {
    ...init,
    headers: await gatewayHeaders({
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    }),
    cache: "no-store",
  });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/json",
    },
  });
}
