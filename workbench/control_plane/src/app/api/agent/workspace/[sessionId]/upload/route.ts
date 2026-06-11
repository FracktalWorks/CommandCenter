/**
 * POST /api/agent/workspace/[sessionId]/upload
 * Proxy multipart file upload to the gateway workspace API.
 * Accepts one or more files as multipart/form-data.
 * Returns JSON array of FileEntry objects.
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  try {
    const { sessionId } = await params;

    // Forward the multipart body to the gateway
    const upstream = `${GATEWAY_URL}/agent/workspace/${sessionId}/upload`;
    const formData = await req.formData();

    const upstreamHeaders = await buildGatewayHeaders();
    // Don't set Content-Type — fetch will set it with boundary for multipart

    const res = await fetch(upstream, {
      method: "POST",
      headers: upstreamHeaders,
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json(
        { error: err },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
