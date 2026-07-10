/**
 * GET /api/observability/runs
 *
 * Proxies the gateway's E2 diagnostics list (GET /debug/runs) for the per-agent
 * drill-down: recent runs + errors for a single agent. Forwards agent / status
 * / since_hours / limit filters. EXECUTIVE/AGENT-gated at the gateway (a run
 * row can carry error detail).
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
    return NextResponse.json({ runs: [] }, { status: 200 });
  }
  const sp = req.nextUrl.searchParams;
  const qs = new URLSearchParams();
  for (const k of ["agent", "status", "user", "thread_id", "since_hours", "limit"]) {
    const v = sp.get(k);
    if (v) qs.set(k, v);
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/debug/runs?${qs.toString()}`, {
      headers: await gatewayHeaders(),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return NextResponse.json({ runs: [] }, { status: 200 });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ runs: [] }, { status: 200 });
  }
}
