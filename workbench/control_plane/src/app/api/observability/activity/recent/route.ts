/**
 * GET /api/observability/activity/recent
 *
 * Proxies GET /observability/activity/recent to the FastAPI gateway — the
 * recent slice of the global activity bus, used to backfill the live feed on
 * first load before the SSE stream takes over.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth, isAuthEnabled } from "@/auth";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

const EXECUTIVE_EMAILS = new Set(
  (process.env.EXECUTIVE_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

async function gatewayHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${INTERNAL_TOKEN}`,
  };
  try {
    const session = await auth();
    if (session?.user?.email) {
      h["X-User-Email"] = session.user.email;
      h["X-User-Role"] = EXECUTIVE_EMAILS.has(session.user.email.toLowerCase())
        ? "executive"
        : "employee";
    }
  } catch {
    /* not a request context */
  }
  return h;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthEnabled && !(await auth())?.user?.email) {
    return NextResponse.json({ events: [], count: 0 }, { status: 200 });
  }
  const limit = req.nextUrl.searchParams.get("limit") ?? "100";
  try {
    const res = await fetch(
      `${GATEWAY_URL}/observability/activity/recent?limit=${encodeURIComponent(limit)}`,
      { headers: await gatewayHeaders(), signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) {
      return NextResponse.json({ events: [], count: 0 }, { status: 200 });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ events: [], count: 0 }, { status: 200 });
  }
}
