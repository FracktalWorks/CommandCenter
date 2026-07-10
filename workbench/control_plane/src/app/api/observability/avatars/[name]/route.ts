/**
 * PUT/DELETE /api/observability/avatars/[name]
 *
 * Proxies the avatar-override write endpoints — pin (PUT) or clear (DELETE) an
 * agent's look/sprite. The Pixel Lab API key never touches the browser; it lives
 * on the gateway (see the generate route).
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

type Ctx = { params: Promise<{ name: string }> };

export async function PUT(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  if (isAuthEnabled && !(await auth())?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { name } = await ctx.params;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* empty body ok */
  }
  try {
    const res = await fetch(
      `${GATEWAY_URL}/observability/avatars/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: await gatewayHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      },
    );
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "gateway unreachable" }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  if (isAuthEnabled && !(await auth())?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { name } = await ctx.params;
  try {
    const res = await fetch(
      `${GATEWAY_URL}/observability/avatars/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: await gatewayHeaders(),
        signal: AbortSignal.timeout(8_000),
      },
    );
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "gateway unreachable" }, { status: 502 });
  }
}
