/**
 * POST /api/agent/artifacts/upload?agent=&category=
 * Proxy multipart file upload to the gateway /agent/artifacts/upload — uploads
 * file(s) into an agent's workspace folder (used by the email rule editor to
 * attach files to draft actions). Returns JSON array of FileEntry objects.
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
  } catch {
    // auth() may throw outside request context
  }
  return headers;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const upstream = new URL(`${GATEWAY_URL}/agent/artifacts/upload`);
    const agent = req.nextUrl.searchParams.get("agent");
    const category = req.nextUrl.searchParams.get("category");
    if (agent) upstream.searchParams.set("agent", agent);
    if (category) upstream.searchParams.set("category", category);

    const formData = await req.formData();
    // Don't set Content-Type — fetch sets it with the multipart boundary.
    const res = await fetch(upstream.toString(), {
      method: "POST",
      headers: await buildGatewayHeaders(),
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: err }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
