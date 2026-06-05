/**
 * POST /api/integrations/github/device/start
 *
 * Proxies to POST /integrations/github/device/start on the gateway.
 * Initiates the GitHub OAuth Device Flow.
 *
 * Response: { user_code, verification_uri, device_code, expires_in, interval }
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GATEWAY_URL = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN =
  process.env.GATEWAY_INTERNAL_TOKEN ??
  process.env.LITELLM_MASTER_KEY ??
  "sk-local-dev-change-me";

export async function POST(_req: NextRequest): Promise<NextResponse> {
  try {
    const res = await fetch(`${GATEWAY_URL}/integrations/github/device/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      signal: AbortSignal.timeout(12_000),
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
