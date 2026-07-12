/**
 * POST /api/observability/avatars/generate
 *
 * Proxies POST /observability/avatars/generate — the gateway calls Pixel Lab
 * (key held server-side) and returns a transparent pixel-art sprite as a
 * data-URI. Generation can take tens of seconds, hence the long timeout.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth, isAuthEnabled } from "@/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (isAuthEnabled && !(await auth())?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/observability/avatars/generate`, {
      method: "POST",
      headers: await gatewayHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(115_000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "Pixel Lab request failed or timed out" },
      { status: 504 },
    );
  }
}
