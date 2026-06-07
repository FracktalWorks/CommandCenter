/**
 * GET  /api/agent/workspace/[sessionId]   — list workspace file tree
 * PATCH /api/agent/workspace/[sessionId]  — set workspace_path for a session
 */
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  try {
    const { sessionId } = await params;
    const res = await fetch(`${GATEWAY_URL}/agent/workspace/${sessionId}`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
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
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    return new NextResponse(null, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 });
  }
}
