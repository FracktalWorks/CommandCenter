/**
 * GET  /api/memory/[userId]/status  — memory system status for a user
 * GET  /api/memory/[userId]         — list all memories for a user
 * POST /api/memory/[userId]/search  — semantic search
 * POST /api/memory/[userId]/add     — save a conversation
 * DELETE /api/memory/[userId]/[memoryId] — delete a memory
 *
 * All routes proxy to the FastAPI gateway /memory/* path.
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
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const { path } = await params;
  const upstream = `${GATEWAY_URL}/memory/${path.join("/")}`;
  try {
    const res = await fetch(upstream, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const { path } = await params;
  const upstream = `${GATEWAY_URL}/memory/${path.join("/")}`;
  try {
    const body = await req.json().catch(() => ({}));
    const res = await fetch(upstream, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const resBody = await res.json().catch(() => ({}));
    return NextResponse.json(resBody, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const { path } = await params;
  const upstream = `${GATEWAY_URL}/memory/${path.join("/")}`;
  try {
    const res = await fetch(upstream, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });
    return new NextResponse(null, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
