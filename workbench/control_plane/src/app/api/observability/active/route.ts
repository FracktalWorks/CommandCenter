/**
 * GET /api/observability/active
 *
 * Proxies GET /observability/active to the FastAPI gateway — the agent runs
 * currently in flight (the "running right now" panel). Degrades to an empty
 * list rather than erroring so the panel stays quiet when the gateway is down.
 */
import { NextResponse } from "next/server";
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

export async function GET(): Promise<NextResponse> {
  if (isAuthEnabled && !(await auth())?.user?.email) {
    return NextResponse.json({ runs: [], count: 0 }, { status: 200 });
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/observability/active`, {
      headers: await gatewayHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return NextResponse.json({ runs: [], count: 0 }, { status: 200 });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ runs: [], count: 0 }, { status: 200 });
  }
}
