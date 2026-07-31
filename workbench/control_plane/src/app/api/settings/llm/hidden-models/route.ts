/**
 * GET  /api/settings/llm/hidden-models   — list hidden model IDs
 * POST /api/settings/llm/hidden-models   — hide a model { id }
 */
import { NextRequest, NextResponse } from "next/server";
import { gatewayHeaders, requireIdentity } from "@/lib/gateway";

const GATEWAY = process.env.GATEWAY_BASE_URL ?? "http://localhost:8000";

const HEADERS = await gatewayHeaders({ "Content-Type": "application/json" });

export async function GET(): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  try {
    const r = await fetch(`${GATEWAY}/settings/llm/hidden-models`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(4_000),
    });
    const data = await r.json().catch(() => []);
    return NextResponse.json(data, { status: r.status });
  } catch (_e) {
    return NextResponse.json([], { status: 200 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  const body = await req.json();
  try {
    const r = await fetch(`${GATEWAY}/settings/llm/hidden-models`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6_000),
    });
    const data = await r.json().catch(() => ({}));
    return NextResponse.json(data, { status: r.status });
  } catch (err) {
    return NextResponse.json({ detail: String(err) }, { status: 502 });
  }
}
