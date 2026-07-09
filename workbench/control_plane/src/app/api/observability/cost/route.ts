/**
 * GET /api/observability/cost
 *
 * Proxies GET /observability/cost to the FastAPI gateway — the daily LLM cost
 * rollup (per-day totals + by-model + by-source), in USD. Powers the cost view.
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

const EMPTY = { days: [], by_model: {}, by_source: {}, totals: { cost: 0, tokens: 0, calls: 0 } };

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthEnabled && !(await auth())?.user?.email) {
    return NextResponse.json(EMPTY, { status: 200 });
  }
  const days = req.nextUrl.searchParams.get("days") ?? "7";
  try {
    const res = await fetch(
      `${GATEWAY_URL}/observability/cost?days=${encodeURIComponent(days)}`,
      { headers: await gatewayHeaders(), signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return NextResponse.json(EMPTY, { status: 200 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json(EMPTY, { status: 200 });
  }
}
