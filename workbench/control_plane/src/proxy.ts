/**
 * Sends signed-out *page* navigations to /signin, and answers signed-out API
 * calls with 401.
 *
 * THIS IS NOT THE AUTHORIZATION BOUNDARY, and the list below is not an
 * access-control policy. Next's own guidance is that Proxy "should not be used
 * as a full session management or authorization solution" — it runs before the
 * request is completed, on an optimistic check. The boundary is in each route,
 * next to the fetch: `lib/gateway.ts` refuses to attach the internal bearer
 * without a member, so a route that reaches the gateway has already
 * established who is asking.
 *
 * It is worth being precise about why that matters, because this file used to
 * be load-bearing by accident. `/api/agent`, `/api/settings/`,
 * `/api/integrations/`, `/api/chat/` and `/api/memory/` were all listed as
 * public — not because they were, but because a redirect to an HTML sign-in
 * page is a useless answer to `fetch()`, so exempting them was the quickest
 * way to stop breaking the client. Meanwhile the routes underneath forwarded
 * the internal token with no identity when there was no session, which the
 * gateway reads as the platform acting as itself and grants `*`. The
 * "temporary" exemption list was the only thing standing between an
 * unauthenticated request and agent registration, code-mutation approval, and
 * the integration key inventory — and on those five prefixes it was not
 * standing there at all.
 *
 * So the redirect-vs-401 split is made explicitly here, and authorization is
 * made somewhere that can actually answer it.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth, isAuthEnabled, isAuthConfigured } from "@/auth";

/** NextAuth's own endpoints, which must stay reachable to sign anybody in. */
const AUTH_ROUTES = "/api/auth";

/** Unauthenticated page routes. */
const PUBLIC_PAGES = new Set(["/signin", "/favicon.ico"]);

export async function proxy(req: NextRequest) {
  // The laptop case, and ONLY the laptop case, runs open. This used to be
  // `!isAuthEnabled` where that merely meant "no client id configured", so a
  // production box whose auth env went missing served every route to anyone
  // (D33.1). `isAuthEnabled` is now false only when NODE_ENV is non-production
  // as well — see `auth.ts`.
  if (!isAuthEnabled) return NextResponse.next();

  const { pathname } = req.nextUrl;

  // Enforcing, but with nothing to enforce with: a production deployment that
  // lost (or never got) its auth configuration. Refuse everything, loudly.
  //
  // Not a redirect to /signin: that page cannot sign anybody in without a
  // provider, so it would be an infinite loop presented as a login screen —
  // which reads to an operator as "auth is working". 503 says the true thing,
  // and says it to health checks too.
  if (!isAuthConfigured) {
    return NextResponse.json(
      { error: "Authentication is not configured on this deployment" },
      { status: 503 },
    );
  }

  if (pathname.startsWith(AUTH_ROUTES) || pathname.startsWith("/_next")) {
    return NextResponse.next();
  }
  if (PUBLIC_PAGES.has(pathname)) return NextResponse.next();

  if (await auth()) return NextResponse.next();

  // An API caller wants a status code it can branch on, not a login page. The
  // shape matches lib/gateway's UNAUTHENTICATED so the client sees one thing.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in to continue" }, { status: 401 });
  }

  const url = new URL("/signin", req.url);
  url.searchParams.set("callbackUrl", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
