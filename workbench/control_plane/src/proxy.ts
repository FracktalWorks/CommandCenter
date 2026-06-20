import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth, isAuthEnabled } from "@/auth";

export async function proxy(req: NextRequest) {
  // If Microsoft credentials are not configured, run wide open (dev mode).
  if (!isAuthEnabled) return NextResponse.next();

  const { pathname } = req.nextUrl;
  const isPublic =
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/models") ||
    pathname.startsWith("/api/agent") ||
    pathname.startsWith("/api/chat/") ||
    pathname.startsWith("/api/integrations/") ||
    pathname.startsWith("/api/memory/") ||
    pathname.startsWith("/api/email/") ||
    pathname.startsWith("/api/settings/") ||
    pathname === "/signin" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico";

  if (isPublic) return NextResponse.next();

  const session = await auth();
  if (!session) {
    const url = new URL("/signin", req.url);
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};