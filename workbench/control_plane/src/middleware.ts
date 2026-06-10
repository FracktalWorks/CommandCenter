/**
 * Next.js middleware — route protection via NextAuth v5.
 *
 * When Google SSO is configured (AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET), all
 * routes except auth handlers, the sign-in page, and public assets require
 * an authenticated session.  Unauthenticated users are redirected to /signin.
 *
 * In dev mode (no Google credentials), all traffic is allowed.
 *
 * API routes that proxy to the gateway add user identity headers inside their
 * own handlers — the middleware only gates access, it does NOT inject headers.
 */
import { auth, isAuthEnabled } from "@/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Routes that never require authentication. */
const PUBLIC_PREFIXES = [
  "/api/auth/",       // NextAuth OAuth callbacks + session endpoint
  "/signin",          // sign-in page
  "/_next/",          // Next.js static assets (JS, CSS, images)
  "/favicon.ico",     // favicon
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export async function middleware(req: NextRequest) {
  // Dev mode: no Google credentials → allow all traffic.
  if (!isAuthEnabled) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  // Public routes — allow through without a session.
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // Authenticated — allow through.
  const session = await auth();
  if (session) {
    return NextResponse.next();
  }

  // Unauthenticated — redirect to sign-in with the original URL as callback.
  const signInUrl = new URL("/signin", req.url);
  signInUrl.searchParams.set("callbackUrl", req.url);
  return NextResponse.redirect(signInUrl);
}

/**
 * Matcher config: apply middleware to all routes EXCEPT Next.js internals
 * and static files.
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - static assets in /public (favicon, robots.txt, etc.)
     */
    "/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot)).*)",
  ],
};
