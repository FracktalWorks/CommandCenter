/**
 * POST /api/settings/llm/provider-models/refresh
 * GET  /api/settings/llm/provider-models/cache-info
 *
 * Trigger a live model refresh from all provider APIs, or get cache metadata.
 */
import { NextRequest, NextResponse } from "next/server";
import { gatewayHeaders, requireIdentity } from "@/lib/gateway";

const GATEWAY = process.env.GATEWAY_BASE_URL ?? "http://localhost:8000";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  const body = await req.json().catch(() => ({}));
  try {
    const r = await fetch(`${GATEWAY}/settings/llm/provider-models/refresh`, {
      method: "POST",
      headers: await gatewayHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), // up to 2 min for all providers
    });
    const data = await r.json().catch(() => ({}));
    return NextResponse.json(data, { status: r.status });
  } catch (err) {
    return NextResponse.json({ detail: String(err) }, { status: 502 });
  }
}

export async function GET(): Promise<NextResponse> {
  const me = await requireIdentity();
  if (me instanceof NextResponse) return me;
  try {
    const r = await fetch(
      `${GATEWAY}/settings/llm/provider-models/cache-info`,
      {
        headers: await gatewayHeaders(),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const data = await r.json().catch(() => ({}));
    return NextResponse.json(data, { status: r.status });
  } catch (err) {
    return NextResponse.json({ detail: String(err) }, { status: 502 });
  }
}
