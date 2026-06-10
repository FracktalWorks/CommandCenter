/**
 * GET  /api/agent/workspace/[sessionId]   — list workspace file tree
 * PATCH /api/agent/workspace/[sessionId]  — set workspace_path for a session
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

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

async function buildGatewayHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${INTERNAL_TOKEN}`,
  };
  try {
    const session = await auth();
    if (session?.user?.email) {
      headers["X-User-Email"] = session.user.email;
      headers["X-User-Role"] = EXECUTIVE_EMAILS.has(
        session.user.email.toLowerCase()
      )
        ? "executive"
        : "employee";
    }
  } catch (_e) {
    // auth() may throw outside request context
  }
  return headers;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  try {
    const { sessionId } = await params;
    const res = await fetch(`${GATEWAY_URL}/agent/workspace/${sessionId}`, {
      headers: await buildGatewayHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  try {
    const { sessionId } = await params;
    const body = await req.json();
    const res = await fetch(`${GATEWAY_URL}/agent/workspace/${sessionId}`, {
      method: "PATCH",
      headers: {
        ...(await buildGatewayHeaders()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    return new NextResponse(null, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 });
  }
}
