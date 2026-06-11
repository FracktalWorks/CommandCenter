/**
 * GET  /api/chat/sessions       — list all sessions from Postgres
 * POST /api/chat/sessions       — upsert a session (create or update metadata)
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
  } catch { /* not a request context */ }
  return h;
}

export async function GET(): Promise<NextResponse> {
  try {
    const res = await fetch(`${GATEWAY_URL}/chat/sessions`, {
      headers: await gatewayHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const res = await fetch(`${GATEWAY_URL}/chat/sessions`, {
      method: "POST",
      headers: await gatewayHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 });
  }
}
