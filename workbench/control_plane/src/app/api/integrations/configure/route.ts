/**
 * POST /api/integrations/configure
 *
 * Proxies to POST /integrations/configure on the FastAPI gateway.
 * Body: { vars: [{ key: string; value: string }] }
 *
 * The gateway validates against an allowlist and writes to .env,
 * then hot-reloads Settings.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const res = await fetch(`${GATEWAY_URL}/integrations/configure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      return NextResponse.json(await res.json());
    }
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Gateway ${res.status}: ${text}` },
      { status: res.status }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gateway unreachable: ${msg}` }, { status: 502 });
  }
}
