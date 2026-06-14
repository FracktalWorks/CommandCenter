/**
 * GET    /api/integrations/plugins
 * POST   /api/integrations/plugins/install (routed to gateway POST /plugins/install)
 *
 * Proxies to the FastAPI gateway.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function GET(): Promise<NextResponse> {
  try {
    const res = await fetch(`${GATEWAY_URL}/integrations/plugins`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gateway unreachable: ${msg}` }, { status: 502 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json().catch(() => ({}));
    // Route to /plugins/install
    const res = await fetch(`${GATEWAY_URL}/integrations/plugins/install`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gateway unreachable: ${msg}` }, { status: 502 });
  }
}
